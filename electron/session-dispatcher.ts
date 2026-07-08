import * as path from "node:path"
import * as fs from "node:fs"
import { app } from "electron"
import {
  getConfig, getChannel, getAgentResource, resolveChannelForSession,
  resolveChannelModel, effectiveWorkspaceDir, mainChatScopeKey,
  type MessageChannel, type ModelScenario,
} from "./config-store"
import { parseChatKey, workspaceDirFromSessionKey } from "../src/shared/channel-types"
import { broadcastLog } from "./ui-logger"
import { readLockFile, httpGet, httpPost, syncActiveSession, getCurrentActiveSession, drainSessionMessages } from "./daemon-client"
import { reportCommandResult } from "./command-handler"
import {
  launchAgent as _launchCliAgent,
  stopSessionAgent as _stopCliSession, stopAllSessionAgents as _stopAllCliSessions,
  getSessionAgentList as getRawCliSessionList,
  isSessionAgentRunning as _isCliSessionRunning,
  getSessionAgentStartedAt,
  setChatNameResolver, setChatNameFallback, setSessionCloseHandler, resolveSessionChatName,
  type ChatType, type SessionExitInfo,
} from "./agent-launcher"
import {
  launchSdkAgent, stopSdkSession, stopAllSdkSessions,
  isSdkSessionRunning, getSdkSessionList, setSdkIdleHandler, setSdkRunErrorHandler, hasResumableSdkSession,
} from "./agent-sdk"
import { injectWorkspaceToDir } from "./workspace-injector"

// ── readLockFile 短 TTL 缓存 ─────────────────────────────
let _lockCache: { value: ReturnType<typeof readLockFile>; ts: number } | null = null
function cachedLock() {
  const now = Date.now()
  if (_lockCache && now - _lockCache.ts < 2000) return _lockCache.value
  const v = readLockFile()
  _lockCache = { value: v, ts: now }
  return v
}

// ── 生命周期通知 ──────────────────────────────────────────

async function notifyChat(sessionKey: string, text: string): Promise<void> {
  const lock = cachedLock()
  if (!lock?.port) return
  const chatId = extractChatId(sessionKey)
  try {
    await httpPost(`http://127.0.0.1:${lock.port}/api/send-text`, { text, session_key: sessionKey }, 5000)
  } catch (e: unknown) {
    broadcastLog(`[Notify] 发送通知失败 (${chatId}): ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}

// ── 内部工具（CLI 与 SDK 双运行时并存）────────────────────

export function isSessionAgentRunning(key: string): boolean {
  return _isCliSessionRunning(key) || isSdkSessionRunning(key)
}

export function stopSessionAgent(key: string): void {
  // 无条件调用：send 前短暂窗口（run=null）isSdkSessionRunning 为 false，但 agent 进程需要释放
  stopSdkSession(key)
  if (_isCliSessionRunning(key)) _stopCliSession(key)
}

export function stopAllSessionAgents(): void {
  stopAllSdkSessions()
  _stopAllCliSessions()
}

// ── Session 状态 ──────────────────────────────────────────

export const chatNameCache = new Map<string, string>()
export const previousActiveSessionMap = new Map<string, string>()
const lastCrashAtMap = new Map<string, number>()
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000

// ── Session 工具 ──────────────────────────────────────────

/** chatId 为 chatKey（`channelId|rawChatId`）；按所属通道的主用户绑定判断 */
export function isMainUser(chatId?: string, chatType?: string): boolean {
  if (chatType !== "p2p" || !chatId) return false
  const { channelId, chatId: raw } = parseChatKey(chatId)
  const channel = getChannel(channelId)
  if (!channel?.mainUserEnabled || !channel.mainUserChatId?.trim()) return false
  return raw === channel.mainUserChatId.trim()
}

export function extractChatId(sessionKey: string): string {
  const idx = sessionKey.indexOf("::")
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

// ── Session 生命周期 ──────────────────────────────────────

export async function handleSessionClosed(sessionKey: string, chatType: ChatType, exitInfo?: SessionExitInfo): Promise<void> {
  const failed = exitInfo && exitInfo.exitCode !== 0 && exitInfo.exitCode !== null
  const chatId = extractChatId(sessionKey)
  const mainChat = isMainUser(chatId, chatType)
  // 非长连接模式下正常退出是常态，不打扰用户
  const ch = resolveChannelForSession(sessionKey)
  const persistentPoll = (ch?.keepSession ?? true) && (ch?.persistentPoll ?? true)

  if (failed) {
    const lock = cachedLock()
    const now = Date.now()
    const prevCrashAt = lastCrashAtMap.get(sessionKey) ?? 0
    lastCrashAtMap.set(sessionKey, now)
    if (lock?.port) {
      if (now - prevCrashAt < CRASH_LOOP_WINDOW_MS) {
        // 短时间内连续崩溃：放弃排队消息，避免 crash-loop 无限重启
        const drained = await drainSessionMessages(lock.port, sessionKey)
        broadcastLog(`[System] Agent 连续异常退出(exit=${exitInfo.exitCode})，已放弃该会话 ${drained} 条消息`, "WARN")
        if (!mainChat && drained > 0) {
          await notifyChat(sessionKey, `⚠️ Agent 连续异常退出 (exit=${exitInfo.exitCode})，已放弃 ${drained} 条排队消息，请重新发送。`)
        }
      } else {
        // 首次崩溃：保留队列消息，调度器轮询会自动重启 Agent 继续处理
        broadcastLog(`[System] Agent 异常退出(exit=${exitInfo.exitCode})，保留队列消息等待自动重启`, "WARN")
      }
    }
    if (mainChat) {
      const stderrContent = exitInfo.stderr?.trim() || ""
      const errMsg = stderrContent
        ? `⚠️ Agent 异常退出 (exit=${exitInfo.exitCode})。\n错误信息：\n${stderrContent}`
        : `⚠️ Agent 异常退出 (exit=${exitInfo.exitCode})。请检查配置后重试。`
      await notifyChat(sessionKey, errMsg)
    }
  } else if (mainChat && persistentPoll) {
    const output = exitInfo?.stderr?.trim() || exitInfo?.stdout?.trim() || ""
    const exitMsg = output ? `Agent已退出\n退出前输出：\n${output}` : "Agent已退出"
    await notifyChat(sessionKey, exitMsg)
  }

  const previous = previousActiveSessionMap.get(sessionKey)
  previousActiveSessionMap.delete(sessionKey)
  if (!previous) return

  const lock = cachedLock()
  if (!lock) return

  const currentActive = await getCurrentActiveSession(lock.port, chatId)
  if (currentActive !== sessionKey) return

  const fallbackKey = isSessionAgentRunning(previous) ? previous : undefined
  if (fallbackKey) {
    await syncActiveSession(lock.port, chatId, fallbackKey)
    broadcastLog(`[System] 临时会话已结束，活跃会话自动回退至: ${fallbackKey}`, "INFO")
  }
}

// ── 名称解析 ──────────────────────────────────────────────

export async function fetchChatNames(chatIds: string[]): Promise<void> {
  const missing = chatIds.filter((id) => id && !chatNameCache.has(id))
  if (missing.length === 0) return
  const lock = cachedLock()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/chat-names`, { chatIds: missing }, 15_000)) as { names?: Record<string, string> }
    if (res?.names) {
      for (const [id, name] of Object.entries(res.names)) chatNameCache.set(id, name)
    }
  } catch { /* ignore */ }
}

/** 解析失败冷却：避免对无权限/无法解析的 openId 每轮轮询都打 API */
const nameFetchFailedAt = new Map<string, number>()
const NAME_FETCH_RETRY_MS = 10 * 60_000

export async function fetchUserNames(openIds: string[], channelId?: string): Promise<void> {
  const now = Date.now()
  const missing = openIds.filter((id) =>
    id && !chatNameCache.has(id) && now - (nameFetchFailedAt.get(id) ?? 0) > NAME_FETCH_RETRY_MS)
  if (missing.length === 0) return
  const lock = cachedLock()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/user-names`, { openIds: missing, channelId }, 15_000)) as { names?: Record<string, string> }
    for (const id of missing) {
      const name = res?.names?.[id]
      if (name) chatNameCache.set(id, name)
      else nameFetchFailedAt.set(id, now)
    }
  } catch { /* ignore */ }
}

// ── 消息队列 ──────────────────────────────────────────────

interface DequeuedMessage { text: string; messageId: string; sessionKey?: string; meta?: { chatType?: string; senderOpenId?: string } }
interface MergedMessages { text: string; count: number; chatType?: string; messageIds: string[]; chatId?: string; senderOpenId?: string }

export async function pullMergedMessagesFromQueue(chatId?: string): Promise<MergedMessages | null> {
  const lock = cachedLock()
  if (!lock?.port) return null
  try {
    const body = chatId ? { chatId } : {}
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/dequeue-all`, body, 10_000)) as {
      messages?: (DequeuedMessage | string)[]
    } | null
    const msgs = res?.messages ?? []
    if (msgs.length === 0) return null

    const parsed: DequeuedMessage[] = msgs
      .map((m) => (typeof m === "string" ? { text: m, messageId: "" } : m))
      .filter((m) => m.text?.trim())

    if (parsed.length === 0) return null

    const chatType = parsed[0].meta?.chatType || undefined
    const messageIds = parsed.map((m) => m.messageId).filter(Boolean)

    const text = parsed.length === 1
      ? parsed[0].text.trim()
      : parsed.map((m, i) => `【消息 ${i + 1}】\n${m.text.trim()}`).join("\n\n")

    return { text, count: parsed.length, chatType, messageIds, chatId, senderOpenId: parsed[0].meta?.senderOpenId || undefined }
  } catch {
    return null
  }
}

interface QueueSession { sessionKey: string; chatType: string; senderOpenId?: string }

async function getQueueSessions(): Promise<QueueSession[]> {
  const lock = cachedLock()
  if (!lock?.port) return []
  try {
    const res = (await httpGet(`http://127.0.0.1:${lock.port}/queue-chat-ids`)) as { chats?: QueueSession[] } | null
    return res?.chats ?? []
  } catch {
    return []
  }
}

export async function clearMessageQueue(): Promise<number> {
  const lock = cachedLock()
  if (!lock?.port) return 0
  try {
    const res = await httpPost(`http://127.0.0.1:${lock.port}/clear-queue`, {}) as { cleared?: number }
    return res?.cleared ?? 0
  } catch { return 0 }
}

export interface QueueMessageItem {
  index: number
  fileId: string
  preview: string
  /** pending = 排队待投递；processing = 已投递给 Agent 待回复确认 */
  status?: "pending" | "processing"
  sessionKey?: string
  chatType?: string
  timestamp?: number
  senderOpenId?: string
}

export async function getQueueMessages(): Promise<QueueMessageItem[]> {
  const lock = cachedLock()
  if (!lock?.port) return []
  try {
    const res = await httpGet(`http://127.0.0.1:${lock.port}/queue`) as { messages?: QueueMessageItem[] }
    return res.messages ?? []
  } catch {
    return []
  }
}

export async function deleteQueueMessage(fileId: string): Promise<boolean> {
  const lock = cachedLock()
  if (!lock?.port) return false
  try {
    const res = await httpPost(`http://127.0.0.1:${lock.port}/queue-delete`, { fileId }, 5000) as { ok?: boolean }
    return res?.ok ?? false
  } catch {
    return false
  }
}

// ── Agent 启动 ─────────────────────────────────────────────

interface LaunchAgentParams {
  sessionKey: string
  chatType: ChatType
  meta?: import("./agent-launcher").LaunchMeta
  useMainWorkspace?: boolean
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  /** 显式指定通道（定时任务/工作流）；缺省从 sessionKey 的 chatKey 前缀解析 */
  channelId?: string
  /** 显式模型覆盖（任务模型 / 工作流节点模型） */
  modelOverride?: string
  modelParamsOverride?: string
  workingDirectory?: string
}

async function launchAgent(p: LaunchAgentParams): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, senderOpenId, chatName, taskMessage } = p
  const useMain = p.useMainWorkspace ?? (chatType === "p2p")

  // 通道与 Agent 资源解析
  const channel: MessageChannel | undefined = getChannel(p.channelId) ?? resolveChannelForSession(sessionKey)
  const resource = getAgentResource(channel?.agentResourceId)

  // 其他人会话需要通道显式开启
  const isOwnTask = chatType === "task" || chatType === "temp" || chatType === "workflow"
  if (!useMain && !isOwnTask && !channel?.allowOthers) {
    return { ok: false, error: `通道「${channel?.name ?? "未知"}」未启用其他人使用` }
  }

  let workDir: string
  if (p.workingDirectory) {
    workDir = p.workingDirectory
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  } else if (useMain || isOwnTask) {
    // sessionKey 自带工作目录后缀时优先（如切换 workspace 后旧会话被重新拉起，
    // 必须回到原目录，否则 UI 目录显示错误且 Resume 目录匹配失败丢上下文）
    const skDir = workspaceDirFromSessionKey(sessionKey)
    workDir = skDir && fs.existsSync(skDir) ? skDir : effectiveWorkspaceDir(channel)
  } else {
    // 临时目录名含 chatKey 的通道前缀（ch_xxx_...），不同通道天然隔离
    const safeChatId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
    workDir = path.join(app.getPath("userData"), "workspaces", safeChatId)
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  }
  if (!workDir) return { ok: false, error: "工作目录未配置" }

  const skipIdentity = chatType === "workflow"
  await injectWorkspaceToDir(workDir, useMain || skipIdentity, channel?.digitalIdentity)

  // 模型解析：显式覆盖 > 通道场景模型
  let model: string
  let modelParams: string
  if (p.modelOverride?.trim()) {
    model = p.modelOverride.trim()
    modelParams = p.modelParamsOverride ?? ""
  } else {
    const scenario: ModelScenario = useMain || isOwnTask ? "primary" : "others"
    const resolved = resolveChannelModel(channel, scenario)
    model = resolved.model
    modelParams = resolved.modelParams
  }

  // 会话模式：保留会话（run 结束持久化 agentId，新消息 Resume 续上下文）+ 长连接（无限 poll）
  const keepSession = channel?.keepSession ?? true
  const persistentPoll = keepSession && (channel?.persistentPoll ?? true)

  if (resource.type === "sdk") {
    return launchSdkAgent({
      sessionKey, chatType, meta, workspaceDir: workDir, useMainWorkspace: useMain,
      senderOpenId, chatName, taskMessage,
      apiKey: resource.apiKey ?? "", model, modelParams,
      keepSession, persistentPoll,
    })
  }

  const needResume = chatType === "p2p" || chatType === "group"
  return _launchCliAgent({
    sessionKey, chatType, meta, useMainWorkspace: useMain,
    senderOpenId, chatName, taskMessage,
    workspaceDir: workDir, model,
    resumeScope: needResume && channel ? mainChatScopeKey(channel.id, workDir) : undefined,
    persistentPoll,
  })
}

export async function launchSessionAgent(
  sessionKey: string, chatType: ChatType,
  meta?: import("./agent-launcher").LaunchMeta,
  useMainWorkspace?: boolean, senderOpenId?: string,
): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({ sessionKey, chatType, meta, useMainWorkspace, senderOpenId })
}

export async function launchIndependentAgent(
  taskId: string, taskName: string, message: string, type: ChatType = "task",
  chatId?: string, channelId?: string, model?: string, modelParams?: string,
): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({
    sessionKey: taskId, chatType: type, chatName: taskName, taskMessage: message,
    meta: { chatId: chatId ?? taskName, chatType: type },
    channelId, modelOverride: model, modelParamsOverride: modelParams,
  })
}

export async function launchWorkflowAgent(p: {
  instanceId: string; nodeId: string; nodeName: string
  prompt: string; workingDirectory: string
  notifyChatId?: string; model?: string
}): Promise<{ ok: boolean; error?: string }> {
  const sessionKey = `${p.notifyChatId || "wf"}::wf_${p.instanceId}_${p.nodeId}`
  return launchAgent({
    sessionKey, chatType: "workflow",
    chatName: `WF: ${p.nodeName}`,
    taskMessage: p.prompt,
    workingDirectory: p.workingDirectory,
    meta: { chatId: p.notifyChatId || sessionKey, chatType: "workflow" },
    channelId: p.notifyChatId ? parseChatKey(extractChatId(p.notifyChatId)).channelId : undefined,
    modelOverride: p.model,
  })
}

export async function notifyWorkflowChat(chatId: string, text: string): Promise<void> {
  const lock = cachedLock()
  if (!lock?.port) return
  try {
    await httpPost(`http://127.0.0.1:${lock.port}/api/send-text`, { text, session_key: chatId }, 5000)
  } catch (e: unknown) {
    broadcastLog(`[WF Notify] 发送通知失败: ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}

// ── Session 列表 ──────────────────────────────────────────

export function getSessionAgentList() {
  const rawList = [
    ...getRawCliSessionList(),
    ...getSdkSessionList().map((s) => ({ ...s, pid: 0 })),
  ]
  return rawList.map((s) => ({ ...s, chatName: resolveSessionChatName(s.sessionKey, s.chatName, s.senderOpenId) }))
}

// ── /chat 命令处理 ────────────────────────────────────────

export async function handleChatCommand(tokens: string[], port: number, messageId: string, chatId?: string): Promise<void> {
  const reply = (ok: boolean, msg: string, buttons?: { label: string; cmd: string }[]) => reportCommandResult(port, messageId, ok, msg, chatId, buttons)
  const sub = tokens[1]?.toLowerCase()

  const sessions = getSessionAgentList().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))

  if (!sub || sub === "ls" || sub === "list") {
    if (sessions.length === 0) { await reply(true, "📭 当前没有活跃会话"); return }
    const now = Date.now()
    const lines = sessions.map((s, i) => {
      const idx = `#${i + 1}`
      const type = s.chatType === "p2p" ? "私聊" : s.chatType === "group" ? "群聊" : s.chatType === "task" ? "定时" : s.chatType === "temp" ? "临时" : s.chatType === "workflow" ? "工作流" : s.chatType
      const name = s.chatName || "-"
      const dir = s.workspaceDir ? path.basename(s.workspaceDir) : "-"
      const pid = s.pid || "-"
      const started = s.startedAt ? new Date(s.startedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "-"
      const dur = s.startedAt ? formatDuration(now - s.startedAt) : "-"
      return `${idx} [${type}] ${name} | 启动:${started} | 时长:${dur} | dir:${dir} | pid:${pid}`
    })
    const chatBtns = sessions.slice(0, 8).map((s, i) => ({ label: `切换到 #${i + 1} ${s.chatName || path.basename(s.workspaceDir ?? "") || s.chatType}`, cmd: `/chat ${i + 1}` }))
    const usage = "💡 /chat <序号> 切换 | /chat stop <序号> 停止 | /chat new <描述> 新临时会话"
    await reply(true, `📋 活跃会话 (${sessions.length}):\n${lines.join("\n")}\n\n${usage}`, chatBtns)
    return
  }

  if (sub === "new") {
    const taskMsg = tokens.slice(2).join(" ").trim()
    if (!taskMsg) { await reply(false, "💡 用法：/chat new <任务描述>\n例如：/chat new 帮我检查一下服务器状态"); return }
    const taskId = `temp_${Date.now()}`
    const result = await launchIndependentAgent(taskId, "临时会话", taskMsg, "temp", chatId)
    if (result.ok && chatId) {
      const currentActive = await getCurrentActiveSession(port, chatId)
      if (currentActive && currentActive !== taskId) previousActiveSessionMap.set(taskId, currentActive)
      await syncActiveSession(port, chatId, taskId)
    }
    if (result.ok) {
      const newSession = getSessionAgentList().find((s) => s.sessionKey === taskId)
      const lines = [
        `🚀 新会话已创建:`,
        `  SessionKey: ${taskId}`,
        `  类型: 临时`,
        `  工作目录: ${newSession?.workspaceDir ? path.basename(newSession.workspaceDir) : "-"}`,
        `  PID: ${newSession?.pid || "-"}`,
        `  启动时间: ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
        `\n🔀 已切换到此会话，临时会话结束后将自动回退`,
      ]
      await reply(true, lines.join("\n"))
    } else {
      await reply(false, `❌ 启动失败: ${result.error ?? "未知错误"}`)
    }
    return
  }

  if (sub === "stop") {
    const idx = parseInt(tokens[2], 10)
    if (isNaN(idx) || idx < 1 || idx > sessions.length) {
      await reply(false, `❌ 无效序号，范围 1-${sessions.length}`)
      return
    }
    const target = sessions[idx - 1]
    stopSessionAgent(target.sessionKey)
    await reply(true, `✅ 已停止会话 #${idx}: ${target.chatName || target.sessionKey}`)
    return
  }

  const idx = parseInt(sub, 10)
  if (!isNaN(idx)) {
    if (idx < 1 || idx > sessions.length) {
      await reply(false, `❌ 无效序号，范围 1-${sessions.length}`)
      return
    }
    const s = sessions[idx - 1]
    const now = Date.now()
    const type = s.chatType === "p2p" ? "私聊" : s.chatType === "group" ? "群聊" : s.chatType === "task" ? "定时任务" : s.chatType === "temp" ? "临时任务" : s.chatType === "workflow" ? "工作流" : s.chatType

    if (chatId) {
      await syncActiveSession(port, chatId, s.sessionKey)
    }

    const lines = [
      `🔀 已切换到会话 #${idx}:`,
      `  类型: ${type}`,
      `  名称: ${s.chatName || "-"}`,
      `  SessionKey: ${s.sessionKey}`,
      `  工作目录: ${s.workspaceDir || "-"}`,
      `  PID: ${s.pid || "-"}`,
      `  启动时间: ${s.startedAt ? new Date(s.startedAt).toLocaleString("zh-CN", { hour12: false }) : "-"}`,
      `  运行时长: ${s.startedAt ? formatDuration(now - s.startedAt) : "-"}`,
      `\n💡 后续消息将路由到此会话`,
    ]
    await reply(true, lines.join("\n"))
    return
  }

  await reply(false, "💡 /chat 用法:\n  /chat ls — 列出所有活跃会话\n  /chat <序号> — 切换到指定会话\n  /chat stop <序号> — 停止指定会话\n  /chat new <描述> — 创建新临时会话")
}

// ── 僵尸 Agent 检测 ──────────────────────────────────────

const ZOMBIE_REPLY_SILENCE_MS = 10 * 60 * 1000

async function isZombieAgent(sessionKey: string): Promise<boolean> {
  const lock = cachedLock()
  if (!lock?.port) return false
  try {
    const sk = encodeURIComponent(sessionKey)
    const [replyRes, msgRes] = await Promise.all([
      httpGet(`http://127.0.0.1:${lock.port}/api/session-last-reply?sessionKey=${sk}`) as Promise<{ lastReplyAt?: number | null }>,
      httpGet(`http://127.0.0.1:${lock.port}/api/session-earliest-msg?sessionKey=${sk}`) as Promise<{ earliestMsgTime?: number | null }>,
    ])
    const earliestMsgTime = msgRes?.earliestMsgTime ?? null
    if (earliestMsgTime === null) return false
    // Agent 有运行时活动（SDK 流事件 / CLI 输出）就不算僵尸——正在干长活未回消息是正常状态
    const agentActivityAt = getSessionAgentList().find((s) => s.sessionKey === sessionKey)?.lastActivityAt ?? 0
    const lastActiveTime = Math.max(replyRes?.lastReplyAt ?? 0, getSessionAgentStartedAt(sessionKey) ?? 0, agentActivityAt)
    const startTime = Math.max(earliestMsgTime, lastActiveTime)
    return Date.now() - startTime > ZOMBIE_REPLY_SILENCE_MS
  } catch {
    return false
  }
}

// ── 会话调度主循环 ────────────────────────────────────────

let dispatching = false

export async function dispatchSessionAgents(): Promise<void> {
  if (dispatching) return
  dispatching = true
  try {
    await _dispatchSessionAgentsInner()
  } finally {
    dispatching = false
  }
}

async function _dispatchSessionAgentsInner(): Promise<void> {
  const config = getConfig()
  const sessions = await getQueueSessions()

  const feishuOn = (config.channels ?? []).some((c) => c.enabled && c.type === "feishu")
  const groupKeys = sessions.filter((s) => s.chatType === "group").map((s) => extractChatId(s.sessionKey))
  if (groupKeys.length > 0 && feishuOn) await fetchChatNames(groupKeys)

  for (const { sessionKey, chatType, senderOpenId } of sessions) {
    if (isSessionAgentRunning(sessionKey)) {
      if (await isZombieAgent(sessionKey)) {
        broadcastLog(`[Agent] ${sessionKey} 疑似僵尸(队列有消息且 ${ZOMBIE_REPLY_SILENCE_MS / 60_000}min 无回复消息)，强制终止并重启`, "WARN")
        stopSessionAgent(sessionKey)
        await new Promise((r) => setTimeout(r, 1000))
      } else {
        continue
      }
    }

    const chatId = extractChatId(sessionKey)
    const mainUser = isMainUser(chatId, chatType)

    if (feishuOn && chatType === "p2p" && senderOpenId?.startsWith("ou_") && !chatNameCache.has(senderOpenId)) {
      await fetchUserNames([senderOpenId], parseChatKey(chatId).channelId)
    }

    const userName = senderOpenId ? chatNameCache.get(senderOpenId) : undefined
    const chatName = chatNameCache.get(chatId) || userName
    const resumable = hasResumableSdkSession(sessionKey)
    const p2pName = userName || resolveSessionChatName(sessionKey, undefined, senderOpenId) || chatId
    const label = chatType === "group"
      ? `群聊 ${chatName ? `「${chatName}」` : chatId}`
      : (mainUser ? `主用户私聊${userName ? ` (${userName})` : ""}` : `私聊 ${p2pName}`)
    broadcastLog(`[Agent] ${label} 有新消息，正在启动Agent（${resumable ? "Resume 恢复上下文" : "全新会话"}）${mainUser ? "(主工作目录)" : ""}`)
    // Resume 恢复静默进行；仅真正冷启动（无历史上下文可续）才提示等待
    if (!resumable) await notifyChat(sessionKey, "正在启动Agent，请稍等...")

    const meta: import("./agent-launcher").LaunchMeta = { chatId, chatType: chatType as "p2p" | "group" }
    const result = await launchSessionAgent(sessionKey, chatType as "p2p" | "group", meta, mainUser, senderOpenId)
    if (result.ok && chatId !== sessionKey) {
      const lock = cachedLock()
      if (lock?.port) await syncActiveSession(lock.port, chatId, sessionKey)
    }
    if (!result.ok) {
      broadcastLog(`[Agent] ${sessionKey} 启动跳过: ${result.error}`)
      await notifyChat(sessionKey, `⚠️ Agent 启动失败，本条消息未能处理，请稍后重发。\n原因: ${result.error ?? "未知错误"}`)
      const lock = cachedLock()
      if (lock?.port) {
        const drained = await drainSessionMessages(lock.port, sessionKey)
        if (drained > 0) broadcastLog(`[Agent] ${sessionKey} 已丢弃 ${drained} 条消息（启动被拒绝）`)
      }
    }
  }
}

// ── 初始化 ────────────────────────────────────────────────

/** SDK run 异常终态处理：窗口外首次异常自动重试拉起（Resume 静默恢复），窗口内重复异常或重试失败则通知用户 */
async function handleSdkRunError(sessionKey: string, chatType: ChatType, errorDetail: string): Promise<void> {
  const now = Date.now()
  const prevCrashAt = lastCrashAtMap.get(sessionKey) ?? 0
  lastCrashAtMap.set(sessionKey, now)

  if (now - prevCrashAt < CRASH_LOOP_WINDOW_MS) {
    broadcastLog(`[SDK] ${sessionKey} 短时间内连续异常结束，停止自动重试`, "WARN")
    await notifyChat(sessionKey, `⚠️ Agent 连续异常结束，已停止自动重试。\n错误信息：${errorDetail}\n请稍后重新发消息唤醒，若持续失败请检查网络或 API Key。`)
    return
  }

  broadcastLog(`[SDK] ${sessionKey} 运行异常结束(${errorDetail})，自动重试拉起`, "WARN")
  const chatId = extractChatId(sessionKey)
  const meta: import("./agent-launcher").LaunchMeta = { chatId, chatType: chatType as "p2p" | "group" }
  const result = await launchSessionAgent(sessionKey, chatType, meta, isMainUser(chatId, chatType))
    .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
  if (!result.ok) {
    await notifyChat(sessionKey, `⚠️ Agent 异常结束，自动重试拉起失败：${result.error ?? "未知错误"}\n原始错误：${errorDetail}\n请重新发消息唤醒。`)
  }
}

export function initSessionDispatcher(): void {
  setChatNameResolver((chatId) => chatNameCache.get(chatId))
  // 名字查不到（如 bot 缺通讯录权限）时，用「通道名·访客」代替裸 sessionKey
  setChatNameFallback((chatId) => {
    const channel = getChannel(parseChatKey(chatId).channelId)
    return channel?.name ? `${channel.name}·访客` : undefined
  })
  setSessionCloseHandler(handleSessionClosed)
  // run 收口释放后立即调度：运行期间到达的消息无需等下一轮轮询
  setSdkIdleHandler(() => { void dispatchSessionAgents().catch(() => {}) })
  // SDK run 异常终态：自动重试 1 次（Resume 恢复上下文），重试失败/连续异常时通知用户
  setSdkRunErrorHandler((sessionKey, chatType, errorDetail) => {
    void handleSdkRunError(sessionKey, chatType, errorDetail).catch(() => {})
  })
}
