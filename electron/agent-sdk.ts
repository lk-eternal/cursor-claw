import { Agent, type SDKAgent, type Run, type SDKMessage } from "@cursor/sdk"
import { app } from "electron"
import { resolve, join, dirname } from "node:path"
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import { type ChatType, type LaunchMeta, buildPrompt, resolveSessionChatName } from "./agent-launcher"
import { getAgentResource, resolveChannelForSession } from "./config-store"
import { readLockFile, httpPost } from "./daemon-client"
import {
  initSessionModelStore,
  resolveModelForSession,
  setSessionOverride,
  pushRecentModel,
} from "../src/shared/session-model-store.js"
import { modelSlugFromParams, rememberModelLabel } from "../src/shared/model-utils.js"
import { projectIdFromSessionKey } from "../src/shared/project-types.js"

interface StreamToolEntry {
  callId: string
  name: string
  status: "running" | "completed" | "error"
  summary: string
  startedAt?: number
  ms?: number
}

type StreamSegment =
  | { type: "thinking"; text: string; startedAt?: number; ms?: number }
  | { type: "tools"; tools: StreamToolEntry[] }
  | { type: "reply"; text: string }


/** 飞书 CardKit 时间线聚合（按执行顺序交错；MCP send_* 不进卡） */
interface StreamAgg {
  segments: StreamSegment[]
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  ensured: boolean
  lastFlushAt: number
  /** 串行化 ensure/update/finish，避免乱序 */
  inflight: Promise<void>
  finished: boolean
  /** false：未过首轮 poll 前不发流式卡（避免非阻塞预热单独建卡） */
  gateOpen: boolean
  /** 正在跑 wait=false，结束后清空预热片段 */
  pendingNonBlockingPoll: boolean
  /** 断线挂起：不 finish 收口，Resume 后继续同一张卡 */
  suspended: boolean
}

interface SdkSessionAgent {
  sessionKey: string
  agent: SDKAgent
  /** 当前活跃 run；null 仅出现在 send 前的短暂窗口（run 结束即整体释放） */
  run: Run | null
  agentId: string
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  workspaceDir?: string
  senderOpenId?: string
  chatName?: string
  abortController: AbortController
  /** 通道开关：是否保留会话上下文（run 结束后记录 agentId，新消息 Resume 续上） */
  keepSession: boolean
  /** 通道开关：是否长连接（无限 poll 保活）；false = 回答完即收回合，按需唤醒 */
  persistentPoll: boolean
  /** 实际使用的模型 id（空/"auto" 时已解析为默认 composer-2） */
  model: string
  /** 模型参数 JSON（与启动时一致，供 UI 展示 slug） */
  modelParams?: string
  /** 流式日志聚合缓冲：连续同类型(thinking/text)增量合并成一条打印 */
  logAgg: { kind: "thinking" | "text" | null; buf: string }
  /** 飞书流式进度卡；非飞书通道为 null */
  streamAgg: StreamAgg | null
  /** poll 已见用户消息 id：区分新一批与处理中重投 */
  seenPollMessageIds: Set<string>
  /** 最近一次终态状态事件（ERROR/EXPIRED/CANCELLED），用于结束时还原真实错误原因 */
  lastStatus?: { status: string; message?: string }
}

const sdkSessions = new Map<string, SdkSessionAgent>()
const pendingLaunches = new Set<string>()
/** /reset 代数：拉起过程中被重置的会话丢弃本次拉起，防止 rememberResumable 把旧上下文写回 */
const sessionResetGen = new Map<string, number>()

// ── 会话上下文恢复（Resume）──────────────────────────────
// 不保留闲置 agent 进程：闲置连接会被代理/NAT 静默掐死，复用必报 SSL WRONG_VERSION_NUMBER。
// run 结束即释放进程，仅持久化 sessionKey→agentId 映射；新消息 Agent.resume 恢复——
// 全新连接 + 历史上下文完整保留，应用重启后同样有效。
interface ResumeEntry { agentId: string; workspaceDir: string; updatedAt: number; senderOpenId?: string; rulesHash?: string }

/** 工作区 rules 目录内容 hash：Resume 会话的规则是创建时的快照，靠它感知规则更新 */
function computeRulesHash(workspaceDir: string): string {
  try {
    const rulesDir = join(workspaceDir, ".cursor", "rules")
    if (!existsSync(rulesDir)) return ""
    const h = createHash("md5")
    for (const f of readdirSync(rulesDir).filter((n) => n.endsWith(".mdc")).sort()) {
      h.update(f)
      try { h.update(readFileSync(join(rulesDir, f))) } catch { /* ignore */ }
    }
    return h.digest("hex").slice(0, 16)
  } catch {
    return ""
  }
}

const RESUME_ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000
let resumableAgents: Map<string, ResumeEntry> | null = null

function resumeStorePath(): string {
  return join(app.getPath("userData"), "sdk-resume-map.json")
}

function ensureModelStore(): void {
  try { initSessionModelStore(app.getPath("userData")) } catch { /* tests / early */ }
}

function getResumableMap(): Map<string, ResumeEntry> {
  if (resumableAgents) return resumableAgents
  resumableAgents = new Map()
  try {
    const raw = JSON.parse(readFileSync(resumeStorePath(), "utf8")) as Record<string, ResumeEntry>
    const now = Date.now()
    for (const [key, e] of Object.entries(raw)) {
      if (e?.agentId && e.workspaceDir && now - (e.updatedAt ?? 0) < RESUME_ENTRY_TTL_MS) {
        resumableAgents.set(key, e)
      }
    }
  } catch { /* 首次运行或文件损坏：从空开始 */ }
  return resumableAgents
}

function saveResumableMap(): void {
  if (!resumableAgents) return
  try {
    writeFileSync(resumeStorePath(), JSON.stringify(Object.fromEntries(resumableAgents)), "utf8")
  } catch (e: unknown) {
    pushUiLog("SDK", "WARN", `Resume 映射保存失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function isResumeEligible(session: SdkSessionAgent): boolean {
  return session.keepSession
    && (session.chatType === "p2p" || session.chatType === "group" || session.chatType === "project")
}

function rememberResumable(session: SdkSessionAgent): void {
  if (!isResumeEligible(session) || !session.workspaceDir) return
  getResumableMap().set(session.sessionKey, {
    agentId: session.agentId, workspaceDir: session.workspaceDir, updatedAt: Date.now(),
    senderOpenId: session.senderOpenId,
    rulesHash: computeRulesHash(session.workspaceDir),
  })
  saveResumableMap()
}

function forgetResumable(sessionKey: string): void {
  if (getResumableMap().delete(sessionKey)) saveResumableMap()
}

function buildWakePrompt(session: SdkSessionAgent, rulesUpdated = false, taskMessage?: string): string {
  const lines = taskMessage
    ? [
      "[SESSION_RESUME / 系统指令] 会话已由后台唤醒（历史上下文完整保留），有新任务待执行。",
      "---",
      "任务内容:",
      taskMessage,
      "---",
      "直接开始执行上述任务；执行中按 cursor-claw 协议同步进度，完成后挂阻塞 poll 收尾。",
      "禁止向用户发送问候、唤醒说明等任何多余消息。",
    ]
    : [
      "[SESSION_RESUME / 系统指令] 会话已由后台唤醒（历史上下文完整保留），有新消息待处理。",
      "立即执行：非阻塞检查 poll-message（wait=false），按 cursor-claw 协议处理所有消息并逐条回复，完成后挂阻塞 poll 收尾。",
      "禁止向用户发送问候、唤醒说明等任何多余消息。",
    ]
  if (rulesUpdated) {
    lines.push("⚠️ 工作区规则已更新（你上下文中的规则是旧版快照）：处理消息前必须先重读 .cursor/rules/ 目录下全部 .mdc 规则文件，并严格按最新规则执行。")
  }
  lines.push(
    "---",
    "会话元数据:",
    `[session_key=${session.sessionKey}]`,
    `[chat_type=${session.chatType}]`,
  )
  return lines.join("\n")
}

let sdkIdleHandler: ((sessionKey: string) => void) | null = null
/** sessionKey → 连续失败次数与最近失败时间（冷却判定在调度器层，对所有叫醒源生效） */
const sdkFailStreak = new Map<string, { count: number; lastFailAt: number; network?: boolean }>()

/** run 收口释放后回调（调度器借此立即消费运行期间积压的消息，含异常结束） */
export function setSdkIdleHandler(fn: (sessionKey: string) => void): void {
  sdkIdleHandler = fn
}

export function clearSdkFailStreak(sessionKey: string): void {
  sdkFailStreak.delete(sessionKey)
}

// SDK socket 深处的网络错误只会抛到主进程全局兜底，无法关联到具体 run；
// 记一份近期错误，run 报错时附到详情里还原真实原因（如代理断连）
const recentGlobalErrors: { at: number; msg: string }[] = []

export function noteGlobalSdkError(msg: string): void {
  recentGlobalErrors.push({ at: Date.now(), msg })
  if (recentGlobalErrors.length > 20) recentGlobalErrors.shift()
}

function recentGlobalErrorHint(withinMs: number): string {
  const cutoff = Date.now() - withinMs
  for (let i = recentGlobalErrors.length - 1; i >= 0; i--) {
    if (recentGlobalErrors[i].at >= cutoff) return recentGlobalErrors[i].msg
  }
  return ""
}

/** 失败不再退避：始终 0，调度器可立即重试（无限） */
export function sdkFailCooldownRemaining(_sessionKey: string): number {
  return 0
}

function scheduleSdkIdle(sessionKey: string, errored: boolean, opts?: { network?: boolean; silent?: boolean }): void {
  if (errored) {
    const st = sdkFailStreak.get(sessionKey) ?? { count: 0, lastFailAt: 0, network: false }
    st.count += 1
    st.lastFailAt = Date.now()
    st.network = !!opts?.network
    sdkFailStreak.set(sessionKey, st)
    if (!opts?.silent) {
      pushUiLog("SDK", st.count > 8 ? "ERROR" : "WARN",
        `[${sessionKey}] 异常结束×${st.count}，立即重试`)
    }
  } else {
    const prev = sdkFailStreak.get(sessionKey)
    clearSdkFailStreak(sessionKey)
    if (prev && prev.count >= 2) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] 已恢复（曾连续失败 ${prev.count} 次）`)
    }
  }
  // 成功失败都立即叫醒调度器；失败无冷却，可立刻再拉起
  sdkIdleHandler?.(sessionKey)
}

function closeAndRemoveSession(session: SdkSessionAgent): void {
  try { session.agent.close() } catch { /* best-effort */ }
  sdkSessions.delete(session.sessionKey)
}

function ensureSdkBinaryPaths(): void {
  if (process.env.CURSOR_RIPGREP_PATH) return

  const platformPkg = `@cursor/sdk-${process.platform}-${process.arch}`
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg"

  const candidates: string[] = []
  try {
    const req = createRequire(import.meta.url)
    const pkgDir = dirname(req.resolve(`${platformPkg}/package.json`))
    candidates.push(join(pkgDir, "bin", binaryName))
  } catch { /* package not resolvable */ }

  // fallback: walk up from app dir
  const appDir = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath)
  for (const base of [appDir, resolve(".")]) {
    candidates.push(join(base, "node_modules", platformPkg, "bin", binaryName))
    candidates.push(join(base, "resources", "node_modules", platformPkg, "bin", binaryName))
  }

  for (const p of candidates) {
    // asar 内的二进制无法 spawn（existsSync 对 asar 虚拟路径返回 true），需指向解包目录
    const real = p.includes("app.asar") && !p.includes("app.asar.unpacked")
      ? p.replace("app.asar", "app.asar.unpacked")
      : p
    if (existsSync(real)) {
      process.env.CURSOR_RIPGREP_PATH = real
      pushUiLog("SDK", "INFO", `Ripgrep 路径: ${real}`)
      return
    }
  }
  pushUiLog("SDK", "WARN", `未找到 ${binaryName}，SDK 可能报错 (searched: ${candidates.join(", ")})`)
}


function broadcastSdkSessionStatus(): void {
  const list = [...sdkSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    pid: 0,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType as string,
    chatName: resolveSessionChatName(s.sessionKey, s.chatName, s.senderOpenId),
    workspaceDir: s.workspaceDir,
    model: s.model,
    modelParams: s.modelParams,
  }))
  broadcastSessionStatus(list, "sdk")
}

// prompt 由 agent-launcher.buildPrompt 统一构建

// stream() 发出的 thinking.text / assistant text 均为增量 delta，逐条打印会刷屏；
// 这里按类型聚合，切换类型 / 超过阈值 / 遇到 tool·status·结束时才落一条日志
const LOG_FLUSH_LEN = 400

/** CardKit 流式更新节流：~400ms 调度，且不低于 ~5/s（200ms） */
const STREAM_FLUSH_MS = 400
const STREAM_MIN_INTERVAL_MS = 200
const STREAM_THINKING_TAIL = 1500
/** 流式卡工具步上限（飞书单卡 ≤200 元素；每步约 1~2 元素） */
const MAX_STREAM_TOOL_STEPS = 40

function newStreamAgg(gateOpen = false): StreamAgg {
  return {
    segments: [],
    dirty: false,
    timer: null,
    ensured: false,
    lastFlushAt: 0,
    inflight: Promise.resolve(),
    finished: false,
    gateOpen,
    pendingNonBlockingPoll: false,
    suspended: false,
  }
}

/** 已结束的 thinking 段写入固定 ms，避免后续 flush 继续涨表 */
function sealClosedThinking(agg: StreamAgg): void {
  const last = agg.segments.length - 1
  for (let i = 0; i < agg.segments.length; i++) {
    const seg = agg.segments[i]
    if (seg.type !== "thinking") continue
    if (seg.ms != null || seg.startedAt == null) continue
    if (i === last) continue
    seg.ms = Date.now() - seg.startedAt
  }
}

function sealAllThinking(agg: StreamAgg): void {
  for (const seg of agg.segments) {
    if (seg.type !== "thinking") continue
    if (seg.ms != null || seg.startedAt == null) continue
    seg.ms = Date.now() - seg.startedAt
  }
}


/** 可 Resume 的异常终态：不把流式卡标成已完成，便于重连续写 */
function shouldSuspendStreamCard(session: SdkSessionAgent, status: string): boolean {
  if (!session.keepSession) return false
  return status === "ERROR" || status === "EXPIRED" || status === "CANCELLED"
}

function isFeishuStreamEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return !!ch && ch.type === "feishu"
}

interface StreamCardPayload {
  segments: Array<
    | { type: "thinking"; text: string; ms?: number }
    | { type: "tools"; tools: { name: string; status: string; summary?: string; ms?: number }[] }
    | { type: "reply"; text: string }
  >
}

function isShowThinkingEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return ch?.showThinking !== false
}

function buildStreamPayload(agg: StreamAgg, sessionKey: string): StreamCardPayload {
  const showThinking = isShowThinkingEnabled(sessionKey)
  sealClosedThinking(agg)
  const segments: StreamCardPayload["segments"] = []
  const lastIdx = agg.segments.length - 1
  for (let i = 0; i < agg.segments.length; i++) {
    const seg = agg.segments[i]
    if (seg.type === "thinking") {
      if (!showThinking) continue
      let thinking = seg.text
      if (thinking.length > STREAM_THINKING_TAIL) {
        thinking = "…" + thinking.slice(-STREAM_THINKING_TAIL)
      }
      // 仅当前仍在写的最后一段 live 计时；已封存用固定 ms
      const ms = seg.ms ?? (i === lastIdx && seg.startedAt != null ? Date.now() - seg.startedAt : undefined)
      segments.push({ type: "thinking", text: thinking, ms })
    } else if (seg.type === "tools") {
      if (!seg.tools.length) continue
      const tools = seg.tools.length > MAX_STREAM_TOOL_STEPS
        ? seg.tools.slice(-MAX_STREAM_TOOL_STEPS)
        : seg.tools
      segments.push({
        type: "tools",
        tools: tools.map((t) => ({
          name: t.name,
          status: t.status,
          summary: t.summary || undefined,
          ms: t.ms,
        })),
      })
    } else if (seg.type === "reply" && seg.text) {
      if (!showThinking) continue
      const replyText = seg.text
      const lastOut = segments[segments.length - 1]
      if (lastOut?.type === "thinking") {
        let combined = lastOut.text?.trim() ? `${lastOut.text}\n\n${replyText}` : replyText
        if (combined.length > STREAM_THINKING_TAIL) {
          combined = "…" + combined.slice(-STREAM_THINKING_TAIL)
        }
        lastOut.text = combined
      } else {
        let thinking = replyText
        if (thinking.length > STREAM_THINKING_TAIL) {
          thinking = "…" + thinking.slice(-STREAM_THINKING_TAIL)
        }
        segments.push({ type: "thinking", text: thinking })
      }
    }
  }
  return { segments }
}


async function postStreamCard(
  sessionKey: string,
  action: "ensure" | "update" | "finish",
  payload: StreamCardPayload,
): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    const r = await httpPost(
      `http://127.0.0.1:${lock.port}/api/agent-stream-card`,
      {
        session_key: sessionKey,
        action,
        segments: payload.segments,
      },
      15_000,
    ) as { ok?: boolean; skipped?: boolean; error?: string } | null
    if (r && r.ok === false && !r.skipped) {
      pushUiLog("SDK", "DEBUG", `[${sessionKey}] 流式卡片 ${action} 失败: ${r.error || "unknown"}`)
    }
  } catch (e: unknown) {
    pushUiLog("SDK", "DEBUG", `[${sessionKey}] 流式卡片 ${action} 异常: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function scheduleFlushStreamCard(session: SdkSessionAgent): void {
  const agg = session.streamAgg
  if (!agg || agg.finished) return
  agg.dirty = true
  if (agg.timer) return
  const elapsed = Date.now() - agg.lastFlushAt
  const delay = Math.max(STREAM_FLUSH_MS, STREAM_MIN_INTERVAL_MS - elapsed)
  agg.timer = setTimeout(() => {
    agg.timer = null
    void flushStreamCard(session, false)
  }, Math.max(0, delay))
}

async function flushStreamCard(session: SdkSessionAgent, finish: boolean): Promise<void> {
  const agg = session.streamAgg
  if (!agg || agg.finished) return
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  if (!finish && !agg.dirty) return
  // 非阻塞 poll 完成前不发卡；仍保留 dirty，开门后再刷
  if (!finish && !agg.gateOpen) return

  const payload = buildStreamPayload(agg, session.sessionKey)
  agg.dirty = false
  agg.lastFlushAt = Date.now()
  // 同步标记，防止 status FINISHED 与 stream finally 双重 finish
  if (finish) agg.finished = true

  const run = async (): Promise<void> => {
    if (finish) {
      // 门未开且从未建卡：丢弃预热，不发空完成卡
      if (!agg.ensured && !agg.gateOpen) return
      await postStreamCard(session.sessionKey, "finish", payload)
      return
    }
    // finish 已抢占：丢弃排队中的 update
    if (agg.finished) return
    if (!agg.ensured) {
      await postStreamCard(session.sessionKey, "ensure", payload)
      agg.ensured = true
      // Resume 复用 Daemon 已有卡时，ensure 本身不写内容，再补一帧 update
      await postStreamCard(session.sessionKey, "update", payload)
      return
    }
    await postStreamCard(session.sessionKey, "update", payload)
  }

  agg.inflight = agg.inflight.then(run, run)
  await agg.inflight
}

function toolArgsCommandText(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v
  }
  try { return JSON.stringify(rec) } catch { return "" }
}

function isPollMessageInvocation(name: string, summary: string, args?: unknown): boolean {
  const full = `${name}\n${summary}\n${args != null ? toolArgsCommandText(args) : ""}`
  return /poll-message/i.test(full)
}

/** 仅阻塞 poll 才换卡。必须看完整 command（摘要 120 字会裁掉 wait=false） */
function isBlockingPollMessage(name: string, summary: string, args?: unknown): boolean {
  const full = `${name}\n${summary}\n${args != null ? toolArgsCommandText(args) : ""}`
  if (!/poll-message/i.test(full)) return false
  if (/wait\s*=\s*false/i.test(full)) return false
  if (/["']wait["']\s*:\s*false/i.test(full)) return false
  if (/wait%3[Dd]false/i.test(full)) return false
  return true
}

/** 仅隐藏本通道出站 MCP（send_text 等）与 poll；其它 MCP/工具都进流式工具区 */
function shouldOmitFromStreamCard(name: string, summary: string, args?: unknown): boolean {
  const full = `${name}\n${summary}\n${args != null ? toolArgsCommandText(args) : ""}`
  // cursor-claw 出站：已有独立飞书消息，不重复进工具区
  if (/(?:^|[\s:.])send_(?:text|question|image|file)\b/i.test(full)) return true
  if (/(?:^|[\s:.])project_(?:action|update|get|list|delete|register)/i.test(full)) return true
  if (/toolName["']?\s*[:=]\s*["']send_/i.test(full)) return true
  if (/toolName["']?\s*[:=]\s*["']project_/i.test(full)) return true
  if (isPollMessageInvocation(name, summary, args)) return true
  return false
}

/** MCP 工具展示名：优先 args.toolName / tool_name */
function resolveToolDisplayName(name: string, args: unknown): string {
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>
    for (const key of ["toolName", "tool_name", "name"]) {
      const v = rec[key]
      if (typeof v === "string" && v.trim()) {
        const server = typeof rec.serverName === "string" ? rec.serverName
          : typeof rec.server === "string" ? rec.server : ""
        return server ? `${server}/${v.trim()}` : v.trim()
      }
    }
  }
  return name
}


function extractToolResultText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (typeof result !== "object") return String(result)
  const rec = result as Record<string, unknown>
  for (const key of ["output", "stdout", "content", "text", "result", "message"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v
  }
  try { return JSON.stringify(rec) } catch { return "" }
}

function parsePollResponse(result: unknown): { messages: Array<{ messageId?: string; text?: string }>; freshIds?: string[] } {
  const raw = extractToolResultText(result)
  const tryObj = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s) as Record<string, unknown> } catch { return null }
  }
  let obj = tryObj(raw.trim())
  if (!obj) {
    const start = raw.indexOf("{\"messages\"")
    const alt = raw.indexOf("{ \"messages\"")
    const i = start >= 0 ? start : alt
    if (i >= 0) {
      const slice = raw.slice(i)
      // 从后往前找最后一个平衡 JSON
      for (let end = slice.length; end > 20; end--) {
        obj = tryObj(slice.slice(0, end))
        if (obj && Array.isArray(obj.messages)) break
        obj = null
      }
    }
  }
  if (!obj) return { messages: [] }
  const messages = Array.isArray(obj.messages) ? obj.messages as Array<{ messageId?: string; text?: string }> : []
  const freshIds = Array.isArray(obj.freshIds) ? obj.freshIds.map(String) : undefined
  return { messages, freshIds }
}

function isSystemPollText(text?: string): boolean {
  if (!text) return true
  return /\[SYSTEM\b/i.test(text) || /\[SESSION_RESUME\b/i.test(text)
}

/** 返回本批「新用户消息」id；处理中重投 / 系统指令不计 */
function takeFreshUserPollIds(session: SdkSessionAgent, result: unknown): string[] {
  const { messages, freshIds } = parsePollResponse(result)
  if (freshIds) {
    const out: string[] = []
    for (const id of freshIds) {
      if (!id || id.startsWith("internal_")) continue
      session.seenPollMessageIds.add(id)
      out.push(id)
    }
    // freshIds 为空但 messages 里有用户消息 = 纯处理中重投
    return out
  }
  const out: string[] = []
  for (const m of messages) {
    const id = typeof m.messageId === "string" ? m.messageId : ""
    const text = typeof m.text === "string" ? m.text : ""
    if (!id || id.startsWith("internal_")) continue
    if (isSystemPollText(text)) continue
    if (session.seenPollMessageIds.has(id)) continue
    session.seenPollMessageIds.add(id)
    out.push(id)
  }
  return out
}

/**
 * 长连接：收口当前流式卡，并换新 agg。
 * 下一轮思考/工具再 ensure 一张新卡，避免一直改上一张。
 */
async function rotateStreamCard(session: SdkSessionAgent): Promise<void> {
  const agg = session.streamAgg
  if (!agg) {
    session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg() : null
    return
  }
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  const shouldFinish = !agg.finished && agg.ensured
  agg.finished = true
  session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg() : null
  if (!shouldFinish) return
  const payload = buildStreamPayload(agg, session.sessionKey)
  agg.inflight = agg.inflight.then(
    () => postStreamCard(session.sessionKey, "finish", payload),
    () => postStreamCard(session.sessionKey, "finish", payload),
  )
  await agg.inflight
}

function flushSdkLog(session: SdkSessionAgent): void {
  const agg = session.logAgg
  const text = agg.buf.trim()
  if (agg.kind && text) {
    if (agg.kind === "thinking") {
      pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] [thinking] ${text}`)
    } else {
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] ${text}`)
    }
  }
  agg.kind = null
  agg.buf = ""
}

function appendSdkLog(session: SdkSessionAgent, kind: "thinking" | "text", delta: string): void {
  const agg = session.logAgg
  if (agg.kind && agg.kind !== kind) flushSdkLog(session)
  agg.kind = kind
  agg.buf += delta
  if (agg.buf.length >= LOG_FLUSH_LEN) flushSdkLog(session)
}

async function streamRunEvents(session: SdkSessionAgent, run: Run): Promise<void> {
  try {
    for await (const event of run.stream()) {
      if (session.abortController.signal.aborted) break
      session.lastActivityAt = Date.now()
      handleSdkEvent(session, event)
    }
    flushSdkLog(session)
  } catch (e: unknown) {
    flushSdkLog(session)
    if (!session.abortController.signal.aborted) {
      const msg = e instanceof Error ? `[${e.constructor.name}] ${e.message}` : String(e)
      const stack = e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : ""
      const cause = e instanceof Error && "cause" in e && e.cause ? JSON.stringify(e.cause) : ""
      pushUiLog("SDK", "ERROR", `[${session.sessionKey}] 流处理异常: ${msg}${stack ? ` stack=${stack}` : ""}${cause ? ` cause=${cause}` : ""}`)
    }
  } finally {
    // run 结束：落最终内容并关闭 streaming_mode（飞书 CardKit）
    // 全程无 thinking/tool/text 则不建空卡
    try {
      const agg = session.streamAgg
      if (agg && (agg.ensured || agg.dirty || agg.segments.length)) {
        sealAllThinking(agg)
        if (agg.suspended || (session.lastStatus && shouldSuspendStreamCard(session, session.lastStatus.status))) {
          agg.suspended = true
          await flushStreamCard(session, false)
        } else {
          await flushStreamCard(session, true)
        }
      } else if (agg) {
        agg.finished = true
      }
    } catch { /* best-effort */ }
  }
}

// 工具入参摘要：按优先级挑最有信息量的字符串字段（Shell→command、Read→path、Grep→pattern…）
const TOOL_ARG_SUMMARY_KEYS = ["command", "path", "target_notebook", "pattern", "glob_pattern", "file_path", "image_path", "url", "query", "question", "text", "description", "name", "toolName", "tool_name", "serverName", "server"]
const TOOL_SUMMARY_MAX = 120

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  let text = ""
  for (const key of TOOL_ARG_SUMMARY_KEYS) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) { text = v.trim(); break }
  }
  if (!text) {
    try { text = JSON.stringify(rec) } catch { return "" }
    if (text === "{}") return ""
  }
  text = text.replace(/\s+/g, " ")
  return text.length > TOOL_SUMMARY_MAX ? `${text.slice(0, TOOL_SUMMARY_MAX)}…` : text
}

function handleSdkEvent(session: SdkSessionAgent, event: SDKMessage): void {
  const stream = session.streamAgg
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          appendSdkLog(session, "text", block.text)
          if (stream && !stream.finished) {
            const last = stream.segments[stream.segments.length - 1]
            if (last?.type === "reply") {
              last.text += block.text
            } else {
              if (last?.type === "thinking" && last.startedAt != null && last.ms == null) {
                last.ms = Date.now() - last.startedAt
              }
              stream.segments.push({ type: "reply", text: block.text })
            }
            scheduleFlushStreamCard(session)
          }
        }
      }
      break
    case "thinking":
      if (event.text) {
        appendSdkLog(session, "thinking", event.text)
        if (stream && !stream.finished && isShowThinkingEnabled(session.sessionKey)) {
          const last = stream.segments[stream.segments.length - 1]
          // 仅未封存的思考段可续写；已封存则新开一段计时
          if (last?.type === "thinking" && last.ms == null) {
            last.text += event.text
          } else {
            stream.segments.push({ type: "thinking", text: event.text, startedAt: Date.now() })
          }
          scheduleFlushStreamCard(session)
        }
      }
      break
    case "tool_call": {
      flushSdkLog(session)
      // 摘要只随发起（running）打一次，完成/失败行保持简短避免刷屏
      const summary = event.status === "running" ? summarizeToolArgs(event.args) : ""
      const detectSummary = summary || summarizeToolArgs(event.args) || ""
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] [tool] ${event.name}: ${event.status}${summary ? ` · ${summary}` : ""}`)
      if (stream && !stream.finished) {
        // 任意工具（含出站 MCP/poll）都先封存上一思考，避免 live 计时把工具墙钟算进去
        {
          const prevThink = stream.segments[stream.segments.length - 1]
          if (prevThink?.type === "thinking" && prevThink.startedAt != null && prevThink.ms == null) {
            prevThink.ms = Date.now() - prevThink.startedAt
          }
        }
                if (isPollMessageInvocation(event.name, detectSummary, event.args)) {
          const blocking = isBlockingPollMessage(event.name, detectSummary, event.args)
          if (event.status === "running") {
            // 阻塞 poll 开始：只收口当前卡（进入空闲），新一批切卡等 poll 返回再定
            if (blocking && stream.gateOpen && stream.ensured) {
              void rotateStreamCard(session)
            } else if (!blocking) {
              stream.pendingNonBlockingPoll = true
            }
            break
          }
          // poll 结束：有新用户消息才切卡；系统指令/处理中重投不切
          const freshIds = takeFreshUserPollIds(session, event.result)
          if (freshIds.length > 0) {
            void rotateStreamCard(session)
            const next = session.streamAgg
            if (next) {
              next.gateOpen = true
              next.pendingNonBlockingPoll = false
            }
            break
          }
          if (stream.pendingNonBlockingPoll || !blocking || !stream.ensured) {
            stream.segments = stream.segments.filter((s) => s.type === "tools" && s.tools.length > 0)
            stream.dirty = stream.segments.length > 0
            stream.pendingNonBlockingPoll = false
          }
          stream.gateOpen = true
          break
        }
        if (shouldOmitFromStreamCard(event.name, detectSummary, event.args)) {
          break
        }
        const prev = stream.segments[stream.segments.length - 1]
        let toolsSeg = prev?.type === "tools" ? prev : null
        if (!toolsSeg) {
          toolsSeg = { type: "tools", tools: [] }
          stream.segments.push(toolsSeg)
        }
        const existing = toolsSeg.tools.find((t) => t.callId === event.call_id)
        if (existing) {
          existing.status = event.status
          if (summary) existing.summary = summary
          if (event.status === "running") {
            existing.startedAt = Date.now()
            existing.ms = undefined
          } else if (existing.startedAt != null && (event.status === "completed" || event.status === "error")) {
            existing.ms = Date.now() - existing.startedAt
          }
        } else {
          const startedAt = event.status === "running" ? Date.now() : undefined
          toolsSeg.tools.push({
            callId: event.call_id,
            name: resolveToolDisplayName(event.name, event.args),
            status: event.status,
            summary,
            startedAt,
          })
        }
        scheduleFlushStreamCard(session)
      }
      break
    }
    case "status": {
      flushSdkLog(session)
      const isErr = event.status === "ERROR" || event.status === "EXPIRED"
      if (isErr || event.status === "CANCELLED") {
        session.lastStatus = { status: event.status, message: event.message }
      }
      const lvl = isErr ? "ERROR" as const : "INFO" as const
      pushUiLog("SDK", lvl, `[${session.sessionKey}] [status] ${event.status}${event.message ? ` - ${event.message}` : ""}`)
      // FINISHED / 终态：尽快收口流式卡（finally 还会再 finish 一次，daemon 侧幂等）
      if (stream && (event.status === "FINISHED" || event.status === "ERROR" || event.status === "CANCELLED" || event.status === "EXPIRED")) {
        sealAllThinking(stream)
        if (event.status === "FINISHED") {
          void flushStreamCard(session, true)
        } else if (shouldSuspendStreamCard(session, event.status)) {
          // 断线/取消：刷最后一帧但不 finish，Daemon 侧保留 card 供 Resume 接续
          stream.suspended = true
          void flushStreamCard(session, false)
        } else {
          void flushStreamCard(session, true)
        }
      }
      break
    }
  }
}

// ── 公开 API ────────────────────────────────────────

export function isSdkSessionRunning(sessionKey: string): boolean {
  if (pendingLaunches.has(sessionKey)) return true
  const s = sdkSessions.get(sessionKey)
  return s !== undefined && !s.abortController.signal.aborted && s.run !== null
}

/** 是否有可 Resume 的历史会话（上下文可恢复，无需完整冷启动提示） */
export function hasResumableSdkSession(sessionKey: string): boolean {
  return getResumableMap().has(sessionKey)
}

// ── 会话诊断 ─────────────────────────────────────────────

export interface SdkRunResult {
  status: string
  endedAt: number
  durationMs?: number
  error?: string
}

export interface SdkSessionDiagnostics {
  running: boolean
  resumeAgentId?: string
  resumeUpdatedAt?: number
  lastRun?: SdkRunResult
}

/** 每会话最近一次 run 的终态（内存，重启清零；诊断面板用） */
const lastRunResults = new Map<string, SdkRunResult>()

export function getSdkSessionDiagnostics(sessionKey: string): SdkSessionDiagnostics {
  const resume = getResumableMap().get(sessionKey)
  return {
    running: isSdkSessionRunning(sessionKey),
    resumeAgentId: resume?.agentId,
    resumeUpdatedAt: resume?.updatedAt,
    lastRun: lastRunResults.get(sessionKey),
  }
}

/** 诊断包用：resume 映射概要（agentId 非敏感） */
export function getResumableSummary(): { sessionKey: string; agentId: string; workspaceDir: string; updatedAt: number }[] {
  return [...getResumableMap().entries()].map(([sessionKey, e]) => ({
    sessionKey, agentId: e.agentId, workspaceDir: e.workspaceDir, updatedAt: e.updatedAt,
  }))
}

export function getSdkSessionCount(): number {
  let count = 0
  for (const s of sdkSessions.values()) {
    if (!s.abortController.signal.aborted && s.run !== null) count++
  }
  return count
}

export function getSdkSessionList() {
  return [...sdkSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    agentId: s.agentId,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType,
    workspaceDir: s.workspaceDir,
    senderOpenId: s.senderOpenId,
    chatName: s.chatName,
    model: s.model,
    modelParams: s.modelParams,
  }))
}

export interface SdkLaunchOptions {
  sessionKey: string
  chatType: ChatType
  meta?: LaunchMeta
  workspaceDir: string
  useMainWorkspace?: boolean
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  /** 该会话所属通道绑定的 SDK 资源 API Key */
  apiKey: string
  /** 调用方解析好的模型（空 = composer-2） */
  model?: string
  modelParams?: string
  /** 通道开关：保留会话上下文（默认 true；false = 每条消息全新会话） */
  keepSession?: boolean
  /** 通道开关：长连接无限 poll 保活（默认 true；false = 回答完收回合按需唤醒） */
  persistentPoll?: boolean
  /** 主用户每次新会话：跳过 Resume，直接新建（上下文清零） */
  newSession?: boolean
}

/** run 生命周期托管：结束即释放 agent 进程（上下文靠持久化的 agentId Resume 恢复） */
function startRunLifecycle(session: SdkSessionAgent, run: Run): void {
  session.run = run
  session.lastActivityAt = Date.now()
  // 新 run 已启动：清掉上一轮的终态记录，避免 UI 持续展示已恢复会话的旧错误
  lastRunResults.delete(session.sessionKey)

  streamRunEvents(session, run).then(async () => {
    const sessionKey = session.sessionKey
    let errorDetail: string | undefined
    let networkFail = false
    if (run.status === "error") {
      // wait() 返回 RunResult 对象（出错时也不抛），真实原因藏在 RunResult.result / 终态状态事件里
      const wr = await run.wait().catch((e: unknown) => e)
      let detail: string
      if (wr instanceof Error) {
        detail = `${wr.constructor.name}: ${wr.message}${(wr as Error & { cause?: unknown }).cause ? ` cause=${String((wr as Error & { cause?: unknown }).cause)}` : ""}`
      } else if (wr && typeof wr === "object") {
        const o = wr as Record<string, unknown>
        detail = JSON.stringify({
          status: o.status, result: o.result, error: o.error, message: o.message,
          durationMs: o.durationMs, id: o.id, model: o.model,
        })
      } else {
        detail = String(wr)
      }
      const last = session.lastStatus
      const lastStr = last ? `lastStatus=${last.status}${last.message ? ` msg=${last.message}` : ""} ` : ""
      const netHint = recentGlobalErrorHint(120_000)
      errorDetail = `${lastStr}${detail}${netHint ? ` | net=${netHint}` : ""}`.slice(0, 500)
      networkFail = /API key exchange|exchange_user_api_key|fetch failed|unauthenticated|ECONNRESET|socket hang up|GOAWAY|疑似底层网络/i.test(errorDetail)
      // 不清 Resume：agentId 仍在，下次 Agent.resume 换新本地句柄，云端上下文保留
    }

    lastRunResults.set(sessionKey, {
      status: run.status ?? "unknown",
      endedAt: Date.now(),
      durationMs: run.durationMs ?? undefined,
      error: errorDetail,
    })

    session.run = null
    const errored = run.status === "error"
    closeAndRemoveSession(session)
    broadcastSdkSessionStatus()

    if (errored) {
      // 记账失败次数后立即叫醒调度器重试（无退避）
      scheduleSdkIdle(sessionKey, true, { network: networkFail, silent: true })
      const st = sdkFailStreak.get(sessionKey)
      const dur = run.durationMs != null ? `${run.durationMs}ms` : "?"
      const tip = networkFail ? "将Resume重建连接" : ""
      pushUiLog("SDK", (st?.count ?? 0) > 8 ? "ERROR" : "WARN",
        `[${sessionKey}] 运行失败×${st?.count ?? 1} ${dur}${tip ? ` ${tip}` : ""} → 立即重试 | ${errorDetail || "unknown"}`)
    } else {
      const summary = [
        run.result && `result=${run.result}`,
        run.durationMs != null && `duration=${run.durationMs}ms`,
      ].filter(Boolean).join(", ")
      pushUiLog("SDK", "INFO", `[${sessionKey}] Agent 运行结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)
      scheduleSdkIdle(sessionKey, false)
    }
  })
}

export async function launchSdkAgent(opts: SdkLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, workspaceDir, senderOpenId, chatName, taskMessage } = opts

  if (isSdkSessionRunning(sessionKey) || pendingLaunches.has(sessionKey)) {
    const s = sdkSessions.get(sessionKey)
    if (s) {
      s.lastActivityAt = Date.now()
      // 异常重启等路径可能丢失用户标识，随新消息自愈回填（否则会话名永远兜底为「通道名·访客」）
      if (!s.senderOpenId && senderOpenId) s.senderOpenId = senderOpenId
    }
    return { ok: true }
  }

  pendingLaunches.add(sessionKey)
  const resetGenAtStart = sessionResetGen.get(sessionKey) ?? 0

  const apiKey = opts.apiKey?.trim()
  if (!apiKey) {
    pendingLaunches.delete(sessionKey)
    return { ok: false, error: "通道绑定的 SDK 资源未配置 API Key（设置 → Agent）" }
  }

  const keepSession = opts.keepSession ?? true
  const persistentPoll = keepSession && (opts.persistentPoll ?? true)

  try {
    ensureSdkBinaryPaths()
    ensureModelStore()

    const fallbackModel = opts.model?.trim() && opts.model.trim() !== "auto" ? opts.model.trim() : "composer-2"
    const resolvedRef = resolveModelForSession(sessionKey, {
      model: fallbackModel,
      modelParams: opts.modelParams ?? "",
    })
    const modelId = resolvedRef.model?.trim() && resolvedRef.model.trim() !== "auto" ? resolvedRef.model.trim() : "composer-2"
    const modelParams = resolvedRef.modelParams ?? ""
    const modelSelection: { id: string; params?: { id: string; value: string }[] } = { id: modelId }
    if (modelParams.trim()) {
      try {
        modelSelection.params = JSON.parse(modelParams)
      } catch { /* ignore bad JSON */ }
    }

    const localOptions = {
      cwd: workspaceDir,
      settingSources: ["project", "user"] as ("project" | "user")[],
      sandboxOptions: { enabled: false },
    }

    // Resume 语义：
    // - project 永远 Resume（带 taskMessage 时任务附在唤醒 prompt 里）
    // - task/temp 带 taskMessage 为任务首启不 Resume；无 taskMessage 为续聊，Resume 保上下文
    // - p2p/group 正常 Resume
    const wantResume = keepSession && !opts.newSession
      && (chatType === "project" || !taskMessage)
    if (!wantResume) forgetResumable(sessionKey)
    const resumable = wantResume ? getResumableMap().get(sessionKey) : undefined
    let agent: SDKAgent | undefined
    if (resumable && resumable.workspaceDir === workspaceDir) {
      try {
        pushUiLog("SDK", "INFO", `[${sessionKey}] Resume 恢复会话 (agentId=${resumable.agentId}, model=${JSON.stringify(modelSelection)}, 新连接/上下文保留)`)
        agent = await Agent.resume(resumable.agentId, { apiKey, model: modelSelection, local: localOptions })
      } catch (e: unknown) {
        pushUiLog("SDK", "WARN", `[${sessionKey}] Resume 失败，回退全新会话: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const resumed = agent !== undefined

    if (!agent) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] 正在创建 SDK Agent (cwd=${workspaceDir}, model=${JSON.stringify(modelSelection)})`)
      agent = await Agent.create({ apiKey, model: modelSelection, local: localOptions })
    }

    // 拉起期间被 /reset：本次 agent 可能带着旧上下文，直接丢弃（队列消息会驱动下一次全新拉起）
    if ((sessionResetGen.get(sessionKey) ?? 0) !== resetGenAtStart) {
      try { agent.close() } catch { /* best-effort */ }
      pushUiLog("SDK", "INFO", `[${sessionKey}] 拉起期间会话被重置，丢弃本次拉起（下次全新会话）`)
      return { ok: false, error: "会话已重置" }
    }

    const abortController = new AbortController()
    const session: SdkSessionAgent = {
      sessionKey,
      agent,
      run: null,
      agentId: agent.agentId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      chatType,
      workspaceDir,
      senderOpenId: senderOpenId ?? resumable?.senderOpenId,
      chatName,
      abortController,
      keepSession,
      persistentPoll,
      model: modelId,
      modelParams,
      logAgg: { kind: null, buf: "" },
      streamAgg: isFeishuStreamEnabled(sessionKey) ? newStreamAgg() : null,
      seenPollMessageIds: new Set(),
    }

    sdkSessions.set(sessionKey, session)
    broadcastLog(`[SDK] 会话 ${sessionKey} 已${resumed ? "恢复" : "创建"}, agentId=${agent.agentId}, model=${JSON.stringify(modelSelection)}`)
    broadcastSdkSessionStatus()
    pushRecentModel({ model: modelId, modelParams })

    // Resume 会话的规则是创建时快照：规则文件变过则在唤醒 prompt 里硬指令重读
    const rulesUpdated = resumed && !!resumable?.rulesHash
      && resumable.rulesHash !== computeRulesHash(workspaceDir)
    if (rulesUpdated) pushUiLog("SDK", "INFO", `[${sessionKey}] 检测到规则更新，唤醒时要求重读规则`)
    const prompt = resumed
      ? buildWakePrompt(session, rulesUpdated, taskMessage)
      : buildPrompt(meta, taskMessage, sessionKey, opts.useMainWorkspace)
    pushUiLog("SDK", "INFO", `[${sessionKey}] ${resumed ? "恢复" : "启动"} Prompt:\n${prompt}`)
    let run: Run
    try {
      run = await agent.send(prompt)
    } catch (e: unknown) {
      // 上次进程异常退出未落终态的 wedged run 会卡死会话（already has active run）；
      // SDK 官方恢复路径：force 过期残留 run 后重发
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes("already has active run")) throw e
      pushUiLog("SDK", "WARN", `[${sessionKey}] 检测到残留 active run，force 恢复重发`)
      run = await agent.send(prompt, { local: { force: true } })
    }
    startRunLifecycle(session, run)
    // 失败计数不在拉起时清零（断网时 Resume 总能成功、run 中途才死）：
    // run 成功跑完由 scheduleSdkIdle 清零；失败无冷却，调度器立即再拉
    // 持久化最新 agentId：run 结束释放进程后靠它 Resume，应用重启后依然有效
    // send 期间被 /reset 则不回写（否则旧上下文的 agentId 会覆盖掉刚删的映射）
    if ((sessionResetGen.get(sessionKey) ?? 0) === resetGenAtStart) {
      rememberResumable(session)
    }

    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[SDK] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    // 不动 resume 映射：仍指向上一个可用的 agentId，重试可续上上下文
    const failed = sdkSessions.get(sessionKey)
    if (failed) closeAndRemoveSession(failed)
    broadcastSdkSessionStatus()
    return { ok: false, error: msg }
  } finally {
    pendingLaunches.delete(sessionKey)
  }
}

/** 停止并释放会话：先等 cancel 把 run 落为终态再关进程（直接 close 会残留 active run，拖垮下次 Resume） */
function releaseSession(s: SdkSessionAgent): Promise<void> {
  s.abortController.abort()
  if (s.streamAgg?.timer) {
    clearTimeout(s.streamAgg.timer)
    s.streamAgg.timer = null
  }
  const { agent, run } = s
  sdkSessions.delete(s.sessionKey)
  if (!run) {
    try { agent.close() } catch { /* best-effort */ }
    return Promise.resolve()
  }
  const timeout = new Promise<void>((r) => setTimeout(r, 5000))
  return Promise.race([run.cancel().catch(() => {}), timeout]).then(() => {
    try { agent.close() } catch { /* best-effort */ }
  })
}

/** 停止会话进程（保留 resume 映射，下条消息仍可续上下文；清上下文用 resetSdkSessionContext） */
export function stopSdkSession(sessionKey: string): void {
  const s = sdkSessions.get(sessionKey)
  if (!s) return
  pushUiLog("SDK", "INFO", `[${sessionKey}] 会话已停止（队列有未回复消息时将自动重新拉起）`)
  void releaseSession(s)
  broadcastSdkSessionStatus()
}

/**
 * 仅本会话切换模型：写 override；有 live/resumable 则停当前 run 后 Resume（禁止 Create 丢上下文）。
 * 无可恢复会话时只写 override，返回 deferred=true（下次唤醒生效）。
 */
export async function switchSdkSessionModel(
  sessionKey: string,
  model: string,
  modelParams?: string,
): Promise<{ ok: boolean; deferred?: boolean; error?: string }> {
  const mid = model?.trim()
  if (!mid) return { ok: false, error: "model 不能为空" }
  ensureModelStore()
  const params = modelParams ?? ""
  setSessionOverride(sessionKey, { model: mid, modelParams: params })
  pushRecentModel({ model: mid, modelParams: params })

  const live = sdkSessions.get(sessionKey)
  const resumable = getResumableMap().get(sessionKey)
  if (!live && !resumable) {
    pushUiLog("SDK", "INFO", `[${sessionKey}] 会话未拉起，已记下模型 ${mid}（下次唤醒生效）`)
    return { ok: true, deferred: true }
  }

  const channel = resolveChannelForSession(sessionKey)
  const resource = getAgentResource(channel?.agentResourceId)
  if (resource.type !== "sdk" || !resource.apiKey?.trim()) {
    return { ok: false, error: "通道未绑定 SDK 资源或缺少 API Key" }
  }

  const workspaceDir = live?.workspaceDir || resumable!.workspaceDir
  if (!workspaceDir) return { ok: false, error: "无法解析会话工作目录" }

  if (live) {
    pushUiLog("SDK", "INFO", `[${sessionKey}] 换模：停止当前 run，准备 Resume → ${mid}`)
    await releaseSession(live)
    broadcastSdkSessionStatus()
  }

  const chatType: ChatType = live?.chatType
    ?? (projectIdFromSessionKey(sessionKey) ? "project" : "p2p")
  const r = await launchSdkAgent({
    sessionKey,
    chatType,
    workspaceDir,
    apiKey: resource.apiKey,
    model: mid,
    modelParams: params,
    keepSession: live?.keepSession ?? channel?.keepSession ?? true,
    persistentPoll: live?.persistentPoll ?? (channel?.keepSession !== false && (channel?.persistentPoll ?? true)),
    senderOpenId: live?.senderOpenId ?? resumable?.senderOpenId,
    chatName: live?.chatName,
  })
  if (!r.ok) return { ok: false, error: r.error || "Resume 换模失败" }
  // 等新 run 真正 RUNNING（最多 15s），避免「已切换」报喜后实际还在 error 重试
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const s = sdkSessions.get(sessionKey)
    if (s?.run && (s.lastStatus?.status === "RUNNING" || s.lastStatus?.status === "running")) {
      clearSdkFailStreak(sessionKey)
      return { ok: true }
    }
    // launch 成功但已又 error 退出：继续等退避重试拉起
    await new Promise((r) => setTimeout(r, 400))
  }
  // 超时仍返回 ok（override 已写入），但提示调用方可能仍在重试
  return { ok: true }
}

/** 显式重置会话上下文（/reset）：停掉在跑的 run、丢弃 resume 映射，下条消息全新会话 */
export function resetSdkSessionContext(sessionKey: string): void {
  sessionResetGen.set(sessionKey, (sessionResetGen.get(sessionKey) ?? 0) + 1)
  const live = sdkSessions.get(sessionKey)
  if (live) void releaseSession(live)
  forgetResumable(sessionKey)
}

/**
 * 停止全部运行中的会话进程；保留 resume 映射（应用重启后上下文可恢复）。
 * 返回的 Promise 在所有 run 取消落库（或超时）后 resolve——退出前 await 可避免残留 active run。
 */
export function stopAllSdkSessions(): Promise<void> {
  const releases = [...sdkSessions.values()].map((s) => releaseSession(s))
  pendingLaunches.clear()
  broadcastSdkSessionStatus()
  return Promise.all(releases).then(() => {})
}

export async function checkSdkApiKey(apiKey: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  const key = apiKey?.trim()
  if (!key) return { ok: false, error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const me = await Cursor.me({ apiKey: key })
    return { ok: true, email: me.userEmail }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export interface SdkModelOption {
  id: string
  label: string
  params: string
  current: boolean
}

/** 与设置页同一套：modelSlug（含 params 里的 1m/300k） */
function modelSlug(id: string, params: { id: string; value: string }[]): string {
  return modelSlugFromParams(id, params)
}

export async function listSdkModels(apiKey: string, currentModelId?: string, currentModelParams?: string): Promise<{ ok: boolean; models: SdkModelOption[]; error?: string }> {
  const key = apiKey?.trim()
  if (!key) return { ok: false, models: [], error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const sdkModels = await Cursor.models.list({ apiKey: key })
    const currentModel = currentModelId?.trim() || ""
    const currentParams = currentModelParams?.trim() || ""

    const models: SdkModelOption[] = []
    for (const m of sdkModels) {
      if (m.variants && m.variants.length > 0) {
        const slugCount = new Map<string, number>()
        for (const v of m.variants) {
          const s = modelSlug(m.id, v.params)
          slugCount.set(s, (slugCount.get(s) || 0) + 1)
        }
        for (const v of m.variants) {
          const ps = JSON.stringify(v.params)
          const slug = modelSlug(m.id, v.params)
          const hasDup = (slugCount.get(slug) || 0) > 1
          const label = hasDup
            ? `${slug} (${v.params.map((p) => `${p.id}=${p.value}`).join(", ")})`
            : slug
          rememberModelLabel(m.id, ps, label)
          models.push({
            id: m.id,
            label,
            params: ps,
            current: m.id === currentModel && ps === currentParams,
          })
        }
      } else {
        const label = m.id
        rememberModelLabel(m.id, "", label)
        models.push({
          id: m.id,
          label,
          params: "",
          current: m.id === currentModel && !currentParams,
        })
      }
    }
    return { ok: true, models }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, models: [], error: msg }
  }
}
