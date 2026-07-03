import { Agent, type SDKAgent, type Run, type SDKMessage } from "@cursor/sdk"
import { resolve, join, dirname } from "node:path"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import { type ChatType, type LaunchMeta, buildPrompt, resolveSessionChatName } from "./agent-launcher"

interface SdkSessionAgent {
  sessionKey: string
  agent: SDKAgent
  /** 当前活跃 run；null = 温存续（agent 进程保留，等待下一次 send 免冷启动） */
  run: Run | null
  agentId: string
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  workspaceDir?: string
  senderOpenId?: string
  chatName?: string
  abortController: AbortController
  /** 通道开关：run 结束后是否保留 agent 进程（温存续） */
  keepSession: boolean
  /** 通道开关：是否长连接（无限 poll 保活）；false = 回答完即收回合，按需唤醒 */
  persistentPoll: boolean
  /** 流式日志聚合缓冲：连续同类型(thinking/text)增量合并成一条打印 */
  logAgg: { kind: "thinking" | "text" | null; buf: string }
  /** 最近一次终态状态事件（ERROR/EXPIRED/CANCELLED），用于结束时还原真实错误原因 */
  lastStatus?: { status: string; message?: string }
  /** 温存续闲置回收 */
  idleTimer?: ReturnType<typeof setTimeout>
}

const sdkSessions = new Map<string, SdkSessionAgent>()
const pendingLaunches = new Set<string>()
const failedCooldowns = new Map<string, number>()
const FAIL_COOLDOWN_MS = 30_000

// ── 温存续（会话保留）────────────────────────────────────
// keepSession=true 的 p2p/群聊会话在 run 结束后不释放 agent 进程：
// - 长连接模式下 run 意外断掉（网络抖动/平台侧中断），下一条消息温启动恢复，上下文保留；
// - 非长连接模式下回答完即收回合，新消息由调度器温启动唤醒，跳过 Agent.create 冷启动。
const WARM_IDLE_TTL_MS = 4 * 60 * 60 * 1000

function isWarmEligible(session: SdkSessionAgent): boolean {
  return session.keepSession && (session.chatType === "p2p" || session.chatType === "group")
}

function buildWakePrompt(session: SdkSessionAgent): string {
  return [
    "[SESSION_RESUME / 系统指令] 会话已由后台唤醒（历史上下文完整保留），有新消息待处理。",
    "立即执行：非阻塞检查 poll-message（wait=false），按 cursor-claw 协议处理所有消息并逐条回复，然后按 keep_alive 模式收尾。",
    "禁止向用户发送问候、唤醒说明等任何多余消息。",
    "---",
    "会话元数据:",
    `[session_key=${session.sessionKey}]`,
    `[chat_type=${session.chatType}]`,
    `[keep_alive=${session.persistentPoll}]`,
  ].join("\n")
}

let sdkIdleHandler: ((sessionKey: string) => void) | null = null

/** run 转入温存续后回调（调度器借此立即消费积压消息） */
export function setSdkIdleHandler(fn: (sessionKey: string) => void): void {
  sdkIdleHandler = fn
}

function closeAndRemoveSession(session: SdkSessionAgent): void {
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = undefined }
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
    case "tool_call":
      flushSdkLog(session)
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] [tool] ${event.name}: ${event.status}`)
      break
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
  // 温存续（run=null）视为未运行：新消息走 launchSdkAgent 的温续期路径
  return s !== undefined && !s.abortController.signal.aborted && s.run !== null
}

/** 是否存在可温启动唤醒的存续会话（秒级恢复，无需"正在启动"提示） */
export function hasWarmSdkSession(sessionKey: string): boolean {
  const s = sdkSessions.get(sessionKey)
  return s !== undefined && !s.abortController.signal.aborted && s.run === null
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
    idle: s.run === null,
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
  /** 通道开关：run 结束后保留 agent 进程（默认 true） */
  keepSession?: boolean
  /** 通道开关：长连接无限 poll 保活（默认 true；false = 回答完收回合按需唤醒） */
  persistentPoll?: boolean
}

/** run 生命周期托管：结束后按 keepSession 转温存续或释放 */
function startRunLifecycle(session: SdkSessionAgent, run: Run): void {
  session.run = run
  session.lastActivityAt = Date.now()

  streamRunEvents(session, run).then(async () => {
    const sessionKey = session.sessionKey
    const level = run.status === "error" ? "ERROR" : "INFO"

    if (run.status === "error") {
      // wait() 返回 RunResult 对象（出错时也不抛），真实原因藏在 RunResult.result / 终态状态事件里
      const wr = await run.wait().catch((e: unknown) => e)
      const detail = wr instanceof Error ? `${wr.constructor.name}: ${wr.message}` : JSON.stringify(wr)
      const last = session.lastStatus
      const lastStr = last ? `lastStatus=${last.status}${last.message ? ` msg=${last.message}` : ""} ` : ""
      pushUiLog("SDK", "ERROR", `[${sessionKey}] 运行错误详情: ${lastStr}waitResult=${detail}`)
      failedCooldowns.set(sessionKey, Date.now() + FAIL_COOLDOWN_MS)
    }

    const summary = [
      run.result && `result=${run.result}`,
      run.durationMs != null && `duration=${run.durationMs}ms`,
    ].filter(Boolean).join(", ")
    pushUiLog("SDK", level, `[${sessionKey}] Agent 运行结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)

    session.run = null
    if (isWarmEligible(session) && !session.abortController.signal.aborted) {
      session.idleTimer = setTimeout(() => {
        pushUiLog("SDK", "INFO", `[${sessionKey}] 温会话闲置 ${WARM_IDLE_TTL_MS / 3_600_000}h，释放 agent 进程`)
        closeAndRemoveSession(session)
        broadcastSdkSessionStatus()
      }, WARM_IDLE_TTL_MS)
      pushUiLog("SDK", "INFO", `[${sessionKey}] 会话转入温存续（agent 进程保留，新消息温启动免冷启动）`)
      broadcastSdkSessionStatus()
      // 收口期间可能已有积压消息，立即触发一次调度
      sdkIdleHandler?.(sessionKey)
    } else {
      closeAndRemoveSession(session)
      broadcastSdkSessionStatus()
    }
  })
}

/** 温启动唤醒：复用存活的 agent 进程直接 send，跳过 Agent.create 冷启动 */
async function wakeWarmSession(session: SdkSessionAgent, opts: SdkLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey } = session
  pendingLaunches.add(sessionKey)
  try {
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = undefined }
    // 开关热更新：唤醒时同步通道最新配置
    session.keepSession = opts.keepSession ?? true
    session.persistentPoll = (opts.keepSession ?? true) && (opts.persistentPoll ?? true)
    pushUiLog("SDK", "INFO", `[${sessionKey}] 温启动唤醒 (agentId=${session.agentId}, 免冷启动)`)
    const wakePrompt = buildWakePrompt(session)
    pushUiLog("SDK", "INFO", `[${sessionKey}] 唤醒 Prompt:\n${wakePrompt}`)
    const run = await session.agent.send(wakePrompt)
    startRunLifecycle(session, run)
    broadcastSdkSessionStatus()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    pushUiLog("SDK", "WARN", `[${sessionKey}] 温启动失败，将回退冷启动: ${msg}`)
    closeAndRemoveSession(session)
    broadcastSdkSessionStatus()
    return { ok: false, error: msg }
  } finally {
    pendingLaunches.delete(sessionKey)
  }
}

export async function launchSdkAgent(opts: SdkLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, workspaceDir, senderOpenId, chatName, taskMessage } = opts

  if (isSdkSessionRunning(sessionKey) || pendingLaunches.has(sessionKey)) {
    const s = sdkSessions.get(sessionKey)
    if (s) s.lastActivityAt = Date.now()
    return { ok: true }
  }

  const cooldownUntil = failedCooldowns.get(sessionKey)
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return { ok: false, error: `冷却中，${Math.ceil((cooldownUntil - Date.now()) / 1000)}s 后可重试` }
  }
  failedCooldowns.delete(sessionKey)

  // 温会话优先：agent 进程还活着，直接温启动唤醒
  const warm = sdkSessions.get(sessionKey)
  if (warm && !warm.abortController.signal.aborted && warm.run === null) {
    const woken = await wakeWarmSession(warm, opts)
    if (woken.ok) return woken
    // 温启动失败已清理会话，继续走冷启动
  }

  pendingLaunches.add(sessionKey)

  const apiKey = opts.apiKey?.trim()
  if (!apiKey) {
    pendingLaunches.delete(sessionKey)
    return { ok: false, error: "通道绑定的 SDK 资源未配置 API Key（设置 → Agent）" }
  }

  const keepSession = opts.keepSession ?? true
  const persistentPoll = keepSession && (opts.persistentPoll ?? true)
  const prompt = buildPrompt(meta, taskMessage, sessionKey, opts.useMainWorkspace, persistentPoll)

  try {
    ensureSdkBinaryPaths()

    const modelId = opts.model?.trim() && opts.model.trim() !== "auto" ? opts.model.trim() : "composer-2"
    const modelSelection: { id: string; params?: { id: string; value: string }[] } = { id: modelId }
    if (opts.modelParams?.trim()) {
      try {
        modelSelection.params = JSON.parse(opts.modelParams)
      } catch { /* ignore bad JSON */ }
    }
    pushUiLog("SDK", "INFO", `[${sessionKey}] 正在创建 SDK Agent (cwd=${workspaceDir}, model=${JSON.stringify(modelSelection)})`)

    const agent = await Agent.create({
      apiKey,
      model: modelSelection,
      local: {
        cwd: workspaceDir,
        settingSources: ["project", "user"],
        sandboxOptions: { enabled: false },
      },
    })

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
      senderOpenId,
      chatName,
      abortController,
      keepSession,
      persistentPoll,
      logAgg: { kind: null, buf: "" },
    }

    sdkSessions.set(sessionKey, session)
    broadcastLog(`[SDK] 会话 ${sessionKey} 已创建, agentId=${agent.agentId}`)
    broadcastSdkSessionStatus()

    pushUiLog("SDK", "INFO", `[${sessionKey}] 启动 Prompt:\n${prompt}`)
    const run = await agent.send(prompt)
    startRunLifecycle(session, run)

    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[SDK] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    failedCooldowns.set(sessionKey, Date.now() + FAIL_COOLDOWN_MS)
    const failed = sdkSessions.get(sessionKey)
    if (failed) closeAndRemoveSession(failed)
    broadcastSdkSessionStatus()
    return { ok: false, error: msg }
  } finally {
    pendingLaunches.delete(sessionKey)
  }
}

export function stopSdkSession(sessionKey: string): void {
  const s = sdkSessions.get(sessionKey)
  if (!s) return
  s.abortController.abort()
  if (s.run) {
    s.run.cancel().catch(() => {})
  }
  closeAndRemoveSession(s)
  broadcastSdkSessionStatus()
}

export function stopAllSdkSessions(): void {
  for (const key of [...sdkSessions.keys()]) {
    stopSdkSession(key)
  }
  failedCooldowns.clear()
  pendingLaunches.clear()
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

/** 变体参数合成 CLI 风格 slug：claude-4.6-opus + {thinking:true, context:max} → claude-4.6-opus-thinking-max */
function modelSlug(id: string, params: { id: string; value: string }[]): string {
  return id + params
    .filter((p) => p.value !== "false")
    .map((p) => (p.value === "true" ? `-${p.id}` : `-${p.value}`))
    .join("")
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
          models.push({
            id: m.id,
            label: hasDup ? `${slug} (${v.params.map((p) => `${p.id}=${p.value}`).join(", ")})` : slug,
            params: ps,
            current: m.id === currentModel && ps === currentParams,
          })
        }
      } else {
        models.push({
          id: m.id,
          label: m.id,
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
