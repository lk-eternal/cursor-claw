import { Agent, type SDKAgent, type Run, type SDKMessage } from "@cursor/sdk"
import { app } from "electron"
import { resolve, join, dirname } from "node:path"
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import { type ChatType, type LaunchMeta, buildPrompt, resolveSessionChatName } from "./agent-launcher"
import { getAgentResource, resolveChannelForSession } from "./config-store"
import {
  initSessionModelStore,
  resolveModelForSession,
  setSessionOverride,
  pushRecentModel,
} from "../src/shared/session-model-store.js"
import { modelSlugFromParams, rememberModelLabel } from "../src/shared/model-utils.js"
import { projectIdFromSessionKey } from "../src/shared/project-types.js"

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
const sdkFailStreak = new Map<string, { count: number; lastFailAt: number }>()

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

/** 失败冷却剩余毫秒：2s→60s 指数递增，超 8 次降频为 10 分钟一次（自愈不放弃） */
export function sdkFailCooldownRemaining(sessionKey: string): number {
  const st = sdkFailStreak.get(sessionKey)
  if (!st) return 0
  const cool = st.count > 8 ? 10 * 60_000 : Math.min(60_000, 2_000 * Math.pow(2, Math.min(st.count - 1, 5)))
  return Math.max(0, st.lastFailAt + cool - Date.now())
}

function scheduleSdkIdle(sessionKey: string, errored: boolean): void {
  if (errored) {
    const st = sdkFailStreak.get(sessionKey) ?? { count: 0, lastFailAt: 0 }
    st.count += 1
    st.lastFailAt = Date.now()
    sdkFailStreak.set(sessionKey, st)
    pushUiLog("SDK", st.count > 8 ? "ERROR" : "WARN",
      `[${sessionKey}] 异常结束（连续第 ${st.count} 次），冷却后由调度器重试；新消息随时放行`)
  } else {
    const prev = sdkFailStreak.get(sessionKey)
    clearSdkFailStreak(sessionKey)
    if (prev && prev.count >= 2) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] 已恢复（曾连续失败 ${prev.count} 次）`)
    }
  }
  // 成功失败都立即叫醒调度器：是否真正拉起由调度器按队列与冷却决定
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
  }
}

// 工具入参摘要：按优先级挑最有信息量的字符串字段（Shell→command、Read→path、Grep→pattern…）
const TOOL_ARG_SUMMARY_KEYS = ["command", "path", "target_notebook", "pattern", "glob_pattern", "file_path", "image_path", "url", "query", "question", "text", "description", "name"]
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
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) appendSdkLog(session, "text", block.text)
      }
      break
    case "thinking":
      if (event.text) appendSdkLog(session, "thinking", event.text)
      break
    case "tool_call": {
      flushSdkLog(session)
      // 摘要只随发起（running）打一次，完成/失败行保持简短避免刷屏
      const summary = event.status === "running" ? summarizeToolArgs(event.args) : ""
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] [tool] ${event.name}: ${event.status}${summary ? ` · ${summary}` : ""}`)
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
    }
      break
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
    const level = run.status === "error" ? "ERROR" : "INFO"

    let errorDetail: string | undefined
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
      errorDetail = `${lastStr}${detail}${netHint ? ` | 疑似底层网络/代理错误: ${netHint}` : ""}`.slice(0, 800)
      pushUiLog("SDK", "ERROR", `[${sessionKey}] 运行错误详情: ${errorDetail}`)
    }

    lastRunResults.set(sessionKey, {
      status: run.status ?? "unknown",
      endedAt: Date.now(),
      durationMs: run.durationMs ?? undefined,
      error: errorDetail,
    })

    const summary = [
      run.result && `result=${run.result}`,
      run.durationMs != null && `duration=${run.durationMs}ms`,
    ].filter(Boolean).join(", ")
    pushUiLog("SDK", level, `[${sessionKey}] Agent 运行结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)

    session.run = null
    const errored = run.status === "error"
    closeAndRemoveSession(session)
    broadcastSdkSessionStatus()
    // 成功立即调度；失败指数退避，避免 4s 一轮硬重试风暴
    scheduleSdkIdle(sessionKey, errored)
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
    // 失败计数不在拉起时清零（断网时 Resume 总能成功、run 中途才死，清了会导致退避永不生效）：
    // run 成功跑完由 scheduleSdkIdle 清零；新消息经 hasPending 无视冷却立即放行
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
