#!/usr/bin/env node
/**
 * 渲染链路 E2E：脚本扮演 Agent 走真实 daemon + 真实飞书（测试群），
 * 覆盖历史翻车场景：吞正文竞态 / 换卡后思考渲染 / 旧队列拒绝 / 问题卡收口 / 黑洞重投 / 多发顺序。
 *
 * 前置：应用已运行（daemon 含 /api/debug/* 接口，即 >= 全序化重构构建）。
 * 用法：node scripts/e2e-card.mjs
 */

const PORT = 19528;
const BASE = `http://127.0.0.1:${PORT}`;
const CHANNEL = "ch_c0130dd0";
const TEST_CHAT = "oc_5a9258865e95f2dc8b7a341da75ee237"; // Claw-E2E自动化测试群
const RUN_TAG = Date.now().toString(36);

let passed = 0;
let failed = 0;
const failures = [];

function sk(scenario) {
  return `${CHANNEL}|${TEST_CHAT}::e2e-${scenario}-${RUN_TAG}`;
}

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b);

function pollUrl(key, wait) {
  const q = new URLSearchParams({ sessionKey: key });
  if (wait === false) q.set("wait", "false");
  return `/api/poll-message?${q}`;
}

/** 阻塞 poll 带超时中断（模拟 curl 被杀/正常拿消息两种用途） */
async function blockingPoll(key, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${pollUrl(key)}`, { signal: ctrl.signal });
    return await r.json();
  } catch {
    return { aborted: true };
  } finally {
    clearTimeout(timer);
  }
}

function streamCard(key, action, segments, extra = {}) {
  return post("/api/agent-stream-card", { session_key: key, action, segments, ...extra });
}

const debugCard = (key) => get(`/api/debug/stream-card?${new URLSearchParams({ sessionKey: key })}`);
const pushMsg = (key, text) => post("/api/debug/push-message", { text, session_key: key });

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const thinkingSeg = (text) => ({ type: "thinking", text });

function cardHasReply(card, text) {
  if (!card) return false;
  if ((card.mcpReplies ?? []).some((r) => r.text.includes(text))) return true;
  return (card.lastSegments ?? []).some((s) => s.type === "reply" && (s.text ?? "").includes(text));
}

// ── S1 吞正文竞态：SDK ensure 与 send-text 同时发起，正文绝不能丢 ──
async function s1() {
  console.log("S1 吞正文竞态（send_text 与 SDK flush 并发建卡）");
  const key = sk("s1");
  await get(pollUrl(key, false)); // 登记会话（send 白名单）
  const born = Date.now();
  const [ensureR, sendR] = await Promise.all([
    streamCard(key, "ensure", [thinkingSeg("并发思考中")], { queue_born_at: born }),
    post("/api/send-text", { text: `S1正文-${RUN_TAG}`, session_key: key }),
  ]);
  check("ensure ok", ensureR.ok === true, ensureR);
  check("send_text 报告成功", sendR.ok === true, sendR);
  const d = await debugCard(key);
  check("卡存在", d.exists === true, d);
  check("正文在卡上（不吞）", cardHasReply(d.card, `S1正文-${RUN_TAG}`), d.card);
  check("思考在卡上", (d.card?.lastSegments ?? []).some((s) => s.type === "thinking"), d.card?.lastSegments);
}

// ── S2 换卡后思考渲染：收口后诞生的新队列必须放行建卡 ──
async function s2() {
  console.log("S2 换卡后新回合思考渲染（gone 不误伤新队列）");
  const key = sk("s2");
  await get(pollUrl(key, false));
  const born1 = Date.now();
  await streamCard(key, "ensure", [thinkingSeg("旧回合思考")], { queue_born_at: born1 });
  await pushMsg(key, "S2用户消息");
  const polled = await get(pollUrl(key, false)); // 投递 → seal 旧卡
  check("消息投递", (polled.messages ?? []).length === 1, polled);
  await sleep(500); // seal 在链上异步执行
  const afterSeal = await debugCard(key);
  check("旧卡已收口摘除", afterSeal.exists === false, afterSeal);
  check("sealAt 已记录", typeof afterSeal.sealAt === "number", afterSeal);
  const born2 = Date.now();
  const r2 = await streamCard(key, "ensure", [thinkingSeg("新回合思考")], { queue_born_at: born2 });
  check("新队列 ensure 放行（非 gone）", r2.ok === true && r2.gone !== true, r2);
  const d2 = await debugCard(key);
  check("新卡带新思考", (d2.card?.lastSegments ?? []).some((s) => s.type === "thinking" && s.text?.includes("新回合思考")), d2.card);
}

// ── S3+S4 旧队列拒绝（幂等）：诞生早于收口的 ensure 连续多次都要拦 ──
async function s3s4() {
  console.log("S3/S4 旧队列 ensure 幂等拒绝");
  const key = sk("s3");
  await get(pollUrl(key, false));
  const bornOld = Date.now();
  await streamCard(key, "ensure", [thinkingSeg("将被收口的思考")], { queue_born_at: bornOld });
  await sleep(50);
  await pushMsg(key, "S3触发收口");
  await get(pollUrl(key, false));
  await sleep(500);
  const r1 = await streamCard(key, "ensure", [thinkingSeg("旧队列重放1")], { queue_born_at: bornOld });
  check("第一个旧 ensure 被拒（gone）", r1.gone === true, r1);
  const r2 = await streamCard(key, "ensure", [thinkingSeg("旧队列重放2")], { queue_born_at: bornOld });
  check("第二个旧 ensure 仍被拒（幂等）", r2.gone === true, r2);
  const d = await debugCard(key);
  check("没有副本卡被重建", d.exists === false, d);
}

// ── S5 问题卡：建问题 → 新消息到达 → 自动关闭收口 ──
async function s5() {
  console.log("S5 问题卡收口（新消息关闭未决问题）");
  const key = sk("s5");
  await get(pollUrl(key, false));
  const q = await post("/api/send-question", {
    text: `S5确认发布吗-${RUN_TAG}`,
    options: ["发布", "取消"],
    session_key: key,
  });
  check("问题卡创建", q.ok === true, q);
  const d1 = await debugCard(key);
  check("pendingQuestion 在位", d1.card?.pendingQuestion?.options?.length === 2, d1.card);
  await pushMsg(key, "S5用户文字答复");
  await get(pollUrl(key, false));
  await sleep(600);
  const d2 = await debugCard(key);
  check("问题卡已随新消息收口", d2.exists === false, d2);
}

// ── S6 黑洞重投：投递后无出站就挂 poll → 不确认、重投一次 ──
async function s6() {
  console.log("S6 黑洞投递重投（投递后无出站不误 DONE）");
  const key = sk("s6");
  await get(pollUrl(key, false));
  await pushMsg(key, `S6黑洞消息-${RUN_TAG}`);
  const claimed = await get(pollUrl(key, false)); // 领走（记投递时刻），扮演黑洞：不回复
  check("消息已领走", (claimed.messages ?? []).length === 1, claimed);
  const re = await blockingPoll(key, 8000); // 无出站直接挂 poll → 应立即重投而非确认
  check("阻塞 poll 立即重投该消息", (re.messages ?? []).some((m) => m.text?.includes("S6黑洞消息")), re);
  const re2 = await blockingPoll(key, 3000); // 再挂一次：已重投过 → 正常确认，空队列挂起（超时中断）
  check("第二次不再重投（防死循环）", re2.aborted === true || (re2.messages ?? []).every((m) => !m.text?.includes("S6黑洞消息")), re2);
}

// ── S7 连续 send_text 顺序合并 ──
async function s7() {
  console.log("S7 连续 send_text 顺序与合并");
  const key = sk("s7");
  await get(pollUrl(key, false));
  for (const n of [1, 2, 3]) {
    const r = await post("/api/send-text", { text: `S7第${n}段`, session_key: key });
    check(`第${n}段发送成功`, r.ok === true, r);
  }
  const d = await debugCard(key);
  const joined = (d.card?.mcpReplies ?? []).map((r) => r.text).join("\n");
  check("三段正文全部在卡且有序", joined.indexOf("S7第1段") >= 0
    && joined.indexOf("S7第1段") < joined.indexOf("S7第2段")
    && joined.indexOf("S7第2段") < joined.indexOf("S7第3段"), d.card?.mcpReplies);
}

// ── S8 finish 后 send_text 走新卡（不复活旧卡） ──
async function s8() {
  console.log("S8 finish 收口后 send_text 走新卡");
  const key = sk("s8");
  await get(pollUrl(key, false));
  const born = Date.now();
  await streamCard(key, "ensure", [thinkingSeg("S8思考")], { queue_born_at: born });
  const d1 = await debugCard(key);
  const firstCard = d1.card?.cardId;
  await streamCard(key, "finish", [], { card_id: firstCard });
  await sleep(200);
  const afterFinish = await debugCard(key);
  check("finish 后卡已摘除", afterFinish.exists === false, afterFinish);
  const r = await post("/api/send-text", { text: `S8新卡正文-${RUN_TAG}`, session_key: key });
  check("finish 后 send_text 成功", r.ok === true, r);
  const d2 = await debugCard(key);
  check("走的是新卡", d2.exists === true && d2.card?.cardId !== firstCard, { old: firstCard, now: d2.card?.cardId });
  check("新卡带正文", cardHasReply(d2.card, `S8新卡正文-${RUN_TAG}`), d2.card);
}

async function main() {
  console.log(`E2E run tag=${RUN_TAG} chat=${TEST_CHAT}\n`);
  const scenarios = [s1, s2, s3s4, s5, s6, s7, s8];
  for (const s of scenarios) {
    try {
      await s();
    } catch (e) {
      failed++;
      failures.push(`${s.name} threw`);
      console.log(`  ❌ ${s.name} 异常: ${e?.message ?? e}`);
    }
    console.log("");
  }
  console.log(`结果: ${passed} 通过, ${failed} 失败${failures.length ? ` — ${failures.join("; ")}` : ""}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
