import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  startDaemonScheduledTasks,
  stopDaemonScheduledTasks,
  setDaemonSchedulerLogger,
} from "./daemon-scheduled-tasks.js";
import { stripProxyEnv, localTimestamp, createLarkClient, LarkSender, LarkMessageEvent, cleanupMediaCache, type MergeBatchCardView, type MergeBatchCardState, type PresentationCardState } from "./shared/lark-core.js";
import { mergeShellToolDetail } from "./shared/tool-presentation.js";
import { WeChatManager } from "./wechat-manager.js";
import {
  initFileQueue,
  getQueueDir,
  pushToFileQueue,
  getEarliestMessageTime,
  claimNextMessage,
  claimSessionMessages,
  ackMessages,
  getQueueLength as getFileQueueLength,
  getQueueMessages as getFileQueueMessages,
  deleteQueueMessage as deleteFileQueueMessage,
  getDistinctSessions,
  cleanupStaleMessages,
  cleanupOrphanClaimedOnColdStart,
  getSessionPendingCount,
  getSessionUnclaimedCount,
  listUnclaimedMessages,
  replaceSessionUnclaimedMessages,
  type QueueMessage,
  type QueueMessageMeta,
} from "./file-queue.js";
import { LOCK_FILE_NAME } from "./shared/constants.js";
import {
  makeChatKey,
  parseChatKey,
  type DaemonChannelConfig,
  type ChannelStatusInfo,
} from "./shared/channel-types.js";
import {
  isFeishuProcessPresentationSuppressed as feishuSuppressesProcessKind,
} from "./shared/feishu-presentation-gate.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { registerAdminTools } from "./server-admin.js";
import { registerWorkflowAgentTools, registerWorkflowAdminTools } from "./server-workflow.js";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../package.json") as { version: string }).version;

// ── 环境变量 ──────────────────────────────────────────────

const ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY ?? "";
const CONFIGURED_PORT = process.env.LARK_DAEMON_PORT ? Number(process.env.LARK_DAEMON_PORT) : 0;
let WORKSPACE_DIR = process.env.LARK_WORKSPACE_DIR ?? process.cwd();
const MESSAGE_PREFIX = process.env.LARK_MESSAGE_PREFIX ?? "";
const APP_DATA_DIR = process.env.APP_DATA_DIR || "";

function parseChannelConfigs(): DaemonChannelConfig[] {
  try {
    const raw = process.env.CLAW_CHANNELS_JSON ?? "";
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as DaemonChannelConfig[]) : [];
  } catch {
    return [];
  }
}

const CHANNEL_CONFIGS = parseChannelConfigs();

const savedProxyKeys = stripProxyEnv();

// ── 活跃 MCP 连接追踪 ──
let activeMcpConnections = 0;
let lastMcpRequestTime = 0;

// ── 日志 ─────────────────────────────────────────────────

const LOG_FILE_PATH = path.join(APP_DATA_DIR, "daemon.log");
const MAX_LOG_SIZE = 2 * 1024 * 1024;
const LOG_ROTATE_CHECK_INTERVAL = 100;
let logWriteCount = 0;
let logDirEnsured = false;

/** 换行用 ⏎ 标记（展示层还原），避免与 Windows 路径中 \n、\r 字面量冲突 */
function escapeLogContentSingleLine(s: string): string {
  return s.replace(/\r?\n/g, "⏎");
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  const dir = path.dirname(LOG_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  logDirEnsured = true;
}

function rotateLogIfNeeded(): void {
  if (++logWriteCount % LOG_ROTATE_CHECK_INTERVAL !== 0) return;
  try {
    if (fs.existsSync(LOG_FILE_PATH) && fs.statSync(LOG_FILE_PATH).size > MAX_LOG_SIZE) {
      const backup = LOG_FILE_PATH + ".old";
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(LOG_FILE_PATH, backup);
    }
  } catch { /* ignore */ }
}

function log(level: string, ...args: unknown[]): void {
  const ts = localTimestamp();
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  const line = `${ts} [Daemon] ${level} ${escapeLogContentSingleLine(msg)}\n`;
  process.stderr.write(line);
  try {
    ensureLogDir();
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE_PATH, line);
  } catch { /* ignore */ }
}

// ── 通道运行时（多飞书 + 多微信）──────────────────────────

interface ChannelRuntime {
  cfg: DaemonChannelConfig;
  // feishu
  client?: ReturnType<typeof createLarkClient>;
  sender?: LarkSender;
  botOpenId?: string;
  /** 机器人应用名（bot/v3/info 的 app_name），用于协作名册 */
  botName?: string;
  feishuConnected?: boolean;
  // wechat
  wechat?: WeChatManager;
  /** 该通道最近一次私聊的原始 chatId */
  lastP2pChatId: string | null;
  /** 主用户绑定模式：下一条私聊消息绑定为主用户 */
  bindArmed: boolean;
}

const channels = new Map<string, ChannelRuntime>();

function channelWorkspaceDir(rt: ChannelRuntime): string {
  return rt.cfg.workspaceDir?.trim() || WORKSPACE_DIR;
}

function isChannelConnected(rt: ChannelRuntime): boolean {
  if (rt.cfg.type === "feishu") return !!rt.feishuConnected && !!rt.sender;
  return rt.wechat?.isConnected() ?? false;
}

function getChannelStatusList(): ChannelStatusInfo[] {
  return [...channels.values()].map((rt) => ({
    id: rt.cfg.id,
    name: rt.cfg.name,
    type: rt.cfg.type,
    connected: isChannelConnected(rt),
    status: rt.cfg.type === "wechat"
      ? (rt.wechat?.getStatus() ?? "disconnected")
      : (rt.feishuConnected ? "connected" : "connecting"),
    mainUserBound: !!(rt.cfg.mainUserEnabled && rt.cfg.mainUserChatId),
    botName: rt.botName,
  }));
}

/** 通道的默认私聊目标（主用户优先，其次最近私聊） */
function channelDefaultChatId(rt: ChannelRuntime): string | null {
  if (rt.cfg.mainUserEnabled && rt.cfg.mainUserChatId) return rt.cfg.mainUserChatId;
  return rt.lastP2pChatId;
}

function pickChannel(channelId?: string): ChannelRuntime | null {
  if (channelId) {
    const rt = channels.get(channelId);
    if (rt) return rt;
  }
  for (const rt of channels.values()) {
    if (isChannelConnected(rt)) return rt;
  }
  return channels.values().next().value ?? null;
}

/** 主用户绑定（armed bind）命中：写回 Electron 并回执 */
function completeBind(rt: ChannelRuntime, chatId: string, messageId?: string): void {
  rt.bindArmed = false;
  rt.cfg.mainUserEnabled = true;
  rt.cfg.mainUserChatId = chatId;
  if (rt.sender) rt.sender.chatId = chatId;
  process.stdout.write(`__BIND_RESULT__:${JSON.stringify({ channelId: rt.cfg.id, chatId })}\n`);
  log("INFO", `[Bind] 通道「${rt.cfg.name}」主用户绑定成功: ${chatId}`);
  if (messageId) {
    replyToMessage(messageId, "✅ 主用户绑定成功！", makeChatKey(rt.cfg.id, chatId)).catch(() => {});
  }
}

function isWechatChatId(rawChatId?: string): rawChatId is string {
  if (!rawChatId) return false;
  return rawChatId.startsWith("wxid_") || rawChatId.startsWith("wx_") || rawChatId.includes("@chatroom") || rawChatId.includes("@im.wechat");
}

function isFeishuChatId(rawChatId?: string): rawChatId is string {
  if (!rawChatId) return false;
  return rawChatId.startsWith("oc_");
}

// ── WeChat 通道 ──────────────────────────────────────────

function wechatDataDir(channelId: string): string {
  return path.join(APP_DATA_DIR, "wechat-data", channelId);
}

function wechatStateFile(channelId: string): string {
  return path.join(wechatDataDir(channelId), "state.json");
}

function loadWechatState(rt: ChannelRuntime): void {
  try {
    const file = wechatStateFile(rt.cfg.id);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (data.lastChatId) {
        rt.lastP2pChatId = data.lastChatId;
        log("INFO", `[WeChat:${rt.cfg.name}] 已恢复 context 绑定: chatId=${rt.lastP2pChatId}`);
      }
    }
  } catch { /* ignore */ }
}

function saveWechatState(rt: ChannelRuntime): void {
  try {
    const file = wechatStateFile(rt.cfg.id);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastChatId: rt.lastP2pChatId }));
  } catch { /* ignore */ }
}

function initWeChatChannel(rt: ChannelRuntime): WeChatManager {
  const channelId = rt.cfg.id;
  return new WeChatManager({
    dataDir: wechatDataDir(channelId),
    log: (level: string, ...args: unknown[]) => log(level, `[${rt.cfg.name}]`, ...args),
    onMessage: (msg) => {
      const chatKey = makeChatKey(channelId, msg.chatId);
      const firstMessage = !rt.lastP2pChatId;
      if (msg.chatType === "p2p" && msg.chatId) {
        rt.lastP2pChatId = msg.chatId;
        saveWechatState(rt);
      }
      if (rt.bindArmed && msg.chatType === "p2p" && msg.chatId) {
        completeBind(rt, msg.chatId, msg.messageId);
        return;
      }
      if (firstMessage) {
        log("INFO", `[WeChat:${rt.cfg.name}] 首条消息已收到，context_token 已绑定（chatId=${msg.chatId}），不入队`);
        return;
      }
      if (isCommand(msg.text)) {
        handleCommand(msg.text, msg.messageId, chatKey, msg.chatType).catch((e: any) =>
          log("ERROR", `[WeChat:${rt.cfg.name}] 指令处理失败: ${e?.message ?? e}`),
        );
        return;
      }
      pushMessage(msg.text, msg.messageId, chatKey, msg.chatType, msg.senderOpenId);
    },
    onQrCode: (dataUrl) => {
      process.stdout.write(`__WECHAT_QR__:${channelId}:${dataUrl}\n`);
    },
    onStatusChange: (status) => {
      process.stdout.write(`__WECHAT_STATUS__:${channelId}:${status}\n`);
    },
  });
}

// ── SSE 客户端管理 ───────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcastQueueEvent(chatId?: string): void {
  const data = JSON.stringify({ type: "queue-update", chatId: chatId ?? null, ts: Date.now() });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
  scheduleAgentDispatch(chatId);
}

// ── 会话路由映射 ─────────────────────────────────────────

const activeSessionMap = new Map<string, string>();
const messageSessionMap = new Map<string, string>();
const sessionToChatMap = new Map<string, string>();
const MSG_SESSION_MAP_MAX = 5000;
const sessionLastReplyAt = new Map<string, number>();

// ── 会话进行中指示（入队确认后至任务完成，供 T8 停止）──
interface SessionProgressState {
  typingActive: boolean;
  outboundMessageId?: string;
  streamId?: string;
  /** 流式：最近一次已推送的全文 */
  streamLastText?: string;
  /** 流式：上次推送时间（节流） */
  streamLastPushAt?: number;
  /** 流式：飞书 PATCH 是否仍可用；false 后走分段降级 */
  streamPatchMode?: boolean;
  /** 流式：fallback 模式下已分段发送的字符数 */
  streamSentLength?: number;
  /** CardKit 流式卡片 id */
  cardId?: string;
  /** CardKit 流式元素 id（固定 stream_content） */
  elementId?: string;
  /** CardKit 流式更新 sequence（递增） */
  cardSequence?: number;
  /** true=CardKit 路径可用 */
  streamCardKitMode?: boolean;
  /** 已对 inbound 消息打过 Get 的 id（poll 去重，独立于 typing 生命周期） */
  getReactedMessageIds?: Set<string>;
  /** 工具进度 CardKit（按 tool_name 分卡，支持并发工具） */
  toolCards?: Map<string, ToolProgressCardState>;
  /** 思考摘要 CardKit */
  thinkingCardEntityId?: string;
  thinkingCardMessageId?: string;
  thinkingCardSequence?: number;
  thinkingBuffer?: string;
  thinkingLastPushAt?: number;
  /** presentation-event assistant 增量累积（stream-text 回退路径） */
  presentationAssistantAccum?: string;
  /** Presentation 时序编排：本 Run 已见过程且尚未 idle */
  presentationProcessActive?: boolean;
  /** started/running 的 tool_name */
  activeToolNames?: Set<string>;
  /** 收到 thinking 且未收 final */
  thinkingOpen?: boolean;
  /** 延迟首建期间累积 assistant 全文 */
  deferredAssistantText?: string;
  /** 已首建 assistant 卡，防重复 */
  assistantCardReleased?: boolean;
  /** 与 Electron runStartedAt 对齐（预留） */
  runPresentationEpoch?: number;
}

/** 流式更新节流间隔（ms），默认 1000，可配置范围 500–1500（NF6） */
function streamTextThrottleMs(): number {
  const raw = Number(process.env.STREAM_TEXT_THROTTLE_MS);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : 1000;
  return Math.min(1500, Math.max(500, ms));
}

const sessionChatTypeMap = new Map<string, string>();
const THINKING_SUMMARY_MAX_CHARS = 800;

function rememberSessionChatType(sessionKey: string, chatType: string): void {
  if (sessionKey && chatType) sessionChatTypeMap.set(sessionKey, chatType);
}

function resolveSessionChatType(sessionKey: string): string | undefined {
  const cached = sessionChatTypeMap.get(sessionKey);
  if (cached) return cached;
  const msgs = listUnclaimedMessages(sessionKey);
  const ct = msgs[0]?.meta?.chatType;
  if (ct) rememberSessionChatType(sessionKey, ct);
  return ct;
}

function resolveChannelRuntime(sessionKey: string): {
  rt: ChannelRuntime;
  rawKey: string;
  chatId: string;
} | null {
  const rawKey = resolveRawChatId(sessionKey);
  if (!rawKey) return null;
  const { channelId, chatId: raw } = parseChatKey(rawKey);
  let rt: ChannelRuntime | undefined;
  if (channelId) {
    rt = channels.get(channelId);
  } else {
    for (const c of channels.values()) {
      if (isWechatChatId(rawKey) && c.cfg.type === "wechat") { rt = c; break; }
      if (isFeishuChatId(rawKey) && c.cfg.type === "feishu") { rt = c; break; }
    }
  }
  if (!rt) return null;
  return { rt, rawKey, chatId: raw || rawKey };
}

function presentationOrderingEnvEnabled(): boolean {
  const v = (process.env.PRESENTATION_ORDERING ?? "").trim().toLowerCase();
  if (v === "0" || v === "false") return false;
  return true;
}

/** Presentation 时序编排总开关（默认开，仅主用户私聊） */
function presentationOrderingEnabled(sessionKey: string): boolean {
  if (!presentationOrderingEnvEnabled()) return false;
  return isMainUserP2pEligible(sessionKey);
}

function isPresentationProcessIdle(state: SessionProgressState): boolean {
  return (state.activeToolNames?.size ?? 0) === 0 && !state.thinkingOpen;
}

function resetPresentationOrderingFields(state: SessionProgressState): void {
  state.presentationProcessActive = false;
  state.activeToolNames = new Set();
  state.thinkingOpen = false;
  state.deferredAssistantText = "";
  state.assistantCardReleased = false;
  state.runPresentationEpoch = 0;
}

/** F4.1：主用户私聊 eligible（合并批次仍限此范围） */
function isMainUserP2pEligible(sessionKey: string): boolean {
  const resolved = resolveChannelRuntime(sessionKey);
  if (!resolved) return false;
  const { rt, rawKey, chatId } = resolved;
  if (isWechatChatId(rawKey) && rawKey.includes("@chatroom")) return false;
  if (!rt.cfg.mainUserEnabled || !rt.cfg.mainUserChatId?.trim()) return false;
  return chatId === rt.cfg.mainUserChatId.trim();
}

/** F4.1 + S1.8：主用户私聊或飞书群聊（allowOthers） */
function isStreamTextEligible(sessionKey: string): boolean {
  if (isMainUserP2pEligible(sessionKey)) return true;
  const resolved = resolveChannelRuntime(sessionKey);
  if (!resolved) return false;
  const { rt, rawKey } = resolved;
  if (isWechatChatId(rawKey) && rawKey.includes("@chatroom")) return false;
  if (rt.cfg.type !== "feishu" || !rt.cfg.allowOthers) return false;
  return resolveSessionChatType(sessionKey) === "group";
}

function isPresentationEligible(sessionKey: string): boolean {
  return isStreamTextEligible(sessionKey);
}

/** 飞书全通道：tool/thinking 不渲染 CardKit，静默 ok；ordering 闩锁仍须更新 */
function isFeishuProcessPresentationSuppressed(sessionKey: string, kind: string): boolean {
  const ch = resolveChannel(sessionKey);
  if (ch.type === "error") return false;
  return feishuSuppressesProcessKind(ch.type, kind);
}

/** NF2：活跃合并批次时 stream/tool/thinking 首包 reply 到首条 inbound */
function getPresentationReplyAnchor(sessionKey: string): string | undefined {
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch || isTerminalMergePhase(batch.phase)) return undefined;
  return batch.lastInboundMessageId;
}

function logPresentationFailed(sessionKey: string, kind: string, reason: string): void {
  log("WARN", `presentation_failed session=${sessionKey} kind=${kind} reason=${reason}`);
}

function logPresentationOrderViolation(ctx: {
  sessionKey: string;
  streamId?: string;
  assistantMsgId: string;
  processKind: string;
  processMsgId?: string;
  orderingEnabled: boolean;
}): void {
  log(
    "WARN",
    `presentation_order_violation session_key=${ctx.sessionKey} stream_id=${ctx.streamId ?? ""} assistant_msg_id=${ctx.assistantMsgId} process_kind=${ctx.processKind} process_msg_id=${ctx.processMsgId ?? ""} ordering_enabled=${ctx.orderingEnabled}`,
  );
}

async function sendStreamSegments(
  ch: { type: "wechat"; rt: ChannelRuntime; chatId: string } | { type: "feishu"; rt: ChannelRuntime; chatId?: string },
  state: SessionProgressState,
  text: string,
  sessionKey: string,
  title: string | undefined,
  final: boolean,
): Promise<void> {
  const sentLen = state.streamSentLength ?? 0;
  if (text.length <= sentLen && !final) return;

  let delta = text.slice(sentLen);
  if (!final && delta.length > 0) {
    const lastParaBreak = delta.lastIndexOf("\n\n");
    if (lastParaBreak > 0) {
      delta = delta.slice(0, lastParaBreak);
    } else if (lastParaBreak === -1 && !text.endsWith("\n\n")) {
      return;
    }
  }
  if (!delta.trim()) {
    if (final && sentLen < text.length) delta = text.slice(sentLen);
    else return;
  }

  if (ch.type === "wechat") {
    await ch.rt.wechat!.sendText(ch.chatId, delta, { skipTyping: true });
  } else {
    const segId = await ch.rt.sender!.sendMessage(delta, undefined, ch.chatId, title);
    if (segId) trackMessageSession(segId, sessionKey);
  }
  state.streamSentLength = sentLen + delta.length;
  state.streamLastPushAt = Date.now();
  state.streamLastText = text.slice(0, state.streamSentLength);
}

/** 飞书 CardKit 不可用时的 PATCH / 分段降级 */
async function feishuStreamFallbackUpdate(
  ch: { type: "feishu"; rt: ChannelRuntime; chatId?: string },
  state: SessionProgressState,
  outId: string,
  text: string,
  sessionKey: string,
  title: string | undefined,
  final: boolean,
): Promise<void> {
  if (state.streamPatchMode !== false) {
    const patched = await ch.rt.sender!.updateMessageContent(outId, text, title);
    if (patched) {
      state.streamLastText = text;
      state.streamLastPushAt = Date.now();
      state.streamSentLength = text.length;
      state.streamPatchMode = true;
    } else {
      state.streamPatchMode = false;
      log("INFO", `飞书 PATCH 不可用，降级分段发送: session=${sessionKey}`);
      await sendStreamSegments(ch, state, text, sessionKey, title, final);
    }
  } else {
    await sendStreamSegments(ch, state, text, sessionKey, title, final);
  }
}

/** 过程 idle 或 Run final 时首建 assistant CardKit（MergeBatch reply 锚点不变） */
async function releaseDeferredAssistantStream(
  sessionKey: string,
  state: SessionProgressState,
  opts?: { force?: boolean; final?: boolean; message_id?: string },
): Promise<void> {
  if (state.assistantCardReleased) return;
  if (!opts?.force && !isPresentationProcessIdle(state)) return;

  const text = state.deferredAssistantText ?? "";
  if (!text.trim() && !opts?.force) return;

  const ch = resolveChannel(sessionKey);
  if (ch.type === "error") return;

  const title = extractWorkspaceTitle(sessionKey);
  const sid = state.streamId ?? randomUUID();
  state.streamId = sid;
  const now = Date.now();
  let outId: string | undefined;

  if (ch.type === "wechat") {
    const ok = await ch.rt.wechat!.sendText(ch.chatId, text, { skipTyping: true });
    if (!ok) {
      logPresentationFailed(sessionKey, "assistant", "微信发送失败");
      return;
    }
    outId = `wx_stream_${sid}`;
    state.streamPatchMode = false;
    state.outboundMessageId = outId;
    state.streamLastText = text;
    state.streamSentLength = text.length;
    state.streamLastPushAt = now;
  } else {
    const card = await ch.rt.sender!.createStreamingCardEntity(title);
    if (card) {
      const replyAnchor = getPresentationReplyAnchor(sessionKey);
      const msgId = await ch.rt.sender!.sendStreamingCardMessage(ch.chatId!, card.cardId, replyAnchor);
      if (msgId) {
        outId = msgId;
        state.cardId = card.cardId;
        state.elementId = card.elementId;
        state.cardSequence = 1;
        state.streamCardKitMode = true;
        trackMessageSession(outId, sessionKey);
        const updated = await ch.rt.sender!.updateStreamingCardText(
          card.cardId, card.elementId, text, state.cardSequence,
        );
        if (updated) {
          state.streamLastText = text;
          state.streamSentLength = text.length;
          state.streamLastPushAt = now;
        } else {
          state.streamCardKitMode = false;
          log("INFO", `CardKit 首包更新失败，降级 PATCH/分段: session=${sessionKey}`);
          await feishuStreamFallbackUpdate(ch, state, outId, text, sessionKey, title, !!opts?.final);
        }
      }
    }
    if (!outId) {
      outId = await ch.rt.sender!.sendStreamMessage(text, ch.chatId, title);
      if (!outId) {
        logPresentationFailed(sessionKey, "assistant", "CardKit 与 sendStreamMessage 均失败");
        return;
      }
      state.streamPatchMode = true;
      trackMessageSession(outId, sessionKey);
      state.streamLastText = text;
      state.streamSentLength = text.length;
      state.streamLastPushAt = now;
    }
    state.outboundMessageId = outId;
  }

  state.assistantCardReleased = true;
  sessionLastReplyAt.set(sessionKey, now);

  if (opts?.final) {
    if (ch.type === "feishu" && state.streamCardKitMode && state.cardId) {
      const closeSeq = (state.cardSequence ?? 0) + 1;
      await ch.rt.sender!.closeStreamingCardMode(state.cardId, closeSeq);
    }
    if (opts.message_id) {
      ackOnReply(opts.message_id, sessionKey);
    } else {
      stopSessionProgress(sessionKey);
    }
  }
}

async function handleStreamText(body: {
  session_key?: string;
  text?: string;
  stream_id?: string;
  outbound_message_id?: string;
  message_id?: string;
  final?: boolean;
}): Promise<{ ok: boolean; stream_id?: string; outbound_message_id?: string; deferred?: boolean; error?: string }> {
  const { session_key, text, stream_id, outbound_message_id, message_id, final } = body;
  if (!session_key || text === undefined || text === "") {
    return { ok: false, error: "session_key and text are required" };
  }
  if (!isStreamTextEligible(session_key)) {
    return { ok: false, error: "stream-text not supported for this session" };
  }

  const ch = resolveChannel(session_key);
  if (ch.type === "error") return { ok: false, error: ch.message };

  let state = sessionProgressMap.get(session_key);
  if (!state) {
    state = { typingActive: false };
    resetPresentationOrderingFields(state);
    sessionProgressMap.set(session_key, state);
  }

  const ordering = presentationOrderingEnabled(session_key);
  if (!outbound_message_id && !stream_id) {
    resetPresentationOrderingFields(state);
  }

  if (stream_id && state.streamId && stream_id !== state.streamId) {
    return { ok: false, error: "stream_id mismatch" };
  }
  const sid = stream_id ?? state.streamId ?? randomUUID();
  state.streamId = sid;

  const outIdHint = outbound_message_id ?? state.outboundMessageId;
  let isFirst = !outIdHint;
  const now = Date.now();
  const throttle = streamTextThrottleMs();
  const forceSend = !!final || isFirst;
  if (!forceSend && state.streamLastPushAt != null && now - state.streamLastPushAt < throttle) {
    return { ok: true, stream_id: sid, outbound_message_id: state.outboundMessageId };
  }
  if (!forceSend && state.streamLastText === text) {
    return { ok: true, stream_id: sid, outbound_message_id: state.outboundMessageId };
  }

  if (ordering) {
    state.deferredAssistantText = text;
    if (state.presentationProcessActive && !state.assistantCardReleased && isFirst && !final) {
      return { ok: true, stream_id: sid, deferred: true };
    }
    if (!state.assistantCardReleased && final && state.presentationProcessActive) {
      await releaseDeferredAssistantStream(session_key, state, { force: true, final: true, message_id });
      return { ok: true, stream_id: sid, outbound_message_id: state.outboundMessageId };
    }
    if (!state.assistantCardReleased && final) {
      await releaseDeferredAssistantStream(session_key, state, { force: true });
      isFirst = !state.outboundMessageId;
    }
  }

  const title = extractWorkspaceTitle(session_key);
  let outId = outIdHint;

  if (isFirst) {
    if (ch.type === "wechat") {
      const ok = await ch.rt.wechat!.sendText(ch.chatId, text, { skipTyping: true });
      if (!ok) return { ok: false, error: "微信发送失败" };
      outId = `wx_stream_${sid}`;
      state.streamPatchMode = false;
      state.outboundMessageId = outId;
      state.streamLastText = text;
      state.streamSentLength = text.length;
      state.streamLastPushAt = now;
      if (ordering) state.assistantCardReleased = true;
    } else {
      const card = await ch.rt.sender!.createStreamingCardEntity(title);
      if (card) {
        const replyAnchor = getPresentationReplyAnchor(session_key);
        const msgId = await ch.rt.sender!.sendStreamingCardMessage(ch.chatId!, card.cardId, replyAnchor);
        if (msgId) {
          outId = msgId;
          state.cardId = card.cardId;
          state.elementId = card.elementId;
          state.cardSequence = 1;
          state.streamCardKitMode = true;
          state.outboundMessageId = outId;
          trackMessageSession(outId, session_key);
          const updated = await ch.rt.sender!.updateStreamingCardText(
            card.cardId, card.elementId, text, state.cardSequence,
          );
          if (updated) {
            state.streamLastText = text;
            state.streamSentLength = text.length;
            state.streamLastPushAt = now;
            if (ordering) state.assistantCardReleased = true;
          } else {
            state.streamCardKitMode = false;
            log("INFO", `CardKit 首包更新失败，降级 PATCH/分段: session=${session_key}`);
            await feishuStreamFallbackUpdate(ch, state, outId, text, session_key, title, !!final);
            if (ordering) state.assistantCardReleased = true;
          }
        } else {
          log("INFO", `CardKit 发送卡片失败，降级 sendStreamMessage: session=${session_key}`);
        }
      }
      if (!outId) {
        outId = await ch.rt.sender!.sendStreamMessage(text, ch.chatId, title);
        if (!outId) return { ok: false, error: "飞书发送失败" };
        state.streamPatchMode = true;
        state.outboundMessageId = outId;
        trackMessageSession(outId, session_key);
        state.streamLastText = text;
        state.streamSentLength = text.length;
        state.streamLastPushAt = now;
        if (ordering) state.assistantCardReleased = true;
      }
    }
  } else {
    outId = outId ?? state.outboundMessageId;
    if (!outId) return { ok: false, error: "missing outbound_message_id" };

    if (ch.type === "feishu" && state.streamCardKitMode && state.cardId && state.elementId) {
      state.cardSequence = (state.cardSequence ?? 0) + 1;
      const updated = await ch.rt.sender!.updateStreamingCardText(
        state.cardId, state.elementId, text, state.cardSequence,
      );
      if (updated) {
        state.streamLastText = text;
        state.streamLastPushAt = now;
        state.streamSentLength = text.length;
      } else {
        state.streamCardKitMode = false;
        log("INFO", `CardKit 更新失败，降级 PATCH/分段: session=${session_key}`);
        await feishuStreamFallbackUpdate(ch, state, outId, text, session_key, title, !!final);
      }
    } else if (ch.type === "feishu" && state.streamPatchMode !== false) {
      const patched = await ch.rt.sender!.updateMessageContent(outId, text, title);
      if (patched) {
        state.streamLastText = text;
        state.streamLastPushAt = now;
        state.streamSentLength = text.length;
      } else {
        state.streamPatchMode = false;
        log("INFO", `飞书 PATCH 不可用，降级分段发送: session=${session_key}`);
        await sendStreamSegments(ch, state, text, session_key, title, !!final);
      }
    } else {
      await sendStreamSegments(ch, state, text, session_key, title, !!final);
    }
  }

  sessionLastReplyAt.set(session_key, Date.now());
  if (final) {
    if (ch.type === "feishu" && state.streamCardKitMode && state.cardId) {
      const closeSeq = (state.cardSequence ?? 0) + 1;
      await ch.rt.sender!.closeStreamingCardMode(state.cardId, closeSeq);
    }
    if (message_id) {
      ackOnReply(message_id, session_key);
    } else {
      stopSessionProgress(session_key);
    }
  }
  return { ok: true, stream_id: sid, outbound_message_id: outId };
}

const sessionProgressMap = new Map<string, SessionProgressState>();
/** 会话 Get 去重集合（stopSessionProgress 清 map 后仍保留，ack 后逐条清理） */
const sessionGetReactedIds = new Map<string, Set<string>>();

type AgentPhase = "starting" | "processing" | "idle";
const sessionAgentPhaseMap = new Map<string, AgentPhase>();

function getSessionAgentPhase(sessionKey: string): AgentPhase | undefined {
  return sessionAgentPhaseMap.get(sessionKey);
}

type MergeBatchPhase = "collecting" | "ready" | "locked" | "dispatched" | "cancelled";

interface MergeBatch {
  sessionKey: string;
  batchId: string;
  phase: MergeBatchPhase;
  messageIds: string[];
  overrideText?: string;
  cardEntityId?: string;
  cardMessageId?: string;
  cardSequence?: number;
  quietTimer?: NodeJS.Timeout;
  quietDeadlineAt?: number;
  lastInboundMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

type PresentationKind = "assistant" | "thinking" | "tool" | "diff" | "merge_batch";

/** 工具卡状态：缓存 shell 命令供 completed PATCH */
interface ToolProgressCardState extends PresentationCardState {
  shellCommand?: string;
  shellCwd?: string;
  shellOutput?: string;
}

interface PresentationEvent {
  session_key: string;
  kind: PresentationKind;
  delta?: string;
  tool_name?: string;
  tool_status?: "started" | "completed" | "failed";
  tool_shell_command?: string;
  tool_shell_cwd?: string;
  tool_shell_output?: string;
  final?: boolean;
  outbound_message_id?: string;
}

const mergeBatchBySession = new Map<string, MergeBatch>();
const mergeCardRegistry = new Map<string, { sessionKey: string; batchId: string }>();

const MERGE_QUIET_MS = Number(process.env.MERGE_QUIET_MS) > 0 ? Number(process.env.MERGE_QUIET_MS) : 2500;
const MERGE_MIN_COUNT = 2;
const MERGE_CARD_MAX_ITEMS = 20;
const MERGE_EDIT_MAX_CHARS = 30000;

function formatMergeBody(messages: QueueMessage[]): string {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0].text.trim();
  return messages.map((m, i) => `【消息 ${i + 1}】\n${m.text.trim()}`).join("\n\n");
}

function isMergeBatchEligible(sessionKey: string): boolean {
  return isMainUserP2pEligible(sessionKey);
}

function isTerminalMergePhase(phase: MergeBatchPhase): boolean {
  return phase === "dispatched" || phase === "cancelled";
}

function registerMergeCardMessage(sessionKey: string, batchId: string, cardMessageId: string): void {
  mergeCardRegistry.set(cardMessageId, { sessionKey, batchId });
}

function clearMergeBatchQuietTimer(batch: MergeBatch): void {
  if (batch.quietTimer) {
    clearTimeout(batch.quietTimer);
    batch.quietTimer = undefined;
  }
}

function clearMergeBatchState(sessionKey: string): void {
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch) return;
  clearMergeBatchQuietTimer(batch);
  if (batch.cardMessageId) mergeCardRegistry.delete(batch.cardMessageId);
  mergeBatchBySession.delete(sessionKey);
}

function applyMergeOverrideForPoll(sessionKey: string, messages: QueueMessage[]): QueueMessage[] {
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch?.overrideText || messages.length === 0) return messages;

  const formatted = formatMergeBody(messages);
  if (batch.overrideText === formatted) return messages;

  const last = messages[messages.length - 1];
  return [{
    text: batch.overrideText,
    messageId: last.messageId,
    sessionKey: last.sessionKey || sessionKey,
    timestamp: last.timestamp,
    ...(last.meta ? { meta: last.meta } : {}),
  }];
}

function buildMergeBatchCardView(batch: MergeBatch, sessionKey: string): MergeBatchCardView {
  const messages = listUnclaimedMessages(sessionKey);
  const count = messages.length;
  const sliceStart = Math.max(0, count - MERGE_CARD_MAX_ITEMS);
  const displayItems = messages.slice(sliceStart).map((m, i) => {
    const idx = sliceStart + i + 1;
    const preview = m.text.trim().slice(0, 300);
    return `${idx}. ${preview}${m.text.trim().length > 300 ? "…" : ""}`;
  });
  if (count > MERGE_CARD_MAX_ITEMS) {
    displayItems.unshift(`*（仅展示最近 ${MERGE_CARD_MAX_ITEMS} 条）*`);
  }

  let footerText: string;
  if (batch.phase === "collecting" && batch.quietDeadlineAt) {
    const secs = Math.max(0, Math.ceil((batch.quietDeadlineAt - Date.now()) / 1000));
    footerText = secs > 0 ? `${secs} 秒后发送…` : "即将发送…";
  } else if (batch.phase === "ready") {
    footerText = getSessionAgentPhase(sessionKey) === "processing"
      ? "当前任务完成后发送"
      : "即将发送";
  } else if (batch.phase === "locked") {
    footerText = "发送中…";
  } else {
    footerText = buildEnqueueStatusText(sessionKey, count);
  }

  return {
    title: `待发送 · ${count} 条消息`,
    bodyMarkdown: displayItems.join("\n") || "（无内容）",
    footerText,
  };
}

async function renderMergeBatchCardForSession(batch: MergeBatch): Promise<void> {
  if (!isMergeBatchEligible(batch.sessionKey)) return;

  const ch = resolveChannel(batch.sessionKey);
  if (ch.type !== "feishu" || !ch.rt.sender || !ch.chatId) return;

  const view = buildMergeBatchCardView(batch, batch.sessionKey);
  const existing: MergeBatchCardState | undefined =
    batch.cardEntityId && batch.cardMessageId
      ? { cardEntityId: batch.cardEntityId, cardMessageId: batch.cardMessageId, cardSequence: batch.cardSequence ?? 0 }
      : undefined;

  const result = await ch.rt.sender.renderMergeBatchCard(
    ch.chatId,
    view,
    existing,
    existing ? undefined : batch.lastInboundMessageId,
  );
  if (!result) {
    log("WARN", `合并 CardKit 渲染失败: session=${batch.sessionKey} batch=${batch.batchId}`);
    return;
  }

  batch.cardEntityId = result.cardEntityId;
  batch.cardSequence = result.cardSequence;
  if (result.cardMessageId !== batch.cardMessageId) {
    if (batch.cardMessageId) mergeCardRegistry.delete(batch.cardMessageId);
    batch.cardMessageId = result.cardMessageId;
    registerMergeCardMessage(batch.sessionKey, batch.batchId, result.cardMessageId);
    trackMessageSession(result.cardMessageId, batch.sessionKey);
  }
  batch.updatedAt = Date.now();
}

function scheduleMergeBatchQuietTimer(batch: MergeBatch): void {
  clearMergeBatchQuietTimer(batch);
  batch.quietDeadlineAt = Date.now() + MERGE_QUIET_MS;
  batch.quietTimer = setTimeout(() => {
    batch.quietTimer = undefined;
    if (batch.phase !== "collecting") return;
    if (getSessionUnclaimedCount(batch.sessionKey) < MERGE_MIN_COUNT) return;
    batch.phase = "ready";
    batch.quietDeadlineAt = undefined;
    batch.updatedAt = Date.now();
    renderMergeBatchCardForSession(batch).catch((e: unknown) => {
      log("WARN", `合并卡 ready 更新失败: ${e instanceof Error ? e.message : e}`);
    });
    void flushReadyMergeBatches(batch.sessionKey);
  }, MERGE_QUIET_MS);
  batch.quietTimer.unref?.();
}

/** ≥2 条入队时进入 collecting；F1 门控由 shouldSendEnqueueF1 配合 */
function onMessageEnqueued(
  sessionKey: string,
  messageId: string,
  _chatId?: string,
  chatType?: string,
  _senderOpenId?: string,
): void {
  if (chatType !== "p2p" || !isMergeBatchEligible(sessionKey)) return;

  const unclaimed = getSessionUnclaimedCount(sessionKey);
  if (unclaimed < MERGE_MIN_COUNT) return;

  let batch = mergeBatchBySession.get(sessionKey);
  if (batch && isTerminalMergePhase(batch.phase)) {
    clearMergeBatchState(sessionKey);
    batch = undefined;
  }

  const now = Date.now();
  if (!batch) {
    batch = {
      sessionKey,
      batchId: randomUUID(),
      phase: "collecting",
      messageIds: [],
      createdAt: now,
      updatedAt: now,
    };
    mergeBatchBySession.set(sessionKey, batch);
  }

  if (messageId && !batch.messageIds.includes(messageId)) {
    batch.messageIds.push(messageId);
  }
  batch.lastInboundMessageId = messageId;
  batch.phase = "collecting";
  batch.updatedAt = now;

  scheduleMergeBatchQuietTimer(batch);
  renderMergeBatchCardForSession(batch).catch((e: unknown) => {
    log("WARN", `合并 CardKit 更新失败: ${e instanceof Error ? e.message : e}`);
  });
}

/** F1 门控（M3）：collecting 批次第 2+ 条不发逐条 F1 */
function shouldSendEnqueueF1(sessionKey: string): boolean {
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch || batch.phase !== "collecting") return true;
  return getSessionUnclaimedCount(sessionKey) < MERGE_MIN_COUNT;
}

/** M7：Agent processing 时禁止 dispatch；collecting 静默窗口内亦禁止 claim */
function isMergeDispatchAllowed(sessionKey: string): boolean {
  return getSessionAgentPhase(sessionKey) !== "processing";
}

/** collecting 静默窗口或 ready 但 M7 阻塞时禁止 claim/dispatch */
function shouldDeferDispatch(sessionKey: string): boolean {
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch || isTerminalMergePhase(batch.phase)) return false;
  if (batch.phase === "collecting" && getSessionUnclaimedCount(sessionKey) >= MERGE_MIN_COUNT) {
    return true;
  }
  if (batch.phase === "ready" && !isMergeDispatchAllowed(sessionKey)) {
    return true;
  }
  return false;
}

type ClaimMergeResult =
  | { ok: true; text: string; message_ids: string[] }
  | { ok: false; error: string };

/** 仅 ready|locked 且 M7 通过时 claim；返回合并正文与 message_ids */
function performClaimAndMerge(sessionKey: string): ClaimMergeResult {
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch) return { ok: false, error: "no merge batch" };
  if (batch.phase === "collecting") return { ok: false, error: "batch collecting" };
  if (isTerminalMergePhase(batch.phase)) return { ok: false, error: "batch terminal" };
  if (batch.phase === "ready" && !isMergeDispatchAllowed(sessionKey)) {
    return { ok: false, error: "agent processing, batch queued" };
  }

  clearMergeBatchQuietTimer(batch);
  const overrideText = batch.overrideText;
  if (batch.phase === "ready") {
    batch.phase = "locked";
    batch.updatedAt = Date.now();
    renderMergeBatchCardForSession(batch).catch((e: unknown) => {
      log("WARN", `合并卡 locked 更新失败: ${e instanceof Error ? e.message : e}`);
    });
  }

  const messages = claimSessionMessages(sessionKey);
  if (messages.length === 0) {
    clearMergeBatchState(sessionKey);
    return { ok: false, error: "no messages to claim" };
  }

  const text = overrideText ?? formatMergeBody(messages);
  const message_ids = messages.map((m) => m.messageId).filter(Boolean);

  batch.phase = "dispatched";
  clearMergeBatchState(sessionKey);

  const pollMessages = overrideText && overrideText !== formatMergeBody(messages)
    ? [{
        text: overrideText,
        messageId: message_ids[message_ids.length - 1] ?? "",
        sessionKey,
        timestamp: messages[messages.length - 1]?.timestamp ?? Date.now(),
        ...(messages[messages.length - 1]?.meta ? { meta: messages[messages.length - 1].meta } : {}),
      }]
    : messages;
  const freshIds = collectFreshAndTrack(pollMessages, sessionKey);
  applyPollGetReactions(freshIds, sessionKey);
  broadcastQueueEvent(sessionKey);
  log("INFO", `claim-and-merge: session=${sessionKey} count=${message_ids.length}`);
  return { ok: true, text, message_ids };
}

/** ready 批次在 M7 允许时触发 Daemon dispatch 循环 */
async function flushReadyMergeBatches(sessionKey: string): Promise<void> {
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch || batch.phase !== "ready") return;
  if (!isMergeDispatchAllowed(sessionKey)) {
    await renderMergeBatchCardForSession(batch);
    return;
  }
  broadcastQueueEvent(sessionKey);
}

// ── SDK Agent 调度（T7：Daemon 单进程 IM→调度→展示）────────────────

let dispatchLoopBusy = false;
let dispatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const busyRetryTimerBySession = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAgentDispatch(_sessionKey?: string): void {
  if (dispatchDebounceTimer) clearTimeout(dispatchDebounceTimer);
  dispatchDebounceTimer = setTimeout(() => void runAgentDispatchLoop(), 300);
}

function readElectronAgentApiPort(): number {
  try {
    const fp = path.join(APP_DATA_DIR, "agent-api-port.json");
    if (!fs.existsSync(fp)) return 0;
    const data = JSON.parse(fs.readFileSync(fp, "utf-8")) as { port?: number };
    return data.port ?? 0;
  } catch {
    return 0;
  }
}

async function forwardElectronAgentApi(subpath: string, body: object): Promise<{ ok: boolean; error?: string }> {
  const port = readElectronAgentApiPort();
  if (!port) return { ok: false, error: "Agent API 未就绪，请确保 Cursor Claw 已运行" };
  try {
    const res = await httpJson<{ ok?: boolean; error?: string }>(`http://127.0.0.1:${port}${subpath}`, body, 120_000);
    return { ok: !!res.ok, error: res.error };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function parseBusyRetryDelayMs(error?: string): number {
  const raw = error?.trim() ?? "";
  if (!/agent busy/i.test(raw)) return 0;
  const m = raw.match(/retry_after=(\d+)/i);
  const parsed = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 1500;
  return Math.min(10_000, parsed);
}

/**
 * agent_busy 延后重排：仅设置下一次调度，不在当前请求内硬重试。
 */
function scheduleBusyRetry(sessionKey: string, delayMs: number): void {
  const existing = busyRetryTimerBySession.get(sessionKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    busyRetryTimerBySession.delete(sessionKey);
    scheduleAgentDispatch(sessionKey);
  }, Math.max(500, delayMs));
  busyRetryTimerBySession.set(sessionKey, timer);
  log("INFO", `agent_busy_requeue session=${sessionKey} delay_ms=${Math.max(500, delayMs)}`);
}

function extractSessionChatId(sessionKey: string): string {
  const idx = sessionKey.indexOf("::");
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey;
}

function isSessionMainUser(sessionKey: string, chatType?: string): boolean {
  if (chatType !== "p2p") return false;
  const resolved = resolveChannelRuntime(sessionKey);
  if (!resolved) return false;
  const { rt, chatId } = resolved;
  if (!rt.cfg.mainUserEnabled || !rt.cfg.mainUserChatId?.trim()) return false;
  return chatId === rt.cfg.mainUserChatId.trim();
}

function formatOrchestratorFailure(error?: string): string {
  if (!error?.trim()) return "Agent 启动失败，请稍后重试。";
  const e = error.trim();
  if (e.includes("冷却中") || e.includes("未启用其他人") || e.includes("未配置 API Key") || e.includes("SDK 资源")) return e;
  if (e.includes("Agent API 未就绪")) return e;
  return "Agent 启动失败，请稍后重试。";
}

async function notifySessionUser(sessionKey: string, text: string, stopProgress = false): Promise<void> {
  try {
    await httpJson(localDaemonUrl("/api/send-text"), {
      text, session_key: sessionKey, ...(stopProgress && { stop_progress: true }),
    }, 10_000);
  } catch (e: unknown) {
    log("WARN", `notifySessionUser 失败 session=${sessionKey}: ${e instanceof Error ? e.message : e}`);
  }
}

function claimForOrchestratorDispatch(sessionKey: string):
  | { ok: true; text: string; message_ids: string[] }
  | { ok: false } {
  if (shouldDeferDispatch(sessionKey)) return { ok: false };
  if (getSessionAgentPhase(sessionKey) === "processing") return { ok: false };

  const batch = mergeBatchBySession.get(sessionKey);
  if (batch?.phase === "ready" && isMergeDispatchAllowed(sessionKey)) {
    const r = performClaimAndMerge(sessionKey);
    if (!r.ok) return { ok: false };
    return { ok: true, text: r.text, message_ids: r.message_ids };
  }
  if (batch?.phase === "collecting") return { ok: false };
  if (getSessionUnclaimedCount(sessionKey) === 0) return { ok: false };

  let messages = claimSessionMessages(sessionKey);
  messages = applyMergeOverrideForPoll(sessionKey, messages);
  if (messages.length === 0) return { ok: false };
  clearMergeBatchState(sessionKey);

  const text = formatMergeBody(messages);
  const message_ids = messages.map((m) => m.messageId).filter(Boolean);
  const freshIds = collectFreshAndTrack(messages, sessionKey);
  applyPollGetReactions(freshIds, sessionKey);
  log("INFO", `orchestrator-claim: session=${sessionKey} count=${messages.length}`);
  return { ok: true, text, message_ids };
}

async function dispatchSessionToAgent(sessionKey: string, chatType: string, senderOpenId?: string): Promise<void> {
  const claimed = claimForOrchestratorDispatch(sessionKey);
  if (!claimed.ok) return;

  const chatId = extractSessionChatId(sessionKey);
  const mainUser = isSessionMainUser(sessionKey, chatType);

  sessionAgentPhaseMap.set(sessionKey, "starting");
  await notifySessionUser(sessionKey, "正在启动");

  const result = await forwardElectronAgentApi("/api/agent/launch", {
    session_key: sessionKey,
    task_text: claimed.text,
    chat_type: chatType,
    chat_id: chatId,
    sender_open_id: senderOpenId,
    use_main_workspace: mainUser,
    message_ids: claimed.message_ids,
  });

  if (result.ok) {
    if (chatId !== sessionKey) setActiveSession(chatId, sessionKey);
    return;
  }

  log("WARN", `dispatch_failed: session=${sessionKey} error=${result.error ?? "unknown"}`);
  const busyDelay = parseBusyRetryDelayMs(result.error);
  if (busyDelay > 0) {
    // 与 /api/agent/dispatch 分支保持一致：busy 时延后重排，不提前 ack 当前批次。
    sessionAgentPhaseMap.delete(sessionKey);
    scheduleBusyRetry(sessionKey, busyDelay);
    return;
  }
  sessionAgentPhaseMap.delete(sessionKey);
  await notifySessionUser(sessionKey, formatOrchestratorFailure(result.error), true);
  const lastId = claimed.message_ids[claimed.message_ids.length - 1];
  if (lastId) ackMessages(lastId, sessionKey);
}

async function runAgentDispatchLoop(): Promise<void> {
  if (dispatchLoopBusy) return;
  dispatchLoopBusy = true;
  try {
    for (const { sessionKey, chatType, senderOpenId } of getDistinctSessions()) {
      await dispatchSessionToAgent(sessionKey, chatType, senderOpenId);
    }
  } catch (e: unknown) {
    log("ERROR", `dispatch loop 异常: ${e instanceof Error ? e.message : e}`);
  } finally {
    dispatchLoopBusy = false;
  }
}

async function handleMergeBatchAction(
  sessionKey: string,
  action: string,
  text?: string,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = action.replace(/^merge_/, "");
  const batch = mergeBatchBySession.get(sessionKey);

  if (normalized === "send_now") {
    if (!batch || batch.phase !== "collecting") {
      return { ok: false, error: "batch not in collecting" };
    }
    clearMergeBatchQuietTimer(batch);
    batch.phase = "ready";
    batch.quietDeadlineAt = undefined;
    batch.updatedAt = Date.now();
    await renderMergeBatchCardForSession(batch);
    await flushReadyMergeBatches(sessionKey);
    return { ok: true };
  }

  if (normalized === "split") {
    if (!batch || isTerminalMergePhase(batch.phase)) {
      return { ok: false, error: "no active merge batch" };
    }
    if (batch.phase === "locked" || batch.phase === "dispatched") {
      return { ok: false, error: "batch already dispatching" };
    }
    clearMergeBatchQuietTimer(batch);
    batch.phase = "cancelled";
    clearMergeBatchState(sessionKey);
    broadcastQueueEvent(sessionKey);
    // ponytail: T7 单条顺序 dispatch；取消合并后由 orchestrator dispatch 按未合并路径领取
    return { ok: true };
  }

  if (normalized === "edit") {
    if (!batch || isTerminalMergePhase(batch.phase)) {
      return { ok: false, error: "no active merge batch" };
    }
    if (batch.phase === "locked" || batch.phase === "dispatched") {
      return { ok: false, error: "batch already dispatching" };
    }
    const trimmed = text?.trim();
    if (!trimmed) return { ok: false, error: "text is required for edit" };
    if (trimmed.length > MERGE_EDIT_MAX_CHARS) {
      return { ok: false, error: `text exceeds ${MERGE_EDIT_MAX_CHARS} chars` };
    }
    const claimed = getSessionPendingCount(sessionKey) - getSessionUnclaimedCount(sessionKey);
    if (claimed > 0) return { ok: false, error: "messages already claimed" };
    const chatType = resolveSessionChatType(sessionKey) ?? "p2p";
    const result = replaceSessionUnclaimedMessages(sessionKey, trimmed, { chatType });
    if (!result.ok) return { ok: false, error: result.error ?? "edit failed" };
    batch.overrideText = trimmed;
    batch.updatedAt = Date.now();
    await renderMergeBatchCardForSession(batch);
    return { ok: true };
  }

  return { ok: false, error: "unknown action" };
}

async function handleToolPresentationEvent(
  event: PresentationEvent,
): Promise<{ ok: boolean; outbound_message_id?: string; error?: string }> {
  const sessionKey = event.session_key?.trim();
  if (!sessionKey) return { ok: false, error: "session_key is required" };
  if (!event.tool_name?.trim()) return { ok: false, error: "tool_name is required" };
  if (!isPresentationEligible(sessionKey)) {
    return { ok: false, error: "presentation not supported for this session" };
  }
  const toolName = event.tool_name.trim();
  const status = event.tool_status ?? "started";

  let state = sessionProgressMap.get(sessionKey);
  if (!state) {
    state = { typingActive: false };
    resetPresentationOrderingFields(state);
    sessionProgressMap.set(sessionKey, state);
  }

  if (!state.toolCards) state.toolCards = new Map();

  const ordering = presentationOrderingEnabled(sessionKey);

  if (status === "started") {
    state.toolCards.delete(toolName);
  }

  if (ordering) {
    if (!state.activeToolNames) state.activeToolNames = new Set();
    if (status === "started") {
      state.activeToolNames.add(toolName);
      state.presentationProcessActive = true;
    } else if (status === "completed" || status === "failed") {
      state.activeToolNames.delete(toolName);
    }
  }

  // 飞书全通道抑制 tool CardKit；ordering 闩锁已在上方更新
  if (isFeishuProcessPresentationSuppressed(sessionKey, "tool")) {
    if (ordering && (status === "completed" || status === "failed") && isPresentationProcessIdle(state)) {
      void releaseDeferredAssistantStream(sessionKey, state, { force: true });
    }
    return { ok: true };
  }

  const ch = resolveChannel(sessionKey);
  if (ch.type !== "feishu" || !ch.rt.sender || !ch.chatId) {
    logPresentationFailed(sessionKey, "tool", "feishu channel unavailable");
    return { ok: false, error: "feishu channel required" };
  }

  const toolCard = status !== "started" ? state.toolCards.get(toolName) : undefined;
  const outHint = event.outbound_message_id ?? toolCard?.cardMessageId;
  const existing =
    toolCard && outHint
      ? { ...toolCard, cardMessageId: outHint }
      : undefined;

  const replyAnchor = existing ? undefined : getPresentationReplyAnchor(sessionKey);

  const shellDetail = mergeShellToolDetail(
    event.tool_shell_command
      ? {
        tool_shell_command: event.tool_shell_command,
        tool_shell_cwd: event.tool_shell_cwd,
        tool_shell_output: event.tool_shell_output,
      }
      : undefined,
    toolCard
      ? {
        command: toolCard.shellCommand,
        cwd: toolCard.shellCwd,
        output: toolCard.shellOutput,
      }
      : undefined,
  );

  try {
    const result = await ch.rt.sender.renderToolProgressCard(
      ch.chatId,
      toolName,
      status,
      existing,
      replyAnchor,
      shellDetail,
    );
    if (!result) {
      logPresentationFailed(sessionKey, "tool", "CardKit render failed");
      return { ok: false, error: "tool card render failed" };
    }
    if (!existing && (state.outboundMessageId || state.assistantCardReleased)) {
      logPresentationOrderViolation({
        sessionKey,
        streamId: state.streamId,
        assistantMsgId: state.outboundMessageId ?? "",
        processKind: "tool",
        processMsgId: result.cardMessageId,
        orderingEnabled: ordering,
      });
    }
    state.toolCards.set(toolName, {
      ...result,
      shellCommand: shellDetail?.command,
      shellCwd: shellDetail?.cwd,
      shellOutput: shellDetail?.output,
    });
    if (status === "completed" || status === "failed") {
      state.toolCards.delete(toolName);
    }
    trackMessageSession(result.cardMessageId, sessionKey);
    if (ordering && (status === "completed" || status === "failed") && isPresentationProcessIdle(state)) {
      void releaseDeferredAssistantStream(sessionKey, state, { force: true });
    }
    return { ok: true, outbound_message_id: result.cardMessageId };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    logPresentationFailed(sessionKey, "tool", reason);
    return { ok: false, error: reason };
  }
}

async function handleThinkingPresentationEvent(
  event: PresentationEvent,
): Promise<{ ok: boolean; outbound_message_id?: string; error?: string }> {
  const sessionKey = event.session_key?.trim();
  if (!sessionKey) return { ok: false, error: "session_key is required" };
  if (!isPresentationEligible(sessionKey)) {
    return { ok: false, error: "presentation not supported for this session" };
  }

  let state = sessionProgressMap.get(sessionKey);
  if (!state) {
    state = { typingActive: false };
    resetPresentationOrderingFields(state);
    sessionProgressMap.set(sessionKey, state);
  }

  const ordering = presentationOrderingEnabled(sessionKey);
  if (ordering) {
    if (event.delta && !state.thinkingOpen) {
      state.thinkingOpen = true;
      state.presentationProcessActive = true;
    }
    if (event.final) {
      state.thinkingOpen = false;
    }
  }

  const releaseIfProcessIdle = () => {
    if (ordering && event.final && isPresentationProcessIdle(state!)) {
      void releaseDeferredAssistantStream(sessionKey, state!, { force: true });
    }
  };

  // 飞书全通道抑制 thinking CardKit；无 delta 的 final 仍闭合 thinkingOpen（上方已处理）
  if (isFeishuProcessPresentationSuppressed(sessionKey, "thinking")) {
    releaseIfProcessIdle();
    return { ok: true, outbound_message_id: event.outbound_message_id ?? state.thinkingCardMessageId };
  }

  if (!event.delta) {
    releaseIfProcessIdle();
    return { ok: true, outbound_message_id: event.outbound_message_id };
  }

  const ch = resolveChannel(sessionKey);
  if (ch.type !== "feishu" || !ch.rt.sender || !ch.chatId) {
    logPresentationFailed(sessionKey, "thinking", "feishu channel unavailable");
    return { ok: false, error: "feishu channel required" };
  }

  state.thinkingBuffer = (state.thinkingBuffer ?? "") + event.delta;
  const now = Date.now();
  const throttle = streamTextThrottleMs();
  if (!event.final && state.thinkingLastPushAt != null && now - state.thinkingLastPushAt < throttle) {
    return { ok: true, outbound_message_id: state.thinkingCardMessageId ?? event.outbound_message_id };
  }

  const summary = state.thinkingBuffer.length > THINKING_SUMMARY_MAX_CHARS
    ? `…${state.thinkingBuffer.slice(-THINKING_SUMMARY_MAX_CHARS)}`
    : state.thinkingBuffer;

  const outHint = event.outbound_message_id ?? state.thinkingCardMessageId;
  const existing =
    state.thinkingCardEntityId && outHint
      ? {
          cardEntityId: state.thinkingCardEntityId,
          cardMessageId: outHint,
          cardSequence: state.thinkingCardSequence ?? 0,
        }
      : undefined;

  const replyAnchor = existing ? undefined : getPresentationReplyAnchor(sessionKey);

  try {
    const result = await ch.rt.sender.renderThinkingCard(
      ch.chatId,
      summary,
      existing,
      replyAnchor,
      event.final,
    );
    if (!result) {
      logPresentationFailed(sessionKey, "thinking", "CardKit render failed");
      return { ok: false, error: "thinking card render failed" };
    }
    if (!existing && (state.outboundMessageId || state.assistantCardReleased)) {
      logPresentationOrderViolation({
        sessionKey,
        streamId: state.streamId,
        assistantMsgId: state.outboundMessageId ?? "",
        processKind: "thinking",
        processMsgId: result.cardMessageId,
        orderingEnabled: ordering,
      });
    }
    state.thinkingCardEntityId = result.cardEntityId;
    state.thinkingCardMessageId = result.cardMessageId;
    state.thinkingCardSequence = result.cardSequence;
    state.thinkingLastPushAt = now;
    trackMessageSession(result.cardMessageId, sessionKey);
    if (ordering && event.final && isPresentationProcessIdle(state)) {
      void releaseDeferredAssistantStream(sessionKey, state, { force: true });
    }
    return { ok: true, outbound_message_id: result.cardMessageId };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    logPresentationFailed(sessionKey, "thinking", reason);
    return { ok: false, error: reason };
  }
}

async function handleAssistantPresentationEvent(
  event: PresentationEvent,
): Promise<{ ok: boolean; outbound_message_id?: string; error?: string }> {
  const sessionKey = event.session_key?.trim();
  if (!sessionKey) return { ok: false, error: "session_key is required" };
  if (!isPresentationEligible(sessionKey)) {
    return { ok: false, error: "presentation not supported for this session" };
  }

  let state = sessionProgressMap.get(sessionKey);
  if (!state) {
    state = { typingActive: false };
    sessionProgressMap.set(sessionKey, state);
  }
  if (event.delta) {
    state.presentationAssistantAccum = (state.presentationAssistantAccum ?? "") + event.delta;
  }
  const text = state.presentationAssistantAccum ?? event.delta ?? "";
  if (!text.trim() && !event.final) {
    return { ok: true, outbound_message_id: event.outbound_message_id ?? state.outboundMessageId };
  }

  const result = await handleStreamText({
    session_key: sessionKey,
    text,
    stream_id: state.streamId,
    outbound_message_id: event.outbound_message_id ?? state.outboundMessageId,
    final: event.final,
  });
  if (!result.ok) {
    logPresentationFailed(sessionKey, "assistant", result.error ?? "stream-text failed");
  }
  return result;
}

async function handleMergeBatchPresentationEvent(
  event: PresentationEvent,
): Promise<{ ok: boolean; outbound_message_id?: string; error?: string }> {
  const sessionKey = event.session_key?.trim();
  if (!sessionKey) return { ok: false, error: "session_key is required" };

  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch || isTerminalMergePhase(batch.phase)) {
    return { ok: false, error: "no active merge batch" };
  }

  try {
    await renderMergeBatchCardForSession(batch);
    return { ok: true, outbound_message_id: batch.cardMessageId };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    logPresentationFailed(sessionKey, "merge_batch", reason);
    return { ok: false, error: reason };
  }
}

async function handlePresentationEvent(
  body: PresentationEvent,
): Promise<{ ok: boolean; outbound_message_id?: string; error?: string }> {
  switch (body.kind) {
    case "merge_batch":
      return handleMergeBatchPresentationEvent(body);
    case "tool":
      return handleToolPresentationEvent(body);
    case "thinking":
      return handleThinkingPresentationEvent(body);
    case "assistant":
      return handleAssistantPresentationEvent(body);
    default:
      logPresentationFailed(body.session_key ?? "?", body.kind, "unsupported kind");
      return { ok: false, error: "unsupported presentation kind" };
  }
}

async function tryHandleMergePreviewReply(
  parentId: string | undefined,
  text: string,
  messageId: string,
  chatKey: string,
  chatType: string,
  senderOpenId?: string,
  meta?: QueueMessageMeta,
): Promise<boolean> {
  if (!parentId) return false;
  const entry = mergeCardRegistry.get(parentId);
  if (!entry) return false;

  const { sessionKey, batchId } = entry;
  const batch = mergeBatchBySession.get(sessionKey);
  if (!batch || batch.batchId !== batchId) return false;

  const mergedText = batch.overrideText ?? formatMergeBody(listUnclaimedMessages(sessionKey));

  const failReply = async (reason: string) => {
    const body = `${reason}请直接回复合并卡片，并发送完整合并正文。`;
    await replyToMessage(messageId, body, chatKey);
  };

  if (batch.phase === "locked" || batch.phase === "dispatched") {
    await replyToMessage(messageId, "该批消息 Agent 已开始处理，无法修改。如需补充请直接发送新消息。", chatKey);
    return true;
  }

  const claimed = getSessionPendingCount(sessionKey) - getSessionUnclaimedCount(sessionKey);
  if (claimed > 0) {
    await replyToMessage(messageId, "该批消息 Agent 已开始处理，无法修改。如需补充请直接发送新消息。", chatKey);
    return true;
  }

  const trimmed = text?.trim();
  if (!trimmed) {
    await failReply("未能识别修改。");
    return true;
  }
  if (trimmed.length > MERGE_EDIT_MAX_CHARS) {
    await failReply(`正文过长（>${MERGE_EDIT_MAX_CHARS} 字）。`);
    return true;
  }

  const fullMeta: QueueMessageMeta = { ...(meta || {}), chatType, senderOpenId };
  const result = replaceSessionUnclaimedMessages(sessionKey, trimmed, fullMeta);
  if (!result.ok) {
    await failReply("未能识别修改。");
    return true;
  }

  batch.overrideText = trimmed;
  batch.updatedAt = Date.now();
  renderMergeBatchCardForSession(batch).catch((e: unknown) => {
    log("WARN", `合并卡编辑后更新失败: ${e instanceof Error ? e.message : e}`);
  });
  await replyToMessage(messageId, "已按你的内容更新合并批次。Agent 领取后将按新内容处理。", chatKey);
  return true;
}

function buildEnqueueStatusText(sessionKey: string, pending: number): string {
  // phase 缺失时默认 idle，不用磁盘 .claimed 推断 processing（重启后 stale claimed 会误报 F1.1）
  const phase = getSessionAgentPhase(sessionKey) ?? "idle";

  let text: string;
  if (phase === "starting") {
    text = "已收到。Agent 正在启动，你的消息已排队";
  } else if (phase === "processing") {
    text = "已收到。Agent 正在处理上一条，你的消息已排队";
  } else if (pending <= 1) {
    text = "已收到，等待 Agent 领取";
  } else {
    text = "已收到，已加入待处理队列";
  }

  if (pending > 1) {
    text += `（前面还有 ${pending - 1} 条待处理）`;
  }
  return text;
}

function getGetReactedIds(sessionKey: string): Set<string> {
  let set = sessionGetReactedIds.get(sessionKey);
  if (!set) {
    set = new Set();
    sessionGetReactedIds.set(sessionKey, set);
  }
  const state = sessionProgressMap.get(sessionKey);
  if (state) state.getReactedMessageIds = set;
  return set;
}

function recordGetReactions(sessionKey: string, messageIds: string[]): void {
  const set = getGetReactedIds(sessionKey);
  for (const id of messageIds) {
    if (id) set.add(id);
  }
}

function clearGetReactions(sessionKey: string, messageIds: string[]): void {
  const set = sessionGetReactedIds.get(sessionKey);
  if (!set) return;
  for (const id of messageIds) set.delete(id);
  if (set.size === 0) sessionGetReactedIds.delete(sessionKey);
}

function stopSessionProgress(sessionKey: string): void {
  const state = sessionProgressMap.get(sessionKey);
  if (!state) return;
  if (state.typingActive) {
    const ch = resolveChannel(sessionKey);
    if (ch.type === "wechat") {
      ch.rt.wechat!.stopProgressTyping(ch.chatId).catch((e: unknown) => {
        log("WARN", `stopProgressTyping 失败: ${e instanceof Error ? e.message : e}`);
      });
    }
  }
  sessionProgressMap.delete(sessionKey);
}

async function confirmEnqueueAndStartProgress(
  messageId: string,
  sessionKey: string,
  chatId?: string,
): Promise<void> {
  // F1 排队数仅计待领取 .qmsg，不含孤儿 .claimed（冷启动由 cleanupOrphanClaimedOnColdStart 回收）
  const pending = getSessionUnclaimedCount(sessionKey);
  const text = buildEnqueueStatusText(sessionKey, pending);
  try {
    await replyToMessage(messageId, text, chatId);
  } catch (e: unknown) {
    log("WARN", `入队确认发送失败: ${e instanceof Error ? e.message : e}`);
  }

  let state = sessionProgressMap.get(sessionKey);
  if (!state) {
    state = { typingActive: false };
    sessionProgressMap.set(sessionKey, state);
  }

  const ch = resolveChannel(sessionKey);
  if (ch.type === "wechat") {
    state.typingActive = true;
    ch.rt.wechat!.startProgressTyping(ch.chatId).catch((e: unknown) => {
      log("WARN", `startProgressTyping 失败: ${e instanceof Error ? e.message : e}`);
    });
  } else if (ch.type === "feishu") {
    state.typingActive = true;
    addReactionToMessages([messageId], sessionKey, "Get");
    recordGetReactions(sessionKey, [messageId]);
  }
}

// ── 延迟 DONE 表情队列（Agent 回复确认后打出，标志任务真正完成）──
const pendingDoneReactions = new Map<string, Map<string, number>>();
const PENDING_DONE_TIMEOUT_MS = 10 * 60 * 1000;

function enqueuePendingDone(sessionKey: string, messageIds: string[]): void {
  const now = Date.now();
  let map = pendingDoneReactions.get(sessionKey);
  if (!map) { map = new Map(); pendingDoneReactions.set(sessionKey, map); }
  for (const mid of messageIds) {
    if (mid && !mid.startsWith("internal_")) map.set(mid, now);
  }
}

function flushPendingDone(sessionKey: string): void {
  const map = pendingDoneReactions.get(sessionKey);
  if (!map || map.size === 0) return;
  const ids = [...map.keys()];
  map.clear();
  addReactionToMessages(ids, sessionKey, "DONE");
  log("INFO", `打 DONE 表情: ${ids.length} 条, session=${sessionKey}`);
}

function setActiveSession(chatId: string, sessionKey: string): void {
  activeSessionMap.set(chatId, sessionKey);
  sessionToChatMap.set(sessionKey, chatId);
  log("INFO", `会话路由更新: ${chatId} → ${sessionKey}`);
}

function resolveRawChatId(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const mapped = sessionToChatMap.get(sessionKey);
  if (mapped) return mapped;
  const idx = sessionKey.indexOf("::");
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey;
}

function extractWorkspaceTitle(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return undefined;
  const wsDir = sessionKey.slice(idx + 2);
  if (!wsDir) return undefined;
  const name = wsDir.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return name || undefined;
}

type ResolvedChannel =
  | { type: "wechat"; rt: ChannelRuntime; chatId: string }
  | { type: "feishu"; rt: ChannelRuntime; chatId?: string }
  | { type: "error"; message: string };

function resolveChannel(sessionKey?: string): ResolvedChannel {
  const rawKey = resolveRawChatId(sessionKey);

  if (rawKey) {
    const { channelId, chatId } = parseChatKey(rawKey);
    if (channelId) {
      const rt = channels.get(channelId);
      if (rt) {
        if (rt.cfg.type === "wechat") {
          return rt.wechat?.isConnected()
            ? { type: "wechat", rt, chatId }
            : { type: "error", message: `微信通道「${rt.cfg.name}」未连接` };
        }
        if (rt.sender) return { type: "feishu", rt, chatId };
        return { type: "error", message: `飞书通道「${rt.cfg.name}」未连接` };
      }
    }
    // 旧格式（无通道前缀）：按 chatId 形态启发式匹配
    for (const rt of channels.values()) {
      if (rt.cfg.type === "wechat" && isWechatChatId(rawKey) && rt.wechat?.isConnected()) {
        return { type: "wechat", rt, chatId: rawKey };
      }
      if (rt.cfg.type === "feishu" && isFeishuChatId(rawKey) && rt.sender) {
        return { type: "feishu", rt, chatId: rawKey };
      }
    }
  }

  // 兜底：第一个有默认私聊目标的已连接通道
  for (const rt of channels.values()) {
    const target = channelDefaultChatId(rt);
    if (!target || !isChannelConnected(rt)) continue;
    if (rt.cfg.type === "wechat") return { type: "wechat", rt, chatId: target };
    return { type: "feishu", rt, chatId: target };
  }
  for (const rt of channels.values()) {
    if (rt.cfg.type === "feishu" && rt.sender) return { type: "feishu", rt };
  }
  return { type: "error", message: "无可用消息通道" };
}

function trackMessageSession(messageId: string, sessionKey: string): void {
  if (!messageId || !sessionKey) return;
  if (messageSessionMap.size >= MSG_SESSION_MAP_MAX) {
    const oldest = messageSessionMap.keys().next().value;
    if (oldest) messageSessionMap.delete(oldest);
  }
  messageSessionMap.set(messageId, sessionKey);
}

/** 记录消息归属会话，并返回首次投递（之前未见过）的 messageId——只对新消息打 Get，避免重投时重复打表情 */
function collectFreshAndTrack(messages: QueueMessage[], sessionKey: string): string[] {
  const fresh: string[] = [];
  for (const m of messages) {
    if (!m.messageId) continue;
    if (!messageSessionMap.has(m.messageId)) fresh.push(m.messageId);
    trackMessageSession(m.messageId, sessionKey);
  }
  return fresh;
}

function addReactionToMessages(messageIds: string[], sessionKey: string, emojiType = "Get"): void {
  const ch = resolveChannel(sessionKey);
  if (ch.type !== "feishu" || !ch.rt.sender) return;
  const sender = ch.rt.sender;
  for (const mid of messageIds) {
    if (mid) sender.addReaction(mid, emojiType).catch(() => {});
  }
}

/** poll 投递 Get：按 messageId 去重，跳过入队确认或前次 poll 已打 Get 的 inbound（F5.3） */
function idsNeedingPollGetReaction(freshIds: string[], sessionKey: string): string[] {
  if (freshIds.length === 0) return freshIds;
  const reacted = sessionGetReactedIds.get(sessionKey);
  if (!reacted?.size) return freshIds;
  return freshIds.filter((id) => !reacted.has(id));
}

function applyPollGetReactions(freshIds: string[], sessionKey: string): void {
  const ids = idsNeedingPollGetReaction(freshIds, sessionKey);
  if (ids.length === 0) return;
  addReactionToMessages(ids, sessionKey, "Get");
  recordGetReactions(sessionKey, ids);
}

/**
 * Agent 回复确认（ack）：删除该 message_id 及更早的未确认消息。
 * DONE 表情在 ack 时打出（T7 已删除 poll-message）。
 */
function ackOnReply(messageId?: string, sessionKey?: string): void {
  if (!messageId) return;
  const acked = ackMessages(messageId, sessionKey);
  if (acked.length === 0) return;
  log("INFO", `回复确认 ${acked.length} 条消息: session=${sessionKey ?? "?"} (via ${messageId})`);
  if (sessionKey) {
    enqueuePendingDone(sessionKey, acked);
    flushPendingDone(sessionKey);
    broadcastQueueEvent(sessionKey);
    clearGetReactions(sessionKey, acked);
    stopSessionProgress(sessionKey);
    clearMergeBatchState(sessionKey);
  }
}

function resolveRoutingKey(chatId?: string, replyMessageId?: string): string | undefined {
  if (replyMessageId) {
    const sk = messageSessionMap.get(replyMessageId);
    if (sk) {
      // 同一条消息（message_id 全局唯一）可能被多个通道分别接收（bot 协作 reply 链）。
      // messageId 映射仅在通道一致时生效，否则会把 A 通道的消息错投进 B 通道的会话。
      const skChannel = parseChatKey(sk.includes("::") ? sk.slice(0, sk.indexOf("::")) : sk).channelId;
      const msgChannel = chatId ? parseChatKey(chatId).channelId : undefined;
      if (!skChannel || !msgChannel || skChannel === msgChannel) {
        log("INFO", `路由命中 messageId 映射: ${replyMessageId} → ${sk}`);
        return sk;
      }
      log("INFO", `messageId 映射跨通道(${skChannel}→${msgChannel})，忽略: ${replyMessageId}`);
    }
  }
  if (!chatId) return undefined;
  return activeSessionMap.get(chatId) ?? chatId;
}

// ── 文件队列 ─────────────────────────────────────────────

function initQueue(): void {
  const dir = initFileQueue();
  log("INFO", `共享文件队列: ${dir}`);
  cleanupStaleMessages();
  const reclaimed = cleanupOrphanClaimedOnColdStart();
  if (reclaimed > 0) {
    log("INFO", `冷启动回收遗留 claimed→qmsg: ${reclaimed} 条`);
  }
}

/** 媒体缓存清理：启动清一次 + 每 6 小时清一次，删除 24 小时前的旧文件 */
function startMediaCacheCleanup(): void {
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const sweep = () => {
    const n = cleanupMediaCache(MAX_AGE_MS);
    if (n > 0) log("INFO", `媒体缓存已清理 ${n} 个过期文件`);
  };
  sweep();
  setInterval(sweep, 6 * 60 * 60 * 1000).unref();
}

function pushMessage(content: string, messageId?: string, chatId?: string, chatType?: string, senderOpenId?: string, replyMessageId?: string, meta?: QueueMessageMeta): void {
  if (!content?.trim()) {
    log("WARN", `丢弃空消息 (messageId=${messageId})`);
    return;
  }
  let routedId = resolveRoutingKey(chatId, replyMessageId);
  if (routedId && routedId === chatId && chatType === "p2p" && !routedId.includes("::")) {
    const { channelId } = parseChatKey(chatId!);
    const rt = channelId ? channels.get(channelId) : undefined;
    const wsDir = rt ? channelWorkspaceDir(rt) : WORKSPACE_DIR;
    if (wsDir) {
      const defaultSessionKey = `${chatId}::${wsDir}`;
      setActiveSession(chatId!, defaultSessionKey);
      routedId = defaultSessionKey;
    }
  }
  const fullMeta: QueueMessageMeta = { ...(meta || {}) };
  if (chatType) fullMeta.chatType = chatType;
  if (senderOpenId) fullMeta.senderOpenId = senderOpenId;
  const written = pushToFileQueue(content, messageId, `daemon-${process.pid}`, routedId, false, Object.keys(fullMeta).length > 0 ? fullMeta : undefined);
  if (written) {
    if (routedId && fullMeta.chatType) rememberSessionChatType(routedId, fullMeta.chatType);
    log("INFO", `消息已写入共享队列: ${JSON.stringify(content)} (id=${messageId ?? "none"}, chat=${chatId ?? "none"}${routedId !== chatId ? ` → routed=${routedId}` : ""}${replyMessageId ? `, reply=${replyMessageId}` : ""})`);
    broadcastQueueEvent(routedId);
    if (messageId && !messageId.startsWith("internal_") && routedId) {
      if (fullMeta.chatType === "p2p") {
        onMessageEnqueued(routedId, messageId, chatId, fullMeta.chatType, senderOpenId);
      }
      if (shouldSendEnqueueF1(routedId)) {
        confirmEnqueueAndStartProgress(messageId, routedId, chatId).catch((e: unknown) => {
          log("WARN", `入队确认/进度启动失败: ${e instanceof Error ? e.message : e}`);
        });
      } else if (messageId) {
        addReactionToMessages([messageId], routedId, "Get");
        recordGetReactions(routedId, [messageId]);
      }
    }
  } else {
    log("INFO", `消息已跳过（重复或写入失败）: id=${messageId ?? "none"}`);
  }
}

function clearFileQueue(): number {
  const queueDir = getQueueDir();
  if (!queueDir) return 0;
  let count = 0;
  const exts = [".qmsg", ".claimed", ".done", ".tmp"];
  const clearDir = (dir: string) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) {
          clearDir(full);
        } else if (exts.some((ext) => f.endsWith(ext))) {
          try { fs.unlinkSync(full); count++; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  };
  clearDir(queueDir);
  log("INFO", `队列已清空: ${count} 条消息`);
  return count;
}

// ── 飞书 WebSocket 长连接（每通道一条）───────────────────

function isBotMentioned(rt: ChannelRuntime, ev: LarkMessageEvent): boolean {
  if (!rt.botOpenId) return ev.mentions.length > 0;
  return ev.mentions.some((m) => m.id === rt.botOpenId || m.key === "@_all");
}

/**
 * 将 `@_user_N` 占位符还原为可读形式：
 * - @自己 → 删除（与旧行为一致）
 * - @其他人/机器人 → `@名字(open_id=ou_xxx)`，Agent 可直接取 open_id 回 @
 */
function resolveMentionTags(text: string, mentions: LarkMessageEvent["mentions"], selfOpenId?: string): string {
  let out = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const replacement = (selfOpenId && m.id === selfOpenId) || m.key === "@_all"
      ? ""
      : (m.id ? `@${m.name}(open_id=${m.id})` : `@${m.name}`);
    out = out.split(m.key).join(replacement);
  }
  return out.replace(/@_user_\d+/g, "").replace(/\s{2,}/g, " ").trim();
}

/** 同实例其他飞书机器人名册（互相感知，供 Agent 按名字路由协作） */
function buildBotRoster(self: ChannelRuntime): string {
  const peers: string[] = [];
  for (const rt of channels.values()) {
    if (rt.cfg.type !== "feishu" || rt === self || !rt.botOpenId) continue;
    peers.push(`${rt.botName ?? rt.cfg.name}=${rt.botOpenId}`);
  }
  return peers.join(", ");
}

async function startFeishuChannel(rt: ChannelRuntime): Promise<void> {
  const { appId, appSecret } = rt.cfg;
  if (!appId || !appSecret) { log("ERROR", `[${rt.cfg.name}] 飞书凭据未配置`); return; }

  rt.client = createLarkClient(appId, appSecret);
  rt.sender = new LarkSender({
    client: rt.client,
    chatId: rt.cfg.mainUserEnabled ? rt.cfg.mainUserChatId : "",
    messagePrefix: MESSAGE_PREFIX,
    log: (level: string, ...args: unknown[]) => log(level, `[${rt.cfg.name}]`, ...args),
  });

  try {
    const botInfo = await rt.client.request({ method: "GET", url: "/open-apis/bot/v3/info" }) as any;
    rt.botOpenId = botInfo?.bot?.open_id;
    rt.botName = botInfo?.bot?.app_name || rt.cfg.name;
    if (rt.botOpenId) log("INFO", `[${rt.cfg.name}] 机器人 open_id: ${rt.botOpenId} (${rt.botName})`);
    else log("WARN", `[${rt.cfg.name}] 未能获取机器人 open_id，群消息过滤将使用宽松模式`);
  } catch (e: any) {
    log("WARN", `[${rt.cfg.name}] 获取机器人信息失败: ${e?.message ?? e}`);
  }

  const sender = rt.sender;
  sender.startConnection(appId, appSecret, ENCRYPT_KEY, (ev) => {
    rt.feishuConnected = true;
    const { text, messageId, chatId, chatType, messageType, rawContent, senderOpenId, parentId } = ev;
    const chatKey = makeChatKey(rt.cfg.id, chatId);

    if (chatType === "p2p" && chatId) {
      rt.lastP2pChatId = chatId;
      if (rt.bindArmed) {
        completeBind(rt, chatId, messageId);
        return;
      }
      if (!sender.chatId) {
        sender.chatId = chatId;
        log("INFO", `[${rt.cfg.name}] 自动绑定默认 chat_id: ${chatId}`);
      }
    }

    if (chatType === "group" && !isBotMentioned(rt, ev)) {
      return;
    }

    const cleanText = chatType === "group" ? resolveMentionTags(text, ev.mentions, rt.botOpenId) : text;
    log("INFO", `[${rt.cfg.name}] 收到消息 [${chatType}] chat=${chatId} sender=${senderOpenId ?? "?"}${ev.senderType === "app" ? "(bot)" : ""}${parentId ? ` reply=${parentId}` : ""}: ${cleanText.slice(0, 100)}`);

    if (messageType === "text" && isCommand(cleanText)) {
      handleCommand(cleanText, messageId, chatKey, chatType).catch((e: any) =>
        log("ERROR", `指令处理失败: ${e?.message ?? e}`),
      );
      return;
    }

    const enqueue = async (content: string) => {
      // 元数据进独立的 meta 字段，text 只保留纯正文（单一职责，不污染消息内容）
      const meta: QueueMessageMeta = {
        senderType: ev.senderType === "app" ? "bot" : "user",
      };
      if (rt.botOpenId) {
        meta.botOpenId = rt.botOpenId;
        meta.botName = rt.botName ?? rt.cfg.name;
      }
      if (chatType === "group") {
        const roster = buildBotRoster(rt);
        if (roster) meta.botRoster = roster;
      }
      if (parentId) {
        const original = await sender.fetchMessageContent(parentId);
        if (original) meta.quotedContent = original;
      }
      if (messageType === "text") {
        const handled = await tryHandleMergePreviewReply(
          parentId, content, messageId, chatKey, chatType, senderOpenId, meta,
        );
        if (handled) return;
      }
      pushMessage(content, messageId, chatKey, chatType, senderOpenId, parentId, meta);
    };

    if (messageType === "text") {
      enqueue(cleanText);
    } else {
      sender.processIncomingMessage(messageId, messageType, rawContent)
        .then((result) => enqueue(result || cleanText))
        .catch(() => enqueue(cleanText));
    }
  });
  // WSClient.start 为异步建立；这里乐观置位，错误会在日志中体现
  rt.feishuConnected = true;
}

// ── 指令系统 ─────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  "/stop": "停止当前运行中的 Agent",
  "/status": "查看 Agent / Daemon 状态",
  "/list": "查看消息队列列表（不消费）",
  "/task": "定时任务（/task 查看子命令说明；如 /task ls）",
  "/workflow": "工作流管理（/workflow ls | info | run | status | delete）",
  "/wf": "同 /workflow",
  "/model": "Cursor CLI 模型（/model ls | info | set <序号>）",
  "/mcp": "MCP 服务器管理（/mcp ls | info | enable | disable | delete | add）",
  "/workspace": "切换工作目录（/workspace 查看当前 | /workspace set <路径>）",
  "/chat": "会话管理（/chat ls | /chat <序号> | /chat stop <序号> | /chat new <描述> [-dir <路径>]；省略 -dir 用当前主会话目录，无效目录不创建）",
  "/clean": "清空消息队列",
  "/reset": "下次拉起 Agent 时不使用 --continue（新 CLI 会话），不删除本地文件",
  "/restart": "停止 Agent + 清空队列 + 重启 Daemon",
  "/help": "显示可用指令列表",
};

function isCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return Object.keys(COMMANDS).some((cmd) => trimmed === cmd || trimmed.startsWith(cmd + " "));
}

async function replyToMessage(messageId: string, text: string, chatId?: string): Promise<void> {
  const ch = resolveChannel(chatId);
  if (ch.type === "error") { log("WARN", `回复失败: ${ch.message}`); return; }
  if (ch.type === "wechat") {
    try { await ch.rt.wechat!.sendText(ch.chatId, text); } catch (e: any) { log("WARN", `微信回复失败: ${e?.message}`); }
    return;
  }
  if (ch.chatId) {
    await ch.rt.sender!.sendMessage(text, undefined, ch.chatId);
  } else {
    await ch.rt.sender!.replyMessage(messageId, text);
  }
}

// ── 共享指令文件队列（.fcmd）──────────────────────────────

function pushCommandToQueue(command: string, messageId: string, source: string, chatId?: string, chatType?: string): boolean {
  const queueDir = getQueueDir();
  if (!queueDir) return false;
  const ts = Date.now();
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");

  try {
    const existing = fs.readdirSync(queueDir);
    if (existing.some((f) => f.includes(`_${safeId}.fcmd`))) return false;
  } catch { /* ignore */ }

  try {
    const data = JSON.stringify({ command, messageId, timestamp: ts, source, chatId, chatType });
    const filename = `${ts}_${safeId}.fcmd`;
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    log("INFO", `指令已入队: ${command} (msgId=${messageId}, source=${source})`);
    return true;
  } catch { return false; }
}

interface CmdEntry { id: string; command: string; messageId: string; chatId?: string; chatType?: string }

function getPendingCommands(): CmdEntry[] {
  const queueDir = getQueueDir();
  if (!queueDir) return [];
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".fcmd")).sort();
    return files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const p = JSON.parse(raw);
        return { id: f, command: p.command, messageId: p.messageId, chatId: p.chatId, chatType: p.chatType };
      } catch { return null; }
    }).filter(Boolean) as CmdEntry[];
  } catch { return []; }
}

function claimCommand(fileId: string): Omit<CmdEntry, "id"> | null {
  const queueDir = getQueueDir();
  if (!queueDir) return null;
  const srcPath = path.join(queueDir, fileId);
  const claimedPath = srcPath + ".claimed";
  try {
    fs.renameSync(srcPath, claimedPath);
    const raw = fs.readFileSync(claimedPath, "utf-8");
    fs.unlinkSync(claimedPath);
    const p = JSON.parse(raw);
    return { command: p.command, messageId: p.messageId, chatId: p.chatId, chatType: p.chatType };
  } catch { return null; }
}

function cleanExpiredCommands(): void {
  const queueDir = getQueueDir();
  if (!queueDir) return;
  const now = Date.now();
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".fcmd"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (now - (parsed.timestamp ?? 0) > 60_000) {
          fs.unlinkSync(path.join(queueDir, f));
          log("WARN", `指令超时已清除: ${parsed.command} (msgId=${parsed.messageId})`);
          if (parsed.messageId) {
            replyToMessage(parsed.messageId, `⚠️ 指令 ${parsed.command} 执行超时`).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function handleCommand(text: string, messageId: string, chatId?: string, chatType?: string): Promise<void> {
  const trimmed = text.trim();
  pushCommandToQueue(trimmed, messageId, `daemon-${process.pid}`, chatId, chatType);
}

// ── HTTP Server ──────────────────────────────────────────

let daemonPort = 0;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    req.on("end", () => resolve(chunks.join("")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── MCP over StreamableHTTP ─────────────────────────────


function httpJson<T = any>(url: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const isPost = body !== undefined;
    const payload = isPost ? JSON.stringify(body) : undefined;
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: isPost ? "POST" : "GET",
      headers: isPost ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload!) } : undefined,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error(`daemon JSON parse: ${Buffer.concat(chunks).toString().slice(0, 200)}`)); }
      });
    });
    req.on("error", (e) => reject(new Error(`daemon request failed: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("daemon request timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

function localDaemonUrl(p: string): string {
  return `http://127.0.0.1:${daemonPort}${p}`;
}

function createMcpServer(): McpServer {
  const s = new McpServer({ name: "cursor-claw", version: PKG_VERSION, description: "消息桥接 – 通过飞书/微信与用户沟通" });

  s.tool(
    "send_text",
    "发送文本消息到飞书/微信。飞书群聊中可 @ 其他成员或机器人：在 text 中使用 `<at user_id=\"ou_xxx\">名字</at>` 标签（open_id 可从收到消息的 @名字(open_id=ou_xxx) 内联标注或 [可协作机器人] 名册中获取），被 @ 的机器人会收到事件并响应。",
    {
      text: z.string().describe("要发送的消息内容；含 <at user_id=\"ou_xxx\">名字</at> 标签时自动以可触发 @ 通知的文本消息发送"),
      message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
      session_key: z.string().optional().describe("目标会话的 sessionKey，用于精确投递"),
    },
    async ({ text, message_id, session_key }) => {
      try {
        const r = await httpJson<{ ok: boolean }>(localDaemonUrl("/api/send-text"), { text, message_id, session_key });
        if (!r?.ok) {
          log("WARN", `send_text 发送失败: message_id=${message_id}`);
          return { content: [{ type: "text" as const, text: "[send_failed] 消息发送失败" }] };
        }
        return { content: [{ type: "text" as const, text: "消息已发送" }] };
      } catch (e: any) {
        log("ERROR", `send_text 异常: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
      }
    },
  );

  s.tool(
    "send_image",
    "发送本地图片到飞书/微信。image_path 为本地文件绝对路径。",
    {
      image_path: z.string().describe("图片绝对路径"),
      message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
      session_key: z.string().optional().describe("目标会话的 sessionKey，用于精确投递"),
    },
    async ({ image_path, message_id, session_key }) => {
      try {
        await httpJson(localDaemonUrl("/api/send-image"), { image_path, message_id, session_key });
        return { content: [{ type: "text" as const, text: "图片已发送" }] };
      } catch (e: any) {
        log("ERROR", `send_image 异常: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
      }
    },
  );

  s.tool(
    "send_file",
    "发送本地文件到飞书/微信。file_path 为本地文件绝对路径。",
    {
      file_path: z.string().describe("文件绝对路径"),
      message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
      session_key: z.string().optional().describe("目标会话的 sessionKey，用于精确投递"),
    },
    async ({ file_path, message_id, session_key }) => {
      try {
        await httpJson(localDaemonUrl("/api/send-file"), { file_path, message_id, session_key });
        return { content: [{ type: "text" as const, text: "文件已发送" }] };
      } catch (e: any) {
        log("ERROR", `send_file 异常: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
      }
    },
  );

  registerWorkflowAgentTools(s);
  return s;
}

function createAdminMcpServer(): McpServer {
  const s = new McpServer({ name: "cursor-claw-admin", version: PKG_VERSION, description: "cursor-claw 管理工具" });
  registerAdminTools(s);
  registerWorkflowAdminTools(s);
  return s;
}

function startHttpServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const pathname = reqUrl.pathname;
      const method = req.method;

      try {
        if (pathname === "/mcp" || pathname === "/mcp-admin") {
          const isAgent = pathname === "/mcp";
          const srv = isAgent ? createMcpServer() : createAdminMcpServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          if (isAgent) { activeMcpConnections++; lastMcpRequestTime = Date.now(); }
          res.on("close", () => {
            transport.close(); srv.close();
            if (isAgent) activeMcpConnections = Math.max(0, activeMcpConnections - 1);
          });
          await srv.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        if (await handleAdminApi(pathname, method!, req, res)) return;

        if (method === "GET" && (pathname === "/health" || pathname === "/status")) {
          cleanExpiredCommands();
          const channelList = getChannelStatusList();
          const feishuList = channelList.filter((c) => c.type === "feishu");
          const wechatList = channelList.filter((c) => c.type === "wechat");
          json(res, {
            status: "ok",
            version: PKG_VERSION,
            uptime: Math.floor(process.uptime()),
            queueLength: getFileQueueLength(),
            channels: channelList,
            // 兼容字段（聚合视图）
            hasChatId: channelList.some((c) => c.connected),
            feishuEnabled: feishuList.length > 0,
            feishuConnected: feishuList.some((c) => c.connected),
            wechatEnabled: wechatList.length > 0,
            wechatStatus: wechatList.some((c) => c.status === "connected") ? "connected" : (wechatList[0]?.status ?? "disconnected"),
            wechatReady: wechatList.some((c) => c.connected),
          });
          return;
        }

        if (method === "GET" && pathname === "/queue") {
          json(res, { length: getFileQueueLength(), messages: getFileQueueMessages() });
          return;
        }

        if (method === "POST" && pathname === "/queue-delete") {
          const body = JSON.parse(await readBody(req));
          const { fileId } = body as { fileId?: string };
          if (!fileId) { json(res, { ok: false, error: "fileId required" }, 400); return; }
          const ok = deleteFileQueueMessage(fileId);
          json(res, { ok, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "POST" && pathname === "/shutdown") {
          log("INFO", ">>> 收到 shutdown 请求，准备退出");
          json(res, { ok: true });
          setTimeout(() => {
            stopDaemonScheduledTasks();
            removeLockFile();
            process.exit(0);
          }, 200);
          return;
        }

        if (method === "POST" && pathname === "/channel-test") {
          const body = JSON.parse(await readBody(req));
          const channelId = typeof body.channelId === "string" ? body.channelId : "";
          const rt = channels.get(channelId);
          if (!rt) { json(res, { ok: false, error: "通道不存在或未启用" }, 400); return; }
          if (!isChannelConnected(rt)) { json(res, { ok: false, error: "通道未连接" }, 400); return; }
          const chatId = channelDefaultChatId(rt);
          if (!chatId) { json(res, { ok: false, error: "暂无私聊记录，请先绑定主用户或给机器人发一条消息" }, 400); return; }
          try {
            if (rt.cfg.type === "wechat") {
              json(res, { ok: await rt.wechat!.sendText(chatId, "🔗 微信测试成功！连接正常。") });
            } else {
              const msgId = await rt.sender!.sendMessage("🔗 绑定测试成功！连接正常。", undefined, chatId);
              json(res, { ok: !!msgId });
            }
          } catch (e: any) {
            json(res, { ok: false, error: e?.message ?? "发送失败" }, 500);
          }
          return;
        }

        if (method === "POST" && pathname === "/channel-bind") {
          const body = JSON.parse(await readBody(req));
          const channelId = typeof body.channelId === "string" ? body.channelId : "";
          const arm = body.arm !== false;
          const rt = channels.get(channelId);
          if (!rt) { json(res, { ok: false, error: "通道不存在或未启用" }, 400); return; }
          rt.bindArmed = arm;
          log("INFO", `[Bind] 通道「${rt.cfg.name}」绑定模式: ${arm ? "开启（等待私聊消息）" : "取消"}`);
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/enqueue") {
          const body = JSON.parse(await readBody(req));
          const content = typeof body.content === "string" ? body.content : "";
          if (!content) { json(res, { error: "content is required" }, 400); return; }
          const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
          const chatType = typeof body.chatType === "string" ? body.chatType : "p2p";
          const internalMsgId = `internal_enqueue_${Date.now()}`;
          if (chatId) {
            pushMessage(content, internalMsgId, chatId, chatType);
          } else {
            pushMessage(content, internalMsgId);
          }
          json(res, { ok: true, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "POST" && pathname === "/clear-queue") {
          json(res, { ok: true, cleared: clearFileQueue() });
          return;
        }

        if (method === "POST" && pathname === "/dequeue-all") {
          const body = await readBody(req).catch(() => "{}");
          const parsed = JSON.parse(body || "{}") as { sessionKey?: string; chatId?: string };
          const filterSession = parsed.sessionKey || parsed.chatId;
          if (!filterSession) {
            json(res, { ok: false, error: "sessionKey is required" }, 400);
            return;
          }
          const messages: QueueMessage[] = [];
          let m: ReturnType<typeof claimNextMessage>;
          while ((m = claimNextMessage(filterSession)) !== null) {
            if (m.messageId) trackMessageSession(m.messageId, filterSession);
            messages.push(m);
          }
          if (messages.length > 0) log("INFO", `dequeue-all 已领取 ${messages.length} 条: session=${filterSession}`);
          json(res, { ok: true, messages, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "GET" && pathname === "/queue-chat-ids") {
          json(res, { chats: getDistinctSessions() });
          return;
        }

        if (method === "GET" && pathname === "/commands") {
          json(res, { commands: getPendingCommands() });
          return;
        }

        if (method === "POST" && pathname === "/commands/claim") {
          const body = JSON.parse(await readBody(req));
          const result = claimCommand(body.id);
          json(res, result ? { ok: true, ...result } : { ok: false, error: "not found" });
          return;
        }

        if (method === "POST" && pathname === "/cmd/result") {
          const body = JSON.parse(await readBody(req)) as { messageId: string; ok: boolean; message: string; chatId?: string };
          log("INFO", `指令执行完成: ok=${body.ok}, msgId=${body.messageId}, chatId=${body.chatId ?? "N/A"}`);
          if (body.messageId) await replyToMessage(body.messageId, body.message, body.chatId);
          json(res, { ok: true });
          return;
        }

        json(res, { error: "not found" }, 404);
      } catch (e: any) {
        log("ERROR", `HTTP 错误: ${pathname} ${e?.message ?? e}`);
        json(res, { error: e?.message ?? "internal error" }, 500);
      }
    });

    server.requestTimeout = 300_000;

    const tryListen = (port: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (port > 0 && err.code === "EADDRINUSE") {
          log("WARN", `端口 ${port} 被占用，回退到随机端口`);
          server.removeAllListeners("error");
          tryListen(0);
          return;
        }
        log("ERROR", `HTTP Server 错误: ${err.message}`);
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        log("INFO", `HTTP Server 监听: http://127.0.0.1:${addr.port}`);
        resolve(addr.port);
      });
    };
    tryListen(CONFIGURED_PORT);
  });
}

// ── 管理 API 辅助函数 ────────────────────────────────────

const HOME_DIR = os.homedir();
const GLOBAL_MCP_PATH = path.join(HOME_DIR, ".cursor", "mcp.json");
const SKILLS_DIR = path.join(HOME_DIR, ".cursor", "skills");
const TASKS_FILE = path.join(APP_DATA_DIR, "scheduled-tasks.json");

function getProjectMcpPath(): string {
  return path.join(WORKSPACE_DIR, ".cursor", "mcp.json");
}
function getRulesDir(): string {
  return path.join(WORKSPACE_DIR, ".cursor", "rules");
}

function readJsonSafe(filePath: string): any {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch { /* ignore */ }
  return null;
}

function writeJsonSafe(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

interface TaskEntry {
  id: string; name: string; cron: string; content: string; enabled: boolean; independent?: boolean
  channelId?: string; model?: string; modelParams?: string
}

function readTasks(): TaskEntry[] {
  const data = readJsonSafe(TASKS_FILE);
  return Array.isArray(data) ? data : [];
}

function writeTasks(tasks: TaskEntry[]): void {
  writeJsonSafe(TASKS_FILE, tasks);
}

// ── CRUD 子路由 ──────────────────────────────────────────

async function handleMcpAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    const globalCfg = readJsonSafe(GLOBAL_MCP_PATH);
    const projectCfg = readJsonSafe(getProjectMcpPath());
    const servers: Record<string, { config: unknown; scope: string }> = {};
    if (globalCfg?.mcpServers) {
      for (const [k, v] of Object.entries(globalCfg.mcpServers)) servers[k] = { config: v, scope: "global" };
    }
    if (projectCfg?.mcpServers) {
      for (const [k, v] of Object.entries(projectCfg.mcpServers)) servers[k] = { config: v, scope: "project" };
    }
    json(res, { ok: true, servers });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, name, config, scope } = body as { action: string; name?: string; config?: string; scope?: string };
    const targetPath = (scope ?? "global") === "project" ? getProjectMcpPath() : GLOBAL_MCP_PATH;

    if (action === "add") {
      if (!name || !config) { json(res, { ok: false, error: "name and config required" }, 400); return true; }
      let parsed: unknown;
      try { parsed = JSON.parse(config); } catch { json(res, { ok: false, error: "invalid config JSON" }, 400); return true; }
      const mcpJson = readJsonSafe(targetPath) ?? {};
      if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
      mcpJson.mcpServers[name] = parsed;
      writeJsonSafe(targetPath, mcpJson);
      json(res, { ok: true, message: `${name} saved` });
      return true;
    }
    if (action === "delete") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      for (const p of [GLOBAL_MCP_PATH, getProjectMcpPath()]) {
        const mcpJson = readJsonSafe(p);
        if (mcpJson?.mcpServers?.[name]) {
          delete mcpJson.mcpServers[name];
          writeJsonSafe(p, mcpJson);
          json(res, { ok: true, message: `${name} deleted` });
          return true;
        }
      }
      json(res, { ok: false, error: "not found" }, 404);
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

async function handleRulesAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    if (!fs.existsSync(getRulesDir())) { json(res, { ok: true, rules: [] }); return true; }
    const files = fs.readdirSync(getRulesDir()).filter((f) => f.endsWith(".mdc") || f.endsWith(".md"));
    json(res, { ok: true, rules: files });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, name, content } = body as { action: string; name?: string; content?: string };

    if (action === "read") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const fp = path.join(getRulesDir(), name);
      if (!fs.existsSync(fp)) { json(res, { ok: false, error: "not found" }, 404); return true; }
      json(res, { ok: true, content: fs.readFileSync(fp, "utf-8") });
      return true;
    }
    if (action === "save") {
      if (!name || content === undefined) { json(res, { ok: false, error: "name and content required" }, 400); return true; }
      let fileName = name.trim();
      if (!fileName.endsWith(".mdc") && !fileName.endsWith(".md")) fileName += ".mdc";
      if (!fs.existsSync(getRulesDir())) fs.mkdirSync(getRulesDir(), { recursive: true });
      fs.writeFileSync(path.join(getRulesDir(), fileName), content, "utf-8");
      json(res, { ok: true, message: `${fileName} saved` });
      return true;
    }
    if (action === "delete") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const fp = path.join(getRulesDir(), name);
      if (!fs.existsSync(fp)) { json(res, { ok: false, error: "not found" }, 404); return true; }
      fs.unlinkSync(fp);
      json(res, { ok: true, message: `${name} deleted` });
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

async function handleSkillsAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    if (!fs.existsSync(SKILLS_DIR)) { json(res, { ok: true, skills: [] }); return true; }
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    const skills = dirs.map((d) => {
      const skillFile = path.join(SKILLS_DIR, d.name, "SKILL.md");
      const preview = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf-8").split("\n")[0].slice(0, 80) : "";
      return { name: d.name, preview };
    });
    json(res, { ok: true, skills });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, name, content } = body as { action: string; name?: string; content?: string };

    if (action === "read") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const fp = path.join(SKILLS_DIR, name, "SKILL.md");
      if (!fs.existsSync(fp)) { json(res, { ok: false, error: "not found" }, 404); return true; }
      json(res, { ok: true, content: fs.readFileSync(fp, "utf-8") });
      return true;
    }
    if (action === "save") {
      if (!name || content === undefined) { json(res, { ok: false, error: "name and content required" }, 400); return true; }
      const dir = path.join(SKILLS_DIR, name.trim());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
      json(res, { ok: true, message: `${name} saved` });
      return true;
    }
    if (action === "delete") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const dir = path.join(SKILLS_DIR, name);
      if (!fs.existsSync(dir)) { json(res, { ok: false, error: "not found" }, 404); return true; }
      fs.rmSync(dir, { recursive: true, force: true });
      json(res, { ok: true, message: `${name} deleted` });
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

async function handleTasksAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    json(res, { ok: true, tasks: readTasks() });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, id, name, cron, content, enabled, independent, channelId, model, modelParams } = body as {
      action: string; id?: string; name?: string; cron?: string; content?: string; enabled?: boolean; independent?: boolean
      channelId?: string; model?: string; modelParams?: string
    };
    const tasks = readTasks();

    if (action === "add") {
      if (!name || !cron || !content) { json(res, { ok: false, error: "name, cron, content required" }, 400); return true; }
      const newTask: TaskEntry = {
        id: crypto.randomUUID(), name: name.trim(), cron: cron.trim(), content,
        enabled: enabled ?? true, independent: independent ?? true,
        channelId: channelId || channels.keys().next().value, model, modelParams,
      };
      tasks.push(newTask);
      writeTasks(tasks);
      json(res, { ok: true, task: newTask });
      return true;
    }
    if (!id) { json(res, { ok: false, error: "id required" }, 400); return true; }
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) { json(res, { ok: false, error: "task not found" }, 404); return true; }

    if (action === "update") {
      if (name !== undefined) tasks[idx].name = name.trim();
      if (cron !== undefined) tasks[idx].cron = cron.trim();
      if (content !== undefined) tasks[idx].content = content;
      if (enabled !== undefined) tasks[idx].enabled = enabled;
      if (independent !== undefined) tasks[idx].independent = independent;
      if (channelId !== undefined) tasks[idx].channelId = channelId;
      if (model !== undefined) tasks[idx].model = model;
      if (modelParams !== undefined) tasks[idx].modelParams = modelParams;
      writeTasks(tasks);
      json(res, { ok: true, task: tasks[idx] });
      return true;
    }
    if (action === "delete") {
      const removed = tasks.splice(idx, 1)[0];
      writeTasks(tasks);
      json(res, { ok: true, removed });
      return true;
    }
    if (action === "toggle") {
      tasks[idx].enabled = !tasks[idx].enabled;
      writeTasks(tasks);
      json(res, { ok: true, task: tasks[idx] });
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

// ── 管理 API 路由分发 ────────────────────────────────────

type RouteHandler = (method: string, req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

const ADMIN_CRUD_ROUTES: Record<string, RouteHandler> = {
  "/api/mcp": handleMcpAdmin,
  "/api/rules": handleRulesAdmin,
  "/api/skills": handleSkillsAdmin,
  "/api/tasks": handleTasksAdmin,
};

async function handleWorkspaceAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    json(res, { ok: true, workspaceDir: WORKSPACE_DIR });
    return true;
  }
  if (method === "PUT" || method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { dir } = body as { dir?: string };
    if (!dir?.trim()) { json(res, { ok: false, error: "dir is required" }, 400); return true; }
    const newDir = dir.trim();
    if (!fs.existsSync(newDir)) { json(res, { ok: false, error: "directory does not exist" }, 400); return true; }
    const oldDir = WORKSPACE_DIR;
    WORKSPACE_DIR = newDir;
    if (oldDir !== newDir) {
      for (const [chatId, oldSessionKey] of activeSessionMap) {
        if (oldSessionKey.endsWith(`::${oldDir}`)) {
          const newSessionKey = `${chatId}::${newDir}`;
          activeSessionMap.set(chatId, newSessionKey);
          sessionToChatMap.delete(oldSessionKey);
          sessionToChatMap.set(newSessionKey, chatId);
          log("INFO", `[Workspace] 会话路由迁移: ${oldSessionKey} → ${newSessionKey}`);
        }
      }
    }
    log("INFO", `[Workspace] hot-updated: ${oldDir} -> ${newDir}`);
    process.stdout.write(`__WORKSPACE_SWITCH__:${JSON.stringify({ dir: newDir })}\n`);
    json(res, { ok: true, message: `工作目录已切换`, dir: newDir, oldDir });
    return true;
  }
  return false;
}

async function handleAgentAdmin(_method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (_method !== "POST") return false;
  const body = JSON.parse(await readBody(req));
  const { action } = body as { action: string };
  const supportedActions = ["stop", "restart", "reset", "clean", "launch"];

  if (action === "launch") {
    const { message, chatId } = body as { message?: string; chatId?: string };
    if (!message?.trim()) { json(res, { ok: false, error: "message is required" }, 400); return true; }
    const taskId = `temp-${Date.now()}`;
    const payload = JSON.stringify({ taskId, taskName: "临时会话", content: message.trim(), chatType: "temp", chatId });
    process.stdout.write(`__IND_LAUNCH__:${payload}\n`);
    json(res, { ok: true, taskId, message: "临时 Agent 已启动" });
    return true;
  }
  if (action === "clean") {
    const cleared = clearFileQueue();
    json(res, { ok: true, cleared });
    return true;
  }
  if (supportedActions.includes(action)) {
    const msgId = `api-${Date.now()}`;
    pushCommandToQueue(`/${action}`, msgId, `mcp-api`);
    json(res, { ok: true, message: `/${action} command queued` });
    return true;
  }
  json(res, { ok: false, error: `unknown action, supported: ${supportedActions.join(", ")}` }, 400);
  return true;
}

const ADMIN_ENTITY_ROUTES: Record<string, RouteHandler> = {
  "/api/workspace": handleWorkspaceAdmin,
  "/api/agent": handleAgentAdmin,
};

async function handleAdminApi(pathname: string, method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  if (method === "GET" && pathname === "/api/status") {
    const tasks = readTasks();
    const recentlyActive = lastMcpRequestTime > 0 && (Date.now() - lastMcpRequestTime) < 120_000;
    const channelList = getChannelStatusList();
    json(res, {
      daemon: {
        running: true, version: PKG_VERSION, uptime: Math.floor(process.uptime()), port: daemonPort,
        agentRunning: activeMcpConnections > 0 || recentlyActive,
        sessionAgentCount: activeMcpConnections,
      },
      queue: { length: getFileQueueLength() },
      tasks: { total: tasks.length, enabled: tasks.filter((t) => t.enabled).length },
      channels: channelList,
      feishu: { connected: channelList.some((c) => c.type === "feishu" && c.connected), hasChatId: channelList.some((c) => c.type === "feishu" && c.mainUserBound) },
      wechat: { enabled: channelList.some((c) => c.type === "wechat"), status: channelList.some((c) => c.type === "wechat" && c.status === "connected") ? "connected" : "disconnected" },
    });
    return true;
  }

  const crudHandler = ADMIN_CRUD_ROUTES[pathname];
  if (crudHandler) return crudHandler(method, req, res);

  // ── 消息发送 API ──
  if (method === "POST" && pathname === "/api/session-agent-phase") {
    try {
      const body = JSON.parse(await readBody(req));
      const { session_key, phase } = body as { session_key?: string; phase?: AgentPhase };
      if (!session_key?.trim()) {
        json(res, { ok: false, error: "session_key is required" }, 400);
        return true;
      }
      if (phase !== "starting" && phase !== "processing" && phase !== "idle") {
        json(res, { ok: false, error: "invalid phase" }, 400);
        return true;
      }
      if (phase === "idle") {
        sessionAgentPhaseMap.delete(session_key);
        const batch = mergeBatchBySession.get(session_key);
        if (batch && !isTerminalMergePhase(batch.phase)) {
          renderMergeBatchCardForSession(batch).catch((e: unknown) => {
            log("WARN", `idle 后合并卡刷新失败: ${e instanceof Error ? e.message : e}`);
          });
        }
        void flushReadyMergeBatches(session_key);
        // processing 期间入队的消息当时无法 claim；idle 后须重调度（含单条 unclaimed，非仅 merge ready）
        scheduleAgentDispatch(session_key);
      } else {
        sessionAgentPhaseMap.set(session_key, phase);
        const batch = mergeBatchBySession.get(session_key);
        if (batch?.phase === "ready" && !isTerminalMergePhase(batch.phase)) {
          renderMergeBatchCardForSession(batch).catch((e: unknown) => {
            log("WARN", `phase 变更后合并卡刷新失败: ${e instanceof Error ? e.message : e}`);
          });
        }
      }
      json(res, { ok: true });
    } catch (e: unknown) {
      json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/merge-batch/action") {
    try {
      const body = JSON.parse(await readBody(req)) as { session_key?: string; action?: string; text?: string };
      const sessionKey = body.session_key?.trim();
      const action = body.action?.trim();
      if (!sessionKey) {
        json(res, { ok: false, error: "session_key is required" }, 400);
        return true;
      }
      if (!action) {
        json(res, { ok: false, error: "action is required" }, 400);
        return true;
      }
      const result = await handleMergeBatchAction(sessionKey, action, body.text);
      json(res, result, result.ok ? 200 : 400);
    } catch (e: unknown) {
      json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/orchestrator/claim-and-merge") {
    try {
      const body = JSON.parse(await readBody(req)) as { session_key?: string };
      const sessionKey = body.session_key?.trim();
      if (!sessionKey) {
        json(res, { ok: false, error: "session_key is required" }, 400);
        return true;
      }
      const result = performClaimAndMerge(sessionKey);
      if (!result.ok) {
        json(res, { ok: false, error: result.error }, 400);
        return true;
      }
      json(res, { text: result.text, message_ids: result.message_ids });
    } catch (e: unknown) {
      json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/send-text") {
    const body = JSON.parse(await readBody(req));
    const { text, message_id, session_key, stop_progress } = body as {
      text: string; message_id?: string; session_key?: string; stop_progress?: boolean;
    };
    if (!text) { json(res, { ok: false, error: "text is required" }, 400); return true; }

    const ch = resolveChannel(session_key);
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    let sendOk = false;
    if (ch.type === "wechat") {
      sendOk = await ch.rt.wechat!.sendText(ch.chatId, text);
      json(res, { ok: sendOk });
    } else {
      const sender = ch.rt.sender!;
      const title = extractWorkspaceTitle(session_key);
      let sentMsgId: string | undefined;
      if (message_id) {
        sentMsgId = await sender.sendMessage(text, message_id, undefined, title);
        if (!sentMsgId) {
          log("INFO", `回复退避: message_id=${message_id} → ${ch.chatId ? `chat_id=${ch.chatId}` : "默认发送"}`);
          sentMsgId = await sender.sendMessage(text, undefined, ch.chatId, title);
        }
      } else {
        sentMsgId = await sender.sendMessage(text, undefined, ch.chatId, title);
      }
      if (sentMsgId && session_key) trackMessageSession(sentMsgId, session_key);
      sendOk = !!sentMsgId;
      json(res, { ok: sendOk, message_id: sentMsgId });
    }
    if (sendOk) {
      if (session_key) sessionLastReplyAt.set(session_key, Date.now());
      ackOnReply(message_id, session_key);
      if (stop_progress && session_key) stopSessionProgress(session_key);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/presentation-event") {
    try {
      const body = JSON.parse(await readBody(req)) as PresentationEvent;
      const result = await handlePresentationEvent(body);
      if (!result.ok && result.error === "session_key is required") {
        json(res, result, 400);
      } else {
        json(res, result);
      }
    } catch (e: unknown) {
      json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/stream-text") {
    const body = JSON.parse(await readBody(req));
    const result = await handleStreamText(body as {
      session_key?: string;
      text?: string;
      stream_id?: string;
      outbound_message_id?: string;
      message_id?: string;
      final?: boolean;
    });
    if (!result.ok && result.error === "session_key and text are required") {
      json(res, result, 400);
    } else {
      json(res, result);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/send-image") {
    const body = JSON.parse(await readBody(req));
    const { image_path, message_id, session_key } = body as { image_path: string; message_id?: string; session_key?: string };
    if (!image_path) { json(res, { ok: false, error: "image_path is required" }, 400); return true; }
    const ch = resolveChannel(session_key);
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    if (ch.type === "wechat") {
      await ch.rt.wechat!.sendMedia(ch.chatId, image_path);
    } else {
      await ch.rt.sender!.sendImage(image_path, message_id, ch.chatId);
    }
    json(res, { ok: true });
    if (session_key) {
      sessionLastReplyAt.set(session_key, Date.now());
      ackOnReply(message_id, session_key);
      stopSessionProgress(session_key);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/send-file") {
    const body = JSON.parse(await readBody(req));
    const { file_path, message_id, session_key } = body as { file_path: string; message_id?: string; session_key?: string };
    if (!file_path) { json(res, { ok: false, error: "file_path is required" }, 400); return true; }
    const ch = resolveChannel(session_key);
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    if (ch.type === "wechat") {
      await ch.rt.wechat!.sendMedia(ch.chatId, file_path);
    } else {
      await ch.rt.sender!.sendFile(file_path, message_id, ch.chatId);
    }
    json(res, { ok: true });
    if (session_key) {
      sessionLastReplyAt.set(session_key, Date.now());
      ackOnReply(message_id, session_key);
      stopSessionProgress(session_key);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/session-last-reply") {
    const sk = new URL(req.url ?? "", "http://localhost").searchParams.get("sessionKey") || "";
    json(res, { lastReplyAt: sk ? (sessionLastReplyAt.get(sk) ?? null) : null });
    return true;
  }

  if (method === "GET" && pathname === "/api/session-earliest-msg") {
    const sk = new URL(req.url ?? "", "http://localhost").searchParams.get("sessionKey") || "";
    json(res, { earliestMsgTime: sk ? getEarliestMessageTime(sk) : null });
    return true;
  }

  if (method === "POST" && pathname === "/api/active-session") {
    const body = await readBody(req);
    const { chatId, sessionKey } = JSON.parse(body);
    if (chatId && sessionKey) {
      setActiveSession(chatId, sessionKey);
      json(res, { ok: true });
    } else {
      json(res, { ok: false, error: "chatId and sessionKey required" }, 400);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/active-sessions") {
    const entries: Record<string, string> = {};
    for (const [k, v] of activeSessionMap) entries[k] = v;
    json(res, { sessions: entries });
    return true;
  }

  if (method === "DELETE" && pathname === "/api/active-session") {
    const qs = new URL(req.url ?? "", "http://localhost").searchParams;
    const chatId = qs.get("chatId");
    if (chatId) activeSessionMap.delete(chatId);
    json(res, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/launch") {
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const result = await forwardElectronAgentApi("/api/agent/launch", body);
      json(res, result, result.ok ? 200 : 400);
    } catch (e: unknown) {
      json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/dispatch") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        session_key?: string; task_text?: string; message_ids?: string[];
      };
      const session_key = body.session_key?.trim();
      const task_text = body.task_text ?? "";
      if (!session_key) {
        json(res, { ok: false, error: "session_key is required" }, 400);
        return true;
      }
      const result = await forwardElectronAgentApi("/api/agent/dispatch", {
        session_key,
        task_text,
        ...(Array.isArray(body.message_ids) && body.message_ids.length > 0 && { message_ids: body.message_ids }),
      });
      if (!result.ok) {
        log("WARN", `dispatch_failed: session=${session_key} error=${result.error ?? "unknown"}`);
        const busyDelay = parseBusyRetryDelayMs(result.error);
        if (busyDelay > 0) scheduleBusyRetry(session_key, busyDelay);
      }
      json(res, result, result.ok ? 200 : 400);
    } catch (e: unknown) {
      json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/poll-message") {
    json(res, { error: "not found" }, 404);
    return true;
  }

  // ── SSE 队列事件流 ──
  if (pathname === "/api/queue-events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", ts: Date.now() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => { sseClients.delete(res); });
    return true;
  }

  // ── Chat 名称查询（按 chatKey 路由到对应通道）──
  if (pathname === "/api/chat-names" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const chatIds = Array.isArray(body.chatIds) ? body.chatIds as string[] : [];
    const names: Record<string, string> = {};
    for (const cid of chatIds) {
      const { channelId, chatId } = parseChatKey(cid);
      const rt = channelId ? channels.get(channelId) : [...channels.values()].find((c) => c.cfg.type === "feishu" && c.client);
      const client = rt?.client;
      if (!client) continue;
      try {
        const r: any = await client.im.chat.get({ path: { chat_id: chatId } });
        const name = r?.data?.name || r?.data?.chat?.name;
        if (name) names[cid] = name;
      } catch { /* ignore */ }
    }
    json(res, { ok: true, names });
    return true;
  }

  // ── 用户名查询（通过 open_id 获取用户名）──
  if (pathname === "/api/user-names" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const openIds = Array.isArray(body.openIds) ? body.openIds as string[] : [];
    const clients = [...channels.values()].filter((c) => c.cfg.type === "feishu" && c.client).map((c) => c.client!);
    if (clients.length === 0) { json(res, { ok: false, error: "飞书未启用" }, 400); return true; }
    const names: Record<string, string> = {};
    for (const oid of openIds) {
      for (const client of clients) {
        try {
          const r: any = await client.contact.user.get({
            path: { user_id: oid },
            params: { user_id_type: "open_id" },
          });
          const name = r?.data?.user?.name;
          if (name) { names[oid] = name; break; }
        } catch { /* ignore */ }
      }
    }
    json(res, { ok: true, names });
    return true;
  }

  const crudHandler2 = ADMIN_ENTITY_ROUTES[pathname];
  if (crudHandler2) return crudHandler2(method, req, res);

  return false;
}

// ── Lock 文件 ────────────────────────────────────────────

function getLockFilePath(): string {
  return path.join(APP_DATA_DIR, LOCK_FILE_NAME);
}

function writeLockFile(port: number): void {
  const lockPath = getLockFilePath();
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, port, version: PKG_VERSION,
    startedAt: localTimestamp(), workspaceDir: WORKSPACE_DIR,
  }));
}

function removeLockFile(): void {
  try {
    const lockPath = getLockFilePath();
    if (fs.existsSync(lockPath)) { fs.unlinkSync(lockPath); }
  } catch { /* ignore */ }
}

// ── 主函数 ───────────────────────────────────────────────

export async function daemonMain(): Promise<void> {
  if (CHANNEL_CONFIGS.length === 0) {
    log("ERROR", "未配置任何消息通道，至少需要启用一个（CLAW_CHANNELS_JSON 为空）");
    process.exit(1);
  }

  log("INFO", `Daemon v${PKG_VERSION} 启动`);
  log("INFO", `workspace: ${WORKSPACE_DIR}`);
  log("INFO", `通道(${CHANNEL_CONFIGS.length}): ${CHANNEL_CONFIGS.map((c) => `${c.name}[${c.type}]`).join(" + ")}`);
  log("INFO", `日志文件: ${LOG_FILE_PATH}`);

  const cleanup = () => {
    stopDaemonScheduledTasks();
    removeLockFile();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", removeLockFile);

  // 全局兜底：消息桥接守护进程，掉线比带病更糟——漏网异步异常只记录不退出，避免飞书/微信整体掉线
  process.on("uncaughtException", (e) => {
    log("ERROR", `未捕获异常: ${e?.stack ?? e}`);
  });
  process.on("unhandledRejection", (reason) => {
    log("ERROR", `未处理的 Promise 拒绝: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });

  initQueue();
  startMediaCacheCleanup();

  // 超时兜底：Agent 崩溃不再 poll 时，超过 10 分钟的 pendingDone 自动打出
  setInterval(() => {
    const now = Date.now();
    for (const [sk, map] of pendingDoneReactions) {
      const expired = [...map.entries()].filter(([, t]) => now - t > PENDING_DONE_TIMEOUT_MS);
      if (expired.length === 0) continue;
      for (const [mid] of expired) map.delete(mid);
      addReactionToMessages(expired.map(([mid]) => mid), sk, "DONE");
      log("INFO", `超时自动打 DONE 表情: ${expired.length} 条, session=${sk}`);
      if (map.size === 0) pendingDoneReactions.delete(sk);
    }
  }, 60_000).unref();

  for (const cfg of CHANNEL_CONFIGS) {
    const rt: ChannelRuntime = { cfg, lastP2pChatId: null, bindArmed: false };
    channels.set(cfg.id, rt);
    if (cfg.type === "feishu") {
      startFeishuChannel(rt).catch((e: any) => {
        log("ERROR", `[${cfg.name}] 飞书通道启动失败: ${e?.message ?? e}`);
      });
    } else {
      loadWechatState(rt);
      rt.wechat = initWeChatChannel(rt);
      rt.wechat.start(cfg.wechatToken, cfg.wechatAccountId).catch((e: any) => {
        log("WARN", `[WeChat:${cfg.name}] 启动失败: ${e?.message ?? e}`);
      });
    }
  }

  daemonPort = await startHttpServer();
  process.env.LARK_DAEMON_PORT = String(daemonPort);
  writeLockFile(daemonPort);
  log("INFO", "MCP 服务已就绪 (/mcp + /mcp-admin)");

  setDaemonSchedulerLogger((msg) => { log("INFO", msg); });
  startDaemonScheduledTasks(
    (task, content) => {
      const rt = pickChannel(task.channelId);
      const target = rt ? channelDefaultChatId(rt) : null;
      if (rt && target) {
        pushMessage(content, `internal_${task.id}_${Date.now()}`, makeChatKey(rt.cfg.id, target), "p2p");
      } else {
        log("WARN", `定时任务「${task.name}」消息无法入队: 通道无主用户且无私聊记录`);
      }
    },
    (task, content) => {
      const rt = pickChannel(task.channelId);
      const target = rt ? channelDefaultChatId(rt) : null;
      const notifyChatKey = rt && target ? makeChatKey(rt.cfg.id, target) : undefined;
      // 任务会话 → 通知目标映射，供 send_text(session_key=taskId) 精确回投
      if (notifyChatKey) sessionToChatMap.set(task.id, notifyChatKey);
      const payload = JSON.stringify({
        taskId: task.id, taskName: task.name, content,
        channelId: rt?.cfg.id, model: task.model, modelParams: task.modelParams,
      });
      process.stdout.write(`__IND_LAUNCH__:${payload}\n`);
    },
  );

  log("INFO", `Daemon 就绪 ✓ port=${daemonPort}`);
}

