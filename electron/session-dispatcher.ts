import * as path from "node:path"
import * as fs from "node:fs"
import { app } from "electron"
import { getConfig, useSdkMode, type ModelScenario } from "./config-store"
import { broadcastLog } from "./ui-logger"
import { readLockFile, httpGet, httpPost, syncActiveSession, getCurrentActiveSession, drainSessionMessages } from "./daemon-client"
import { reportCommandResult } from "./command-handler"
import {
  launchSessionAgent as _launchSessionAgent,
  launchIndependentAgent as _launchIndependentAgentCli,
  stopSessionAgent as _stopCliSession, stopAllSessionAgents as _stopAllCliSessions,
  getSessionAgentList as getRawCliSessionList,
  isSessionAgentRunning as _isCliSessionRunning,
  getSessionAgentStartedAt,
  setChatNameResolver, setSessionCloseHandler,
  type ChatType, type SessionExitInfo,
} from "./agent-launcher"
import {
  launchSdkAgent, stopSdkSession, stopAllSdkSessions,
  isSdkSessionRunning, getSdkSessionList,
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

// ── 内部工具 ──────────────────────────────────────────────

export function isSessionAgentRunning(key: string): boolean {
  return useSdkMode() ? isSdkSessionRunning(key) : _isCliSessionRunning(key)
}

export function stopSessionAgent(key: string): void {
  if (useSdkMode()) stopSdkSession(key)
  else _stopCliSession(key)
}

export function stopAllSessionAgents(): void {
  if (useSdkMode()) stopAllSdkSessions()
  else _stopAllCliSessions()
}

// ── Session 状态 ──────────────────────────────────────────

export const chatNameCache = new Map<string, string>()
export const previousActiveSessionMap = new Map<string, string>()

// ── Session 工具 ──────────────────────────────────────────

export function isMainUser(chatId?: string, chatType?: string): boolean {
  if (chatType !== "p2p") return false
  const cfg = getConfig()
  if (cfg.larkReceiveId?.trim() && chatId === cfg.larkReceiveId.trim()) return true
  if (cfg.wechatEnabled && !cfg.feishuEnabled) return true
  if (cfg.wechatEnabled && cfg.wechatAccountId && chatId && !chatId.startsWith("oc_")) return true
  return false
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

  if (failed) {
    const lock = cachedLock()
    if (lock?.port) {
      const drained = await drainSessionMessages(lock.port, sessionKey)
      broadcastLog(`[System] Agent 异常退出(exit=${exitInfo.exitCode})，已清空该会话 ${drained} 条消息`, "WARN")
    }
    if (mainChat) {
      const stderrContent = exitInfo.stderr?.trim() || ""
      const errMsg = stderrContent
        ? `⚠️ Agent 异常退出 (exit=${exitInfo.exitCode})。\n错误信息：\n${stderrContent}`
        : `⚠️ Agent 异常退出 (exit=${exitInfo.exitCode})。请检查配置后重试。`
      await notifyChat(sessionKey, errMsg)
    }
  } else if (mainChat) {
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

export async function fetchUserNames(openIds: string[]): Promise<void> {
  const missing = openIds.filter((id) => id && !chatNameCache.has(id))
  if (missing.length === 0) return
  const lock = cachedLock()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/user-names`, { openIds: missing }, 15_000)) as { names?: Record<string, string> }
    if (res?.names) {
      for (const [id, name] of Object.entries(res.names)) chatNameCache.set(id, name)
    }
  } catch { /* ignore */ }
}

// ── 消息队列 ──────────────────────────────────────────────

interface DequeuedMessage { text: string; messageId: string; chatId: string; chatType: string; senderOpenId?: string }
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
      .map((m) => (typeof m === "string" ? { text: m, messageId: "", chatId: "", chatType: "" } : m))
      .filter((m) => m.text?.trim())

    if (parsed.length === 0) return null

    const chatType = parsed[0].chatType || undefined
    const messageIds = parsed.map((m) => m.messageId).filter(Boolean)

    const text = parsed.length === 1
      ? parsed[0].text.trim()
      : parsed.map((m, i) => `【消息 ${i + 1}】\n${m.text.trim()}`).join("\n\n")

    return { text, count: parsed.length, chatType, messageIds, chatId: parsed[0].chatId || chatId, senderOpenId: parsed[0].senderOpenId || undefined }
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
  modelScenario?: ModelScenario
  modelOverride?: string
  workingDirectory?: string
}

async function launchAgent(p: LaunchAgentParams): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, senderOpenId, chatName, taskMessage } = p
  const useMain = p.useMainWorkspace ?? (chatType === "p2p")
  const config = getConfig()

  let workDir: string
  if (p.workingDirectory) {
    workDir = p.workingDirectory
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  } else if (useMain) {
    workDir = config.workspaceDir
  } else {
    const safeChatId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
    workDir = path.join(app.getPath("userData"), "workspaces", safeChatId)
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  }

  const skipIdentity = chatType === "workflow"
  await injectWorkspaceToDir(workDir, useMain || skipIdentity)

  const scenario = p.modelScenario ?? (useMain ? "primary" : chatType === "task" || chatType === "temp" || chatType === "workflow" ? "task" : "others")

  if (useSdkMode()) {
    return launchSdkAgent({ sessionKey, chatType, meta, workspaceDir: workDir, useMainWorkspace: useMain, senderOpenId, chatName, taskMessage, modelScenario: scenario, modelOverride: p.modelOverride })
  }

  if (chatType === "task" || chatType === "temp" || chatType === "workflow") {
    return _launchIndependentAgentCli(sessionKey, chatName ?? sessionKey, taskMessage ?? "", chatType, scenario, p.modelOverride)
  }
  return _launchSessionAgent(sessionKey, chatType, undefined, meta, useMain, senderOpenId, scenario)
}

export async function launchSessionAgent(
  sessionKey: string, chatType: ChatType,
  meta?: import("./agent-launcher").LaunchMeta,
  useMainWorkspace?: boolean, senderOpenId?: string,
  modelScenario?: ModelScenario,
): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({ sessionKey, chatType, meta, useMainWorkspace, senderOpenId, modelScenario })
}

export async function launchIndependentAgent(taskId: string, taskName: string, message: string, type: ChatType = "task", chatId?: string, modelScenario?: ModelScenario): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({ sessionKey: taskId, chatType: type, chatName: taskName, taskMessage: message, meta: { chatId: chatId ?? taskName, chatType: type }, modelScenario: modelScenario ?? "task" })
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
    modelScenario: "task",
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
  const rawList = useSdkMode()
    ? getSdkSessionList().map((s) => ({ ...s, pid: 0 }))
    : getRawCliSessionList()
  return rawList.map((s) => {
    const chatId = s.sessionKey.includes("::") ? s.sessionKey.split("::")[0] : s.sessionKey
    const chatName = s.chatName || chatNameCache.get(chatId) || (s.senderOpenId ? chatNameCache.get(s.senderOpenId) : undefined)
    return { ...s, chatName }
  })
}

// ── /chat 命令处理 ────────────────────────────────────────

export async function handleChatCommand(tokens: string[], port: number, messageId: string, chatId?: string): Promise<void> {
  const reply = (ok: boolean, msg: string) => reportCommandResult(port, messageId, ok, msg, chatId)
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
    await reply(true, `📋 活跃会话 (${sessions.length}):\n${lines.join("\n")}`)
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
    const lastActiveTime = replyRes?.lastReplyAt ?? getSessionAgentStartedAt(sessionKey) ?? 0
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

  const feishuOn = !!config.feishuEnabled
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

    if (feishuOn && chatType === "p2p" && senderOpenId && !chatNameCache.has(senderOpenId)) {
      await fetchUserNames([senderOpenId])
    }

    await new Promise((r) => setTimeout(r, 500))

    const userName = senderOpenId ? chatNameCache.get(senderOpenId) : undefined
    const chatName = chatNameCache.get(chatId) || userName
    const label = chatType === "group"
      ? `群聊 ${chatName ? `「${chatName}」` : chatId}`
      : (mainUser ? `主用户私聊${userName ? ` (${userName})` : ""}` : `私聊 ${userName || chatId}`)
    broadcastLog(`[Agent] ${label} 有新消息，自动拉起${mainUser ? "(主工作目录)" : ""}`)
    await notifyChat(sessionKey, "正在启动Agent，请稍等...")

    const meta: import("./agent-launcher").LaunchMeta = { chatId, chatType: chatType as "p2p" | "group" }
    const scenario: ModelScenario = mainUser ? "primary" : "others"
    const result = await launchSessionAgent(sessionKey, chatType as "p2p" | "group", meta, mainUser, senderOpenId, scenario)
    if (result.ok && chatId !== sessionKey) {
      const lock = cachedLock()
      if (lock?.port) await syncActiveSession(lock.port, chatId, sessionKey)
    }
    if (!result.ok) {
      broadcastLog(`[Agent] ${sessionKey} 启动跳过: ${result.error}`)
      await notifyChat(sessionKey, `启动Agent失败: ${result.error ?? "未知错误"}`)
      const lock = cachedLock()
      if (lock?.port) {
        const drained = await drainSessionMessages(lock.port, sessionKey)
        if (drained > 0) broadcastLog(`[Agent] ${sessionKey} 已丢弃 ${drained} 条消息（启动被拒绝）`)
      }
    }
  }
}

// ── 初始化 ────────────────────────────────────────────────

export function initSessionDispatcher(): void {
  setChatNameResolver((chatId) => chatNameCache.get(chatId))
  setSessionCloseHandler(handleSessionClosed)
}
