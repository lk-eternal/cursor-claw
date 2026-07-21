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
  | { type: "todos"; items: StreamTodoItem[] }

interface StreamTodoItem {
  id?: string
  content: string
  status: string
}


/**
 * 飞书流式卡：事件队列。
 * 同类合并、异类新开；SDK assistant 正文当思考；空段丢弃。
 * 切卡仅在新用户消息 / 点选项（见 rotate）；阻塞 poll 开始只收口不换卡。
 */
interface StreamAgg {
  segments: StreamSegment[]
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  ensured: boolean
  /** Daemon 侧 cardId：finish 必须带上，防延迟 finish 误杀下一轮新卡 */
  cardId?: string
  lastFlushAt: number
  /** 串行化 ensure/update/finish，避免乱序 */
  inflight: Promise<void>
  finished: boolean
  /** false：未过首轮 poll 前不发流式卡（避免非阻塞预热单独建卡） */
  gateOpen: boolean
  /** 正在跑 wait=false，结束后清空预热片段 */
  pendingNonBlockingPoll: boolean
  /** 已挂阻塞 poll：期间关门，防思考刷新卡；重复 poll 不再 endStreamRound */
  pendingBlockingPoll: boolean
  /** send_* 正文边界：下一段思考必须新开，禁止并进 send 前的思考块 */
  forceNewThinking: boolean
  /** 断线挂起：不 finish 收口，Resume 后继续同一张卡 */
  suspended: boolean
  /** 队列诞生时刻：daemon 用它区分「seal 前的旧队列」（gone 丢弃）与「seal 后的新队列」（放行建卡） */
  bornAt: number
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
  /** 任务清单最新快照（会话级，跨换卡存活）：merge 更新基于它，新卡渲染完整清单 */
  todoSnapshot: StreamTodoItem[] | null
  /** 最近一次 status 事件（含 RUNNING/ERROR 等），结束诊断与断线挂起判定用 */
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
interface ResumeEntry {
  agentId: string
  workspaceDir: string
  updatedAt: number
  senderOpenId?: string
  rulesHash?: string
  /** 最近一次飞书流式卡 cardId；进程重启后用于收口孤儿卡，避免 Resume 再建一张重复卡 */
  streamCardId?: string
}

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
  const prev = getResumableMap().get(session.sessionKey)
  getResumableMap().set(session.sessionKey, {
    agentId: session.agentId, workspaceDir: session.workspaceDir, updatedAt: Date.now(),
    senderOpenId: session.senderOpenId,
    rulesHash: computeRulesHash(session.workspaceDir),
    streamCardId: session.streamAgg?.cardId ?? prev?.streamCardId,
  })
  saveResumableMap()
}

function patchResumableStreamCard(sessionKey: string, streamCardId: string | undefined, opts?: { onlyIf?: string }): void {
  const map = getResumableMap()
  const e = map.get(sessionKey)
  if (!e) return
  // 清除必须带期望值：延迟 finish 的清理不能抹掉新回合刚记录的新卡
  if (opts?.onlyIf && e.streamCardId !== opts.onlyIf) return
  if (e.streamCardId === streamCardId) return
  e.streamCardId = streamCardId
  e.updatedAt = Date.now()
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
    pendingBlockingPoll: false,
    forceNewThinking: false,
    suspended: false,
    bornAt: Date.now(),
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

/** 收口时 running 工具改完成态：终态事件已无处投递（换卡/run 结束），不留假 running */
function sealRunningTools(agg: StreamAgg): void {
  for (const seg of agg.segments) {
    if (seg.type !== "tools") continue
    for (const t of seg.tools) {
      if (t.status !== "running") continue
      t.status = "completed"
      if (t.startedAt != null) t.ms = Date.now() - t.startedAt
    }
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
    | { type: "todos"; items: { content: string; status: string }[] }
  >
}

function isShowThinkingEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return ch?.showThinking !== false
}


/** 丢掉末尾空块（空思考/空正文/空工具） */
function dropEmptyTail(stream: StreamAgg): void {
  while (stream.segments.length) {
    const last = stream.segments[stream.segments.length - 1]
    if (last.type === "thinking" && !last.text.trim()) { stream.segments.pop(); continue }
    if (last.type === "reply" && !last.text.trim()) { stream.segments.pop(); continue }
    if (last.type === "tools" && !last.tools.length) { stream.segments.pop(); continue }
    break
  }
}

function sealLastThinking(stream: StreamAgg): void {
  const last = stream.segments[stream.segments.length - 1]
  if (last?.type !== "thinking" || last.ms != null) return
  // startedAt 缺失也要封存，否则后续思考会并进同一块
  last.ms = last.startedAt != null ? Date.now() - last.startedAt : 0
}

/** 入队思考：与上一块同类则合并，否则新开；空文本丢弃 */
function enqueueThinking(stream: StreamAgg, text: string): void {
  if (!text) return
  dropEmptyTail(stream)
  if (stream.forceNewThinking) {
    stream.forceNewThinking = false
    sealLastThinking(stream)
    stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
    stream.dirty = true
    return
  }
  const last = stream.segments[stream.segments.length - 1]
  if (last?.type === "thinking" && last.ms == null) {
    last.text += text
    return
  }
  if (last?.type === "thinking") {
    // 已封存 → 新开一块
    stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
    return
  }
  sealLastThinking(stream)
  stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
}

/** updateTodos 工具调用：解析任务快照（merge=true 按 id 合并），原地刷新时间线中的任务清单段 */
function isTodoUpdateInvocation(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[_-]/g, "")
  return n === "updatetodos" || n === "todowrite" || n === "writetodos"
}

/** status 归一化：事件里是驼峰（inProgress），渲染映射用下划线（in_progress） */
function normalizeTodoStatus(s: unknown): string {
  const n = String(s ?? "").trim().replace(/[-_\s]/g, "").toLowerCase()
  if (n === "inprogress") return "in_progress"
  if (n === "completed" || n === "done") return "completed"
  if (n === "cancelled" || n === "canceled") return "cancelled"
  return "pending"
}

/**
 * 基于真实事件形态（实测）设计：
 * - 同一次调用会发多个 running 事件，args.todos 从 1 项流式增长到本次调用的全部项；
 * - 事件里无 id、无 merge 字段；status 为驼峰。
 * 因此按 content 匹配「合并」到会话级快照（跨换卡存活）：命中更新状态、未命中追加；
 * 仅当新清单与快照零交集时才视为全新清单整体替换。
 */
function applyTodoUpdate(session: SdkSessionAgent, stream: StreamAgg, args: unknown): void {
  if (typeof args === "string") {
    try { args = JSON.parse(args) } catch { return }
  }
  if (!args || typeof args !== "object") return
  const rec = args as { todos?: unknown }
  if (!Array.isArray(rec.todos)) return
  const incoming: StreamTodoItem[] = []
  for (const t of rec.todos) {
    if (!t || typeof t !== "object") continue
    const item = t as { id?: unknown; content?: unknown; status?: unknown }
    const content = typeof item.content === "string" ? item.content.trim() : ""
    if (!content) continue
    incoming.push({
      id: typeof item.id === "string" ? item.id : undefined,
      content,
      status: normalizeTodoStatus(item.status),
    })
  }
  if (!incoming.length) return

  const snapshot = session.todoSnapshot ?? []
  const sameItem = (a: StreamTodoItem, b: StreamTodoItem): boolean =>
    (!!a.id && a.id === b.id) || a.content === b.content
  const overlap = incoming.filter((inc) => snapshot.some((x) => sameItem(inc, x))).length
  if (snapshot.length && overlap === 0) {
    // 零交集 = 全新任务清单：整体替换
    session.todoSnapshot = incoming
  } else {
    for (const inc of incoming) {
      const hit = snapshot.find((x) => sameItem(inc, x))
      if (hit) {
        hit.status = inc.status
        if (inc.id && !hit.id) hit.id = inc.id
      } else {
        snapshot.push(inc)
      }
    }
    session.todoSnapshot = snapshot
  }
  pushUiLog("SDK", "DEBUG",
    `[${session.sessionKey}] [todos] incoming=${incoming.length} overlap=${overlap} snapshot=${session.todoSnapshot.length}`)

  let seg = stream.segments.find((s): s is Extract<StreamSegment, { type: "todos" }> => s.type === "todos")
  if (!seg) {
    dropEmptyTail(stream)
    sealLastThinking(stream)
    seg = { type: "todos", items: [] }
    stream.segments.push(seg)
  }
  seg.items = session.todoSnapshot.map((t) => ({ ...t }))
  stream.dirty = true
}

/** 入队工具：callId 已存在则更新；running 新开步；孤儿终态事件（上一回合遗留）丢弃 */
function enqueueTool(
  stream: StreamAgg,
  event: { call_id: string; name: string; args?: unknown; status: StreamToolEntry["status"] },
  summary: string,
): void {
  for (const seg of stream.segments) {
    if (seg.type !== "tools") continue
    const hit = seg.tools.find((x) => x.callId === event.call_id)
    if (!hit) continue
    hit.status = event.status
    if (summary) hit.summary = summary
    if (event.status === "running") {
      hit.startedAt = Date.now()
      hit.ms = undefined
    } else if (hit.startedAt != null && (event.status === "completed" || event.status === "error")) {
      hit.ms = Date.now() - hit.startedAt
    }
    return
  }
  // 终态事件但队列里没有对应步：running 落在换卡前的旧队列，别在新卡凭空造一个孤儿步
  if (event.status !== "running") return
  dropEmptyTail(stream)
  sealLastThinking(stream)
  let toolsSeg = stream.segments[stream.segments.length - 1]
  if (toolsSeg?.type !== "tools") {
    toolsSeg = { type: "tools", tools: [] }
    stream.segments.push(toolsSeg)
  }
  toolsSeg.tools.push({
    callId: event.call_id,
    name: resolveToolDisplayName(event.name, event.args),
    status: event.status,
    summary,
    startedAt: event.status === "running" ? Date.now() : undefined,
  })
}

/** 出站 payload：只按队列顺序输出，空段丢弃；SDK reply 残段并入思考 */
function buildStreamPayload(agg: StreamAgg, sessionKey: string): StreamCardPayload {
  const showThinking = isShowThinkingEnabled(sessionKey)
  sealClosedThinking(agg)
  const segments: StreamCardPayload["segments"] = []
  const lastIdx = agg.segments.length - 1
  for (let i = 0; i < agg.segments.length; i++) {
    const seg = agg.segments[i]
    if (seg.type === "thinking") {
      const text = seg.text.trim()
      if (!text || !showThinking) continue
      let thinking = text
      if (thinking.length > STREAM_THINKING_TAIL) {
        thinking = "…" + thinking.slice(-STREAM_THINKING_TAIL)
      }
      const ms = seg.ms ?? (i === lastIdx && seg.startedAt != null ? Date.now() - seg.startedAt : undefined)
      // 不合并相邻思考：每块独立面板独立计时，避免旧思考被新思考顶出截断窗口
      segments.push({ type: "thinking", text: thinking, ms })
    } else if (seg.type === "tools") {
      if (!seg.tools.length) continue
      const tools = seg.tools.length > MAX_STREAM_TOOL_STEPS
        ? seg.tools.slice(-MAX_STREAM_TOOL_STEPS)
        : seg.tools
      const prev = segments[segments.length - 1]
      if (prev?.type === "tools") {
        prev.tools.push(...tools.map((t) => ({
          name: t.name,
          status: t.status,
          summary: t.summary || undefined,
          ms: t.ms,
        })))
      } else {
        segments.push({
          type: "tools",
          tools: tools.map((t) => ({
            name: t.name,
            status: t.status,
            summary: t.summary || undefined,
            ms: t.ms,
          })),
        })
      }
    } else if (seg.type === "todos") {
      if (!seg.items.length) continue
      segments.push({ type: "todos", items: seg.items.map((t) => ({ content: t.content, status: t.status })) })
    } else if (seg.type === "reply") {
      // 兼容残段：SDK 正文视作思考（独立块，不并入上一块）
      const text = seg.text.trim()
      if (!text || !showThinking) continue
      let thinking = text
      if (thinking.length > STREAM_THINKING_TAIL) {
        thinking = "…" + thinking.slice(-STREAM_THINKING_TAIL)
      }
      segments.push({ type: "thinking", text: thinking })
    }
  }
  return { segments }
}


async function postStreamCard(
  sessionKey: string,
  action: "ensure" | "update" | "finish",
  payload: StreamCardPayload,
  opts?: { cardId?: string; queueBornAt?: number },
): Promise<{ cardId?: string; gone?: boolean } | undefined> {
  const lock = readLockFile()
  if (!lock?.port) return undefined
  try {
    const r = await httpPost(
      `http://127.0.0.1:${lock.port}/api/agent-stream-card`,
      {
        session_key: sessionKey,
        action,
        segments: payload.segments,
        ...(opts?.cardId ? { card_id: opts.cardId } : {}),
        ...(opts?.queueBornAt ? { queue_born_at: opts.queueBornAt } : {}),
      },
      15_000,
    ) as { ok?: boolean; skipped?: boolean; error?: string; cardId?: string; gone?: boolean } | null
    if (r && r.ok === false && !r.skipped) {
      pushUiLog("SDK", "DEBUG", `[${sessionKey}] 流式卡片 ${action} 失败: ${r.error || "unknown"}`)
    }
    if (r?.gone) return { gone: true }
    return r?.cardId ? { cardId: r.cardId } : undefined
  } catch (e: unknown) {
    pushUiLog("SDK", "DEBUG", `[${sessionKey}] 流式卡片 ${action} 异常: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

/** daemon 判定本队列已随旧卡收口（gone）：丢弃旧时间线，换新空队列——后续新内容走新卡 */
function dropStaleStreamQueue(session: SdkSessionAgent, agg: StreamAgg): void {
  agg.finished = true
  pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] 流式卡队列已随收口作废，丢弃旧时间线`)
  if (session.streamAgg === agg) {
    session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
  }
}

function scheduleFlushStreamCard(session: SdkSessionAgent, immediate = false): void {
  const agg = session.streamAgg
  if (!agg || agg.finished) return
  agg.dirty = true
  if (immediate) {
    if (agg.timer) {
      clearTimeout(agg.timer)
      agg.timer = null
    }
    void flushStreamCard(session, false)
    return
  }
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
  // 空 payload 不建卡（只有会话条的空白卡会闪现给用户）；保留 dirty 等真内容
  if (!finish && !agg.ensured && payload.segments.length === 0) return
  agg.dirty = false
  agg.lastFlushAt = Date.now()
  // 同步标记，防止 status FINISHED 与 stream finally 双重 finish
  if (finish) agg.finished = true

  const run = async (): Promise<void> => {
    if (finish) {
      // 与 endStreamRound 对齐：无 cardId 不 finish，防误杀 MCP 新卡
      if (!agg.cardId) return
      await postStreamCard(session.sessionKey, "finish", payload, { cardId: agg.cardId })
      patchResumableStreamCard(session.sessionKey, undefined, { onlyIf: agg.cardId })
      return
    }
    // finish 已抢占：丢弃排队中的 update
    if (agg.finished) return
    if (!agg.ensured) {
      const ensured = await postStreamCard(session.sessionKey, "ensure", payload, { queueBornAt: agg.bornAt })
      if (ensured?.gone) {
        dropStaleStreamQueue(session, agg)
        return
      }
      agg.ensured = true
      if (ensured?.cardId) {
        agg.cardId = ensured.cardId
        patchResumableStreamCard(session.sessionKey, ensured.cardId)
      }
      // Resume 复用 Daemon 已有卡时，ensure 本身不写内容，再补一帧 update
      const updated = await postStreamCard(session.sessionKey, "update", payload, { cardId: agg.cardId, queueBornAt: agg.bornAt })
      if (updated?.gone) {
        dropStaleStreamQueue(session, agg)
        return
      }
      if (!agg.cardId && updated?.cardId) {
        agg.cardId = updated.cardId
        patchResumableStreamCard(session.sessionKey, updated.cardId)
      }
      return
    }
    const updated = await postStreamCard(session.sessionKey, "update", payload, { cardId: agg.cardId, queueBornAt: agg.bornAt })
    if (updated?.gone) {
      dropStaleStreamQueue(session, agg)
      return
    }
    if (!agg.cardId && updated?.cardId) {
      agg.cardId = updated.cardId
      patchResumableStreamCard(session.sessionKey, updated.cardId)
    }
  }

  agg.inflight = agg.inflight.then(run, run)
  await agg.inflight
}

// ── 工具调用识别：优先结构化解析 args，字符串匹配只留给 shell command ──
// tool_call 事件本身是结构化的：MCP 工具有 args.toolName，shell 有 args.command。
// 严禁把整个 args 序列化后模糊匹配——Task 的 prompt / send_text 的 text 等长文本里
// 出现 "poll-message"、"send_text" 字样就会整体误判（Subagent 步被隐藏、卡片被错误收口）。

/** MCP 调用的目标工具名（args.toolName / tool_name）；非 MCP 调用返回 "" */
function mcpToolName(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  for (const key of ["toolName", "tool_name"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

/** shell 类工具的命令文本；非 shell 调用返回 "" */
function shellCommandText(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v
  }
  return ""
}

/** cursor-claw 出站工具（已有独立飞书消息，不进流式工具区） */
const OUTBOUND_MCP_RE = /^(?:send_(?:text|question|image|file)|project_\w+)$/i
const MEDIA_MCP_RE = /^send_(?:file|image)$/i

function isPollMessageInvocation(name: string, summary: string, args?: unknown): boolean {
  // MCP 调用（含 send_*）绝不可能是 poll 的 curl 命令；text 参数里聊到 poll-message 不算
  if (mcpToolName(args)) return false
  const cmd = shellCommandText(args)
  if (cmd) return /poll-message/i.test(cmd)
  // args 缺失（部分事件只有摘要）：summary 对 shell 是 command 截断，可兜底
  return /poll-message/i.test(summary)
}

/** 仅阻塞 poll 才换卡。必须看完整 command（摘要 120 字会裁掉 wait=false） */
function isBlockingPollMessage(name: string, summary: string, args?: unknown): boolean {
  if (!isPollMessageInvocation(name, summary, args)) return false
  const full = shellCommandText(args) || summary
  if (/wait\s*=\s*false/i.test(full)) return false
  if (/["']wait["']\s*:\s*false/i.test(full)) return false
  if (/wait%3[Dd]false/i.test(full)) return false
  return true
}

/** 仅隐藏本通道出站 MCP（send_text 等）与 poll；其它 MCP/工具都进流式工具区 */
function shouldOmitFromStreamCard(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return OUTBOUND_MCP_RE.test(mcp)
  if (OUTBOUND_MCP_RE.test(name.trim())) return true
  if (isPollMessageInvocation(name, summary, args)) return true
  // MCP 退避方案：shell curl 直连 daemon HTTP API 也是出站
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-(?:text|question|image|file)/i.test(cmd)
}

/** send_file / send_image：独立消息，完成后必须换回合，否则 daemon seal 后 SDK 会 ensure 复制整卡 */
function isMediaSendInvocation(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return MEDIA_MCP_RE.test(mcp)
  if (MEDIA_MCP_RE.test(name.trim())) return true
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-(?:file|image)/i.test(cmd)
}

/** MCP 工具展示名：优先 args.toolName / tool_name；Task/subagent 加可见标记 */
function resolveToolDisplayName(name: string, args: unknown): string {
  const raw = name.trim()
  const isTask = /^task$/i.test(raw) || /^task\b/i.test(raw)
  let label = raw
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>
    if (isTask) {
      const desc = typeof rec.description === "string" ? rec.description.trim()
        : typeof rec.prompt === "string" ? rec.prompt.trim().slice(0, 80) : ""
      const sub = typeof rec.subagent_type === "string" ? rec.subagent_type.trim() : ""
      label = desc ? `🤖 Subagent · ${desc}` : sub ? `🤖 Subagent · ${sub}` : "🤖 Subagent"
      return label
    }
    for (const key of ["toolName", "tool_name", "name"]) {
      const v = rec[key]
      if (typeof v === "string" && v.trim()) {
        const server = typeof rec.serverName === "string" ? rec.serverName
          : typeof rec.server === "string" ? rec.server : ""
        return server ? `${server}/${v.trim()}` : v.trim()
      }
    }
  }
  return isTask ? "🤖 Subagent" : label
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

/** poll 结果里 freshIds 非空 = 拉到新用户消息（重投属于当前回合，不算回合边界） */
function pollResultHasFreshMessages(result: unknown): boolean {
  return /"freshIds"\s*:\s*\[\s*"/.test(extractToolResultText(result))
}

/**
 * 拉起后通知 daemon：resumed=false 全新会话（收口上一 run 残留流式卡）。失败静默＝降级默认行为。
 */
async function notifySessionLaunched(sessionKey: string, resumed: boolean): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    await httpPost(
      `http://127.0.0.1:${lock.port}/api/session-launched`,
      { session_key: sessionKey, resumed },
      5_000,
    )
  } catch { /* best-effort */ }
}

/**
 * 回合结束（阻塞 poll 挂起 / 干活途中拉到新消息）：
 * 同步换新队列，旧卡异步 finish 收口——后续事件自动落新卡。
 */
function endStreamRound(session: SdkSessionAgent): void {
  const agg = session.streamAgg
  if (!agg) {
    session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
    return
  }
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  const finishCardId = agg.cardId
  // 仅收口本 SDK 队列建过的卡；无 cardId 时 finish 会误杀 MCP 刚建的卡（拆卡/空卡）
  const shouldPost = !agg.finished && !!finishCardId
  agg.finished = true
  sealAllThinking(agg)
  sealRunningTools(agg)
  // 回合边界已过 bootstrap，新队列直接开门
  session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
  if (!shouldPost) return
  const payload = buildStreamPayload(agg, session.sessionKey)
  // 必须带上旧卡 cardId：延迟 finish 不能误杀下一轮 MCP/SDK 新建的卡
  const finishAndClear = async (): Promise<void> => {
    await postStreamCard(session.sessionKey, "finish", payload, { cardId: finishCardId })
    // 已收口的卡不再留给 Resume 孤儿收口（条件清，防抹掉新回合的卡）
    patchResumableStreamCard(session.sessionKey, undefined, { onlyIf: finishCardId })
  }
  agg.inflight = agg.inflight.then(finishAndClear, finishAndClear)
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
        sealRunningTools(agg)
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
          // 阻塞 poll 挂起期间不刷卡（避免重复 poll 思考落成新卡）
          if (stream?.pendingBlockingPoll) continue
          // SDK 正文视作思考，不进用户可见正文区
          if (stream && !stream.finished && isShowThinkingEnabled(session.sessionKey)) {
            enqueueThinking(stream, block.text)
            scheduleFlushStreamCard(session)
          }
        }
      }
      break
    case "thinking":
      if (event.text) {
        appendSdkLog(session, "thinking", event.text)
        if (stream?.pendingBlockingPoll) break
        if (stream && !stream.finished && isShowThinkingEnabled(session.sessionKey)) {
          enqueueThinking(stream, event.text)
          scheduleFlushStreamCard(session)
        }
      }
      break
    case "tool_call": {
      flushSdkLog(session)
      const summary = event.status === "running" ? summarizeToolArgs(event.args) : ""
      const detectSummary = summary || summarizeToolArgs(event.args) || ""
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] [tool] ${event.name}: ${event.status}${summary ? ` · ${summary}` : ""}`)
      if (stream && !stream.finished) {
        if (isPollMessageInvocation(event.name, detectSummary, event.args)) {
          const blocking = isBlockingPollMessage(event.name, detectSummary, event.args)
          if (event.status === "running") {
            if (blocking) {
              // 已在等第一条阻塞 poll：忽略重复 running，防再 endStreamRound 刷卡
              if (stream.pendingBlockingPoll) break
              // 挂阻塞 poll = 本回合结束：收口当前卡；新队列关门，挂起期间不刷思考卡
              endStreamRound(session)
              const next = session.streamAgg
              if (next) {
                next.gateOpen = false
                next.pendingBlockingPoll = true
              }
            } else {
              stream.pendingNonBlockingPoll = true
            }
            break
          }
          // poll 返回
          const wasNonBlocking = stream.pendingNonBlockingPoll
          const wasBlocking = stream.pendingBlockingPoll
          stream.pendingNonBlockingPoll = false
          stream.pendingBlockingPoll = false
          if (wasNonBlocking && stream.gateOpen && pollResultHasFreshMessages(event.result)) {
            // 干活途中拉到新消息：回合边界（重投是当前回合的活，不换卡）
            endStreamRound(session)
            break
          }
          if (wasNonBlocking && !stream.gateOpen) {
            // 冷启动预热：丢弃 poll 前的推理噪音，保留已入队工具
            stream.segments = stream.segments.filter((s) => s.type === "tools" && s.tools.length > 0)
            stream.dirty = stream.segments.length > 0
          }
          // 阻塞 poll 仅在真正拉到新消息时开门；超时/空结果保持关门
          if (wasBlocking && !pollResultHasFreshMessages(event.result)) {
            stream.gateOpen = false
            break
          }
          if (wasBlocking) {
            // 拿到新消息 = 新回合：重开队列。bornAt 晚于 daemon 投递时打的 gone 标记，
            // 新回合思考不会被 gone 误丢（曾致换卡后思考全部不渲染）；顺带丢掉挂起期间的收尾念叨
            session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
            break
          }
          stream.gateOpen = true
          break
        }
        // 非 poll 工具 = 真实工作开始：开门；poll completed 事件若丢失（工具桥中断）
        // pendingBlockingPoll 会残留，这里顺手复位，避免本回合思考永久不进卡
        stream.gateOpen = true
        stream.pendingBlockingPoll = false
        // updateTodos：独立任务清单面板（原地实时刷新），不进普通工具步。
        // running/completed 都应用一次（幂等）：running 的 args 偶见缺失/截断，completed 兜底
        if (isTodoUpdateInvocation(event.name)) {
          applyTodoUpdate(session, stream, event.args)
          scheduleFlushStreamCard(session, true)
          break
        }
        if (shouldOmitFromStreamCard(event.name, detectSummary, event.args)) {
          if (isMediaSendInvocation(event.name, detectSummary, event.args)) {
            if (event.status === "running") {
              sealLastThinking(stream)
              stream.forceNewThinking = true
              scheduleFlushStreamCard(session, true)
            } else {
              // completed/error：与 daemon seal 对齐，换新队列，防复制整卡 / 思考中挂起
              endStreamRound(session)
            }
            break
          }
          if (event.status === "running") {
            // send_* 是正文边界：封存当前思考块，后续思考强制新开
            sealLastThinking(stream)
            stream.forceNewThinking = true
            scheduleFlushStreamCard(session, true)
          }
          break
        }
        enqueueTool(stream, event, summary)
        scheduleFlushStreamCard(session, event.status === "running")
      }
      break
    }
    case "status": {
      flushSdkLog(session)
      const isErr = event.status === "ERROR" || event.status === "EXPIRED"
      // 含 RUNNING：换模等待依赖 lastStatus，不能只记终态
      session.lastStatus = { status: event.status, message: event.message }
      const lvl = isErr ? "ERROR" as const : "INFO" as const
      pushUiLog("SDK", lvl, `[${session.sessionKey}] [status] ${event.status}${event.message ? ` - ${event.message}` : ""}`)
      // FINISHED / 终态：尽快收口流式卡（finally 还会再 finish 一次，daemon 侧幂等）
      if (stream && (event.status === "FINISHED" || event.status === "ERROR" || event.status === "CANCELLED" || event.status === "EXPIRED")) {
        sealAllThinking(stream)
        sealRunningTools(stream)
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
      todoSnapshot: null,
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
    // pack/进程重启后 daemon 内存无卡，飞书旧流式卡仍在：Resume 前先按持久化 cardId 收口，避免再建一张重复卡
    if (resumed && resumable?.streamCardId && session.streamAgg) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] Resume 收口孤儿流式卡 card=${resumable.streamCardId}`)
      await postStreamCard(sessionKey, "finish", { segments: [] }, { cardId: resumable.streamCardId })
      patchResumableStreamCard(sessionKey, undefined, { onlyIf: resumable.streamCardId })
    }
    // 发 prompt 前通知 daemon 拉起形态：Resume 打 fresh-only 标；全新会话收残留旧卡
    await notifySessionLaunched(sessionKey, resumed)
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
  // 残留的 poll 连接无需专门收口：新回合的任意 poll 会顶掉它，claimed 消息下次 poll 重新可见
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

async function waitSdkPendingLaunch(sessionKey: string, ms = 12_000): Promise<void> {
  const deadline = Date.now() + ms
  while (pendingLaunches.has(sessionKey) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * 仅本会话切换模型：写 override；有 live 则停当前 run（保留 resume）。
 * 不主动拉起——有队列消息时由调度器拉起，否则下次唤醒生效。
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

  // 先等掉进行中的拉起，避免 pendingLaunches 合流后旧模型占坑
  await waitSdkPendingLaunch(sessionKey)

  const live = sdkSessions.get(sessionKey)
  if (live) {
    pushUiLog("SDK", "INFO", `[${sessionKey}] 换模：停止当前 run，记下 ${mid}（有消息再拉起）`)
    await releaseSession(live)
    broadcastSdkSessionStatus()
  } else {
    pushUiLog("SDK", "INFO", `[${sessionKey}] 已记下模型 ${mid}（下次唤醒生效）`)
  }
  // 日志带完整 key 后缀，避免飞书/微信同目录都显示「📂 xxx」看不出切到哪
  const chatPart = sessionKey.includes("::") ? sessionKey.slice(0, sessionKey.indexOf("::")) : sessionKey
  pushUiLog("SDK", "INFO", `[${sessionKey}] 切模目标 chat=${chatPart} → ${mid}`)
  return { ok: true, deferred: true }
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
