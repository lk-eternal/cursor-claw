import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as http from "node:http"
import * as https from "node:https"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { app, BrowserWindow, ipcMain, powerSaveBlocker } from "electron"
import { getConfig, saveConfig, type AppConfig, type ScheduledTask } from "./config-store"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { pushLog, pushUiLog, broadcastLog, getLogBuffer, clearLogBuffer, logCursorAgentInvocation, escapeLogContentSingleLine } from "./ui-logger"
import { resolveAgentBinary, applyProxyEnv, quoteArg, getAgentPaths, execAgentSync } from "./agent-cli"
import {
  launchSessionAgent as _launchSessionAgent,
  launchIndependentAgent as _launchIndependentAgentCli,
  stopAgent as _stopCliAgent, stopSessionAgent as _stopCliSession, stopAllSessionAgents as _stopAllCliSessions,
  getSessionAgentList as getRawCliSessionList,
  isAgentRunning as _isCliAgentRunning, isSessionAgentRunning as _isCliSessionRunning, getRunningSessionCount as _getCliRunningCount,
  getAgentChildPid, getSessionAgentCount as _getCliSessionCount, getIndependentTaskStatuses as _getCliTaskStatuses,
  reapIdleGroupAgents as _reapCliIdleGroups, setChatNameResolver, setSessionCloseHandler,
  P2P_SESSION_KEY, setMainChatId, getMainChatId,
  type ChatType,
} from "./agent-launcher"
import {
  launchSdkAgent, stopSdkSession, stopAllSdkSessions,
  isSdkSessionRunning, getSdkSessionCount, getSdkSessionList,
  checkSdkApiKey, listSdkModels,
} from "./agent-sdk"
import {
  setDaemonPort, registerEnableMcpFn, getMcpServerPath, getAdminMcpPath,
  injectMcpToDir, injectRulesToDir, injectSkillsToDir,
  injectWorkspaceToDir, injectWorkspaceMcpAndRules,
} from "./workspace-injector"

export { applyProxyEnv, checkCliInstalled, installCli, execAgentSync, execAgentAsync, type ExecAgentOptions as ExecAgentSyncOptions } from "./agent-cli"
export { checkAgentLoggedIn, loginCli } from "./agent-launcher"
export { getLogBuffer } from "./ui-logger"
export { checkSdkApiKey, listSdkModels } from "./agent-sdk"
export { injectWorkspaceMcpAndRules, injectWorkspaceToDir, getMcpServerPath, getAdminMcpPath } from "./workspace-injector"

function useSdkMode(): boolean {
  return getConfig().agentMode === "sdk"
}

function isAgentRunning(): boolean {
  return useSdkMode() ? getSdkSessionCount() > 0 : _isCliAgentRunning()
}

function isSessionAgentRunning(key: string): boolean {
  return useSdkMode() ? isSdkSessionRunning(key) : _isCliSessionRunning(key)
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

function stopSessionAgent(key: string): void {
  if (useSdkMode()) stopSdkSession(key)
  else _stopCliSession(key)
}

function stopAllSessionAgents(): void {
  if (useSdkMode()) stopAllSdkSessions()
  else _stopAllCliSessions()
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

function reapIdleGroupAgents(): void {
  if (!useSdkMode()) _reapCliIdleGroups()
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


function getLockFilePath(): string {
  return path.join(app.getPath("userData"), LOCK_FILE_NAME)
}

function readLockFile(): { pid: number; port: number; version: string } | null {
  try {
    const lockPath = getLockFilePath()
    if (!fs.existsSync(lockPath)) return null
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"))
  } catch {
    return null
  }
}

function httpGet(url: string, timeoutMs = 3000): Promise<DaemonStatus> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: string[] = []
      res.on("data", (c: Buffer) => chunks.push(c.toString()))
      res.on("end", () => {
        try {
          resolve(JSON.parse(chunks.join("")))
        } catch {
          reject(new Error("Invalid JSON"))
        }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("timeout"))
    })
  })
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

function httpPost(url: string, body: object, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
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

async function syncActiveSession(port: number, chatId: string, sessionKey: string): Promise<void> {
  try {
    await httpPost(`http://127.0.0.1:${port}/api/active-session`, { chatId, sessionKey })
  } catch {}
}

async function getCurrentActiveSession(port: number, chatId: string): Promise<string | undefined> {
  try {
    const res = await httpGet(`http://127.0.0.1:${port}/api/active-sessions`) as { sessions?: Record<string, string> }
    return res?.sessions?.[chatId]
  } catch { return undefined }
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
  stopAllSessionAgents()
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

const AGENT_STALE_TIMEOUT_MS = 10 * 60 * 1000
let queueStaleStartTime: number | null = null

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

function connectSseQueueEvents(): void {
  disconnectSseQueueEvents()
  const lock = readLockFile()
  if (!lock?.port) return
  const url = `http://127.0.0.1:${lock.port}/api/queue-events`
  let buf = ""
  sseReq = http.get(url, { timeout: 0 }, (res) => {
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
      setTimeout(() => connectSseQueueEvents(), 3_000)
    })
  })
  sseReq.on("error", () => {
    sseReq = null
    setTimeout(() => connectSseQueueEvents(), 5_000)
  })
}

function disconnectSseQueueEvents(): void {
  if (sseDispatchDebounce) { clearTimeout(sseDispatchDebounce); sseDispatchDebounce = null }
  if (sseReq) { try { sseReq.destroy() } catch { /* */ }; sseReq = null }
}

function startStatusPolling(): void {
  stopStatusPolling()
  queueStaleStartTime = null
  startDaemonPowerSaveBlock()
  connectSseQueueEvents()
  statusInterval = setInterval(async () => {
    try {
      const status = await getDaemonStatus()
      broadcastStatus(status)

      if (status.running && status.queueLength && status.queueLength > 0 && isAgentRunning()) {
        if (queueStaleStartTime === null) {
          queueStaleStartTime = Date.now()
        } else if (Date.now() - queueStaleStartTime > AGENT_STALE_TIMEOUT_MS) {
          broadcastLog(`[防卡死] Agent 运行中但队列消息已 ${Math.round((Date.now() - queueStaleStartTime) / 60_000)} 分钟未消费，自动终止`, "WARN")
          stopAgent()
          queueStaleStartTime = null
        }
      } else {
        queueStaleStartTime = null
      }

      if (status.running && status.queueLength && status.queueLength > 0) {
        await dispatchSessionAgents()
      }

      reapIdleGroupAgents()

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

// ── Chat 名称缓存 ──────────────────────────────────────────

const chatNameCache = new Map<string, string>()
const previousActiveSessionMap = new Map<string, string>()

async function handleSessionClosed(sessionKey: string, _chatType: ChatType): Promise<void> {
  const previous = previousActiveSessionMap.get(sessionKey)
  previousActiveSessionMap.delete(sessionKey)
  if (!previous) return

  const chatId = extractChatId(sessionKey)
  const lock = readLockFile()
  if (!lock) return

  const currentActive = await getCurrentActiveSession(lock.port, chatId)
  if (currentActive !== sessionKey) return

  const fallbackKey = isSessionAgentRunning(previous) ? previous : undefined
  if (fallbackKey) {
    await syncActiveSession(lock.port, chatId, fallbackKey)
    broadcastLog("info", `[System] 临时会话已结束，活跃会话自动回退至: ${fallbackKey}`)
  }
}

async function fetchChatNames(chatIds: string[]): Promise<void> {
  const missing = chatIds.filter((id) => id && !chatNameCache.has(id))
  if (missing.length === 0) return
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/chat-names`, { chatIds: missing }, 15_000)) as { names?: Record<string, string> }
    if (res?.names) {
      for (const [id, name] of Object.entries(res.names)) chatNameCache.set(id, name)
    }
  } catch { /* ignore */ }
}

async function fetchUserNames(openIds: string[]): Promise<void> {
  const missing = openIds.filter((id) => id && !chatNameCache.has(id))
  if (missing.length === 0) return
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/user-names`, { openIds: missing }, 15_000)) as { names?: Record<string, string> }
    if (res?.names) {
      for (const [id, name] of Object.entries(res.names)) chatNameCache.set(id, name)
    }
  } catch { /* ignore */ }
}

interface DequeuedMessage { text: string; messageId: string; chatId: string; chatType: string; senderOpenId?: string }

interface MergedMessages { text: string; count: number; chatType?: string; messageIds: string[]; chatId?: string; senderOpenId?: string }

async function pullMergedMessagesFromQueue(chatId?: string): Promise<MergedMessages | null> {
  const lock = readLockFile()
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
  const lock = readLockFile()
  if (!lock?.port) return []
  try {
    const res = (await httpGet(`http://127.0.0.1:${lock.port}/queue-chat-ids`)) as { chats?: QueueSession[] } | null
    return res?.chats ?? []
  } catch {
    return []
  }
}


function isMainUser(chatId?: string, chatType?: string): boolean {
  if (chatType !== "p2p") return false
  const cfg = getConfig()
  if (cfg.larkReceiveId?.trim() && chatId === cfg.larkReceiveId.trim()) return true
  if (cfg.wechatEnabled && !cfg.feishuEnabled) return true
  if (cfg.wechatEnabled && cfg.wechatAccountId && chatId && !chatId.startsWith("ou_")) return true
  return false
}

function extractChatId(sessionKey: string): string {
  const idx = sessionKey.indexOf("::")
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey
}

async function dispatchSessionAgents(): Promise<void> {
  const config = getConfig()
  const sessions = await getQueueSessions()

  const feishuOn = !!config.feishuEnabled
  const groupKeys = sessions.filter((s) => s.chatType === "group").map((s) => extractChatId(s.sessionKey))
  if (groupKeys.length > 0 && feishuOn) await fetchChatNames(groupKeys)

  for (const { sessionKey, chatType, senderOpenId } of sessions) {
    if (isSessionAgentRunning(sessionKey)) continue

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

    if (config.workspaceDir) await injectMcpToDir(config.workspaceDir)

    const meta: import("./agent-launcher").LaunchMeta = { chatId, chatType: chatType as "p2p" | "group" }
    const result = await launchSessionAgent(sessionKey, chatType as "p2p" | "group", undefined, meta, mainUser, senderOpenId)
    if (result.ok && chatId !== sessionKey) {
      const lock = readLockFile()
      if (lock?.port) await syncActiveSession(lock.port, chatId, sessionKey)
    }
    if (!result.ok) broadcastLog(`[Agent] ${sessionKey} 启动跳过: ${result.error}`)
  }
}

export async function clearMessageQueue(): Promise<number> {
  const lock = readLockFile()
  if (!lock?.port) return 0
  try {
    const res = await httpPost(`http://127.0.0.1:${lock.port}/clear-queue`, {}) as { cleared?: number }
    return res?.cleared ?? 0
  } catch { return 0 }
}

export async function getQueueMessages(): Promise<{ index: number; preview: string; chatId?: string; chatType?: string }[]> {
  const lock = readLockFile()
  if (!lock?.port) return []
  try {
    const res = await httpGet(`http://127.0.0.1:${lock.port}/queue`) as {
      messages?: { index: number; preview: string; chatId?: string; chatType?: string }[]
    }
    return res.messages ?? []
  } catch {
    return []
  }
}

// ── CLI 检测与安装 ──────────────────────────────────────────




// ── Agent 状态与会话管理（委托 agent-launcher） ─────────────

export type AgentLoginStatus = {
  cliFound: boolean
  loggedIn: boolean
  identityLine?: string
  error?: string
}

interface LaunchAgentParams {
  sessionKey: string
  chatType: ChatType
  meta?: import("./agent-launcher").LaunchMeta
  useMainWorkspace?: boolean
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
}

async function launchAgent(p: LaunchAgentParams): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, senderOpenId, chatName, taskMessage } = p
  const useMain = p.useMainWorkspace ?? (chatType === "p2p" || chatType === "task" || chatType === "temp")
  const config = getConfig()

  let workDir = config.workspaceDir
  if (!useMain) {
    const safeChatId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
    workDir = path.join(app.getPath("userData"), "workspaces", safeChatId)
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  }

  await injectWorkspaceToDir(workDir)

  if (useSdkMode()) {
    return launchSdkAgent({ sessionKey, chatType, meta, workspaceDir: workDir, senderOpenId, chatName, taskMessage })
  }

  if (chatType === "task" || chatType === "temp") {
    return _launchIndependentAgentCli(sessionKey, chatName ?? sessionKey, taskMessage ?? "", chatType)
  }
  return _launchSessionAgent(sessionKey, chatType, injectWorkspaceToDir, meta, useMain, senderOpenId)
}

export async function launchSessionAgent(
  sessionKey: string, chatType: ChatType,
  _injectFn?: (dir: string) => boolean | Promise<boolean>,
  meta?: import("./agent-launcher").LaunchMeta,
  useMainWorkspace?: boolean, senderOpenId?: string,
): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({ sessionKey, chatType, meta, useMainWorkspace, senderOpenId })
}

async function launchIndependentAgent(taskId: string, taskName: string, message: string, type: ChatType = "task", chatId?: string): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({ sessionKey: taskId, chatType: type, chatName: taskName, taskMessage: message, meta: { chatId: chatId ?? taskName, chatType: type } })
}

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

// ── 指令执行（从共享文件队列消费）──────────────────────────

interface FileCommand { id: string; command: string; messageId: string; chatId?: string; chatType?: string }

async function reportCommandResult(port: number, messageId: string, ok: boolean, message: string, chatId?: string): Promise<void> {
  try {
    await httpPost(`http://127.0.0.1:${port}/cmd/result`, { messageId, ok, message, chatId })
  } catch (e: unknown) {
    broadcastLog(`指令结果回报失败: ${e instanceof Error ? e.message : e}`, "WARN")
  }
}

const MODEL_SUBCMD_HELP =
  "💡 /model 子命令\n" +
  "🔹 /model ls — 列出可用模型与序号\n" +
  "🔹 /model info — 查看当前应用配置的模型\n" +
  "🔹 /model set <序号> — 按 /model ls 的 # 设置模型（写入配置，下次启动 Agent 生效）"

type ListedModel = { id: string; label: string; current: boolean }

export function parseListModelsStdout(out: string): ListedModel[] {
  const cleaned = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "")
  const models: ListedModel[] = []
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || /^available models/i.test(trimmed)) {
      continue
    }
    const match = trimmed.match(/^(\S+)\s+[–—-]\s+(.+?)(\s+\((?:default|current)\))?\s*$/)
    if (match) {
      models.push({ id: match[1], label: match[2].trim(), current: !!match[3] })
    }
  }
  return models
}

async function listCursorModelsForCommands(): Promise<{ ok: true; models: ListedModel[] } | { ok: false; error: string }> {
  if (useSdkMode()) {
    const r = await listSdkModels()
    if (!r.ok) return { ok: false, error: r.error || "SDK 获取模型列表失败" }
    return { ok: true, models: r.models }
  }
  const config = getConfig()
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
  applyProxyEnv(env, config)
  const ws = config.workspaceDir?.trim() || undefined
  const run = execAgentSync(["--list-models"], env, { timeoutMs: 30_000, logLabel: "list-models-cmd", cwd: ws })
  if (!run.ok) {
    return { ok: false, error: run.error || run.stderr.trim() || "获取模型列表失败" }
  }
  const models = parseListModelsStdout(run.stdout)
  if (models.length === 0) {
    return { ok: false, error: "未解析到任何模型，请检查 agent --list-models 输出格式是否变化" }
  }
  return { ok: true, models }
}

async function handleFeishuModelCommand(port: number, messageId: string, raw: string, chatId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP)
    return
  }

  if (sub === "info") {
    const cfgModel = getConfig().model?.trim() || "auto"
    const lines: string[] = [`📝 应用配置 model: ${cfgModel}`]
    if (cfgModel === "auto") {
      lines.push("（auto：启动 Agent 时不传 --model，由 CLI 默认策略选择）")
    }
    const lr = await listCursorModelsForCommands()
    if (lr.ok) {
      const hit = lr.models.findIndex((m) => m.id === cfgModel)
      if (hit >= 0) {
        lines.push(`对应列表序号: #${hit + 1}`)
        lines.push(`   ${lr.models[hit].id} — ${lr.models[hit].label}`)
      } else if (cfgModel !== "auto") {
        lines.push("（当前配置 id 不在本次列表中，若刚换模型列表可再执行 /model ls）")
      }
      const cliCur = lr.models.filter((m) => m.current)
      if (cliCur.length > 0) {
        lines.push(`标注 (current): ${cliCur.map((m) => m.id).join(", ")}`)
      }
    } else {
      lines.push(`⚠️ 无法拉取模型列表: ${lr.error}`)
    }
    await reportCommandResult(port, messageId, true, lines.join("\n"))
    return
  }

  if (sub === "ls") {
    const lr = await listCursorModelsForCommands()
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`)
      return
    }
    const blocks = lr.models.map((m, i) => {
      const n = i + 1
      const tag = m.current ? "  ⭐CLI current" : ""
      return [`#${n}`, `\t id · ${m.id}`, `\t说明 · ${m.label}${tag}`].join("\n")
    })
    const body = [`🧠 模型列表（共 ${lr.models.length} 个）`, "", ...blocks, "", "💡 设置：/model set <序号>"].join("\n")
    await reportCommandResult(port, messageId, true, body)
    return
  }

  if (sub === "set") {
    const lr = await listCursorModelsForCommands()
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`)
      return
    }
    if (parts.length < 3) {
      await reportCommandResult(port, messageId, false, "💡 用法：/model set <序号>（数字见 /model ls 的 #）")
      return
    }
    const idx = parseInt(parts[2], 10)
    if (!Number.isInteger(idx) || idx < 1 || idx > lr.models.length) {
      await reportCommandResult(
        port,
        messageId,
        false,
        `😅 序号须为 1～${lr.models.length} 之间的整数（先 /model ls）`,
      )
      return
    }
    const picked = lr.models[idx - 1]
    saveConfig({ model: picked.id })
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        `✅ 已保存模型（下次启动 Agent 生效）`,
        ` # · ${idx}`,
        ` id · ${picked.id}`,
        `说明 · ${picked.label}`,
        "",
        "若 Agent 正在运行，可 /stop 后由新消息再拉起以使用新模型。",
      ].join("\n"),
    )
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${MODEL_SUBCMD_HELP}`)
}

const TASK_SUBCMD_HELP =
  "💡 可用指令\n" +
  "🔹 /task 显示本说明\n" +
  "🔹 /task ls 列出所有任务\n" +
  "🔹 /task info <序号> 查看详情\n" +
  "🔹 /task run <序号> 立即触发一次\n" +
  "🔹 /task stop <序号> 停止任务\n" +
  "🔹 /task start <序号> 启动任务\n" +
  "🔹 /task delete <序号> 删除任务\n" +
  "🔹 /task create <名称> <cron> <内容> 创建任务\n" +
  "🔹 /task update <序号> [-name 值] [-cron 值] [-content 值] 更新任务"

function parseTaskOneBasedIndex(s: string | undefined): number | null {
  if (s === undefined || s === "") {
    return null
  }
  const n = parseInt(s, 10)
  if (!Number.isInteger(n) || n < 1) {
    return null
  }
  return n
}

function parseTaskCreateArgs(parts: string[]):
  | { ok: true; name: string; cron: string; content: string }
  | { ok: false; error: string } {
  const afterCreate = parts.slice(2)
  if (afterCreate.length < 1 + 5 + 1) {
    return { ok: false, error: "❌ 参数不足：/task create <名称> <cron五或六段> <内容>" }
  }
  for (const cronLen of [6, 5] as const) {
    if (afterCreate.length < cronLen + 2) {
      continue
    }
    for (let nameLen = 1; nameLen <= afterCreate.length - cronLen - 1; nameLen++) {
      const name = afterCreate.slice(0, nameLen).join(" ").trim()
      if (!name) {
        continue
      }
      const cronToks = afterCreate.slice(nameLen, nameLen + cronLen)
      const cronExpr = cronToks.join(" ").trim()
      if (!validateCron(cronExpr)) {
        continue
      }
      const content = afterCreate.slice(nameLen + cronLen).join(" ").trim()
      if (!content) {
        return { ok: false, error: "任务内容不能为空" }
      }
      return { ok: true, name, cron: cronExpr, content }
    }
  }
  return { ok: false, error: "无法解析：请保证「名称」「cron（连续 5 或 6 段）」「内容」三部分，且 cron 能通过校验" }
}

function parseTaskUpdateArgs(parts: string[]):
  | { ok: true; oneBasedIndex: number; updates: { name?: string; cron?: string; content?: string } }
  | { ok: false; error: string } {
  if (parts.length < 4) {
    return { ok: false, error: "💡 用法：/task update <序号> [-name 值] [-cron 值] [-content 值]" }
  }
  const idx = parseTaskOneBasedIndex(parts[2])
  if (idx === null) {
    return { ok: false, error: "❌ 序号须为正整数" }
  }
  const known = new Set(["-name", "-cron", "-content"])
  let i = 3
  const updates: { name?: string; cron?: string; content?: string } = {}
  while (i < parts.length) {
    const flag = parts[i].toLowerCase()
    if (!known.has(flag)) {
      return { ok: false, error: `❌ 未知选项: ${parts[i]}（仅支持 -name -cron -content）` }
    }
    i++
    const valBuf: string[] = []
    while (i < parts.length) {
      const t = parts[i]
      if (t.startsWith("-") && known.has(t.toLowerCase())) {
        break
      }
      valBuf.push(t)
      i++
    }
    if (valBuf.length === 0) {
      return { ok: false, error: `❌ ${flag} 缺少取值` }
    }
    const val = valBuf.join(" ").trim()
    if (flag === "-name") {
      updates.name = val
    } else if (flag === "-cron") {
      updates.cron = val
    } else {
      updates.content = val
    }
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "❌ 至少指定一项：-name / -cron / -content" }
  }
  return { ok: true, oneBasedIndex: idx, updates }
}

const TASK_PREVIEW_BULLETS = ["①", "②", "③", "④", "⑤"] as const

function taskPreviewBullet(i: number): string {
  return TASK_PREVIEW_BULLETS[i] ?? `${i + 1}.`
}

function formatTaskStatusLine(enabled: boolean): string {
  return enabled ? "✅ 运行中" : "⏸️ 已停止"
}

async function handleFeishuTaskCommand(port: number, messageId: string, raw: string, chatId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP)
    return
  }

  let tasks = readTasksFromFile()

  if (sub === "ls") {
    if (tasks.length === 0) {
      await reportCommandResult(
        port,
        messageId,
        true,
        "📭 当前还没有定时任务～\n\n💡 需要的话可以用：\n   /task create <名称> <cron> <内容>",
      )
      return
    }
    const blocks = tasks.map((t, i) => {
      const n = i + 1
      return [
        "┈┈┈┈┈┈┈┈┈┈",
        `#${n}\t📋 名称 · ${t.name}`,
        `\t💠 状态 · ${formatTaskStatusLine(t.enabled)}`,
        `\t🔄 Cron · ${t.cron}`,
        `\t⏱️ 下次 · ${t.enabled ? getNextCronFireLabel(t.cron) : "-"}`
      ].join("\n")
    })
    const header = `⏰ 定时任务一览（共 ${tasks.length} 条）`
    await reportCommandResult(port, messageId, true, `${header}\n\n${blocks.join("\n\n")}\n\n✨ 看某条详情：/task info <序号>`)
    return
  }

  if (sub === "info") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task info <序号>（数字见 /task ls 的 #）")
      return
    }
    if (tasks.length === 0) {
      await reportCommandResult(port, messageId, false, "📭 还没有任何任务，先用 /task ls 确认一下吧～")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（当前共 ${tasks.length} 条）`)
      return
    }
    const t = tasks[idx - 1]
    const statusLine = formatTaskStatusLine(t.enabled)
    let scheduleSection: string
    const prev = previewCronNextRuns(t.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    } else {
      scheduleSection = ``
    }
    const body = [
      `📋 任务详情  #${idx}`,
      "",
      `📝 名称 · ${t.name}`,
      `💠 状态 · ${statusLine}`,
      `🔄 Cron · ${t.cron}`,
      scheduleSection,
      "",
      "✉️ 任务内容",
      "────────────",
      t.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body)
    return
  }

  if (sub === "run") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task run <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const t = tasks[idx - 1]
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${t.name}] (手动触发: ${nowStr})\n\n${t.content}`
    if (t.independent !== false) {
      const result = await launchIndependentAgent(t.id, t.name, content)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已独立启动任务 #${idx} ${t.name}`)
      } else {
        await reportCommandResult(port, messageId, false, `❌ 独立启动失败: ${result.error}`)
      }
    } else {
      try {
        await httpPost(`http://127.0.0.1:${port}/enqueue`, { content })
        await reportCommandResult(port, messageId, true, `🚀 已手动触发任务 #${idx} ${t.name}`)
      } catch (e: unknown) {
        await reportCommandResult(port, messageId, false, `❌ 触发失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return
  }

  if (sub === "stop") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task stop <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const name = tasks[idx - 1].name
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: false } : t))
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `⏸️ 已停止任务 #${idx} ${name}`)
    return
  }

  if (sub === "start") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task start <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const name = tasks[idx - 1].name
    const cron = tasks[idx - 1].cron
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: true } : t))
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(cron)
    await reportCommandResult(port, messageId, true, `✅ 已启动任务 #${idx} ${name}\n下次执行: ${next}`)
    return
  }

  if (sub === "delete") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task delete <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const name = tasks[idx - 1].name
    tasks = tasks.filter((_, j) => j !== idx - 1)
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `🗑️ 已删除任务 #${idx} ${name}`)
    return
  }

  if (sub === "create") {
    const parsed = parseTaskCreateArgs(parts)
    if (!parsed.ok) {
      await reportCommandResult(port, messageId, false, parsed.error)
      return
    }
    const newTask: ScheduledTask = {
      id: randomUUID(),
      name: parsed.name,
      cron: parsed.cron,
      content: parsed.content,
      enabled: true,
    }
    tasks = [...tasks, newTask]
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(parsed.cron)
    await reportCommandResult(port, messageId, true, `✅ 已创建并启动：${parsed.name}\n下次执行: ${next}`)
    return
  }

  if (sub === "update") {
    const pu = parseTaskUpdateArgs(parts)
    if (!pu.ok) {
      await reportCommandResult(port, messageId, false, pu.error)
      return
    }
    if (pu.oneBasedIndex > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${pu.oneBasedIndex} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const t = tasks[pu.oneBasedIndex - 1]
    let nextName = t.name
    let nextCron = t.cron
    let nextContent = t.content
    if (pu.updates.name !== undefined) {
      nextName = pu.updates.name
    }
    if (pu.updates.cron !== undefined) {
      nextCron = pu.updates.cron
    }
    if (pu.updates.content !== undefined) {
      nextContent = pu.updates.content
    }
    if (pu.updates.cron !== undefined && !validateCron(nextCron)) {
      await reportCommandResult(port, messageId, false, "😅 新 Cron 表达式无效")
      return
    }
    const updated: ScheduledTask = { ...t, name: nextName, cron: nextCron, content: nextContent }
    tasks = tasks.map((x, j) => (j === pu.oneBasedIndex - 1 ? updated : x))
    writeTasksToFile(tasks)

    const statusLine = formatTaskStatusLine(updated.enabled)
    let scheduleSection: string
    const prev = previewCronNextRuns(updated.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    } else {
      scheduleSection = ``
    }
    const body = [
      `✅ 已更新任务`,
      `📋 任务详情  #${pu.oneBasedIndex}`,
      "",
      `📝 名称 · ${updated.name}`,
      `💠 状态 · ${statusLine}`,
      `🔄 Cron · ${updated.cron}`,
      scheduleSection,
      "",
      "✉️ 任务内容",
      "────────────",
      updated.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${TASK_SUBCMD_HELP}`)
}

const MCP_SUBCMD_HELP = [
  "📦 MCP 服务器管理",
  "",
  "  /mcp ls              列出所有 MCP 服务器",
  "  /mcp info <序号|名称>  查看详情",
  "  /mcp enable <序号|名称> 启用",
  "  /mcp disable <序号|名称> 禁用",
  "  /mcp delete <序号|名称> 删除",
  '  /mcp add <json>       添加（如 /mcp add {"name":"test","command":"npx","args":["-y","xxx"]}）',
].join("\n")

function resolveMcpTarget(list: McpServerEntry[], token: string): McpServerEntry | null {
  const idx = parseInt(token, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]
  return list.find((s) => s.name.toLowerCase() === token.toLowerCase()) ?? null
}

async function handleFeishuMcpCommand(port: number, messageId: string, raw: string, chatId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP)
    return
  }

  const sub = parts[1].toLowerCase()

  if (sub === "help" || sub === "-h") {
    await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP)
    return
  }

  if (sub === "ls" || sub === "list") {
    const list = getMcpServerList()
    const enabledMap = await getMcpEnabledMap()
    if (list.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 暂无 MCP 服务器")
      return
    }
    const lines = list.map((s, i) => {
      const flag = enabledMap[s.name] === false ? "🔴" : "🟢"
      const src = s.source === "global" ? "[G]" : "[P]"
      const detail = s.type === "url" ? s.url : s.command
      return `  ${i + 1}. ${flag} ${src} ${s.name}  (${detail})`
    })
    await reportCommandResult(port, messageId, true, `📦 MCP 服务器列表：\n${lines.join("\n")}`)
    return
  }

  if (sub === "info") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mcp info <序号|名称>"); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    const enabledMap = await getMcpEnabledMap()
    const lines = [
      `📦 ${target.name}`,
      `  类型: ${target.type}`,
      `  来源: ${target.source}`,
      `  状态: ${enabledMap[target.name] === false ? "🔴 已禁用" : "🟢 已启用"}`,
    ]
    if (target.type === "url") lines.push(`  URL: ${target.url}`)
    else lines.push(`  命令: ${target.command} ${(target.args ?? []).join(" ")}`)
    if (target.env && Object.keys(target.env).length > 0) {
      lines.push(`  环境变量: ${Object.keys(target.env).join(", ")}`)
    }
    await reportCommandResult(port, messageId, true, lines.join("\n"))
    return
  }

  if (sub === "enable" || sub === "disable") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, `用法: /mcp ${sub} <序号|名称>`); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    const enabled = sub === "enable"
    const result = await toggleMcpServer(target.name, enabled)
    await reportCommandResult(port, messageId, result.ok,
      result.ok ? `✅ ${target.name} 已${enabled ? "启用" : "禁用"}` : `❌ 操作失败: ${result.output}`)
    return
  }

  if (sub === "delete" || sub === "rm") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mcp delete <序号|名称>"); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    deleteMcpServer(target.name)
    await reportCommandResult(port, messageId, true, `🗑️ ${target.name} 已删除`)
    return
  }

  if (sub === "add") {
    const jsonStr = raw.replace(/^\/mcp\s+add\s*/i, "").trim()
    if (!jsonStr) {
      await reportCommandResult(port, messageId, false, '用法: /mcp add {"name":"xxx","command":"npx","args":[...]}')
      return
    }
    try {
      const parsed = JSON.parse(jsonStr)
      const name = parsed.name as string
      if (!name) { await reportCommandResult(port, messageId, false, "❌ 缺少 name 字段"); return }
      const { name: _, ...entry } = parsed
      saveMcpServer(name, entry, "project")
      await reportCommandResult(port, messageId, true, `✅ ${name} 已添加`)
    } catch (e: unknown) {
      await reportCommandResult(port, messageId, false, `❌ JSON 解析失败: ${e instanceof Error ? e.message : e}`)
    }
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${sub}\n\n${MCP_SUBCMD_HELP}`)
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

async function handleChatCommand(tokens: string[], port: number, messageId: string, chatId?: string): Promise<void> {
  const reply = (ok: boolean, msg: string) => reportCommandResult(port, messageId, ok, msg, chatId)
  const sub = tokens[1]?.toLowerCase()

  const sessions = getSessionAgentList().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))

  if (!sub || sub === "ls" || sub === "list") {
    if (sessions.length === 0) { await reply(true, "📭 当前没有活跃会话"); return }
    const now = Date.now()
    const lines = sessions.map((s, i) => {
      const idx = `#${i + 1}`
      const type = s.chatType === "p2p" ? "私聊" : s.chatType === "group" ? "群聊" : s.chatType === "task" ? "定时" : s.chatType === "temp" ? "临时" : s.chatType
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
    const type = s.chatType === "p2p" ? "私聊" : s.chatType === "group" ? "群聊" : s.chatType === "task" ? "定时任务" : s.chatType === "temp" ? "临时任务" : s.chatType

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
          await handleFeishuTaskCommand(lock.port, claimed.messageId, rawCmd, claimed.chatId)
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
              const wsResult = await applyWorkspaceDirChange(newDir)
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

// ── MCP OAuth 认证管理 ────────────────────────────────────

function findProjectDir(workspaceDir: string): string | null {
  const projectsBase = path.join(os.homedir(), ".cursor", "projects")
  if (!fs.existsSync(projectsBase)) return null

  const expected = workspaceDir.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "")
  const exactPath = path.join(projectsBase, expected)
  if (fs.existsSync(exactPath)) return exactPath

  try {
    const lower = expected.toLowerCase()
    const match = fs.readdirSync(projectsBase).find((d) => d.toLowerCase() === lower)
    if (match) return path.join(projectsBase, match)
  } catch { /* ignore */ }
  return null
}

function getProjectSlug(workspaceDir: string): string {
  const dir = findProjectDir(workspaceDir)
  if (dir) return path.basename(dir)
  return workspaceDir.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "")
}

function readMcpAuthFile(workspaceDir: string): Record<string, unknown> {
  const dir = findProjectDir(workspaceDir)
  if (!dir) return {}
  const authPath = path.join(dir, "mcp-auth.json")
  try {
    if (fs.existsSync(authPath)) return JSON.parse(fs.readFileSync(authPath, "utf-8"))
  } catch { /* ignore */ }
  return {}
}

function readAllMcpServers(): Record<string, Record<string, unknown>> {
  const config = getConfig()
  const servers: Record<string, Record<string, unknown>> = {}

  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  try {
    if (fs.existsSync(globalPath)) {
      const cfg = JSON.parse(fs.readFileSync(globalPath, "utf-8"))
      if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers)
    }
  } catch { /* ignore */ }

  if (config.workspaceDir) {
    const projectPath = path.join(config.workspaceDir, ".cursor", "mcp.json")
    try {
      if (fs.existsSync(projectPath)) {
        const cfg = JSON.parse(fs.readFileSync(projectPath, "utf-8"))
        if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers)
      }
    } catch { /* ignore */ }
  }

  return servers
}

export interface McpServerEntry {
  name: string
  type: "command" | "url"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  source: "global" | "project"
  authenticated?: boolean
  rawConfig?: Record<string, unknown>
  enabled?: boolean
}

function spawnAsync(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const mcpLabel = args.length >= 2 && args[0] === "mcp" ? `mcp-${args[1]}` : `mcp-${args[0] ?? "spawn"}`
    logCursorAgentInvocation(mcpLabel, args, cwd)
    let stdout = "", stderr = "", settled = false, didTimeout = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: didTimeout || undefined })
    }
    const { agentNodePath: np, agentIndexPath: ip } = getAgentPaths()
    const child = np && ip
      ? spawn(np, [ip, ...args], {
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env,
        })
      : spawn("agent", args.map(quoteArg), {
          shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env,
        })
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.on("error", () => done(1))
    child.on("exit", (code) => done(code ?? 1))
    const timer = setTimeout(() => { didTimeout = true; try { child.kill() } catch { /* */ }; done(1) }, 30_000)
  })
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function isEnabledStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s !== "disabled" && !s.includes("not loaded")
}

interface McpListCache { enabled: Record<string, boolean>; status: Record<string, string>; ts: number; ws: string }
const MCP_ENABLED_CACHE_TTL_MS = 30_000
let mcpListCache: McpListCache | null = null
let mcpListInflight: Promise<McpListCache> | null = null

async function fetchMcpList(force = false): Promise<McpListCache> {
  const config = getConfig()
  const ws = (config.workspaceDir || "").trim()
  const empty: McpListCache = { enabled: {}, status: {}, ts: 0, ws }
  if (!ws) return empty
  if (!force && mcpListCache && mcpListCache.ws === ws && Date.now() - mcpListCache.ts < MCP_ENABLED_CACHE_TTL_MS) return mcpListCache

  if (useSdkMode()) {
    return fetchMcpListFromJson(ws)
  }

  if (!resolveAgentBinary()) return empty
  if (mcpListInflight) return mcpListInflight

  const p = (async (): Promise<McpListCache> => {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(env, config)
    try {
      const r = await spawnAsync(["mcp", "list"], ws, env)
      const clean = r.stdout.replace(ANSI_RE, "").replace(/\r/g, "")
      const enabled: Record<string, boolean> = {}
      const status: Record<string, string> = {}
      for (const line of clean.split("\n")) {
        const m = line.match(/^(.+?):\s+(.+)$/)
        if (m) {
          const name = m[1].trim(), raw = m[2].trim()
          enabled[name] = isEnabledStatus(raw)
          status[name] = raw.toLowerCase()
        }
      }
      const result: McpListCache = { enabled, status, ts: Date.now(), ws }
      mcpListCache = result
      return result
    } catch {
      return empty
    } finally {
      mcpListInflight = null
    }
  })()
  mcpListInflight = p
  return p
}

function fetchMcpListFromJson(ws: string): McpListCache {
  const enabled: Record<string, boolean> = {}
  const status: Record<string, string> = {}
  const servers = getMcpServerList()
  for (const s of servers) {
    const disabled = s.rawConfig && (s.rawConfig as Record<string, unknown>).disabled === true
    enabled[s.name] = !disabled
    status[s.name] = disabled ? "disabled" : "enabled"
  }
  const result: McpListCache = { enabled, status, ts: Date.now(), ws }
  mcpListCache = result
  return result
}

export async function getMcpEnabledMap(force = false): Promise<Record<string, boolean>> {
  return (await fetchMcpList(force)).enabled
}

export async function getMcpStatusMap(force = false): Promise<Record<string, string>> {
  return (await fetchMcpList(force)).status
}

export function invalidateMcpEnabledCache(): void {
  mcpListCache = null
}

export async function toggleMcpServer(serverName: string, enabled: boolean): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, output: "工作目录未配置" }

  if (useSdkMode()) {
    return toggleMcpServerViaJson(serverName, enabled)
  }

  if (!resolveAgentBinary()) return { ok: false, output: "Cursor CLI 未安装" }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)

  const sub = enabled ? "enable" : "disable"
  try {
    const r = await spawnAsync(["mcp", sub, serverName], config.workspaceDir, env)
    const out = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "").trim()
    broadcastLog(`[MCP ${sub}] ${serverName}: ${out}`, r.code === 0 ? "INFO" : "WARN")
    invalidateMcpEnabledCache()
    return { ok: r.code === 0, output: out }
  } catch (e: unknown) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) }
  }
}

function toggleMcpServerViaJson(serverName: string, enabled: boolean): { ok: boolean; output: string } {
  for (const source of ["project", "global"] as const) {
    const filePath = getMcpJsonPath(source)
    const cfg = readMcpJson(filePath)
    const servers = (cfg.mcpServers ?? {}) as Record<string, Record<string, unknown>>
    if (!(serverName in servers)) continue

    if (enabled) {
      delete servers[serverName].disabled
    } else {
      servers[serverName].disabled = true
    }
    cfg.mcpServers = servers
    writeMcpJson(filePath, cfg)
    invalidateMcpEnabledCache()
    const action = enabled ? "已启用" : "已禁用"
    broadcastLog(`[MCP] ${serverName}: ${action} (mcp.json)`, "INFO")
    return { ok: true, output: action }
  }
  return { ok: false, output: `MCP 服务器 "${serverName}" 未在配置中找到` }
}

export function getMcpServerList(): McpServerEntry[] {
  const config = getConfig()
  const authData = config.workspaceDir ? readMcpAuthFile(config.workspaceDir) : {}
  const verified = config.verifiedMcpServers ?? []

  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  const projectPath = config.workspaceDir ? path.join(config.workspaceDir, ".cursor", "mcp.json") : ""

  const result: McpServerEntry[] = []
  const seen = new Set<string>()

  for (const [filePath, source] of [[projectPath, "project"], [globalPath, "global"]] as const) {
    if (!filePath) continue
    try {
      if (!fs.existsSync(filePath)) continue
      const cfg = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      const servers = cfg.mcpServers as Record<string, Record<string, unknown>> | undefined
      if (!servers) continue
      for (const [name, entry] of Object.entries(servers)) {
        if (seen.has(name)) continue
        seen.add(name)
        const isUrl = "url" in entry && !("command" in entry)
        const item: McpServerEntry = {
          name,
          type: isUrl ? "url" : "command",
          source,
          rawConfig: entry,
        }
        if (isUrl) {
          item.url = entry.url as string
          const hasHeaders = !!(entry.headers && typeof entry.headers === "object" && Object.keys(entry.headers as object).length > 0)
          if (hasHeaders) {
            item.authenticated = true
          } else {
            const auth = authData[name] as Record<string, unknown> | undefined
            const hasToken = !!(auth?.tokens && (auth.tokens as Record<string, unknown>).access_token)
            item.authenticated = hasToken || verified.includes(name)
          }
        } else {
          item.command = entry.command as string
          item.args = entry.args as string[] | undefined
          item.env = entry.env as Record<string, string> | undefined
        }
        result.push(item)
      }
    } catch { /* ignore */ }
  }

  return result
}

function getMcpJsonPath(source: "global" | "project"): string {
  if (source === "global") return path.join(os.homedir(), ".cursor", "mcp.json")
  const config = getConfig()
  return path.join(config.workspaceDir || "", ".cursor", "mcp.json")
}

function readMcpJson(filePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch { /* ignore */ }
  return {}
}

function writeMcpJson(filePath: string, config: Record<string, unknown>): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8")
}

export function saveMcpServer(name: string, entry: Record<string, unknown>, source: "global" | "project"): void {
  const filePath = getMcpJsonPath(source)
  const config = readMcpJson(filePath)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  servers[name] = entry
  config.mcpServers = servers
  writeMcpJson(filePath, config)
}

export function deleteMcpServer(name: string): void {
  for (const source of ["project", "global"] as const) {
    const filePath = getMcpJsonPath(source)
    const config = readMcpJson(filePath)
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>
    if (name in servers) {
      delete servers[name]
      config.mcpServers = servers
      writeMcpJson(filePath, config)
      return
    }
  }
}

let mcpLoginChild: ChildProcess | null = null
let mcpLoginGeneration = 0

export function loginMcpServer(serverName: string): Promise<{ ok: boolean; output: string }> {
  if (useSdkMode()) {
    broadcastLog(`[MCP Login] SDK 模式暂不支持 OAuth 认证，请在 Cursor IDE 中完成 "${serverName}" 的登录认证`, "WARN")
    return Promise.resolve({ ok: false, output: `SDK 模式暂不支持 MCP OAuth 认证。请打开 Cursor IDE，在 MCP 设置中完成 "${serverName}" 的认证，认证后本应用会自动读取凭据。` })
  }

  const gen = ++mcpLoginGeneration

  return new Promise<{ ok: boolean; output: string }>(async (resolve) => {
    if (mcpLoginChild) {
      try { mcpLoginChild.kill() } catch { /* ignore */ }
      mcpLoginChild = null
      broadcastLog(`[MCP Login] 终止上一次未完成的登录进程`)
    }

    const config = getConfig()
    if (!config.workspaceDir) {
      resolve({ ok: false, output: "工作目录未配置" })
      return
    }

    if (!resolveAgentBinary()) {
      resolve({ ok: false, output: "Cursor CLI 未安装" })
      return
    }

    const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(spawnEnv, config)

    // 先 enable 再 login（异步）
    try {
      const er = await spawnAsync(["mcp", "enable", serverName], config.workspaceDir, spawnEnv)
      const enOut = (er.stdout + er.stderr).trim()
      broadcastLog(`[MCP Enable] "${serverName}": ${enOut || "已启用"}`, er.code === 0 ? "INFO" : "WARN")
    } catch (e: unknown) {
      broadcastLog(`[MCP Enable] 启用失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    }

    const args = [
      "--workspace", config.workspaceDir,
      "mcp", "login", serverName,
    ]

    let output = ""
    broadcastLog(`[MCP Login] 正在认证 "${serverName}"...`)
    logCursorAgentInvocation("mcp-login", args, config.workspaceDir)

    try {
      const { agentNodePath: np, agentIndexPath: ip } = getAgentPaths()
      if (np && ip) {
        mcpLoginChild = spawn(np, [ip, ...args], {
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: config.workspaceDir,
          env: spawnEnv,
        })
      } else {
        mcpLoginChild = spawn("agent", args.map(quoteArg), {
          shell: true,
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: config.workspaceDir,
          env: spawnEnv,
        })
      }

      mcpLoginChild.stdout?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[MCP Login] ${s}`, "INFO")
      })

      mcpLoginChild.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[MCP Login:err] ${s}`, "ERROR")
      })

      mcpLoginChild.on("exit", (code) => {
        mcpLoginChild = null
        if (gen !== mcpLoginGeneration) {
          resolve({ ok: true, output: "" })
          return
        }
        if (code === 0) {
          const cfg = getConfig()
          const authData = cfg.workspaceDir ? readMcpAuthFile(cfg.workspaceDir) : {}
          const auth = authData[serverName] as Record<string, unknown> | undefined
          const hasToken = !!(auth?.tokens && (auth.tokens as Record<string, unknown>).access_token)
          if (!hasToken) {
            const verified = cfg.verifiedMcpServers ?? []
            if (!verified.includes(serverName)) {
              saveConfig({ verifiedMcpServers: [...verified, serverName] })
            }
          }
        }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("mcp:login-complete", { serverName, ok: code === 0 })
        }
        resolve(code === 0
          ? { ok: true, output: `MCP "${serverName}" 认证成功` }
          : { ok: false, output: output || `认证失败 (exit code: ${code})` },
        )
      })

      mcpLoginChild.on("error", (e) => {
        mcpLoginChild = null
        if (gen !== mcpLoginGeneration) { resolve({ ok: true, output: "" }); return }
        resolve({ ok: false, output: `认证进程错误: ${e.message}` })
      })

      setTimeout(() => {
        if (mcpLoginChild && gen === mcpLoginGeneration) {
          try { mcpLoginChild.kill() } catch { /* ignore */ }
          mcpLoginChild = null
          resolve({ ok: false, output: "认证超时（2分钟）" })
        }
      }, 120_000)
    } catch (e: unknown) {
      mcpLoginChild = null
      resolve({ ok: false, output: `启动认证失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}

export interface ConfigSaveResult {
  ok: boolean
  /** 需在渲染进程展示自定义弹窗后，由用户选择「重启」或「保持」 */
  needWorkspaceDaemonChoice?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  /** 因目录冲突未写入 store，完成向导需在重启成功后补写 */
  deferredSetupComplete?: boolean
  restartFailed?: string
  /** 本次已将工作目录写入配置（非「待确认重启」分支）；渲染进程应刷新依赖工作区的数据（如 MCP 列表与启用状态） */
  workspaceDirChanged?: boolean
}

/**
 * 切换工作目录：不终止任何 session，旧会话保留供用户切回。
 * 新消息会通过复合 sessionKey (chatId::workspaceDir) 路由到当前活跃目录。
 */
export async function applyWorkspaceDirChange(workspaceDir: string): Promise<{ ok: boolean; error?: string }> {
  const w = workspaceDir.trim()
  if (!w) return { ok: false, error: "工作目录为空" }

  saveConfig({ workspaceDir: w })
  invalidateMcpEnabledCache()
  await injectWorkspaceMcpAndRules()
  broadcastStatus(await getDaemonStatus())
  return { ok: true }
}

/**
 * 在新工作目录下保存并重启 Daemon（由渲染进程在确认后调用）。
 */
export async function applyWorkspaceDirRestart(workspaceDir: string): Promise<{ ok: boolean; error?: string }> {
  const w = workspaceDir.trim()
  if (!w) return { ok: false, error: "工作目录为空" }
  saveConfig({ workspaceDir: w })
  await stopDaemon()
  const started = await startDaemon()
  broadcastStatus(await getDaemonStatus())
  if (!started.ok) return { ok: false, error: started.error ?? "Daemon 启动失败" }
  return { ok: true }
}

/**
 * 保存配置；若正在修改工作目录且 Daemon 在运行，交由渲染进程展示与主页风格一致的确认弹窗。
 */
export async function saveAppConfigFromRenderer(partial: Partial<AppConfig>): Promise<ConfigSaveResult> {
  const current = getConfig()
  const oldW = (current.workspaceDir || "").trim()
  const nextW = partial.workspaceDir !== undefined ? partial.workspaceDir.trim() : oldW
  const workspaceChanging = partial.workspaceDir !== undefined && nextW !== oldW && oldW !== ""

  if (workspaceChanging) {
    const st = await getDaemonStatus()
    if (st.running) {
      const deferredSc = partial.setupComplete === true
      const rest: Partial<AppConfig> = { ...partial }
      delete (rest as Record<string, unknown>).workspaceDir
      if (deferredSc) {
        delete (rest as Record<string, unknown>).setupComplete
      }
      saveConfig({ ...rest, workspaceDir: oldW })
      broadcastStatus(await getDaemonStatus())
      return {
        ok: true,
        needWorkspaceDaemonChoice: true,
        oldWorkspaceDir: oldW,
        newWorkspaceDir: nextW,
        deferredSetupComplete: deferredSc,
      }
    }
  }

  const workspaceDirChanged =
    partial.workspaceDir !== undefined && nextW !== oldW

  if (workspaceDirChanged) {
    invalidateMcpEnabledCache()
  }

  saveConfig(partial)
  return {
    ok: true,
    ...(workspaceDirChanged ? { workspaceDirChanged: true } : {}),
  }
}

// ── 初始化 ───────────────────────────────────────────────

export function initDaemonManager(): void {
  setChatNameResolver((chatId) => chatNameCache.get(chatId))
  setSessionCloseHandler(handleSessionClosed)
  registerEnableMcpFn(async (_wsDir, serverNames) => {
    for (const name of serverNames) await toggleMcpServer(name, true)
  })
  ipcMain.handle("config:apply-workspace-restart", (_, workspaceDir: string) => applyWorkspaceDirRestart(workspaceDir))
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
  stopAllSessionAgents()
  if (daemonProcess) {
    try { daemonProcess.kill() } catch { /* ignore */ }
    daemonProcess = null
  }
  cachedPort = null
  setDaemonPort(null)
  activeDaemonWorkspaceDir = null
}

// ── MCP Server 工具列表查询（via Cursor CLI） ──────────────

export interface McpToolInfo {
  name: string
  description?: string
  params?: { name: string; type?: string; description?: string; required?: boolean }[]
}

function extractParams(schema: any): McpToolInfo["params"] {
  if (!schema?.properties) return undefined
  const required = new Set<string>(schema.required ?? [])
  return Object.entries(schema.properties).map(([k, v]: [string, any]) => ({
    name: k,
    type: v.type,
    description: v.description,
    required: required.has(k),
  }))
}

function queryToolsViaProtocol(cmd: string, args: string[], envOverride?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...(envOverride ?? {}) }
    if (!env.PATH && env.Path) env.PATH = env.Path

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(quoteArg(cmd), args.map(quoteArg), { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true })
    } catch (e: any) {
      resolve({ ok: false, tools: [], error: `启动失败: ${e.message}` })
      return
    }

    let stdout = ""
    let phase: "init" | "list" | "done" = "init"
    const timeout = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve({ ok: false, tools: [], error: "查询超时" })
    }, 15_000)

    const finish = (result: { ok: boolean; tools: McpToolInfo[]; error?: string }) => {
      if (phase === "done") return
      phase = "done"
      clearTimeout(timeout)
      try { child.kill() } catch { /* */ }
      resolve(result)
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
      for (const raw of stdout.split("\n")) {
        const line = raw.trim()
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && msg.result && phase === "init") {
            phase = "list"
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n")
          }
          if (msg.id === 2 && msg.result?.tools) {
            const tools: McpToolInfo[] = (msg.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
            finish({ ok: true, tools })
          }
        } catch { /* not json */ }
      }
    })

    child.on("error", (err) => finish({ ok: false, tools: [], error: `启动失败: ${err.message}` }))
    child.on("close", () => finish(phase === "init" ? { ok: false, tools: [], error: "进程退出，未获取到工具" } : { ok: true, tools: [] }))

    child.stdin?.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cursor-claw", version: "1.0.0" } },
    }) + "\n")
  })
}

async function queryToolsViaHttp(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const rpc = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params })
  const post = (body: string): Promise<any> => new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === "https:"
    const mod = isHttps ? require("node:https") : require("node:http")
    const req = mod.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(headers ?? {}) },
      timeout: 10_000,
    }, (res: any) => {
      let data = ""
      res.on("data", (chunk: Buffer) => { data += chunk.toString() })
      res.on("end", () => {
        try {
          if (res.headers["content-type"]?.includes("text/event-stream")) {
            for (const line of data.split("\n")) {
              if (line.startsWith("data:")) {
                const parsed = JSON.parse(line.slice(5).trim())
                if (parsed.id !== undefined) { resolve(parsed); return }
              }
            }
          }
          resolve(JSON.parse(data))
        } catch { resolve(null) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.write(body)
    req.end()
  })

  try {
    const initRes = await post(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cursor-claw", version: "1.0.0" } }))
    if (!initRes?.result) return { ok: false, tools: [], error: "initialize 失败" }
    const listRes = await post(rpc(2, "tools/list"))
    if (!listRes?.result?.tools) return { ok: false, tools: [], error: "tools/list 无结果" }
    const tools: McpToolInfo[] = (listRes.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
    return { ok: true, tools }
  } catch (e: any) {
    return { ok: false, tools: [], error: e?.message ?? "HTTP 请求失败" }
  }
}

function queryToolsViaCli(serverName: string): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const config = getConfig()
  if (!config.workspaceDir || !resolveAgentBinary()) return Promise.resolve({ ok: false, tools: [], error: "CLI 不可用" })
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)
  return spawnAsync(["mcp", "list-tools", serverName], config.workspaceDir, env).then((r) => {
    const clean = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "")
    if (r.code !== 0) return { ok: false, tools: [] as McpToolInfo[], error: clean.trim().split("\n").pop()?.trim() || `exit ${r.code}` }
    const tools: McpToolInfo[] = []
    for (const line of clean.split("\n")) {
      const m = line.match(/^[-–]\s+(\S+)/)
      if (m) tools.push({ name: m[1] })
    }
    return { ok: true, tools }
  })
}

export async function getMcpServerTools(serverName: string): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const servers = getMcpServerList()
  const server = servers.find((s) => s.name === serverName)
  if (!server) return { ok: false, tools: [], error: "MCP 服务器未找到" }

  if (server.type === "url" && server.url) {
    const headers = server.rawConfig?.headers as Record<string, string> | undefined
    const result = await queryToolsViaHttp(server.url, headers)
    if (result.ok && result.tools.length > 0) return result
  }

  if (server.type === "command" && server.command) {
    const result = await queryToolsViaProtocol(server.command, server.args ?? [], server.env)
    if (result.ok && result.tools.length > 0) return result
  }

  return queryToolsViaCli(serverName)
}
