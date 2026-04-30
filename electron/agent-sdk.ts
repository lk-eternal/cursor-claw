import { Agent, type SDKAgent, type Run, type SDKMessage } from "@cursor/sdk"
import { getConfig } from "./config-store"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import { applyProxyEnv } from "./agent-cli"
import type { ChatType, LaunchMeta } from "./agent-launcher"

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
}

const sdkSessions = new Map<string, SdkSessionAgent>()

function broadcastSdkSessionStatus(): void {
  const list = [...sdkSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    pid: 0,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType as string,
    chatName: s.chatName,
    workspaceDir: s.workspaceDir,
  }))
  broadcastSessionStatus(list)
}

function buildSdkPrompt(meta?: LaunchMeta, taskMessage?: string): string {
  const parts: string[] = []
  parts.push("请按照digital-identity数字身份定义并遵守工作流规则cursor-claw开始工作")

  if (meta?.chatType === "p2p" || meta?.chatType === "group") {
    parts.push("如果你当前正在执行任务（上下文中已有进行中的工作），请直接继续，不要重复处理已完成的内容。")
    parts.push("否则，请立即通过 sync_message 工具获取待处理的消息并开始工作。")
  }
  if (meta?.chatType === "temp_chat") {
    parts.push("请立即通过 sync_message 工具获取待处理的消息并开始工作。")
  }
  if (meta?.chatType === "task" && taskMessage) {
    parts.push("[定时任务]")
    parts.push(taskMessage)
  }

  parts.push("\n\n---\n会话元数据:\n")
  parts.push(`[chat_id=${meta?.chatId}]`)
  parts.push(`[chat_type=${meta?.chatType}]`)
  return parts.join("\n")
}

function getMcpServerPath(): string {
  const { app } = require("electron")
  const path = require("node:path")
  const fs = require("node:fs")
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "mcp-server.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "mcp-server.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "index.js")
}

function getAdminMcpPath(): string {
  const { app } = require("electron")
  const path = require("node:path")
  const fs = require("node:fs")
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "mcp-admin.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "mcp-admin.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "server-admin-entry.js")
}

function buildInlineMcpServers(daemonPort: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    "cursor-claw": {
      type: "stdio",
      command: "node",
      args: [getMcpServerPath()],
      env: { LARK_DAEMON_PORT: String(daemonPort) },
    },
    "cursor-claw-admin": {
      type: "stdio",
      command: "node",
      args: [getAdminMcpPath()],
      env: { LARK_DAEMON_PORT: String(daemonPort) },
    },
  }

  const { getMcpServerList } = require("./daemon-manager") as typeof import("./daemon-manager")
  try {
    const servers = getMcpServerList()
    for (const s of servers) {
      if (result[s.name]) continue
      if (s.rawConfig && (s.rawConfig as Record<string, unknown>).disabled === true) continue
      if (s.type === "command" && s.command) {
        result[s.name] = { command: s.command, args: s.args, env: s.env }
      } else if (s.type === "url" && s.url) {
        const entry: Record<string, unknown> = { url: s.url }
        if (s.rawConfig?.headers) entry.headers = s.rawConfig.headers
        result[s.name] = entry
      }
    }
  } catch { /* mcp list unavailable, use built-in only */ }

  return result
}

function readDaemonPort(): number | null {
  const { app } = require("electron")
  const path = require("node:path")
  const fs = require("node:fs")
  const config = getConfig()
  const appKey = config.larkAppId || config.wechatAccountId || "default"
  const lockPath = path.join(app.getPath("userData"), "apps", appKey, "daemon.lock.json")
  try {
    if (!fs.existsSync(lockPath)) return null
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
    return lock?.port ?? null
  } catch {
    return null
  }
}

async function streamRunEvents(session: SdkSessionAgent, run: Run): Promise<void> {
  try {
    for await (const event of run.stream()) {
      if (session.abortController.signal.aborted) break
      session.lastActivityAt = Date.now()
      handleSdkEvent(session.sessionKey, event)
    }
  } catch (e: unknown) {
    if (!session.abortController.signal.aborted) {
      const msg = e instanceof Error ? e.message : String(e)
      pushUiLog("SDK", "ERROR", `[${session.sessionKey}] 流处理异常: ${msg}`)
    }
  }
}

function handleSdkEvent(sessionKey: string, event: SDKMessage): void {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text.trim()) {
          pushUiLog("SDK", "INFO", `[${sessionKey}] ${block.text.slice(0, 200)}`)
        }
      }
      break
    case "thinking":
      if (event.text.trim()) {
        pushUiLog("SDK", "DEBUG", `[${sessionKey}] [thinking] ${event.text.slice(0, 120)}`)
      }
      break
    case "tool_call":
      pushUiLog("SDK", "INFO", `[${sessionKey}] [tool] ${event.name}: ${event.status}`)
      break
    case "status":
      pushUiLog("SDK", "INFO", `[${sessionKey}] [status] ${event.status}${event.message ? ` - ${event.message}` : ""}`)
      break
  }
}

// ── 公开 API ────────────────────────────────────────

export function isSdkSessionRunning(sessionKey: string): boolean {
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
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  daemonPort?: number
}

export async function launchSdkAgent(opts: SdkLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, workspaceDir, senderOpenId, chatName, taskMessage } = opts

  if (isSdkSessionRunning(sessionKey)) {
    sdkSessions.get(sessionKey)!.lastActivityAt = Date.now()
    return { ok: true }
  }

  const config = getConfig()
  const apiKey = config.cursorApiKey?.trim()
  if (!apiKey) {
    return { ok: false, error: "Cursor API Key 未配置（设置 → Agent 驱动模式）" }
  }

  const daemonPort = opts.daemonPort ?? readDaemonPort()
  const mcpServers = daemonPort ? buildInlineMcpServers(daemonPort) : undefined

  const prompt = buildSdkPrompt(meta, taskMessage)

  try {
    pushUiLog("SDK", "INFO", `[${sessionKey}] 正在创建 SDK Agent (cwd=${workspaceDir})`)

    const agent = await Agent.create({
      apiKey,
      model: { id: config.model && config.model !== "auto" ? config.model : "claude-4.6-opus-max" },
      local: {
        cwd: workspaceDir,
        settingSources: ["project", "user"],
      },
      ...(mcpServers ? { mcpServers: mcpServers as any } : {}),
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
    }

    sdkSessions.set(sessionKey, session)
    broadcastLog(`[SDK] 会话 ${sessionKey} 已创建, agentId=${agent.agentId}`)
    broadcastSdkSessionStatus()

    const run = await agent.send(prompt)
    session.run = run

    streamRunEvents(session, run).then(() => {
      pushUiLog("SDK", "INFO", `[${sessionKey}] Agent 运行结束 (status=${run.status})`)
      sdkSessions.delete(sessionKey)
      broadcastSdkSessionStatus()
    })

    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[SDK] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    sdkSessions.delete(sessionKey)
    broadcastSdkSessionStatus()
    return { ok: false, error: msg }
  }
}

export function stopSdkSession(sessionKey: string): void {
  const s = sdkSessions.get(sessionKey)
  if (!s) return
  s.abortController.abort()
  if (s.run) {
    s.run.cancel().catch(() => {})
  }
  s.agent.close()
  sdkSessions.delete(sessionKey)
  broadcastSdkSessionStatus()
}

export function stopAllSdkSessions(): void {
  for (const key of [...sdkSessions.keys()]) {
    stopSdkSession(key)
  }
}

export async function checkSdkApiKey(): Promise<{ ok: boolean; email?: string; error?: string }> {
  const config = getConfig()
  const apiKey = config.cursorApiKey?.trim()
  if (!apiKey) return { ok: false, error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const me = await Cursor.me({ apiKey })
    return { ok: true, email: me.userEmail }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export async function listSdkModels(): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }> {
  const config = getConfig()
  const apiKey = config.cursorApiKey?.trim()
  if (!apiKey) return { ok: false, models: [], error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const sdkModels = await Cursor.models.list({ apiKey })
    const currentModel = config.model?.trim() || ""
    const models = sdkModels.map((m) => ({
      id: m.id,
      label: m.displayName || m.id,
      current: m.id === currentModel,
    }))
    return { ok: true, models }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, models: [], error: msg }
  }
}
