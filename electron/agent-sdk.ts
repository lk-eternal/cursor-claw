import * as http from "node:http"
import { Agent, type SDKAgent, type Run, type SDKMessage } from "@cursor/sdk"
import { resolve, join, dirname } from "node:path"
import { existsSync, writeFileSync, mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { app } from "electron"
import { readLockFile, httpPost, reportSessionAgentPhase } from "./daemon-client"
import { getChannel, getAgentResource, resolveChannelForSession, resolveChannelModel, effectiveWorkspaceDir, type MessageChannel, type ModelScenario } from "./config-store"
import { parseChatKey } from "../src/shared/channel-types"
import {
  isFeishuProcessPresentationSuppressed as feishuSuppressesProcessKind,
} from "../src/shared/feishu-presentation-gate"
import {
  extractShellPresentationFields,
  formatToolCallLogSuffix,
} from "../src/shared/tool-presentation"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import {
  ZERO_CONTEXT_USAGE,
  type ContextUsageState,
  appendContextFooter,
  createAgentSendOptions,
  formatContextFooter,
  resolveContextLimitForSession,
} from "./context-usage"
import { finalizeContextUsageAtRunEnd } from "./context-usage-run-end"
import { type ChatType, type LaunchMeta, buildPrompt, resolveSessionChatName } from "./agent-launcher"
import { appendInlineMcpToSendOptions, loadInlineMcpServers } from "./mcp-sdk-loader"
import {
  finalizeSdkRunOnTimeout as finalizeSdkRunOnTimeoutImpl,
  isRunTimeoutFailure as isRunTimeoutFailureImpl,
  type FinalizerContext,
} from "./finalize-sdk-run"

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
  /** SDK 流式桥接 eligible（f41Eligible：主用户私聊或飞书群聊 allowOthers） */
  f41Stream: boolean
  streamBuffer: string
  outboundMessageId?: string
  /** 工具进度 CardKit message_id（按 tool_name，供并发工具各自 PATCH） */
  toolPresentationOutboundIds?: Map<string, string>
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
  /** Feature flag SDK_RESIDENT_AGENT：Run 结束后保持 Agent 实例 */
  residentMode: boolean
  /** 二次 send 进行中，防并发 dispatch */
  pendingDispatch: boolean
  /** 当前 Run 启动时刻，供 error 时 durationMs 未就绪的兜底 */
  runStartedAt?: number
  /** daemon 曾返回 deferred 或本地已见过程，延迟 POST stream-text */
  presentationDeferStream?: boolean
  /** 本 Run 是否出现过 tool/thinking */
  seenProcessEvent?: boolean
  /** 本 Run thinking 过程尚未 final */
  thinkingOpen?: boolean
  /** 当前 turn token 快照（onDelta turn-ended replace） */
  contextUsage: ContextUsageState
  /** session 级 prompt 侧 peak（跨 Run 保留；压缩后清零；footer 取 max(peak, 当前)） */
  contextUsagePeakTokens?: number
  /** Run 结束时 run.usage.totalTokens，footer 优先使用 */
  contextUsageFromRunTotal?: number
  /** 本 Run 是否已从 run.usage finalize */
  contextUsageFinalized?: boolean
  /** 模型上下文上限（session 级缓存，跨 Run 复用） */
  contextLimitTokens?: number
  /** 当前模型 id，供 resolveModelContextLimit */
  modelId?: string
  /** 通道 SDK API Key，供 models.list */
  apiKey?: string
  /** 本 Run 是否已下发压缩进度通知（防重复） */
  compressionNotified?: boolean
  /** 当次 dispatch claim 的 inbound message_ids，final stream-text 末条 id 用于 ack */
  inboundMessageIds?: string[]
  /** 本 Run 正在执行超时/终态收尾，防 completeSdkRun 重复 */
  runFinalizing?: boolean
}

const sdkSessions = new Map<string, SdkSessionAgent>()
const pendingLaunches = new Set<string>()
const failedCooldowns = new Map<string, number>()
const FAIL_COOLDOWN_MS = 30_000
const NOTIFY_PROCESSING = "Agent 处理中…"
const NOTIFY_COMPRESSING = "正在压缩上下文…"
const STREAM_POST_INTERVAL_MS = 400
/** 观测约 23min 档 Run 超时；低于此阈值的 shell+running 不误判为保活失败 */
const KEEPALIVE_TIMEOUT_MS = 20 * 60 * 1000

function sdkResidentModeEnabled(): boolean {
  const v = (process.env.SDK_RESIDENT_AGENT ?? "").trim().toLowerCase()
  return v !== "0" && v !== "false"
}

function isSdkSessionProcessing(session: SdkSessionAgent): boolean {
  return session.run !== null || session.pendingDispatch
}

function resetSdkRunPresentationState(session: SdkSessionAgent): void {
  session.errorNotified = false
  session.lastStatus = undefined
  session.lastTool = undefined
  session.runStartedAt = undefined
  session.streamBuffer = ""
  session.outboundMessageId = undefined
  session.toolPresentationOutboundIds = undefined
  session.streamId = undefined
  session.streamLastPostAt = undefined
  session.logAgg = { kind: null, buf: "" }
  session.presentationDeferStream = false
  session.seenProcessEvent = false
  session.thinkingOpen = false
  session.contextUsage = { ...ZERO_CONTEXT_USAGE }
  session.contextUsageFromRunTotal = undefined
  session.contextUsageFinalized = false
  // contextUsagePeakTokens 跨 Run 保留，保证同 session 多轮 footer 可比
  session.compressionNotified = false
  session.runFinalizing = false
  session.abortController = new AbortController()
}

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

/** 主用户私聊或飞书群聊（allowOthers）+ SDK 资源 → 可走 /api/stream-text */
function f41Eligible(sessionKey: string, chatType: ChatType): boolean {
  const chatId = extractChatId(sessionKey)
  const { channelId, chatId: raw } = parseChatKey(chatId)
  const channel = channelId ? getChannel(channelId) : undefined
  if (chatType === "p2p") {
    if (!channel?.mainUserEnabled || !channel.mainUserChatId?.trim()) return false
    return raw === channel.mainUserChatId.trim()
  }
  if (chatType === "group") {
    return channel?.type === "feishu" && !!channel.allowOthers
  }
  return false
}

function presentationOrderingEnvEnabled(): boolean {
  const v = (process.env.PRESENTATION_ORDERING ?? "").trim().toLowerCase()
  if (v === "0" || v === "false") return false
  return true
}

/** Presentation 时序编排：PRESENTATION_ORDERING 开启且主用户私聊 SDK 流式 */
function presentationOrderingEligible(session: SdkSessionAgent): boolean {
  if (!presentationOrderingEnvEnabled()) return false
  return session.f41Stream && session.chatType === "p2p"
}

function resolveRunDurationMs(session: SdkSessionAgent, run?: Run | null): number | undefined {
  const fromRun = run?.durationMs ?? session.run?.durationMs
  if (fromRun != null) return fromRun
  if (session.runStartedAt != null) return Date.now() - session.runStartedAt
  return undefined
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
    return "会话因等待超时已退出，请重新发送消息，我会继续为你处理。"
  }
  const msg = message?.trim()
  if (msg && !isUnsafeSdkMessage(msg)) {
    return `⚠️ Agent 处理失败：${msg}`
  }
  return "⚠️ Agent 处理失败，请稍后重试。"
}

async function notifySdkFailure(session: SdkSessionAgent, override?: string, run?: Run | null): Promise<void> {
  if (session.errorNotified || session.abortController.signal.aborted) return
  session.errorNotified = true
  const last = session.lastStatus
  let text = override ?? formatSdkStreamFailure(last?.status, last?.message, {
    lastTool: session.lastTool,
    durationMs: resolveRunDurationMs(session, run),
  })
  const footer = formatContextFooter(
    session.contextUsage,
    session.contextLimitTokens ?? null,
    session.contextUsagePeakTokens,
    session.contextUsageFromRunTotal,
  )
  text = appendContextFooter(text, footer)
  await notifySessionChat(session.sessionKey, text, true)
}

async function notifyDispatchFailure(sessionKey: string, reason: string): Promise<void> {
  pushUiLog("SDK", "ERROR", `[${sessionKey}] dispatch_failed: ${reason}`)
  await notifySessionChat(sessionKey, "⚠️ 消息投递失败，请稍后重试。", true)
}

interface StreamTextPayload {
  session_key: string
  text: string
  stream_id?: string
  outbound_message_id?: string
  /** final 包携带末条 inbound id，daemon handleStreamText → ackOnReply */
  message_id?: string
  final?: boolean
}

export type PresentationKind = "assistant" | "thinking" | "tool" | "diff" | "merge_batch"

export interface PresentationEvent {
  session_key: string
  kind: PresentationKind
  delta?: string
  tool_name?: string
  tool_status?: "started" | "completed" | "failed"
  /** shell 工具：具体命令（CardKit ```shell 渲染） */
  tool_shell_command?: string
  tool_shell_cwd?: string
  tool_shell_output?: string
  final?: boolean
  outbound_message_id?: string
}

function mapToolPresentationStatus(status: "running" | "completed" | "error"): PresentationEvent["tool_status"] {
  if (status === "running") return "started"
  if (status === "completed") return "completed"
  return "failed"
}

/** 从 sessionKey 解析通道类型（与 f41Eligible 同源 parseChatKey + getChannel） */
function resolveSessionChannelType(sessionKey: string): string | undefined {
  const chatId = extractChatId(sessionKey)
  const { channelId } = parseChatKey(chatId)
  const channel = channelId ? getChannel(channelId) : resolveChannelForSession(sessionKey)
  return channel?.type
}

/** 飞书全通道：tool/thinking 不 POST presentation-event；assistant 仍走 stream-text */
function isFeishuProcessPresentationSuppressed(
  session: SdkSessionAgent,
  event: Omit<PresentationEvent, "session_key">,
): boolean {
  return feishuSuppressesProcessKind(resolveSessionChannelType(session.sessionKey), event.kind)
}

async function postPresentationEvent(
  session: SdkSessionAgent,
  event: Omit<PresentationEvent, "session_key">,
): Promise<void> {
  // 飞书抑制过程卡出站；本地闩锁 / SDK UI 日志仍由 handleSdkEvent 维护
  if (isFeishuProcessPresentationSuppressed(session, event)) return
  const lock = readLockFile()
  if (!lock?.port) return
  const payload: PresentationEvent = {
    session_key: session.sessionKey,
    ...event,
  }
  if (payload.kind === "tool" && payload.tool_name && !payload.outbound_message_id) {
    const id = session.toolPresentationOutboundIds?.get(payload.tool_name)
    if (id) payload.outbound_message_id = id
  }
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/presentation-event`, payload, 5000)) as {
      ok?: boolean
      outbound_message_id?: string
      error?: string
    }
    if (res?.outbound_message_id && payload.kind === "tool" && payload.tool_name) {
      if (!session.toolPresentationOutboundIds) session.toolPresentationOutboundIds = new Map()
      session.toolPresentationOutboundIds.set(payload.tool_name, res.outbound_message_id)
    }
    if (res?.ok === false && res.error) {
      pushUiLog("SDK", "WARN", `[${session.sessionKey}] presentation-event 拒绝: ${res.error}`)
    }
  } catch (e: unknown) {
    pushUiLog("SDK", "WARN", `[${session.sessionKey}] presentation-event 推送失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function postStreamText(session: SdkSessionAgent, payload: StreamTextPayload): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/stream-text`, payload, 5000)) as {
      ok?: boolean
      stream_id?: string
      outbound_message_id?: string
      deferred?: boolean
      error?: string
    }
    if (res?.stream_id) session.streamId = res.stream_id
    if (res?.deferred) {
      session.presentationDeferStream = true
      return
    }
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
  if (!final && shouldDeferAssistantPost(session)) return
  if (final) applyContextFooterToBuffer(session)
  const text = session.streamBuffer
  if (!text.trim() && !final) return

  const payload: StreamTextPayload = {
    session_key: session.sessionKey,
    text,
  }
  if (session.streamId) payload.stream_id = session.streamId
  if (session.outboundMessageId) payload.outbound_message_id = session.outboundMessageId
  if (final) {
    payload.final = true
    const ids = session.inboundMessageIds
    const lastId = ids?.[ids.length - 1]
    if (lastId) payload.message_id = lastId
  }

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

function shouldDeferAssistantPost(session: SdkSessionAgent): boolean {
  if (!presentationOrderingEligible(session)) return false
  if (session.outboundMessageId) return false
  return !!(session.presentationDeferStream || session.seenProcessEvent)
}

function isAwaitingFirstProcessEvent(session: SdkSessionAgent): boolean {
  return presentationOrderingEligible(session)
    && !session.outboundMessageId
    && !session.seenProcessEvent
}

/** 首包 POST 前短窗等待 tool/thinking，与 STREAM_POST_INTERVAL 对齐，纯对话路径不额外延迟 */
function schedulePreambleRelease(session: SdkSessionAgent): void {
  if (!session.f41Stream) return
  clearStreamPostTimer(session)
  session.streamPostTimer = setTimeout(() => {
    session.streamPostTimer = undefined
    if (shouldDeferAssistantPost(session)) return
    scheduleStreamPost(session, false)
  }, STREAM_POST_INTERVAL_MS)
}

function appendAssistantStreamDelta(session: SdkSessionAgent, delta: string): void {
  session.streamBuffer += delta
  if (shouldDeferAssistantPost(session)) return
  if (isAwaitingFirstProcessEvent(session)) {
    schedulePreambleRelease(session)
    return
  }
  scheduleStreamPost(session, false)
}

function closeThinkingIfOpen(session: SdkSessionAgent): void {
  if (!session.thinkingOpen) return
  session.thinkingOpen = false
  void postPresentationEvent(session, { kind: "thinking", final: true })
  maybeReleaseDeferredAssistant(session)
}

function markProcessEventSeen(session: SdkSessionAgent): void {
  clearStreamPostTimer(session)
  session.seenProcessEvent = true
  if (presentationOrderingEligible(session)) {
    session.presentationDeferStream = true
  }
}

async function flushDeferredStreamPost(session: SdkSessionAgent): Promise<void> {
  if (!session.streamBuffer.trim()) return
  await flushStreamPost(session, false)
}

function maybeReleaseDeferredAssistant(session: SdkSessionAgent): void {
  if (!presentationOrderingEligible(session)) return
  if (!session.seenProcessEvent) return
  void flushDeferredStreamPost(session)
}

/** final flush 前将上下文 footer 写入 streamBuffer（幂等） */
function applyContextFooterToBuffer(session: SdkSessionAgent): void {
  const footer = formatContextFooter(
    session.contextUsage,
    session.contextLimitTokens ?? null,
    session.contextUsagePeakTokens,
    session.contextUsageFromRunTotal,
  )
  if (!footer) return
  session.streamBuffer = appendContextFooter(session.streamBuffer, footer)
}

/** Run 结束：读 run.usage（必要时 wait），对照 turn-ended 打日志并写入 footer 源 */
async function finalizeRunContextUsage(session: SdkSessionAgent, run: Run): Promise<void> {
  if (session.contextUsageFinalized) return
  let runUsage = run.usage
  if (!runUsage) {
    try {
      const result = await run.wait()
      runUsage = result.usage
    } catch {
      // wait 失败仍用 turn-ended 快照
    }
  }
  finalizeContextUsageAtRunEnd(session, runUsage, pushUiLog)
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

/** 自动压缩开始时向飞书/微信下发进度通知（同「Agent 处理中…」语义，不 stop progress） */
function makeCompressionNotify(session: SdkSessionAgent): (phase: "started" | "completed") => void {
  return (phase) => {
    if (phase !== "started" || session.compressionNotified) return
    session.compressionNotified = true
    void notifySessionChat(session.sessionKey, NOTIFY_COMPRESSING)
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


/** T2 挂接用：绑定 sdkSessions 等依赖的超时 finalizer */
const finalizerCtx: FinalizerContext = {
  sdkSessions,
  resetStreamPostChain,
  notifySdkFailure,
  broadcastSdkSessionStatus,
}

/** 超时类终态判定（供 T2 completeSdkRun / streamRunEvents 挂接） */
export function isRunTimeoutFailure(
  session: SdkSessionAgent,
  run: Run,
  lastStatus?: { status: string; message?: string },
): boolean {
  return isRunTimeoutFailureImpl(session, run, lastStatus)
}

/** 超时类终态主动收尾（供 T2 handleSdkEvent / streamRunEvents 挂接） */
export async function finalizeSdkRunOnTimeout(
  session: SdkSessionAgent,
  run: Run,
  trigger: string,
): Promise<void> {
  return finalizeSdkRunOnTimeoutImpl(finalizerCtx, session, run, trigger)
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
    closeThinkingIfOpen(session)
    if (presentationOrderingEligible(session) && session.seenProcessEvent) {
      await flushDeferredStreamPost(session)
    }
    await finalizeRunContextUsage(session, run)
    if (session.f41Stream && (session.streamBuffer.trim() || session.outboundMessageId)) {
      await flushStreamPost(session, true)
    }
    // 流结束兜底：无 status ERROR/EXPIRED 事件时，保活/Run 超时档仍走 finalizer
    if (
      run.status === "error" &&
      isRunTimeoutFailure(session, run) &&
      !session.runFinalizing
    ) {
      await finalizeSdkRunOnTimeout(session, run, "stream")
    }
  } catch (e: unknown) {
    flushSdkLog(session)
    if (!session.abortController.signal.aborted) {
      const msg = e instanceof Error ? `[${e.constructor.name}] ${e.message}` : String(e)
      const stack = e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : ""
      const cause = e instanceof Error && "cause" in e && e.cause ? JSON.stringify(e.cause) : ""
      pushUiLog("SDK", "ERROR", `[${session.sessionKey}] 流处理异常: ${msg}${stack ? ` stack=${stack}` : ""}${cause ? ` cause=${cause}` : ""}`)
      await finalizeRunContextUsage(session, run)
      await notifySdkFailure(session)
    }
  }
}

async function completeSdkRun(session: SdkSessionAgent, run: Run): Promise<void> {
  const sessionKey = session.sessionKey

  // finalizer 已收尾：幂等跳过，避免重复 cooldown/notify/resident 清理
  if (session.runFinalizing || session.run === null) {
    pushUiLog(
      "SDK",
      "INFO",
      `[${sessionKey}] completeSdkRun 跳过（幂等 finalizing=${!!session.runFinalizing} runNull=${session.run === null}）`,
    )
    return
  }

  const level = run.status === "error" ? "ERROR" : "INFO"

  if (run.status === "error") {
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
    pushUiLog("SDK", "ERROR", `[${sessionKey}] agent_failed 运行错误详情: ${parts.join(" ")}`)
    // 超时类失败不写 failedCooldowns，便于用户立即重发
    if (!isRunTimeoutFailure(session, run)) {
      failedCooldowns.set(sessionKey, Date.now() + FAIL_COOLDOWN_MS)
    }
    if (!session.errorNotified) {
      await notifySdkFailure(session, undefined, run)
    }
  }

  const summary = [
    run.result && `result=${run.result}`,
    run.durationMs != null && `duration=${run.durationMs}ms`,
  ].filter(Boolean).join(", ")
  pushUiLog("SDK", level, `[${sessionKey}] Agent 运行结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)

  resetStreamPostChain(session)
  session.run = null
  session.pendingDispatch = false
  await reportSessionAgentPhase(sessionKey, "idle")

  if (session.residentMode) {
    resetSdkRunPresentationState(session)
    broadcastSdkSessionStatus()
    return
  }

  try { session.agent.close() } catch { /* best-effort */ }
  sdkSessions.delete(sessionKey)
  broadcastSdkSessionStatus()
}

async function startSdkRun(session: SdkSessionAgent, run: Run): Promise<void> {
  session.run = run
  session.runStartedAt = Date.now()
  session.lastActivityAt = Date.now()
  await notifySessionChat(session.sessionKey, NOTIFY_PROCESSING)
  await reportSessionAgentPhase(session.sessionKey, "processing")
  streamRunEvents(session, run).then(() => completeSdkRun(session, run))
}

function handleSdkEvent(session: SdkSessionAgent, event: SDKMessage): void {
  switch (event.type) {
    case "assistant":
      closeThinkingIfOpen(session)
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          if (session.f41Stream) {
            appendAssistantStreamDelta(session, block.text)
          } else {
            appendSdkLog(session, "text", block.text)
          }
        }
      }
      break
    case "thinking":
      if (event.text) {
        appendSdkLog(session, "thinking", event.text)
        markProcessEventSeen(session)
        session.thinkingOpen = true
        void postPresentationEvent(session, { kind: "thinking", delta: event.text })
      }
      break
    case "tool_call":
      flushSdkLog(session)
      closeThinkingIfOpen(session)
      session.lastTool = { name: event.name, status: event.status }
      const toolDetail = formatToolCallLogSuffix(event.status, event.args, event.result, event.truncated)
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] [tool] ${event.name}: ${event.status}${toolDetail}`)
      markProcessEventSeen(session)
      if (event.status === "running") session.toolPresentationOutboundIds?.delete(event.name)
      void postPresentationEvent(session, {
        kind: "tool",
        tool_name: event.name,
        tool_status: mapToolPresentationStatus(event.status),
        final: event.status !== "running",
        ...extractShellPresentationFields(event.name, event.status, event.args, event.result),
      })
      if (event.status !== "running") {
        maybeReleaseDeferredAssistant(session)
      }
      break
    case "status": {
      flushSdkLog(session)
      const isErr = event.status === "ERROR" || event.status === "EXPIRED"
      if (isErr || event.status === "CANCELLED") {
        session.lastStatus = { status: event.status, message: event.message }
        // ERROR/EXPIRED 即时 finalizer；用户主动 stop（aborted）不误触发
        if (isErr && !session.abortController.signal.aborted && session.run) {
          void finalizeSdkRunOnTimeout(session, session.run, "status")
        }
        if (event.status === "CANCELLED" && !session.abortController.signal.aborted) {
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
  if (!s || s.abortController.signal.aborted) return false
  return isSdkSessionProcessing(s)
}

/** 长驻 Agent 实例是否存在（含 idle，供 stop 等路径；T7 dispatch 须用 isSdkSessionRunning 区分 processing） */
export function hasSdkSession(sessionKey: string): boolean {
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
  ensureAgentSdkHttpServer()

  const existing = sdkSessions.get(sessionKey)
  if (existing && !existing.abortController.signal.aborted) {
    if (isSdkSessionProcessing(existing)) {
      existing.lastActivityAt = Date.now()
      pushUiLog(
        "SDK",
        "WARN",
        `[${sessionKey}] launchSdkAgent 早退：session 仍 processing（run=${existing.run !== null} pendingDispatch=${existing.pendingDispatch}）`,
      )
      return { ok: true }
    }
    if (taskMessage?.trim()) {
      const prompt = buildPrompt(meta, taskMessage, sessionKey, opts.useMainWorkspace)
      return dispatchToSdkAgent(sessionKey, prompt, meta?.messageIds)
    }
    return { ok: true }
  }

  if (pendingLaunches.has(sessionKey)) {
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

    // 自动压缩：SDK LocalAgentOptions / SendOptions 无 autoCompress 字段；接近上限时由 harness 默认 summarization（onDelta summary-* 可观测）
    const agent = await Agent.create({
      apiKey,
      model: modelSelection,
      mcpServers: loadInlineMcpServers(workspaceDir),
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
      residentMode: sdkResidentModeEnabled(),
      pendingDispatch: false,
      presentationDeferStream: false,
      seenProcessEvent: false,
      thinkingOpen: false,
      contextUsage: { ...ZERO_CONTEXT_USAGE },
      modelId,
      apiKey,
      inboundMessageIds: meta?.messageIds,
    }

    sdkSessions.set(sessionKey, session)
    pendingLaunches.delete(sessionKey)
    broadcastLog(`[SDK] 会话 ${sessionKey} 已创建, agentId=${agent.agentId}`)
    broadcastSdkSessionStatus()

    await resolveContextLimitForSession(session)
    const run = await agent.send(
      prompt,
      appendInlineMcpToSendOptions(createAgentSendOptions(session, pushUiLog, makeCompressionNotify(session)), workspaceDir),
    )
    await startSdkRun(session, run)

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

export async function dispatchToSdkAgent(
  sessionKey: string,
  taskText: string,
  messageIds?: string[],
): Promise<{ ok: boolean; error?: string }> {
  ensureAgentSdkHttpServer()
  const text = taskText?.trim()
  if (!text) return { ok: false, error: "empty task" }

  const session = sdkSessions.get(sessionKey)
  if (!session || session.abortController.signal.aborted) {
    const err = "no resident agent"
    pushUiLog("SDK", "ERROR", `[${sessionKey}] dispatch_failed: ${err}`)
    return { ok: false, error: err }
  }
  if (isSdkSessionProcessing(session)) {
    return { ok: false, error: "agent busy" }
  }

  // 覆盖当次 batch ids；resetSdkRunPresentationState 不清除 inboundMessageIds
  session.inboundMessageIds = messageIds?.length ? messageIds : undefined

  session.pendingDispatch = true
  try {
    resetSdkRunPresentationState(session)
    await resolveContextLimitForSession(session)
    const run = await session.agent.send(
      text,
      appendInlineMcpToSendOptions(createAgentSendOptions(session, pushUiLog, makeCompressionNotify(session)), session.workspaceDir),
    )
    session.pendingDispatch = false
    await startSdkRun(session, run)
    return { ok: true }
  } catch (e: unknown) {
    session.pendingDispatch = false
    const msg = e instanceof Error ? e.message : String(e)
    await notifyDispatchFailure(sessionKey, msg)
    return { ok: false, error: msg }
  }
}

// ponytail: Electron 侧 agent API 端口写入 userData/agent-api-port.json；T7 Daemon 转发 SSOT 后仍可直连此端口
let agentApiServer: http.Server | null = null
let agentApiPort = 0

function writeAgentApiPortFile(port: number): void {
  try {
    const dir = app.getPath("userData")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "agent-api-port.json"), JSON.stringify({ port }), "utf-8")
  } catch (e: unknown) {
    pushUiLog("SDK", "WARN", `agent-api-port 写入失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function readAgentApiBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

function jsonAgentApi(res: http.ServerResponse, body: object, status = 200): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) })
  res.end(data)
}

function parseInboundMessageIds(body: Record<string, unknown>): string[] | undefined {
  const raw = body.message_ids
  if (!Array.isArray(raw)) return undefined
  const ids = raw.filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim())
  return ids.length ? ids : undefined
}

export async function launchSdkAgentFromHttp(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const sessionKey = typeof body.session_key === "string" ? body.session_key.trim() : ""
  if (!sessionKey) return { ok: false, error: "session_key is required" }

  const chatType = (typeof body.chat_type === "string" ? body.chat_type : "p2p") as ChatType
  const taskMessage = typeof body.task_text === "string" ? body.task_text : undefined
  const senderOpenId = typeof body.sender_open_id === "string" ? body.sender_open_id : undefined
  const chatName = typeof body.chat_name === "string" ? body.chat_name : undefined
  const channelId = typeof body.channel_id === "string" ? body.channel_id : undefined
  const explicitDir = typeof body.working_directory === "string" ? body.working_directory.trim() : ""
  const modelOverride = typeof body.model === "string" ? body.model : undefined
  const modelParamsOverride = typeof body.model_params === "string" ? body.model_params : undefined

  const useMain = body.use_main_workspace === true

  const chatId = typeof body.chat_id === "string" ? body.chat_id.trim() : sessionKey.split("::")[0]
  const messageIds = parseInboundMessageIds(body)
  const meta: LaunchMeta = { chatId, chatType: chatType === "group" ? "group" : "p2p", messageIds }

  const channel = getChannel(channelId) ?? resolveChannelForSession(sessionKey)
  const resource = getAgentResource(channel?.agentResourceId)
  if (resource.type !== "sdk") {
    return { ok: false, error: "请配置 SDK 资源（设置 → Agent）" }
  }

  const isOwnTask = chatType === "task" || chatType === "temp" || chatType === "workflow"
  if (!useMain && !isOwnTask && !channel?.allowOthers) {
    return { ok: false, error: `通道「${channel?.name ?? "未知"}」未启用其他人使用` }
  }

  let workDir = explicitDir
  if (!workDir) {
    if (useMain || isOwnTask) {
      workDir = effectiveWorkspaceDir(channel)
    } else {
      const mode = channel?.othersWorkspaceMode ?? "isolated"
      if (mode === "isolated") {
        const safeChatId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
        workDir = join(app.getPath("userData"), "workspaces", safeChatId)
        if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })
      } else {
        const dir = channel?.othersWorkspaceDir?.trim() ?? ""
        if (!dir) {
          workDir = effectiveWorkspaceDir(channel)
        } else {
          const resolved = resolve(dir)
          if (!existsSync(resolved)) return { ok: false, error: "目录不存在，请检查路径或省略 -dir 使用当前主会话目录" }
          workDir = resolved
        }
      }
    }
  } else if (chatType !== "temp" && !existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true })
  }
  if (!workDir) return { ok: false, error: "工作目录未配置" }

  let model: string
  let modelParams: string
  if (modelOverride?.trim()) {
    model = modelOverride.trim()
    modelParams = modelParamsOverride ?? ""
  } else {
    const scenario: ModelScenario = useMain || isOwnTask ? "primary" : "others"
    const resolved = resolveChannelModel(channel, scenario)
    model = resolved.model
    modelParams = resolved.modelParams
  }

  return launchSdkAgent({
    sessionKey, chatType, meta, workspaceDir: workDir, useMainWorkspace: useMain,
    senderOpenId, chatName, taskMessage,
    apiKey: resource.apiKey ?? "", model, modelParams,
  })
}

export function getAgentSdkApiPort(): number {
  return agentApiPort
}

export function ensureAgentSdkHttpServer(): void {
  if (agentApiServer) return
  agentApiServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      jsonAgentApi(res, { ok: false, error: "method not allowed" }, 405)
      return
    }
    const pathname = req.url?.split("?")[0] ?? ""
    try {
      const raw = await readAgentApiBody(req)
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      if (pathname === "/api/agent/dispatch") {
        const session_key = typeof body.session_key === "string" ? body.session_key.trim() : ""
        const task_text = typeof body.task_text === "string" ? body.task_text : ""
        if (!session_key) {
          jsonAgentApi(res, { ok: false, error: "session_key is required" }, 400)
          return
        }
        const messageIds = parseInboundMessageIds(body)
        const result = await dispatchToSdkAgent(session_key, task_text, messageIds)
        jsonAgentApi(res, result, result.ok ? 200 : 400)
        return
      }
      if (pathname === "/api/agent/launch") {
        const result = await launchSdkAgentFromHttp(body)
        jsonAgentApi(res, result, result.ok ? 200 : 400)
        return
      }
      jsonAgentApi(res, { ok: false, error: "not found" }, 404)
    } catch (e: unknown) {
      jsonAgentApi(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })
  agentApiServer.listen(0, "127.0.0.1", () => {
    const addr = agentApiServer!.address()
    agentApiPort = typeof addr === "object" && addr ? addr.port : 0
    writeAgentApiPortFile(agentApiPort)
    pushUiLog("SDK", "INFO", `Agent API 监听 127.0.0.1:${agentApiPort}`)
  })
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
