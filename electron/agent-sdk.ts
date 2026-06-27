import { Agent, type SDKAgent, type Run, type SDKMessage } from "@cursor/sdk"
import { resolve, join, dirname } from "node:path"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { readLockFile, httpPost, reportSessionAgentPhase } from "./daemon-client"
import { getChannel } from "./config-store"
import { parseChatKey } from "../src/shared/channel-types"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import { type ChatType, type LaunchMeta, buildPrompt, resolveSessionChatName } from "./agent-launcher"

interface SdkSessionAgent {
  sessionKey: string
  agent: SDKAgent
  run: Run | null
  agentId: string
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  workspaceDir?: string
  senderOpenId?: string
  chatName?: string
  abortController: AbortController
  /** 流式日志聚合缓冲：连续同类型(thinking/text)增量合并成一条打印 */
  logAgg: { kind: "thinking" | "text" | null; buf: string }
  /** 主用户私聊 SDK 流式桥接（f41Eligible） */
  f41Stream: boolean
  streamBuffer: string
  outboundMessageId?: string
  streamId?: string
  streamLastPostAt?: number
  streamPostTimer?: ReturnType<typeof setTimeout>
  /** stream-text POST 串行链，避免并发首包 */
  streamPostChain?: Promise<void>
  errorNotified?: boolean
  /** 最近一次终态状态事件（ERROR/EXPIRED/CANCELLED），用于结束时还原真实错误原因 */
  lastStatus?: { status: string; message?: string }
  /** 末次 tool 事件快照，供 error 日志与保活失败分类 */
  lastTool?: { name: string; status: string }
}

const sdkSessions = new Map<string, SdkSessionAgent>()
const pendingLaunches = new Set<string>()
const failedCooldowns = new Map<string, number>()
const FAIL_COOLDOWN_MS = 30_000
const NOTIFY_PROCESSING = "Agent 处理中…"
const STREAM_POST_INTERVAL_MS = 400
/** 观测约 23min 档 Run 超时；低于此阈值的 shell+running 不误判为保活失败 */
const KEEPALIVE_TIMEOUT_MS = 20 * 60 * 1000

function isUnsafeSdkMessage(msg?: string): boolean {
  const t = msg?.trim()
  return !t || /[/\\]|\.ts:|at |stack|Error:|ENOENT|spawn|EACCES|EPERM/i.test(t)
}

function extractErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const code = (value as { errorCode?: unknown }).errorCode
  return code != null && String(code).trim() ? String(code) : undefined
}

function extractChatId(sessionKey: string): string {
  const idx = sessionKey.indexOf("::")
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey
}

/** 主用户私聊 + SDK 资源 → 可走 /api/stream-text（resource.type 在 agent-sdk 内恒为 sdk） */
function f41Eligible(sessionKey: string, chatType: ChatType): boolean {
  if (chatType !== "p2p") return false
  const chatId = extractChatId(sessionKey)
  const { channelId, chatId: raw } = parseChatKey(chatId)
  const channel = getChannel(channelId)
  if (!channel?.mainUserEnabled || !channel.mainUserChatId?.trim()) return false
  return raw === channel.mainUserChatId.trim()
}

function formatSdkStreamFailure(
  status?: string,
  message?: string,
  ctx?: { lastTool?: { name: string; status: string }; durationMs?: number },
): string {
  const st = status?.toUpperCase()
  if (st === "CANCELLED") return "Agent 任务已取消。"
  if (st === "EXPIRED") return "Agent 会话已过期，请重新发送消息。"
  const lt = ctx?.lastTool
  const isKeepaliveTimeout =
    lt?.name === "shell" &&
    lt.status.toLowerCase() === "running" &&
    ctx?.durationMs != null &&
    ctx.durationMs >= KEEPALIVE_TIMEOUT_MS
  if (isKeepaliveTimeout && isUnsafeSdkMessage(message)) {
    return "会话在等待下一条消息时已结束（等待超时）。请重新发送消息，我会继续为你处理。"
  }
  const msg = message?.trim()
  if (msg && !isUnsafeSdkMessage(msg)) {
    return `⚠️ Agent 处理失败：${msg}`
  }
  return "⚠️ Agent 处理失败，请稍后重试。"
}

async function notifySdkFailure(session: SdkSessionAgent, override?: string): Promise<void> {
  if (session.errorNotified || session.abortController.signal.aborted) return
  session.errorNotified = true
  const last = session.lastStatus
  const text = override ?? formatSdkStreamFailure(last?.status, last?.message, {
    lastTool: session.lastTool,
    durationMs: session.run?.durationMs ?? undefined,
  })
  await notifySessionChat(session.sessionKey, text, true)
}

interface StreamTextPayload {
  session_key: string
  text: string
  stream_id?: string
  outbound_message_id?: string
  final?: boolean
}

async function postStreamText(session: SdkSessionAgent, payload: StreamTextPayload): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/stream-text`, payload, 5000)) as {
      ok?: boolean
      stream_id?: string
      outbound_message_id?: string
      error?: string
    }
    if (res?.stream_id) session.streamId = res.stream_id
    if (res?.outbound_message_id) session.outboundMessageId = res.outbound_message_id
    if (res?.ok === false && res.error) {
      pushUiLog("SDK", "WARN", `[${session.sessionKey}] stream-text 拒绝: ${res.error}`)
    }
  } catch (e: unknown) {
    pushUiLog("SDK", "WARN", `[${session.sessionKey}] stream-text 推送失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function clearStreamPostTimer(session: SdkSessionAgent): void {
  if (session.streamPostTimer) {
    clearTimeout(session.streamPostTimer)
    session.streamPostTimer = undefined
  }
}

function resetStreamPostChain(session: SdkSessionAgent): void {
  clearStreamPostTimer(session)
  session.streamPostChain = undefined
}

async function doFlushStreamPost(session: SdkSessionAgent, final: boolean): Promise<void> {
  clearStreamPostTimer(session)
  if (!session.f41Stream) return
  const text = session.streamBuffer
  if (!text.trim() && !final) return

  const payload: StreamTextPayload = {
    session_key: session.sessionKey,
    text,
  }
  if (session.streamId) payload.stream_id = session.streamId
  if (session.outboundMessageId) payload.outbound_message_id = session.outboundMessageId
  if (final) payload.final = true

  await postStreamText(session, payload)
  session.streamLastPostAt = Date.now()
}

function flushStreamPost(session: SdkSessionAgent, final: boolean): Promise<void> {
  session.streamPostChain = (session.streamPostChain ?? Promise.resolve())
    .then(() => doFlushStreamPost(session, final))
    .catch((e: unknown) => {
      pushUiLog("SDK", "WARN", `[${session.sessionKey}] stream-post chain 错误: ${e instanceof Error ? e.message : String(e)}`)
    })
  return session.streamPostChain
}

function scheduleStreamPost(session: SdkSessionAgent, final: boolean): void {
  if (!session.f41Stream) return
  if (final) {
    flushStreamPost(session, true)
    return
  }
  const now = Date.now()
  const elapsed = session.streamLastPostAt != null ? now - session.streamLastPostAt : STREAM_POST_INTERVAL_MS
  if (elapsed >= STREAM_POST_INTERVAL_MS) {
    flushStreamPost(session, false)
    return
  }
  if (session.streamPostTimer) return
  session.streamPostTimer = setTimeout(() => {
    session.streamPostTimer = undefined
    flushStreamPost(session, false)
  }, STREAM_POST_INTERVAL_MS - elapsed)
}

function appendStreamDelta(session: SdkSessionAgent, delta: string): void {
  session.streamBuffer += delta
  scheduleStreamPost(session, false)
}

async function notifySessionChat(sessionKey: string, text: string, stopProgress = false): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    await httpPost(`http://127.0.0.1:${lock.port}/api/send-text`, {
      text, session_key: sessionKey, ...(stopProgress && { stop_progress: true }),
    }, 5000)
  } catch (e: unknown) {
    broadcastLog(`[SDK Notify] 发送通知失败 (${sessionKey}): ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
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
    if (session.f41Stream && (session.streamBuffer.trim() || session.outboundMessageId)) {
      await flushStreamPost(session, true)
    }
  } catch (e: unknown) {
    flushSdkLog(session)
    if (!session.abortController.signal.aborted) {
      const msg = e instanceof Error ? `[${e.constructor.name}] ${e.message}` : String(e)
      const stack = e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : ""
      const cause = e instanceof Error && "cause" in e && e.cause ? JSON.stringify(e.cause) : ""
      pushUiLog("SDK", "ERROR", `[${session.sessionKey}] 流处理异常: ${msg}${stack ? ` stack=${stack}` : ""}${cause ? ` cause=${cause}` : ""}`)
      await notifySdkFailure(session)
    }
  }
}

function handleSdkEvent(session: SdkSessionAgent, event: SDKMessage): void {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          if (session.f41Stream) {
            appendStreamDelta(session, block.text)
          } else {
            appendSdkLog(session, "text", block.text)
          }
        }
      }
      break
    case "thinking":
      if (event.text) appendSdkLog(session, "thinking", event.text)
      break
    case "tool_call":
      flushSdkLog(session)
      session.lastTool = { name: event.name, status: event.status }
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] [tool] ${event.name}: ${event.status}`)
      break
    case "status": {
      flushSdkLog(session)
      const isErr = event.status === "ERROR" || event.status === "EXPIRED"
      if (isErr || event.status === "CANCELLED") {
        session.lastStatus = { status: event.status, message: event.message }
        if (!session.abortController.signal.aborted) {
          void notifySdkFailure(session)
        }
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
  return s !== undefined && !s.abortController.signal.aborted
}

export function getSdkSessionCount(): number {
  let count = 0
  for (const s of sdkSessions.values()) {
    if (!s.abortController.signal.aborted) count++
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

  pendingLaunches.add(sessionKey)

  const apiKey = opts.apiKey?.trim()
  if (!apiKey) {
    pendingLaunches.delete(sessionKey)
    return { ok: false, error: "通道绑定的 SDK 资源未配置 API Key（设置 → Agent）" }
  }

  const prompt = buildPrompt(meta, taskMessage, sessionKey, opts.useMainWorkspace)

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
      logAgg: { kind: null, buf: "" },
      f41Stream: f41Eligible(sessionKey, chatType),
      streamBuffer: "",
    }

    sdkSessions.set(sessionKey, session)
    pendingLaunches.delete(sessionKey)
    broadcastLog(`[SDK] 会话 ${sessionKey} 已创建, agentId=${agent.agentId}`)
    broadcastSdkSessionStatus()

    const run = await agent.send(prompt)
    session.run = run

    await notifySessionChat(sessionKey, NOTIFY_PROCESSING)
    await reportSessionAgentPhase(sessionKey, "processing")
    streamRunEvents(session, run).then(async () => {
      const level = run.status === "error" ? "ERROR" : "INFO"

      if (run.status === "error") {
        // wait() 返回 RunResult 对象（出错时也不抛），真实原因藏在 RunResult.result / 终态状态事件里
        const wr = await run.wait().catch((e: unknown) => e)
        const detail = wr instanceof Error ? `${wr.constructor.name}: ${wr.message}` : JSON.stringify(wr)
        const last = session.lastStatus
        const lt = session.lastTool
        const errorCode = extractErrorCode(wr) ?? extractErrorCode(last)
        const parts = [
          `sessionKey=${sessionKey}`,
          `agentId=${session.agentId}`,
          last && `lastStatus=${last.status}${last.message ? ` msg=${last.message}` : ""}`,
          run.result && `run.result=${run.result}`,
          run.durationMs != null && `durationMs=${run.durationMs}`,
          errorCode && `errorCode=${errorCode}`,
          lt && `lastTool=${lt.name}:${lt.status}`,
          `waitResult=${detail}`,
        ].filter(Boolean)
        pushUiLog("SDK", "ERROR", `[${sessionKey}] 运行错误详情: ${parts.join(" ")}`)
        failedCooldowns.set(sessionKey, Date.now() + FAIL_COOLDOWN_MS)
        if (!session.errorNotified) {
          await notifySdkFailure(session)
        }
      }

      const summary = [
        run.result && `result=${run.result}`,
        run.durationMs != null && `duration=${run.durationMs}ms`,
      ].filter(Boolean).join(", ")
      pushUiLog("SDK", level, `[${sessionKey}] Agent 运行结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)
      resetStreamPostChain(session)
      await reportSessionAgentPhase(sessionKey, "idle")
      try { session.agent.close() } catch { /* best-effort */ }
      sdkSessions.delete(sessionKey)
      broadcastSdkSessionStatus()
    })

    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[SDK] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    failedCooldowns.set(sessionKey, Date.now() + FAIL_COOLDOWN_MS)
    pendingLaunches.delete(sessionKey)
    const failed = sdkSessions.get(sessionKey)
    if (failed) try { failed.agent.close() } catch { /* best-effort */ }
    sdkSessions.delete(sessionKey)
    broadcastSdkSessionStatus()
    return { ok: false, error: msg }
  }
}

export function stopSdkSession(sessionKey: string): void {
  const s = sdkSessions.get(sessionKey)
  if (!s) return
  s.abortController.abort()
  resetStreamPostChain(s)
  if (s.run) {
    s.run.cancel().catch(() => {})
  }
  s.agent.close()
  sdkSessions.delete(sessionKey)
  void reportSessionAgentPhase(sessionKey, "idle")
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
        const nameCount = new Map<string, number>()
        for (const v of m.variants) nameCount.set(v.displayName, (nameCount.get(v.displayName) || 0) + 1)

        for (const v of m.variants) {
          const ps = JSON.stringify(v.params)
          const hasDup = (nameCount.get(v.displayName) || 0) > 1
          const suffix = hasDup ? ` (${v.params.map((p) => `${p.id}=${p.value}`).join(", ")})` : ""
          models.push({
            id: m.id,
            label: (v.displayName || m.displayName) + suffix,
            params: ps,
            current: m.id === currentModel && ps === currentParams,
          })
        }
      } else {
        models.push({
          id: m.id,
          label: m.displayName || m.id,
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
