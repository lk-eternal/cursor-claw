import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as http from "node:http"
import * as https from "node:https"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { app, BrowserWindow, ipcMain, powerSaveBlocker } from "electron"
import { getConfig, saveConfig, useSdkMode, type AppConfig, type ScheduledTask } from "./config-store"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { pushLog, pushUiLog, broadcastLog, getLogBuffer, clearLogBuffer, logCursorAgentInvocation, escapeLogContentSingleLine, resetLogFilePath } from "./ui-logger"
import { resolveAgentBinary, applyProxyEnv, quoteArg, getAgentPaths, execAgentSync } from "./agent-cli"
import {
  stopAgent as _stopCliAgent,
  isAgentRunning as _isCliAgentRunning, getRunningSessionCount as _getCliRunningCount,
  getAgentChildPid, getSessionAgentCount as _getCliSessionCount, getIndependentTaskStatuses as _getCliTaskStatuses,
  P2P_SESSION_KEY, setMainChatId, getMainChatId,
  type ChatType,
} from "./agent-launcher"
import { stopAllSdkSessions, getSdkSessionCount, getSdkSessionList, checkSdkApiKey, listSdkModels } from "./agent-sdk"
import {
  setDaemonPort, registerEnableMcpFn, getMcpServerPath, getAdminMcpPath,
  injectMcpToDir, injectRulesToDir, injectSkillsToDir,
  injectWorkspaceToDir, injectWorkspaceMcpAndRules, clearInjectionCache,
} from "./workspace-injector"
import {
  invalidateMcpEnabledCache,
  getMcpServerList,
  getMcpEnabledMap,
  toggleMcpServer,
  deleteMcpServer,
  saveMcpServer,
  McpServerEntry,
} from "./mcp-manager"
import { FileCommand, reportCommandResult, handleFeishuModelCommand, handleFeishuMcpCommand, handleFeishuTaskCommand, parseListModelsStdout, type TaskRunFn } from "./command-handler"
import { readLockFile, httpGet, httpPost, syncActiveSession, getCurrentActiveSession } from "./daemon-client"
import {
  isSessionAgentRunning, stopSessionAgent, stopAllSessionAgents,
  dispatchSessionAgents, launchSessionAgent, launchIndependentAgent,
  getSessionAgentList, handleChatCommand, clearMessageQueue, getQueueMessages,
  pullMergedMessagesFromQueue, isMainUser, extractChatId, chatNameCache,
  fetchChatNames, fetchUserNames, initSessionDispatcher,
} from "./session-dispatcher"

export { applyProxyEnv, checkCliInstalled, installCli, execAgentSync, execAgentAsync, type ExecAgentOptions as ExecAgentSyncOptions } from "./agent-cli"
export { checkAgentLoggedIn, loginCli } from "./agent-launcher"
export { getLogBuffer } from "./ui-logger"
export { checkSdkApiKey, listSdkModels } from "./agent-sdk"
export { injectWorkspaceMcpAndRules, injectWorkspaceToDir, clearInjectionCache, getMcpServerPath, getAdminMcpPath } from "./workspace-injector"
export { getQueueMessages, clearMessageQueue } from "./session-dispatcher"


function isAgentRunning(): boolean {
  return useSdkMode() ? getSdkSessionCount() > 0 : _isCliAgentRunning()
}

function getRunningSessionCount(): number {
  return useSdkMode() ? getSdkSessionCount() : _getCliRunningCount()
}

function getSessionAgentCount(): number {
  return useSdkMode() ? getSdkSessionCount() : _getCliSessionCount()
}

function stopAgent(): void {
  if (useSdkMode()) stopAllSdkSessions()
  else _stopCliAgent()
}

function getIndependentTaskStatuses(): Record<string, { running: boolean; pid?: number; startedAt?: number }> {
  if (useSdkMode()) {
    const out: Record<string, { running: boolean; pid?: number; startedAt?: number }> = {}
    for (const s of getSdkSessionList()) {
      if (s.chatType === "task") out[s.sessionKey] = { running: true, startedAt: s.startedAt }
    }
    return out
  }
  return _getCliTaskStatuses()
}


const UNIFIED_DAEMON_PREFIX = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3} \[Daemon\] /

const LEGACY_COMMA_DAEMON = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3}),(?:Lark)?Daemon,(INFO|WARN|ERROR|DEBUG),(.+)$/

function normalizeUnifiedDaemonLine(s: string): string {
  return s.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:)/, "$1 $2")
}

function pushDaemonStderrLine(rawLine: string): void {
  const t = rawLine.trim()
  if (!t) return
  if (UNIFIED_DAEMON_PREFIX.test(t)) {
    pushLog(normalizeUnifiedDaemonLine(t))
    return
  }
  const legacyComma = t.match(LEGACY_COMMA_DAEMON)
  if (legacyComma) {
    const ts = legacyComma[1].replace("T", " ")
    pushLog(`${ts} [Daemon] ${legacyComma[2]} ${legacyComma[3]}`)
    return
  }
  const legacy = t.match(/^\[(?:Lark)?Daemon\]\[([^\]]+)\]\[([^\]]+)\]\s*(.*)$/)
  if (legacy) {
    const ts = legacy[1].replace("T", " ")
    pushLog(`${ts} [Daemon] ${legacy[2]} ${escapeLogContentSingleLine(legacy[3])}`)
    return
  }
  pushUiLog("Daemon", "WARN", t)
}


export interface DaemonStatus {
  running: boolean
  version?: string
  uptime?: number
  queueLength?: number
  hasTarget?: boolean
  autoOpenId?: string | null
  agentRunning?: boolean
  agentPid?: number | null
  sessionAgentCount?: number
  cliAvailable?: boolean
  error?: string
  model?: string
  workspaceMismatch?: boolean
  daemonWorkspaceDir?: string
  feishuEnabled?: boolean
  feishuConnected?: boolean
  wechatEnabled?: boolean
  wechatStatus?: string
  wechatReady?: boolean
}

let daemonProcess: ChildProcess | null = null
let statusInterval: NodeJS.Timeout | null = null
let cachedPort: number | null = null
/** 本次由本应用启动成功时 Daemon 所绑定的工作目录（用于目录切换后的状态判断） */
let activeDaemonWorkspaceDir: string | null = null

let tempConnProcess: ChildProcess | null = null

function getDaemonEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "daemon-entry.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "daemon-entry.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "daemon-entry.js")
}

function startTempConnection(appId: string, appSecret: string): Promise<{ openId: string; chatId: string }> {
  stopTempConnection()
  return new Promise((resolve, reject) => {
    const entry = getDaemonEntryPath()
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      LARK_APP_ID: appId,
      LARK_APP_SECRET: appSecret,
      LARK_TEMP_MODE: "1",
      APP_DATA_DIR: app.getPath("userData"),
    }
    const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] })
    tempConnProcess = child

    let settled = false
    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n")
      for (const line of lines) {
        if (line.startsWith("__BIND_RESULT__:")) {
          const json = line.slice("__BIND_RESULT__:".length).trim()
          try {
            const result = JSON.parse(json)
            settled = true
            resolve(result)
          } catch { /* ignore parse error */ }
        }
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) pushLog(`[TEMP_CONN] ${text}`)
    })
    child.on("exit", (code) => {
      tempConnProcess = null
      if (!settled) reject(new Error(`临时连接进程退出: code=${code}`))
    })
    child.on("error", (err) => {
      tempConnProcess = null
      if (!settled) reject(err)
    })
  })
}

function stopTempConnection(): void {
  if (tempConnProcess) {
    tempConnProcess.kill()
    tempConnProcess = null
  }
}



function httpsPost(url: string, body: object, headers: Record<string, string> = {}, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data).toString(), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: string[] = []
      res.on("data", (c: Buffer) => chunks.push(c.toString()))
      res.on("end", () => {
        try { resolve(JSON.parse(chunks.join(""))) } catch { resolve(null) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.end(data)
  })
}

async function larkSendTestMessage(receiveId: string): Promise<void> {
  const cfg = getConfig()
  if (!cfg.larkAppId || !cfg.larkAppSecret) throw new Error("飞书凭据未配置")
  const tokenResp = await httpsPost("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: cfg.larkAppId,
    app_secret: cfg.larkAppSecret,
  })
  const token = tokenResp?.tenant_access_token
  if (!token) throw new Error("获取 access_token 失败")
  const sendResp = await httpsPost(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
    { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text: "🔗 绑定测试成功！连接正常。" }) },
    { Authorization: `Bearer ${token}` },
  )
  if (sendResp?.code !== 0) throw new Error(sendResp?.msg || "发送失败")
}


export async function getDaemonStatus(): Promise<DaemonStatus> {
  const config = getConfig()
  const cfgWs = (config.workspaceDir || "").trim()

  const statusFromHealth = (port: number, health: Record<string, unknown>): DaemonStatus => {
    cachedPort = port
    setDaemonPort(port)
    const cfgModel = config.model?.trim() || "auto"
    const status: DaemonStatus = {
      running: true,
      version: health.version as string,
      uptime: health.uptime as number,
      queueLength: health.queueLength as number,
      hasTarget: health.hasTarget as boolean,
      autoOpenId: health.autoOpenId as string | null,
      agentRunning: isAgentRunning() || getSessionAgentCount() > 0,
      agentPid: getAgentChildPid(),
      sessionAgentCount: getRunningSessionCount(),
      model: cfgModel,
      feishuEnabled: health.feishuEnabled as boolean | undefined,
      feishuConnected: health.feishuConnected as boolean | undefined,
      wechatEnabled: health.wechatEnabled as boolean | undefined,
      wechatStatus: health.wechatStatus as string | undefined,
      wechatReady: !!(health.wechatStatus === "connected" && health.lastWechatChatId),
    }
    if (status.autoOpenId && !config.larkReceiveId) {
      saveConfig({ larkReceiveId: status.autoOpenId })
    }
    return status
  }

  const tryHealth = async (port: number): Promise<DaemonStatus | null> => {
    try {
      const health = await httpGet(`http://127.0.0.1:${port}/health`) as Record<string, unknown>
      if (health.status !== "ok") {
        return null
      }
      return statusFromHealth(port, health)
    } catch {
      return null
    }
  }

  const lock = readLockFile()
  if (lock?.port) {
    const st = await tryHealth(lock.port)
    if (st) {
      const mismatch =
        activeDaemonWorkspaceDir !== null && activeDaemonWorkspaceDir !== cfgWs
      if (mismatch) {
        st.workspaceMismatch = true
        st.daemonWorkspaceDir = activeDaemonWorkspaceDir ?? undefined
      }
      return st
    }
  }

  if (cachedPort) {
    const st = await tryHealth(cachedPort)
    if (st) {
      const mismatch =
        !lock?.port ||
        lock.port !== cachedPort ||
        (activeDaemonWorkspaceDir !== null && activeDaemonWorkspaceDir !== cfgWs)
      if (mismatch) {
        st.workspaceMismatch = true
        st.daemonWorkspaceDir = activeDaemonWorkspaceDir ?? undefined
      }
      return st
    }
  }

  return { running: false, error: "Daemon 未运行" }
}

function ensureCliConfig(): void {
  try {
    const cliConfigPath = path.join(os.homedir(), ".cursor", "cli-config.json")
    let config: Record<string, unknown> = {}
    if (fs.existsSync(cliConfigPath)) {
      config = JSON.parse(fs.readFileSync(cliConfigPath, "utf-8"))
    }
    const network = (config.network ?? {}) as Record<string, unknown>
    if (network.useHttp1ForAgent !== true) {
      network.useHttp1ForAgent = true
      config.network = network
      if (!config.version) config.version = 1
      if (!config.editor) config.editor = { vimMode: false }
      if (!config.permissions) config.permissions = { allow: [], deny: [] }
      const dir = path.dirname(cliConfigPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(cliConfigPath, JSON.stringify(config, null, 2), "utf-8")
    }
  } catch { /* ignore */ }
}

export async function startDaemon(): Promise<{ ok: boolean; error?: string }> {
  const config = getConfig()
  const feishuReady = !!(config.feishuEnabled && config.larkAppId && config.larkAppSecret)
  const wechatReady = !!(config.wechatEnabled && config.wechatToken)
  if (!feishuReady && !wechatReady) {
    return { ok: false, error: "至少需要配置一个消息通道（飞书凭据或微信 Token）" }
  }
  if (!config.workspaceDir) {
    return { ok: false, error: "工作目录未配置" }
  }

  ensureCliConfig()

  const existingStatus = await getDaemonStatus()
  if (existingStatus.running) {
    if (daemonProcess) {
      startStatusPolling()
      return { ok: true }
    }
    try {
      const lock = readLockFile()
      const portToShutdown = lock?.port ?? cachedPort
      if (portToShutdown) {
        await httpPost(`http://127.0.0.1:${portToShutdown}/shutdown`, {})
        await new Promise((r) => setTimeout(r, 1500))
      }
    } catch { /* ignore orphan cleanup */ }
  }

  const entryPath = getDaemonEntryPath()
  if (!fs.existsSync(entryPath)) {
    return { ok: false, error: `Daemon 入口文件不存在: ${entryPath}` }
  }

  try {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      LARK_WORKSPACE_DIR: config.workspaceDir,
      APP_DATA_DIR: app.getPath("userData"),
      NODE_USE_ENV_PROXY: "1",
      ...(feishuReady ? {
        FEISHU_ENABLED: "1",
        LARK_APP_ID: config.larkAppId,
        LARK_APP_SECRET: config.larkAppSecret,
        LARK_RECEIVE_ID: config.larkReceiveId,
        LARK_RECEIVE_ID_TYPE: "chat_id",
      } : {}),
      ...(wechatReady ? {
        WECHAT_ENABLED: "1",
        WECHAT_TOKEN: config.wechatToken,
        WECHAT_ACCOUNT_ID: config.wechatAccountId,
      } : {}),
    }
    applyProxyEnv(env, config)

    let earlyOutput = ""
    let earlyExit: number | null = null
    let daemonStdoutBuf = ""
    let daemonStderrBuf = ""

    daemonProcess = spawn(process.execPath, [entryPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    })

    daemonProcess.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      earlyOutput += chunk
      daemonStdoutBuf += chunk
      const parts = daemonStdoutBuf.split(/\r?\n/)
      daemonStdoutBuf = parts.pop() ?? ""
      for (const raw of parts) {
        const line = raw.trim()
        if (!line || line.startsWith("[info]:")) continue
        if (line.startsWith("__IND_LAUNCH__:")) {
          try {
            const payload = JSON.parse(line.slice("__IND_LAUNCH__:".length))
            void launchIndependentAgent(payload.taskId, payload.taskName, payload.content)
          } catch { /* ignore malformed */ }
          continue
        }
        if (line.startsWith("__BIND_RESULT__:")) {
          try {
            const payload = JSON.parse(line.slice("__BIND_RESULT__:".length))
            const chatId = payload.chatId
            if (chatId) {
              saveConfig({ larkReceiveId: chatId })
              broadcastLog(`[Bind] 主用户绑定成功: chat_id=${chatId}`)
              BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("bind:result", { ok: true, value: chatId }))
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WORKSPACE_SWITCH__:")) {
          try {
            const { dir } = JSON.parse(line.slice("__WORKSPACE_SWITCH__:".length))
            if (dir) void applyWorkspaceSwitch(dir, false)
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WECHAT_QR__:")) {
          const dataUrl = line.slice("__WECHAT_QR__:".length)
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:qrcode", dataUrl))
          continue
        }
        if (line.startsWith("__WECHAT_STATUS__:")) {
          const status = line.slice("__WECHAT_STATUS__:".length)
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:status", status))
          continue
        }
        pushUiLog("Daemon", "INFO", line)
      }
    })

    daemonProcess.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      earlyOutput += chunk
      daemonStderrBuf += chunk
      const parts = daemonStderrBuf.split(/\r?\n/)
      daemonStderrBuf = parts.pop() ?? ""
      for (const raw of parts) {
        pushDaemonStderrLine(raw)
      }
    })

    daemonProcess.on("exit", (code) => {
      earlyExit = code
      daemonProcess = null
      cachedPort = null
      setDaemonPort(null)
      activeDaemonWorkspaceDir = null
      broadcastStatus({ running: false, error: `Daemon 退出 (code=${code})` })
    })

    const lock = await waitForLockFile(15_000)
    if (!lock) {
      if (earlyExit !== null) {
        return { ok: false, error: `Daemon 进程已退出 (code=${earlyExit})。输出:\n${earlyOutput.slice(-500)}` }
      }
      return { ok: false, error: "Daemon 启动超时（未生成 lock 文件）" }
    }

    cachedPort = lock.port
    setDaemonPort(lock.port)
    activeDaemonWorkspaceDir = config.workspaceDir.trim() || null
    startStatusPolling()
    await injectWorkspaceMcpAndRules()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `启动失败: ${msg}` }
  }
}

export async function stopDaemon(): Promise<void> {
  stopStatusPolling()
  stopAgent()
  clearLogBuffer()

  if (cachedPort) {
    try {
      await httpPost(`http://127.0.0.1:${cachedPort}/shutdown`, {})
      await new Promise((r) => setTimeout(r, 500))
    } catch { /* ignore */ }
  }

  if (daemonProcess && !daemonProcess.killed) {
    try { daemonProcess.kill("SIGTERM") } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000))
    if (daemonProcess && !daemonProcess.killed) {
      try { daemonProcess.kill("SIGKILL") } catch { /* ignore */ }
    }
  }
  daemonProcess = null
  cachedPort = null
  setDaemonPort(null)
  activeDaemonWorkspaceDir = null
  broadcastStatus({
    running: false,
    error: "Daemon 未运行",
    agentRunning: false,
    agentPid: null,
    queueLength: 0,
  })
}

function waitForLockFile(timeoutMs: number): Promise<{ port: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      const lock = readLockFile()
      if (lock?.port) {
        resolve(lock)
        return
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null)
        return
      }
      setTimeout(check, 300)
    }
    check()
  })
}

function broadcastStatus(status: DaemonStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("daemon:status-update", status)
  }
}


let powerSaveBlockerId: number | null = null
let sseReq: http.ClientRequest | null = null
let sseDispatchDebounce: NodeJS.Timeout | null = null

function startDaemonPowerSaveBlock(): void {
  stopDaemonPowerSaveBlock()
  try {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension")
  } catch { /* ignore */ }
}

function stopDaemonPowerSaveBlock(): void {
  if (powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId)
    } catch { /* ignore */ }
    powerSaveBlockerId = null
  }
}

let sseBackoff = 1_000
const SSE_BACKOFF_MAX = 30_000

function connectSseQueueEvents(): void {
  disconnectSseQueueEvents()
  const lock = readLockFile()
  if (!lock?.port) return
  const url = `http://127.0.0.1:${lock.port}/api/queue-events`
  let buf = ""
  sseReq = http.get(url, { timeout: 0 }, (res) => {
    sseBackoff = 1_000
    res.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        try {
          const ev = JSON.parse(line.slice(6))
          if (ev.type === "queue-update") {
            if (sseDispatchDebounce) clearTimeout(sseDispatchDebounce)
            sseDispatchDebounce = setTimeout(() => dispatchSessionAgents().catch(() => {}), 300)
          }
        } catch { /* ignore */ }
      }
    })
    res.on("end", () => {
      sseReq = null
      setTimeout(() => connectSseQueueEvents(), sseBackoff)
      sseBackoff = Math.min(sseBackoff * 2, SSE_BACKOFF_MAX)
    })
  })
  sseReq.on("error", () => {
    sseReq = null
    setTimeout(() => connectSseQueueEvents(), sseBackoff)
    sseBackoff = Math.min(sseBackoff * 2, SSE_BACKOFF_MAX)
  })
}

function disconnectSseQueueEvents(): void {
  if (sseDispatchDebounce) { clearTimeout(sseDispatchDebounce); sseDispatchDebounce = null }
  if (sseReq) { try { sseReq.destroy() } catch { /* */ }; sseReq = null }
}

function startStatusPolling(): void {
  stopStatusPolling()
  startDaemonPowerSaveBlock()
  connectSseQueueEvents()
  statusInterval = setInterval(async () => {
    try {
      const status = await getDaemonStatus()
      broadcastStatus(status)

      if (status.running && status.queueLength && status.queueLength > 0) {
        await dispatchSessionAgents()
      }

      const sessions = getSessionAgentList()
      if (getConfig().feishuEnabled) {
        const uncachedGroups = sessions
          .filter((s) => s.chatType === "group" && !chatNameCache.has(s.sessionKey))
          .map((s) => s.sessionKey)
        if (uncachedGroups.length > 0) await fetchChatNames(uncachedGroups)

        const uncachedP2pOpenIds = sessions
          .filter((s) => s.chatType === "p2p" && s.senderOpenId && !chatNameCache.has(s.senderOpenId))
          .map((s) => s.senderOpenId!)
        if (uncachedP2pOpenIds.length > 0) await fetchUserNames(uncachedP2pOpenIds)
      }

      if (status.running) {
        await checkAndExecutePendingCommands()
      }
    } catch (e: unknown) {
      broadcastLog(`[StatusPoll] 异常: ${e instanceof Error ? e.message : e}`, "ERROR")
    }
  }, 5_000)
}

function stopStatusPolling(): void {
  disconnectSseQueueEvents()
  if (statusInterval) {
    clearInterval(statusInterval)
    statusInterval = null
  }
  stopDaemonPowerSaveBlock()
}




// ── CLI 检测与安装 ──────────────────────────────────────────




// ── Agent 状态与会话管理（委托 agent-launcher） ─────────────

export type AgentLoginStatus = {
  cliFound: boolean
  loggedIn: boolean
  identityLine?: string
  error?: string
}

async function checkAndExecutePendingCommands(): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return

  let commandsRes: { commands?: FileCommand[] }
  try {
    commandsRes = await httpGet(`http://127.0.0.1:${lock.port}/commands`) as { commands?: FileCommand[] }
  } catch { return }

  const cmds = commandsRes.commands
  if (!cmds || cmds.length === 0) return

  for (const cmd of cmds) {
    let claimed: { command: string; messageId: string; chatId?: string; chatType?: string } | null
    try {
      const claimRes = await httpPost(`http://127.0.0.1:${lock.port}/commands/claim`, { id: cmd.id }) as
        { ok: boolean; command?: string; messageId?: string; chatId?: string; chatType?: string }
      if (!claimRes.ok) continue
      claimed = { command: claimRes.command!, messageId: claimRes.messageId!, chatId: claimRes.chatId, chatType: claimRes.chatType }
    } catch { continue }

    const rawCmd = claimed.command.trim()
    const cmdTokens = rawCmd.split(/\s+/).filter((t) => t.length > 0)
    const head = (cmdTokens[0] ?? "").toLowerCase()
    const isAdmin = isMainUser(claimed.chatId, claimed.chatType)
    const reply = (ok: boolean, msg: string) => reportCommandResult(lock.port, claimed!.messageId, ok, msg, claimed!.chatId)
    const denyNonAdmin = () => reply(false, "🔒 该指令仅管理员可用")

    broadcastLog(`[指令] 执行 ${rawCmd} (msgId=${claimed.messageId} admin=${isAdmin})`)
    try {
      switch (head) {
        case "/stop": {
          if (isAdmin) {
            const wasRunning = isAgentRunning()
            stopAgent()
            await reply(true, wasRunning ? "✅ Agent 已停止" : "❌ Agent 当前未运行")
          } else if (claimed.chatId && isSessionAgentRunning(claimed.chatId)) {
            stopSessionAgent(claimed.chatId)
            await reply(true, "✅ 当前会话 Agent 已停止")
          } else {
            await reply(false, "❌ 当前会话无运行中的 Agent")
          }
          break
        }

        case "/status": {
          const status = await getDaemonStatus()
          const schedTasks = readTasksFromFile()
          const schedTotal = schedTasks.length
          const schedEnabled = schedTasks.filter((t) => t.enabled).length
          const lines = [
            `🛡️ Daemon: ${status.running ? "✅ 运行中" : "❌ 未运行"}`,
            status.version ? `🔄 版本: ${status.version}` : "",
            status.uptime !== undefined ? `⌛️ 运行时间: ${Math.floor(status.uptime / 60)}分钟` : "",
            `🤖 Agent: ${isAgentRunning() ? `✅ 运行中 (PID: ${getAgentChildPid()})` : "❌ 未运行"}`,
            `📭 队列消息: ${status.queueLength ?? 0} 条`,
            `⏰ 定时任务: 开启 ${schedEnabled} / 共 ${schedTotal} 条`,
          ].filter(Boolean)
          await reply(true, lines.join("\n"))
          break
        }

        case "/list": {
          const msgs = await getQueueMessages()
          const filtered = isAdmin ? msgs : msgs.filter((m) => m.chatId === claimed!.chatId)
          if (filtered.length === 0) {
            await reply(true, "📭 消息队列为空")
          } else {
            const lines = filtered.map((m) => `  [${m.index}] ${m.preview}`)
            await reply(true, `📬 队列中有 ${filtered.length} 条消息：\n${lines.join("\n")}`)
          }
          break
        }

        case "/task": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuTaskCommand(lock.port, claimed.messageId, rawCmd, (id, name, content) => launchIndependentAgent(id, name, content), claimed.chatId)
          break
        }

        case "/model": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuModelCommand(lock.port, claimed.messageId, rawCmd, claimed.chatId)
          break
        }

        case "/mcp": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuMcpCommand(lock.port, claimed.messageId, rawCmd, claimed.chatId)
          break
        }

        case "/restart": {
          if (!isAdmin) { await denyNonAdmin(); break }
          stopAgent()
          const cleared = await clearMessageQueue()
          await reply(true, `✅ Agent 已停止，已清空 ${cleared} 条队列消息，正在重启 Daemon...`)
          await stopDaemon()
          await new Promise((r) => setTimeout(r, 1500))
          const result = await startDaemon()
          if (!result.ok) broadcastLog(`[指令] Daemon 重启失败: ${result.error}`, "ERROR")
          break
        }

        case "/clean": {
          if (!isAdmin) { await denyNonAdmin(); break }
          const cleared = await clearMessageQueue()
          broadcastLog(`[指令 /clean] 已清空队列 ${cleared} 条`, "INFO")
          await reply(true, `✅ 已清空消息队列，共移除 ${cleared} 条`)
          break
        }

        case "/reset": {
          if (isAdmin) {
            stopAgent()
            setMainChatId(getConfig().workspaceDir, "")
            broadcastLog("[指令 /reset] 已清除主会话并停止 Agent，下次启动将创建新会话", "INFO")
            await reply(true, "✅ 已停止并重置当前会话, 请重新发消息开启新会话")
          } else if (claimed.chatId && isSessionAgentRunning(claimed.chatId)) {
            stopSessionAgent(claimed.chatId)
            await reply(true, "✅ 当前会话已重置, 请重新发消息开启新会话")
          } else {
            await reply(true, "✅ 当前会话已重置, 请重新发消息开启新会话")
          }
          break
        }

        case "/workspace": {
          if (!isAdmin) { await denyNonAdmin(); break }
          const wsArgs = cmdTokens.slice(1)
          if (wsArgs.length === 0 || wsArgs[0] === "info") {
            const cfg = getConfig()
            await reply(true, `📂 当前工作目录: ${cfg.workspaceDir || "(未配置)"}`)
          } else if (wsArgs[0] === "set" && wsArgs.length >= 2) {
            const newDir = wsArgs.slice(1).join(" ").trim()
            const cfg = getConfig()
            if (newDir === cfg.workspaceDir) {
              await reply(true, `📂 工作目录未变化: ${newDir}`)
            } else {
              await reply(true, `📂 正在切换工作目录到: ${newDir}\n⏳ 切换中...`)
              const wsResult = await applyWorkspaceSwitch(newDir, false)
              if (wsResult.ok) {
                broadcastLog(`[指令 /workspace] 已切换到 ${newDir}`, "INFO")
              } else {
                broadcastLog(`[指令 /workspace] 切换失败: ${wsResult.error}`, "ERROR")
              }
            }
          } else {
            await reply(false, "用法：/workspace 查看当前 | /workspace set <路径>")
          }
          break
        }

        case "/chat": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleChatCommand(cmdTokens, lock.port, claimed!.messageId, claimed!.chatId)
          break
        }

        case "/help": {
          const common = [
            "🔹 /status 运行状态",
            "🔹 /stop 停止Agent",
            "🔹 /reset 重置会话",
            "🔹 /help 指令列表",
          ]
          const adminOnly = [
            "🔹 /restart 重启应用",
            "🔹 /list 消息队列",
            "🔹 /clean 清空队列",
            "🔹 /task 定时任务",
            "🔹 /model 模型设置",
            "🔹 /mcp MCP服务器管理",
            "🔹 /workspace 切换工作目录",
            "🔹 /chat 会话管理",
          ]
          const lines = isAdmin
            ? ["💡 可用指令（管理员）：", ...common, ...adminOnly]
            : ["💡 可用指令：", ...common]
          await reply(true, lines.join("\n"))
          break
        }

        default:
          await reply(false, `😅 未知指令: ${head}`)
      }
    } catch (e: unknown) {
      broadcastLog(`[指令] ${rawCmd} 执行异常: ${e instanceof Error ? e.message : e}`, "ERROR")
      try { await reply(false, `❌ 执行异常: ${e instanceof Error ? e.message : e}`) } catch { /* ignore */ }
    }
  }
}


export interface WorkspaceSessionInfo {
  sessionKey: string
  chatName?: string
}

export interface ConfigSaveResult {
  ok: boolean
  /** 工作目录变更：旧目录下存在活跃会话，需用户选择保留或结束 */
  needWorkspaceConfirm?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  existingSessions?: WorkspaceSessionInfo[]
  /** 因目录冲突未写入 store，完成向导需在切换成功后补写 */
  deferredSetupComplete?: boolean
  /** 本次已将工作目录写入配置；渲染进程应刷新依赖工作区的数据（如 MCP 列表与启用状态） */
  workspaceDirChanged?: boolean
}

/**
 * 切换工作目录：可选地停止旧会话，然后热更新到新目录。
 */
export async function applyWorkspaceSwitch(workspaceDir: string, stopOldSessions: boolean): Promise<{ ok: boolean; error?: string }> {
  const w = workspaceDir.trim()
  if (!w) return { ok: false, error: "工作目录为空" }

  if (stopOldSessions) {
    stopAllSessionAgents()
  }

  saveConfig({ workspaceDir: w })
  invalidateMcpEnabledCache()
  clearInjectionCache()
  resetLogFilePath()
  await injectWorkspaceMcpAndRules()
  broadcastStatus(await getDaemonStatus())
  return { ok: true }
}

/**
 * 保存配置；若工作目录变更且旧目录有活跃会话，返回会话列表供渲染进程展示确认弹窗。
 */
export async function saveAppConfigFromRenderer(partial: Partial<AppConfig>): Promise<ConfigSaveResult> {
  const current = getConfig()
  const oldW = (current.workspaceDir || "").trim()
  const nextW = partial.workspaceDir !== undefined ? partial.workspaceDir.trim() : oldW
  const workspaceChanging = partial.workspaceDir !== undefined && nextW !== oldW && oldW !== ""

  if (workspaceChanging) {
    const st = await getDaemonStatus()
    if (st.running) {
      const sessions = getSessionAgentList()
      const deferredSc = partial.setupComplete === true
      const rest: Partial<AppConfig> = { ...partial }
      delete (rest as Record<string, unknown>).workspaceDir
      if (deferredSc) delete (rest as Record<string, unknown>).setupComplete
      saveConfig({ ...rest, workspaceDir: oldW })
      broadcastStatus(await getDaemonStatus())
      return {
        ok: true,
        needWorkspaceConfirm: true,
        oldWorkspaceDir: oldW,
        newWorkspaceDir: nextW,
        existingSessions: sessions.map((s) => ({ sessionKey: s.sessionKey, chatName: s.chatName })),
        deferredSetupComplete: deferredSc,
      }
    }
  }

  const workspaceDirChanged = partial.workspaceDir !== undefined && nextW !== oldW
  if (workspaceDirChanged) {
    invalidateMcpEnabledCache()
    resetLogFilePath()
  }

  saveConfig(partial)
  return { ok: true, ...(workspaceDirChanged ? { workspaceDirChanged: true } : {}) }
}

// ── 初始化 ───────────────────────────────────────────────

export function initDaemonManager(): void {
  initSessionDispatcher()
  registerEnableMcpFn(async (wsDir, serverNames) => {
    for (const name of serverNames) await toggleMcpServer(name, true, wsDir)
  })
  ipcMain.handle("config:apply-workspace-switch", (_, workspaceDir: string, stopOldSessions: boolean) => applyWorkspaceSwitch(workspaceDir, stopOldSessions))
  ipcMain.handle("daemon:get-log-buffer", () => getLogBuffer())
  ipcMain.handle("agent:stop", () => { stopAgent(); return { ok: true } })
  ipcMain.handle("agent:sessions", () => getSessionAgentList())
  ipcMain.handle("bind:start", async () => {
    const lock = readLockFile()
    if (!lock) return { ok: false, error: "Daemon 未运行" }
    try {
      await httpPost(`http://127.0.0.1:${lock.port}/start-bind`, {})
      return { ok: true }
    } catch {
      return { ok: false, error: "无法通知 Daemon" }
    }
  })
  ipcMain.handle("bind:test", async () => {
    const chatId = getConfig().larkReceiveId?.trim()
    if (!chatId) return { ok: false, error: "未绑定主用户" }
    try {
      await larkSendTestMessage(chatId)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "发送失败" }
    }
  })
  ipcMain.handle("bind:test-wechat", async () => {
    const lock = readLockFile()
    if (!lock?.port) return { ok: false, error: "Daemon 未运行" }
    try {
      const res = await httpPost(`http://127.0.0.1:${lock.port}/wechat-test`, {}) as { ok?: boolean; error?: string }
      return res
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "发送失败" }
    }
  })
  ipcMain.handle("agent:stop-session", (_e, sessionKey: string) => { stopSessionAgent(sessionKey); return { ok: true } })
  ipcMain.handle("agent:stop-all-sessions", () => { stopAllSessionAgents(); return { ok: true } })

  ipcMain.handle("temp-conn:start", async (_e, appId: string, appSecret: string) => {
    try {
      const result = await startTempConnection(appId, appSecret)
      return { ok: true, ...result }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) }
    }
  })
  ipcMain.handle("temp-conn:stop", () => { stopTempConnection(); return { ok: true } })

  // ── WeChat QR code login (runs in main process, not daemon) ──
  let wechatQrAbort: AbortController | null = null

  ipcMain.handle("wechat:qr-login", async () => {
    if (wechatQrAbort) wechatQrAbort.abort()
    wechatQrAbort = new AbortController()
    try {
      const { WeChatClient } = await import("../src/wechat/index.js")
      const QRCode = await import("qrcode")
      const tmpClient = new WeChatClient()
      const result = await tmpClient.login({
        signal: wechatQrAbort.signal,
        async onQRCode(url) {
          const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 })
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:setup-qrcode", dataUrl))
        },
        onStatus(status) {
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:setup-status", status))
        },
      })
      wechatQrAbort = null
      if (result.connected) {
        return { ok: true, botToken: result.botToken, accountId: result.accountId, baseUrl: result.baseUrl }
      }
      return { ok: false, error: result.message }
    } catch (err: any) {
      wechatQrAbort = null
      if (err?.name === "AbortError") return { ok: false, error: "cancelled" }
      return { ok: false, error: err?.message ?? String(err) }
    }
  })

  ipcMain.handle("wechat:qr-login-cancel", () => {
    if (wechatQrAbort) { wechatQrAbort.abort(); wechatQrAbort = null }
    return { ok: true }
  })

  ipcMain.handle("scheduled-tasks:get", () => readTasksFromFile())
  ipcMain.handle("scheduled-tasks:save", (_, tasks) => {
    writeTasksToFile(tasks)
    return { ok: true }
  })
  ipcMain.handle("scheduled-tasks:validate-cron", (_, expression: string) => {
    return validateCron(expression)
  })
  ipcMain.handle("scheduled-tasks:preview-cron", (_, expression: string) => {
    return previewCronNextRuns(expression)
  })

  ipcMain.handle("scheduled-tasks:trigger", async (_, taskId: string) => {
    const tasks = readTasksFromFile()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return { ok: false, error: "任务不存在" }
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${task.name}] (手动触发: ${nowStr})\n\n${task.content}`
    if (task.independent !== false) {
      return launchIndependentAgent(task.id, task.name, content)
    }
    const lock = readLockFile()
    if (!lock?.port) return { ok: false, error: "守护进程未运行" }
    try {
      await httpPost(`http://127.0.0.1:${lock.port}/enqueue`, { content })
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle("scheduled-tasks:get-status", () => getIndependentTaskStatuses())

  getDaemonStatus().then((status) => {
    if (status.running) {
      startStatusPolling()
    }
  })
}

export function cleanupDaemonManager(): void {
  stopStatusPolling()
  stopAgent()
  if (daemonProcess) {
    try { daemonProcess.kill() } catch { /* ignore */ }
    daemonProcess = null
  }
  cachedPort = null
  setDaemonPort(null)
  activeDaemonWorkspaceDir = null
}
