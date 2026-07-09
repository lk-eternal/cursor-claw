import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID, randomBytes } from "node:crypto"
import * as http from "node:http"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { app, BrowserWindow, ipcMain, powerSaveBlocker, shell } from "electron"
import {
  getConfig, saveConfig, type AppConfig,
  getChannels, getEnabledChannels, getChannel,
  updateChannel, migrateLegacyConfig, effectiveWorkspaceDir,
  mainChatScopeKey, setMainChatIdForScope, type MessageChannel,
} from "./config-store"
import { parseChatKey, channelIdFromSessionKey, type DaemonChannelConfig, type ChannelStatusInfo } from "../src/shared/channel-types"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { seedBuiltins, listDefinitions, saveDefinition, deleteDefinition, listInstances, getInstance, saveInstance, deleteInstance } from "./workflow-file"
import { runWorkflowDefinition } from "./workflow-runner"
import { pushLog, pushUiLog, broadcastLog, getLogBuffer, clearLogBuffer, escapeLogContentSingleLine } from "./ui-logger"
import { applyProxyEnv } from "./agent-cli"
import {
  stopAgent as _stopCliAgent,
  isAgentRunning as _isCliAgentRunning, getRunningSessionCount as _getCliRunningCount,
  getAgentChildPid, getSessionAgentCount as _getCliSessionCount, getIndependentTaskStatuses as _getCliTaskStatuses,
  type ChatType,
} from "./agent-launcher"
import { stopAllSdkSessions, resetSdkSessionContext, getSdkSessionCount, getSdkSessionList, checkSdkApiKey, listSdkModels, getSdkSessionDiagnostics, getResumableSummary } from "./agent-sdk"
import { registerFeishuApp } from "./feishu-register"
import {
  setDaemonPort,
  injectWorkspaceToDir, injectWorkspaceMcpAndRules, clearInjectionCache,
} from "./workspace-injector"
import {
  invalidateMcpEnabledCache,
  getMcpServerList,
  getMcpEnabledMap,
  deleteMcpServer,
  saveMcpServer,
  McpServerEntry,
} from "./mcp-manager"
import { FileCommand, reportCommandResult, handleFeishuModelCommand, handleFeishuMcpCommand, handleFeishuTaskCommand, handleFeishuWorkflowCommand, parseListModelsStdout, type TaskRunFn } from "./command-handler"
import { readLockFile, getLockFilePath, httpGet, httpPost, syncActiveSession, getCurrentActiveSession, enqueueToMainSession } from "./daemon-client"
import {
  isSessionAgentRunning, stopSessionAgent, stopAllSessionAgents,
  dispatchSessionAgents, launchSessionAgent, launchIndependentAgent,
  launchWorkflowAgent, notifyWorkflowChat,
  getSessionAgentList, handleChatCommand, clearMessageQueue, getQueueMessages,
  pullMergedMessagesFromQueue, isMainUser, extractChatId, chatNameCache,
  fetchChatNames, fetchUserNames, initSessionDispatcher, previousActiveSessionMap,
} from "./session-dispatcher"

export { applyProxyEnv, checkCliInstalled, installCli, execAgentSync, execAgentAsync, type ExecAgentOptions as ExecAgentSyncOptions } from "./agent-cli"
export { checkAgentLoggedIn, loginCli } from "./agent-launcher"
export { getLogBuffer } from "./ui-logger"
export { checkSdkApiKey, listSdkModels } from "./agent-sdk"
export { injectWorkspaceMcpAndRules, injectWorkspaceToDir, clearInjectionCache } from "./workspace-injector"
export { getQueueMessages, clearMessageQueue, deleteQueueMessage } from "./session-dispatcher"


function isAgentRunning(): boolean {
  return _isCliAgentRunning() || getSdkSessionCount() > 0
}

function getRunningSessionCount(): number {
  return _getCliRunningCount() + getSdkSessionCount()
}

function getSessionAgentCount(): number {
  return _getCliSessionCount() + getSdkSessionCount()
}

async function stopAgent(): Promise<void> {
  const timeout = new Promise<void>((r) => setTimeout(r, 5000))
  await Promise.race([stopAllSdkSessions(), timeout])
  _stopCliAgent()
}

function getIndependentTaskStatuses(): Record<string, { running: boolean; pid?: number; startedAt?: number }> {
  const out: Record<string, { running: boolean; pid?: number; startedAt?: number }> = _getCliTaskStatuses()
  for (const s of getSdkSessionList()) {
    if (s.chatType === "task" || s.chatType === "temp") out[s.sessionKey] = { running: true, startedAt: s.startedAt }
  }
  return out
}


const UNIFIED_DAEMON_PREFIX = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3} \[Daemon\] /

function pushDaemonStderrLine(rawLine: string): void {
  const t = rawLine.trim()
  if (!t) return
  if (UNIFIED_DAEMON_PREFIX.test(t)) {
    pushLog(t.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:)/, "$1 $2"))
    return
  }
  pushUiLog("Daemon", "WARN", t)
}


export interface DaemonStatus {
  running: boolean
  /** 正在启动中（spawn 到就绪期间），UI 据此显示"启动中"并禁用启动按钮 */
  starting?: boolean
  version?: string
  uptime?: number
  queueLength?: number
  queueCounts?: { pending: number; processing: number }
  hasChatId?: boolean
  agentRunning?: boolean
  agentPid?: number | null
  sessionAgentCount?: number
  cliAvailable?: boolean
  error?: string
  workspaceMismatch?: boolean
  daemonWorkspaceDir?: string
  channels?: ChannelStatusInfo[]
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

/** 期望 Daemon 处于运行态：true 时若进程意外退出则自动重启；主动停止/退出应用置 false */
let daemonShouldRun = false
/** 启动进行中（含自动启动/自愈重启），用于向 UI 暴露"启动中"状态 */
let daemonStarting = false
let daemonRestartTimer: NodeJS.Timeout | null = null
let daemonRestartCount = 0
let lastDaemonStartAt = 0
const DAEMON_AUTO_RESTART_DELAY_MS = 3_000
const DAEMON_RESTART_WINDOW_MS = 60_000
const DAEMON_RESTART_MAX = 5

/** 运行期意外退出的自愈重启：带 crash-loop 退避（窗口内超限即停手报警，等待人工介入） */
function scheduleDaemonAutoRestart(exitCode: number | null): void {
  if (!daemonShouldRun) return
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  const now = Date.now()
  if (now - lastDaemonStartAt > DAEMON_RESTART_WINDOW_MS) daemonRestartCount = 0
  if (daemonRestartCount >= DAEMON_RESTART_MAX) {
    daemonShouldRun = false
    broadcastLog(`[Daemon] 短时间内异常退出 ${daemonRestartCount} 次，已停止自动重启，请检查后在主页手动启动`, "ERROR")
    return
  }
  daemonRestartCount++
  broadcastLog(`[Daemon] 异常退出 (code=${exitCode})，${DAEMON_AUTO_RESTART_DELAY_MS / 1000}s 后自动重启 (第 ${daemonRestartCount}/${DAEMON_RESTART_MAX} 次)`, "WARN")
  daemonRestartTimer = setTimeout(() => {
    daemonRestartTimer = null
    if (!daemonShouldRun) return
    void startDaemon().then((r) => {
      if (!r.ok) broadcastLog(`[Daemon] 自动重启失败: ${r.error}`, "ERROR")
    })
  }, DAEMON_AUTO_RESTART_DELAY_MS)
}

let tempWsClient: import("@larksuiteoapi/node-sdk").WSClient | null = null
let tempConnAbort: (() => void) | null = null

// ── 主用户绑定等待器（daemon armed-bind 模式）──────────────
let bindWaiter: { channelId: string; resolve: (chatId: string) => void } | null = null

function resolveBindWaiter(channelId: string, chatId: string): void {
  if (bindWaiter && bindWaiter.channelId === channelId) {
    const w = bindWaiter
    bindWaiter = null
    w.resolve(chatId)
  }
}

// ── 微信临时连接：等待首条消息（Daemon 未运行时的绑定兜底）──
let wechatTempMgr: { stop: () => Promise<void> } | null = null

async function wechatWaitFirstMessageImpl(token: string, accountId: string, channelId?: string): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  if (wechatTempMgr) { try { await wechatTempMgr.stop() } catch { /* ignore */ } wechatTempMgr = null }
  const dataDir = channelId
    ? path.join(app.getPath("userData"), "wechat-data", channelId)
    : path.join(app.getPath("userData"), "wechat-data")
  const { WeChatManager } = await import("../src/wechat-manager.js")

  return new Promise<{ ok: boolean; chatId?: string; error?: string }>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return; done = true
      wechatTempMgr?.stop().catch(() => {}); wechatTempMgr = null
      resolve({ ok: false, error: "等待超时(5分钟)，请重试" })
    }, 5 * 60_000)

    const mgr = new WeChatManager({
      dataDir,
      log: (level: string, ...args: unknown[]) => console.log(`[main-wechat-temp] [${level}]`, ...args),
      onMessage: (msg: { chatType: string; chatId: string }) => {
        if (done) return
        if (msg.chatType === "p2p" && msg.chatId) {
          done = true; clearTimeout(timer)
          const stateFile = path.join(dataDir, "state.json")
          try {
            let st: Record<string, unknown> = {}
            if (fs.existsSync(stateFile)) st = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
            st.lastChatId = msg.chatId
            if (!fs.existsSync(path.dirname(stateFile))) fs.mkdirSync(path.dirname(stateFile), { recursive: true })
            fs.writeFileSync(stateFile, JSON.stringify(st))
          } catch { /* ignore */ }
          mgr.stop().then(() => { wechatTempMgr = null }).catch(() => { wechatTempMgr = null })
          resolve({ ok: true, chatId: msg.chatId })
        }
      },
    })
    wechatTempMgr = mgr
    mgr.start(token, accountId).catch((err: Error) => {
      if (done) return; done = true; clearTimeout(timer)
      wechatTempMgr = null
      resolve({ ok: false, error: err?.message ?? "连接失败" })
    })
  })
}

function getDaemonEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "daemon-entry.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "daemon-entry.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "daemon-entry.js")
}

async function startTempConnection(appId: string, appSecret: string): Promise<{ chatId: string }> {
  stopTempConnection()
  const Lark = await import("@larksuiteoapi/node-sdk")
  return new Promise((resolve, reject) => {
    let settled = false
    // 任何终态（成功/超时/取消/失败）都必须关闭临时连接：飞书按连接负载均衡推送事件，
    // 残留连接会截走 Daemon 正式连接的消息（且在主进程里，重启 Daemon 无法恢复）
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      tempConnAbort = null
      if (tempWsClient) {
        try { tempWsClient.close({ force: true }) } catch { /* ignore */ }
        tempWsClient = null
      }
      fn()
    }
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("绑定超时（90秒内未收到飞书私聊消息）")))
    }, 90_000)
    tempConnAbort = () => settle(() => reject(new Error("cancelled")))

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data: any) => {
        const msg = data?.message
        if ((msg?.chat_type ?? "p2p") !== "p2p") return
        settle(() => resolve({ chatId: msg?.chat_id ?? "" }))
      },
    })

    const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error, autoReconnect: false })
    tempWsClient = wsClient
    wsClient.start({ eventDispatcher })
      .then(() => pushLog("[TEMP_CONN] 飞书临时 WebSocket 连接建立成功"))
      .catch((e: any) => settle(() => reject(new Error(`WebSocket 连接失败: ${e?.message ?? e}`))))
  })
}

function stopTempConnection(): void {
  if (tempConnAbort) { tempConnAbort(); tempConnAbort = null }
  if (tempWsClient) {
    try { tempWsClient.close({ force: true }) } catch { /* ignore */ }
    tempWsClient = null
  }
}



async function httpsPost(url: string, body: object, headers: Record<string, string> = {}, timeoutMs = 5000): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json().catch(() => null)
}

async function httpsGet(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json().catch(() => null)
}

/** 用凭据获取飞书机器人应用信息（app_name / open_id），凭据无效时返回错误 */
async function fetchLarkBotInfo(appId: string, appSecret: string): Promise<{ ok: boolean; name?: string; openId?: string; error?: string }> {
  try {
    const tokenResp = await httpsPost("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      app_id: appId, app_secret: appSecret,
    })
    const token = tokenResp?.tenant_access_token
    if (!token) return { ok: false, error: tokenResp?.msg || "凭据无效（获取 token 失败）" }
    const botResp = await httpsGet("https://open.feishu.cn/open-apis/bot/v3/info", { Authorization: `Bearer ${token}` })
    const bot = botResp?.bot
    if (!bot?.app_name) return { ok: false, error: botResp?.msg || "未获取到机器人信息（请确认已开启机器人能力）" }
    return { ok: true, name: bot.app_name, openId: bot.open_id }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "请求失败" }
  }
}

async function larkSendTestMessage(channel: MessageChannel, receiveId: string): Promise<void> {
  if (!channel.larkAppId || !channel.larkAppSecret) throw new Error("飞书凭据未配置")
  const tokenResp = await httpsPost("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: channel.larkAppId,
    app_secret: channel.larkAppSecret,
  })
  const token = tokenResp?.tenant_access_token
  if (!token) throw new Error("获取 access_token 失败")
  const sendResp = await httpsPost(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
    { receive_id: receiveId, msg_type: "interactive", content: JSON.stringify({ schema: "2.0", config: { wide_screen_mode: true }, body: { elements: [{ tag: "markdown", content: "🔗 绑定测试成功！连接正常。" }] } }) },
    { Authorization: `Bearer ${token}` },
  )
  if (sendResp?.code !== 0) throw new Error(sendResp?.msg || "发送失败")
}

async function wechatSendTestMessage(channel: MessageChannel): Promise<void> {
  if (!channel.wechatToken) throw new Error("微信 Token 未配置")
  const dataDir = path.join(app.getPath("userData"), "wechat-data", channel.id)
  return wechatSendTestMessageRaw(channel.wechatToken, dataDir, channel.mainUserEnabled ? channel.mainUserChatId : "")
}

async function wechatSendTestMessageRaw(token: string, dataDir: string, preferredChatId?: string): Promise<void> {
  if (!token?.trim()) throw new Error("微信 Token 未配置")
  const stateFile = path.join(dataDir, "state.json")
  if (!fs.existsSync(stateFile)) throw new Error("暂无微信交互记录，请先给机器人发一条消息")
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
  const chatId = preferredChatId?.trim() || (state?.lastChatId as string | undefined)
  if (!chatId) throw new Error("暂无微信交互记录，请先给机器人发一条消息")
  const ctFile = path.join(dataDir, "wechat-ctx-tokens.json")
  if (!fs.existsSync(ctFile)) throw new Error("无会话上下文，请先给机器人发一条消息")
  const ctMap = JSON.parse(fs.readFileSync(ctFile, "utf-8")) as Record<string, string>
  const contextToken = ctMap[chatId]
  if (!contextToken) throw new Error("无会话上下文，请先给机器人发一条消息")
  const clientId = `claw:${Date.now()}-${randomBytes(4).toString("hex")}`
  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64")
  const bodyStr = JSON.stringify({
    msg: {
      from_user_id: "", to_user_id: chatId, client_id: clientId,
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text: "🔗 微信测试成功！连接正常。" } }],
      context_token: contextToken,
    },
    base_info: { channel_version: "standalone-0.1.0" },
  })
  const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "Authorization": `Bearer ${token.trim()}`,
      "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
      "X-WECHAT-UIN": uin,
    },
    body: bodyStr,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`微信 API 错误 ${res.status}: ${raw}`)
  try {
    const json = JSON.parse(raw)
    if (json.ret && json.ret !== 0) throw new Error(`微信 API 返回错误: ${json.errmsg ?? raw}`)
  } catch (e) {
    if (e instanceof SyntaxError) return
    throw e
  }
}


export async function getDaemonStatus(): Promise<DaemonStatus> {
  const config = getConfig()
  const cfgWs = (config.workspaceDir || "").trim()

  const statusFromHealth = (port: number, health: Record<string, unknown>): DaemonStatus => {
    cachedPort = port
    setDaemonPort(port)
    const status: DaemonStatus = {
      running: true,
      version: health.version as string,
      uptime: health.uptime as number,
      queueLength: health.queueLength as number,
      queueCounts: health.queueCounts as { pending: number; processing: number } | undefined,
      hasChatId: health.hasChatId as boolean,
      agentRunning: isAgentRunning() || getSessionAgentCount() > 0,
      agentPid: getAgentChildPid(),
      sessionAgentCount: getRunningSessionCount(),
      channels: health.channels as ChannelStatusInfo[] | undefined,
      feishuEnabled: health.feishuEnabled as boolean | undefined,
      feishuConnected: health.feishuConnected as boolean | undefined,
      wechatEnabled: health.wechatEnabled as boolean | undefined,
      wechatStatus: health.wechatStatus as string | undefined,
      wechatReady: health.wechatReady as boolean | undefined,
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

  return { running: false, starting: daemonStarting, error: daemonStarting ? undefined : "Daemon 未运行" }
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

/** 通道是否凭据齐全可下发给 Daemon */
function channelReady(c: MessageChannel): boolean {
  if (!c.enabled) return false
  if (c.type === "feishu") return !!(c.larkAppId?.trim() && c.larkAppSecret?.trim())
  return !!c.wechatToken?.trim()
}

function buildDaemonChannelConfigs(): DaemonChannelConfig[] {
  return getChannels().filter(channelReady).map((c) => ({
    id: c.id,
    name: c.name || (c.type === "feishu" ? "飞书" : "微信"),
    type: c.type,
    appId: c.larkAppId?.trim(),
    appSecret: c.larkAppSecret?.trim(),
    wechatToken: c.wechatToken?.trim(),
    wechatAccountId: c.wechatAccountId?.trim(),
    mainUserEnabled: !!c.mainUserEnabled,
    mainUserChatId: c.mainUserEnabled ? (c.mainUserChatId?.trim() ?? "") : "",
    workspaceDir: c.workspaceDir?.trim() ?? "",
    keepAlive: (c.keepSession ?? true) && (c.persistentPoll ?? true),
  }))
}

export async function startDaemon(): Promise<{ ok: boolean; error?: string }> {
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  const config = getConfig()
  const channelConfigs = buildDaemonChannelConfigs()
  if (channelConfigs.length === 0) {
    return { ok: false, error: "至少需要配置一个可用的消息通道（设置 → 消息通道）" }
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

  // 强制清理旧 lock，确保 waitForLockFile 不会读到残留数据
  try { fs.unlinkSync(getLockFilePath()) } catch { /* ok if absent */ }

  const entryPath = getDaemonEntryPath()
  if (!fs.existsSync(entryPath)) {
    return { ok: false, error: `Daemon 入口文件不存在: ${entryPath}` }
  }

  daemonStarting = true
  broadcastStatus({ running: false, starting: true })

  try {
    const templateDir = app.isPackaged
      ? path.join(process.resourcesPath, "template")
      : path.join(app.getAppPath(), "resources", "template")

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      LARK_WORKSPACE_DIR: config.workspaceDir,
      APP_DATA_DIR: app.getPath("userData"),
      CURSOR_CLAW_TEMPLATE_DIR: templateDir,
      NODE_USE_ENV_PROXY: "1",
      CLAW_CHANNELS_JSON: JSON.stringify(channelConfigs),
      ...(config.daemonPort ? { LARK_DAEMON_PORT: String(config.daemonPort) } : {}),
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
            const chatType = payload.chatType ?? "task"
            const chatId = payload.chatId as string | undefined
            void launchIndependentAgent(
              payload.taskId, payload.taskName, payload.content, chatType, chatId,
              payload.channelId, payload.model, payload.modelParams,
            ).then(async (result) => {
              if (result.ok && chatId && cachedPort) {
                const currentActive = await getCurrentActiveSession(cachedPort, chatId)
                if (currentActive && currentActive !== payload.taskId) previousActiveSessionMap.set(payload.taskId, currentActive)
                await syncActiveSession(cachedPort, chatId, payload.taskId)
              }
            })
          } catch { /* ignore malformed */ }
          continue
        }
        if (line.startsWith("__WF_LAUNCH__:")) {
          try {
            const p = JSON.parse(line.slice("__WF_LAUNCH__:".length))
            void launchWorkflowAgent(p).then((r) => {
              if (!r.ok) broadcastLog(`[WF] Agent 启动失败: ${r.error}`, "WARN")
            })
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WF_INSTANCE__:")) {
          try {
            const inst = JSON.parse(line.slice("__WF_INSTANCE__:".length))
            BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("workflow:instance-updated", inst))
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WF_NOTIFY__:")) {
          try {
            const { chatId, text } = JSON.parse(line.slice("__WF_NOTIFY__:".length))
            if (chatId && text) void notifyWorkflowChat(chatId, text)
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__BIND_RESULT__:")) {
          try {
            const payload = JSON.parse(line.slice("__BIND_RESULT__:".length))
            const chatId = payload.chatId as string | undefined
            const channelId = payload.channelId as string | undefined
            if (chatId && channelId) {
              updateChannel(channelId, { mainUserEnabled: true, mainUserChatId: chatId })
              broadcastLog(`[Bind] 通道 ${channelId} 主用户绑定成功: chat_id=${chatId}`)
              resolveBindWaiter(channelId, chatId)
              BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("bind:result", { ok: true, value: chatId, channelId }))
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WORKSPACE_SWITCH__:")) {
          try {
            const { dir } = JSON.parse(line.slice("__WORKSPACE_SWITCH__:".length))
            if (dir) void applyWorkspaceSwitch(dir, false, true)
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WECHAT_QR__:")) {
          const rest = line.slice("__WECHAT_QR__:".length)
          const sep = rest.indexOf(":")
          const channelId = sep > 0 ? rest.slice(0, sep) : ""
          const dataUrl = sep > 0 ? rest.slice(sep + 1) : rest
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:qrcode", dataUrl, channelId))
          continue
        }
        if (line.startsWith("__WECHAT_STATUS__:")) {
          const rest = line.slice("__WECHAT_STATUS__:".length)
          const sep = rest.indexOf(":")
          const channelId = sep > 0 ? rest.slice(0, sep) : ""
          const status = sep > 0 ? rest.slice(sep + 1) : rest
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:status", status, channelId))
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
      if (daemonShouldRun) scheduleDaemonAutoRestart(code)
    })

    const lock = await waitForLockFile(15_000, daemonProcess?.pid)
    if (!lock) {
      // 启动失败：清理可能僵死的进程，避免端口/资源泄漏（earlyExit 已退出则无需 kill）
      if (earlyExit === null && daemonProcess && !daemonProcess.killed) {
        try { daemonProcess.kill("SIGKILL") } catch { /* ignore */ }
        daemonProcess = null
      }
      if (earlyExit !== null) {
        return { ok: false, error: `Daemon 进程已退出 (code=${earlyExit})。输出:\n${earlyOutput.slice(-500)}` }
      }
      return { ok: false, error: "Daemon 启动超时（未生成 lock 文件）" }
    }

    cachedPort = lock.port
    setDaemonPort(lock.port)
    activeDaemonWorkspaceDir = config.workspaceDir.trim() || null
    daemonShouldRun = true
    lastDaemonStartAt = Date.now()
    startStatusPolling()
    await injectWorkspaceMcpAndRules()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `启动失败: ${msg}` }
  } finally {
    daemonStarting = false
  }
}

export async function stopDaemon(): Promise<void> {
  daemonShouldRun = false
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  stopStatusPolling()
  await stopAgent()
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

function waitForLockFile(timeoutMs: number, expectedPid?: number): Promise<{ port: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      const lock = readLockFile()
      if (lock?.port && (!expectedPid || lock.pid === expectedPid)) {
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
      if (getEnabledChannels().some((c) => c.type === "feishu")) {
        const uncachedGroups = sessions
          .filter((s) => {
            if (s.chatType !== "group") return false
            const chatId = s.sessionKey.includes("::") ? s.sessionKey.split("::")[0] : s.sessionKey
            return !chatNameCache.has(chatId)
          })
          .map((s) => s.sessionKey.includes("::") ? s.sessionKey.split("::")[0] : s.sessionKey)
        if (uncachedGroups.length > 0) await fetchChatNames(uncachedGroups)

        // open_id 按签发应用分组查询（open_id 是应用维度的，跨应用查询必然失败）
        const uncachedP2p = sessions
          .filter((s) => s.chatType === "p2p" && s.senderOpenId?.startsWith("ou_") && !chatNameCache.has(s.senderOpenId))
        const byChannel = new Map<string | undefined, string[]>()
        for (const s of uncachedP2p) {
          const cid = channelIdFromSessionKey(s.sessionKey)
          const list = byChannel.get(cid) ?? []
          list.push(s.senderOpenId!)
          byChannel.set(cid, list)
        }
        for (const [cid, ids] of byChannel) await fetchUserNames(ids, cid)
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

function resolveCommandSessionKey(chatId?: string, chatType?: string): string | undefined {
  if (!chatId) return undefined
  if (chatType === "p2p" && isMainUser(chatId, chatType)) {
    const channel = getChannel(parseChatKey(chatId).channelId)
    const wsDir = effectiveWorkspaceDir(channel)
    if (wsDir) return `${chatId}::${wsDir}`
  }
  return chatId
}

function resolveResetWorkspaceDir(sessionKey?: string, chatId?: string, chatType?: string): string | undefined {
  if (!sessionKey) return undefined
  if (chatType === "p2p" && isMainUser(chatId, chatType)) {
    const channel = getChannel(parseChatKey(chatId!).channelId)
    return effectiveWorkspaceDir(channel)
  }
  return path.join(app.getPath("userData"), "workspaces", sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_"))
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
    const reply = (ok: boolean, msg: string, buttons?: { label: string; cmd: string }[]) => reportCommandResult(lock.port, claimed!.messageId, ok, msg, claimed!.chatId, buttons)
    const denyNonAdmin = () => reply(false, "🔒 该指令仅管理员可用")

    broadcastLog(`[指令] 执行 ${rawCmd} (msgId=${claimed.messageId} admin=${isAdmin})`)
    try {
      switch (head) {
        case "/stop": {
          if (isAdmin) {
            const wasRunning = isAgentRunning()
            await stopAgent()
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
            `📭 队列消息: 排队 ${status.queueCounts?.pending ?? 0} · 处理中 ${status.queueCounts?.processing ?? 0}`,
            `⏰ 定时任务: 开启 ${schedEnabled} / 共 ${schedTotal} 条`,
          ].filter(Boolean)
          await reply(true, lines.join("\n"))
          break
        }

        case "/list": {
          const msgs = await getQueueMessages()
          const filtered = isAdmin ? msgs : msgs.filter((m) =>
            m.sessionKey === claimed!.chatId || m.sessionKey?.startsWith(claimed!.chatId + "::"))
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
          await handleFeishuTaskCommand(
            lock.port, claimed.messageId, rawCmd,
            (task, content) => launchIndependentAgent(task.id, task.name, content, "task", undefined, task.channelId, task.model, task.modelParams),
            claimed.chatId,
            async (content, preferredChatId) => enqueueToMainSession(lock.port, content, preferredChatId ?? claimed.chatId),
          )
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

        case "/workflow":
        case "/wf": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuWorkflowCommand(lock.port, claimed.messageId, rawCmd, claimed.chatId)
          break
        }

        case "/restart": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await stopAgent()
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
          const sessionKey = resolveCommandSessionKey(claimed.chatId, claimed.chatType)
          if (sessionKey && isSessionAgentRunning(sessionKey)) {
            stopSessionAgent(sessionKey)
          }
          // SDK 上下文重置：丢弃 resume 映射，下条消息全新会话
          if (sessionKey) resetSdkSessionContext(sessionKey)
          const wsDir = resolveResetWorkspaceDir(sessionKey, claimed.chatId, claimed.chatType)
          const cmdChannelId = claimed.chatId ? parseChatKey(claimed.chatId).channelId : undefined
          if (wsDir && cmdChannelId) setMainChatIdForScope(mainChatScopeKey(cmdChannelId, wsDir), "")
          broadcastLog(`[指令 /reset] 已重置会话 ${sessionKey ?? claimed.chatId ?? "unknown"}`, "INFO")
          await reply(true, "✅ 当前会话已重置, 请重新发消息开启新会话")
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
                await reply(true, `✅ 工作目录已切换到: ${newDir} 会话上下文已切换`)
              } else {
                broadcastLog(`[指令 /workspace] 切换失败: ${wsResult.error}`, "ERROR")
                await reply(false, `❌ 切换失败: ${wsResult.error}`)
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

        case "/h":
        case "/help": {
          // 全指令按钮化：label ≤8 字符时卡片按 3 列紧凑排布，正文只留一行说明
          const common = [
            { label: "📊 状态", cmd: "/status" },
            { label: "⏹ 停止", cmd: "/stop" },
            { label: "🔄 重置", cmd: "/reset" },
          ]
          const adminOnly = [
            { label: "💬 会话", cmd: "/chat ls" },
            { label: "🧠 模型", cmd: "/model ls" },
            { label: "⏰ 任务", cmd: "/task ls" },
            { label: "🔀 工作流", cmd: "/workflow ls" },
            { label: "📦 MCP", cmd: "/mcp ls" },
            { label: "📁 目录", cmd: "/workspace" },
            { label: "📋 队列", cmd: "/list" },
            { label: "🧹 清队列", cmd: "/clean" },
            { label: "♻️ 重启", cmd: "/restart" },
          ]
          // 常用工作目录快捷切换（末段重名时附父目录区分）
          const favDirs = isAdmin ? (getConfig().favoriteWorkspaces ?? []) : []
          const lastSeg = (d: string) => d.split(/[\\/]/).filter(Boolean).pop() ?? d
          const wsBtns = favDirs.map((d) => {
            const parts = d.split(/[\\/]/).filter(Boolean)
            const name = parts.pop() ?? d
            const dup = favDirs.some((o) => o !== d && lastSeg(o) === name)
            const parent = parts.pop()
            return { label: `📂 ${dup && parent ? `${name}·${parent}` : name}`, cmd: `/workspace set ${d}` }
          })
          const helpBtns = isAdmin ? [...common, ...adminOnly, ...wsBtns] : common
          const body = isAdmin
            ? "💡 点按钮执行，或输入指令（子命令用文字，如 /chat new <描述>、/model set <序号>）；📂 按钮一键切换工作目录"
            : "💡 点按钮执行，或直接输入指令"
          await reply(true, body, helpBtns)
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
export async function applyWorkspaceSwitch(workspaceDir: string, stopOldSessions: boolean, skipDaemonSync = false): Promise<{ ok: boolean; error?: string }> {
  const w = workspaceDir.trim()
  if (!w) return { ok: false, error: "工作目录为空" }

  if (stopOldSessions) {
    stopAllSessionAgents()
  }

  saveConfig({ workspaceDir: w })
  invalidateMcpEnabledCache()
  clearInjectionCache()

  if (!skipDaemonSync) {
    const lock = readLockFile()
    if (lock?.port) {
      try {
        await httpPost(`http://127.0.0.1:${lock.port}/api/workspace`, { dir: w })
      } catch (e: unknown) {
        broadcastLog(`[Workspace] Daemon WORKSPACE_DIR 同步失败: ${e instanceof Error ? e.message : e}`, "WARN")
      }
    }
  }

  // Daemon 侧目录已随切换更新，同步内存记录，否则状态检查会误报"目录与设置不一致"
  if (activeDaemonWorkspaceDir !== null) activeDaemonWorkspaceDir = w

  await injectWorkspaceMcpAndRules()
  broadcastStatus(await getDaemonStatus())
  return { ok: true }
}

/**
 * 保存配置；若工作目录变更且旧目录有活跃会话，返回会话列表供渲染进程展示确认弹窗。
 */
/** 通道中影响 Daemon 连接的字段子集（变更后才需要重启 Daemon）；配置类字段走热更新，不入此名单 */
function daemonRelevantChannelView(channels: MessageChannel[]): string {
  return JSON.stringify(channels.map((c) => ({
    id: c.id, type: c.type, enabled: c.enabled,
    appId: c.larkAppId, appSecret: c.larkAppSecret,
    token: c.wechatToken, account: c.wechatAccountId,
    ws: c.workspaceDir,
  })))
}

/** 运行时可热更新的通道配置（保存后直推 daemon 内存，不重启、不打断会话） */
function channelRuntimeFlags(channels: MessageChannel[]) {
  return channels.filter(channelReady).map((c) => ({
    id: c.id,
    keepAlive: (c.keepSession ?? true) && (c.persistentPoll ?? true),
    name: c.name,
    mainUserEnabled: !!c.mainUserEnabled,
    mainUserChatId: c.mainUserEnabled ? (c.mainUserChatId?.trim() ?? "") : "",
  }))
}

async function pushChannelFlagsToDaemon(channels: MessageChannel[]): Promise<void> {
  const port = cachedPort ?? readLockFile()?.port
  if (!port) return
  try {
    await httpPost(`http://127.0.0.1:${port}/api/channel-flags`, { channels: channelRuntimeFlags(channels) }, 5000)
    broadcastLog("[Channels] 保活开关已热更新至 Daemon（无需重启）")
  } catch (e: unknown) {
    broadcastLog(`[Channels] 保活开关热更新失败: ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}

export async function saveAppConfigFromRenderer(partial: Partial<AppConfig>): Promise<ConfigSaveResult> {
  const current = getConfig()
  const oldW = (current.workspaceDir || "").trim()
  const nextW = partial.workspaceDir !== undefined ? partial.workspaceDir.trim() : oldW
  const workspaceChanging = partial.workspaceDir !== undefined && nextW !== oldW && oldW !== ""
  const channelsChanging = partial.channels !== undefined
    && daemonRelevantChannelView(partial.channels) !== daemonRelevantChannelView(current.channels ?? [])

  if (workspaceChanging) {
    const st = await getDaemonStatus()
    const sessions = st.running ? getSessionAgentList() : []
    // 仅当存在活跃会话时才需要用户确认；无会话直接静默切换
    if (st.running && sessions.length > 0) {
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
    if (st.running) {
      const rest: Partial<AppConfig> = { ...partial }
      delete (rest as Record<string, unknown>).workspaceDir
      saveConfig(rest)
      const r = await applyWorkspaceSwitch(nextW, false)
      if (!r.ok) {
        broadcastLog(`[Workspace] 切换失败: ${r.error}`, "ERROR")
        return { ok: false }
      }
      return { ok: true, workspaceDirChanged: true }
    }
  }

  const workspaceDirChanged = partial.workspaceDir !== undefined && nextW !== oldW
  if (workspaceDirChanged) {
    invalidateMcpEnabledCache()
  }

  saveConfig(partial)

  if (channelsChanging) {
    // 连接类字段（凭据/启停/工作目录）变化：必须重启 Daemon 重建连接
    const st = await getDaemonStatus()
    if (st.running) {
      broadcastLog("[Channels] 通道连接配置已变更，正在重启 Daemon...")
      void (async () => {
        await stopDaemon()
        await new Promise((r) => setTimeout(r, 800))
        const result = await startDaemon()
        if (!result.ok) broadcastLog(`[Channels] Daemon 重启失败: ${result.error}`, "ERROR")
        broadcastStatus(await getDaemonStatus())
      })()
    }
  } else if (partial.channels !== undefined) {
    // 仅运行时配置（保活开关等）变化：热推送到 Daemon，不重启、不打断会话
    void pushChannelFlagsToDaemon(partial.channels)
  }

  return { ok: true, ...(workspaceDirChanged ? { workspaceDirChanged: true } : {}) }
}

// ── 初始化 ───────────────────────────────────────────────

/** 旧单通道配置 → channels 模型一次性迁移（应用启动时执行） */
export function runLegacyConfigMigration(): void {
  if (getConfig().channelsMigrated) return
  const wechatBase = path.join(app.getPath("userData"), "wechat-data")
  migrateLegacyConfig({
    readWechatLastChatId: () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(wechatBase, "state.json"), "utf-8"))?.lastChatId ?? ""
      } catch { return "" }
    },
    moveWechatDataDir: (channelId: string) => {
      try {
        if (!fs.existsSync(wechatBase)) return
        const dest = path.join(wechatBase, channelId)
        if (fs.existsSync(dest)) return
        fs.mkdirSync(dest, { recursive: true })
        for (const f of fs.readdirSync(wechatBase, { withFileTypes: true })) {
          if (f.isFile()) fs.renameSync(path.join(wechatBase, f.name), path.join(dest, f.name))
        }
        broadcastLog(`[Migrate] 微信数据目录已迁移到 wechat-data/${channelId}`)
      } catch { /* ignore */ }
    },
    patchScheduledTasks: (patch) => {
      const tasks = readTasksFromFile()
      if (tasks.length > 0) writeTasksToFile(tasks.map(patch))
    },
  })
}

/** 应用启动后自动拉起 Daemon（配置就绪时免手动点击）；已在运行则仅接管状态轮询与自愈 */
async function autoStartDaemonOnLaunch(): Promise<void> {
  const status = await getDaemonStatus()
  if (status.running) {
    daemonShouldRun = true
    lastDaemonStartAt = Date.now()
    startStatusPolling()
    return
  }
  const config = getConfig()
  if (!config.setupComplete || !config.workspaceDir?.trim() || buildDaemonChannelConfigs().length === 0) {
    return
  }
  broadcastLog("[Daemon] 应用启动，自动拉起 Daemon…")
  const r = await startDaemon()
  if (!r.ok) broadcastLog(`[Daemon] 自动启动失败: ${r.error}`, "WARN")
  broadcastStatus(await getDaemonStatus())
}

export function initDaemonManager(): void {
  process.env.APP_DATA_DIR = app.getPath("userData")
  runLegacyConfigMigration()
  seedBuiltins()
  initSessionDispatcher()
  ipcMain.handle("config:apply-workspace-switch", (_, workspaceDir: string, stopOldSessions: boolean) => applyWorkspaceSwitch(workspaceDir, stopOldSessions))
  ipcMain.handle("daemon:get-log-buffer", () => getLogBuffer())
  ipcMain.handle("agent:stop", async () => { await stopAgent(); return { ok: true } })
  ipcMain.handle("agent:sessions", () => getSessionAgentList())
  ipcMain.handle("diagnostics:session", async (_e, sessionKey: string) => {
    const diag = getSdkSessionDiagnostics(sessionKey)
    let lastReplyAt: number | null = null
    const lock = readLockFile()
    if (lock?.port) {
      try {
        const r = (await httpGet(`http://127.0.0.1:${lock.port}/api/session-last-reply?sessionKey=${encodeURIComponent(sessionKey)}`)) as { lastReplyAt?: number | null }
        lastReplyAt = r?.lastReplyAt ?? null
      } catch { /* daemon 未运行 */ }
    }
    return { ...diag, lastReplyAt }
  })
  ipcMain.handle("diagnostics:export", () => exportDiagnostics())
  ipcMain.handle("bind:test", async (_e, channelId?: string) => {
    // Setup 向导（通道尚未创建）：用旧字段直接测试飞书
    if (!channelId) {
      const cfg = getConfig()
      const chatId = cfg.larkReceiveId?.trim()
      if (!chatId) return { ok: false, error: "未绑定主用户" }
      try {
        await larkSendTestMessage({ larkAppId: cfg.larkAppId, larkAppSecret: cfg.larkAppSecret } as MessageChannel, chatId)
        return { ok: true }
      } catch (e: any) {
        return { ok: false, error: e?.message ?? "发送失败" }
      }
    }
    const channel = getChannel(channelId)
    if (!channel) return { ok: false, error: "通道不存在" }
    try {
      // 优先走运行中的 Daemon（统一处理飞书/微信，含 lastP2pChatId 兜底）
      const lock = readLockFile()
      if (lock?.port) {
        const st = await getDaemonStatus()
        if (st.running && st.channels?.some((c) => c.id === channelId)) {
          const res = await httpPost(`http://127.0.0.1:${lock.port}/channel-test`, { channelId }, 10_000) as { ok?: boolean; error?: string }
          return res?.ok ? { ok: true } : { ok: false, error: res?.error ?? "发送失败" }
        }
      }
      if (channel.type === "feishu") {
        const chatId = channel.mainUserChatId?.trim()
        if (!chatId) return { ok: false, error: "未绑定主用户" }
        await larkSendTestMessage(channel, chatId)
        return { ok: true }
      }
      await wechatSendTestMessage(channel)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "发送失败" }
    }
  })

  ipcMain.handle("bind:test-wechat", async () => {
    // Setup 向导（通道尚未创建）：旧字段 + 旧数据目录测试微信
    const cfg = getConfig()
    const wechatChannel = getChannels().find((c) => c.type === "wechat")
    try {
      if (wechatChannel?.wechatToken?.trim()) {
        await wechatSendTestMessage(wechatChannel)
      } else {
        await wechatSendTestMessageRaw(cfg.wechatToken, path.join(app.getPath("userData"), "wechat-data"))
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "发送失败" }
    }
  })

  // ── 通道主用户绑定（Daemon armed-bind 优先，临时连接兜底）──
  ipcMain.handle("channel:bind-start", async (_e, channelId: string) => {
    const channel = getChannel(channelId)
    if (!channel) return { ok: false, error: "通道不存在" }

    const st = await getDaemonStatus()
    const lock = readLockFile()
    const viaDaemon = st.running && lock?.port && st.channels?.some((c) => c.id === channelId && c.connected)

    if (viaDaemon) {
      try {
        await httpPost(`http://127.0.0.1:${lock!.port}/channel-bind`, { channelId, arm: true })
      } catch (e: any) {
        return { ok: false, error: e?.message ?? "绑定请求失败" }
      }
      return await new Promise<{ ok: boolean; chatId?: string; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          bindWaiter = null
          httpPost(`http://127.0.0.1:${lock!.port}/channel-bind`, { channelId, arm: false }).catch(() => {})
          resolve({ ok: false, error: "绑定超时（90秒内未收到私聊消息）" })
        }, 90_000)
        bindWaiter = { channelId, resolve: (chatId) => { clearTimeout(timeout); resolve({ ok: true, chatId }) } }
      })
    }

    // Daemon 未运行该通道：临时连接兜底
    if (channel.type === "feishu") {
      if (!channel.larkAppId?.trim() || !channel.larkAppSecret?.trim()) {
        return { ok: false, error: "请先填写飞书 App ID 和 App Secret" }
      }
      try {
        const result = await startTempConnection(channel.larkAppId.trim(), channel.larkAppSecret.trim())
        if (result.chatId) {
          updateChannel(channelId, { mainUserEnabled: true, mainUserChatId: result.chatId })
          return { ok: true, chatId: result.chatId }
        }
        return { ok: false, error: "未收到绑定结果" }
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) }
      }
    }

    // wechat：临时管理器等待首条消息（使用通道专属数据目录）
    if (!channel.wechatToken?.trim()) return { ok: false, error: "请先扫码获取微信 Token" }
    const r = await wechatWaitFirstMessageImpl(channel.wechatToken.trim(), channel.wechatAccountId?.trim() ?? "", channelId)
    if (r.ok && r.chatId) {
      updateChannel(channelId, { mainUserEnabled: true, mainUserChatId: r.chatId })
    }
    return r
  })

  ipcMain.handle("channel:bind-cancel", async (_e, channelId: string) => {
    bindWaiter = null
    stopTempConnection()
    if (wechatTempMgr) { try { await wechatTempMgr.stop() } catch { /* ignore */ } wechatTempMgr = null }
    const lock = readLockFile()
    if (lock?.port) {
      httpPost(`http://127.0.0.1:${lock.port}/channel-bind`, { channelId, arm: false }).catch(() => {})
    }
    return { ok: true }
  })

  ipcMain.handle("channel:unbind", (_e, channelId: string) => {
    updateChannel(channelId, { mainUserEnabled: false, mainUserChatId: "" })
    void pushChannelFlagsToDaemon(getChannels())
    return { ok: true }
  })

  ipcMain.handle("feishu:app-info", (_e, appId: string, appSecret: string) =>
    fetchLarkBotInfo(appId?.trim() ?? "", appSecret?.trim() ?? ""))
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
    const signal = wechatQrAbort.signal
    try {
      const { WeChatClient } = await import("../src/wechat/index.js")
      const QRCode = await import("qrcode")
      const tmpClient = new WeChatClient()
      const result = await tmpClient.login({
        signal,
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
      if (signal.aborted) return { ok: false, error: "cancelled" }
      return { ok: false, error: result.message }
    } catch (err: any) {
      wechatQrAbort = null
      if (err?.name === "AbortError" || signal.aborted) return { ok: false, error: "cancelled" }
      return { ok: false, error: err?.message ?? String(err) }
    }
  })

  ipcMain.handle("wechat:qr-login-cancel", () => {
    if (wechatQrAbort) { wechatQrAbort.abort(); wechatQrAbort = null }
    return { ok: true }
  })

  // ── Feishu one-click app registration (OAuth Device Flow) ──
  let feishuRegisterAbort: AbortController | null = null

  ipcMain.handle("feishu:register-app", async (_e, preset?: { name?: string; desc?: string }) => {
    if (feishuRegisterAbort) feishuRegisterAbort.abort()
    feishuRegisterAbort = new AbortController()
    const signal = feishuRegisterAbort.signal
    try {
      const QRCode = await import("qrcode")
      const result = await registerFeishuApp({
        name: preset?.name?.trim() || "Cursor Claw",
        desc: preset?.desc?.trim() || "Cursor AI 协作助手",
        signal,
        onQrCodeUrl(url) {
          QRCode.toDataURL(url, { width: 280, margin: 2 })
            .then((dataUrl) => {
              BrowserWindow.getAllWindows().forEach((w) =>
                w.webContents.send("feishu:setup-qrcode", dataUrl),
              )
            })
            .catch(() => {})
        },
        onStatus(status) {
          BrowserWindow.getAllWindows().forEach((w) =>
            w.webContents.send("feishu:setup-status", status),
          )
        },
      })
      feishuRegisterAbort = null
      return { ok: true, appId: result.appId, appSecret: result.appSecret }
    } catch (err: unknown) {
      feishuRegisterAbort = null
      if (signal.aborted) return { ok: false, error: "cancelled" }
      const e = err as { message?: string }
      return { ok: false, error: e?.message ?? String(err) }
    }
  })

  ipcMain.handle("feishu:register-app-cancel", () => {
    if (feishuRegisterAbort) {
      feishuRegisterAbort.abort()
      feishuRegisterAbort = null
    }
    return { ok: true }
  })

  // ── Wait for first WeChat message (runs in main process, no daemon) ──

  ipcMain.handle("wechat:wait-first-message", (_e, token: string, accountId: string, channelId?: string) =>
    wechatWaitFirstMessageImpl(token, accountId, channelId))

  ipcMain.handle("wechat:cancel-wait-message", async () => {
    if (wechatTempMgr) { try { await wechatTempMgr.stop() } catch {} wechatTempMgr = null }
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
      return launchIndependentAgent(task.id, task.name, content, "task", undefined, task.channelId, task.model, task.modelParams)
    }
    const lock = readLockFile()
    if (!lock?.port) return { ok: false, error: "守护进程未运行" }
    const result = await enqueueToMainSession(lock.port, content, undefined, task.channelId)
    return result
  })

  ipcMain.handle("scheduled-tasks:get-status", () => getIndependentTaskStatuses())

  // ── Workflow CRUD ─────────────────────────────────────
  ipcMain.handle("workflow:list-definitions", () => listDefinitions())
  ipcMain.handle("workflow:save-definition", (_, def) => { saveDefinition(def); return { ok: true } })
  ipcMain.handle("workflow:delete-definition", (_, id: string) => ({ ok: deleteDefinition(id) }))
  ipcMain.handle("workflow:list-instances", () => listInstances())
  ipcMain.handle("workflow:get-instance", (_, id: string) => getInstance(id))
  ipcMain.handle("workflow:save-instance", (_, inst) => { saveInstance(inst); return { ok: true } })
  ipcMain.handle("workflow:delete-instance", (_, id: string) => ({ ok: deleteInstance(id) }))

  ipcMain.handle("workflow:run", async (_, workflowId: string, input?: string) => {
    if (!workflowId?.trim()) return { ok: false, error: "工作流 ID 不能为空" }
    return runWorkflowDefinition(workflowId.trim(), { input: input?.trim() || undefined })
  })

  void autoStartDaemonOnLaunch()
}

// ── 诊断包导出 ───────────────────────────────────────────

function maskSecret(v?: string): string {
  return v ? `${v.slice(0, 4)}***(len=${v.length})` : ""
}

function tailOfFile(p: string, lines = 400): string {
  try {
    return fs.readFileSync(p, "utf-8").split(/\r?\n/).slice(-lines).join("\n")
  } catch {
    return "(不存在或读取失败)"
  }
}

/** 汇总日志、脱敏配置、会话/队列快照到单个文本文件，供远程排障（凭据不落盘） */
async function exportDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const dir = path.join(app.getPath("userData"), "diagnostics")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const file = path.join(dir, `diagnostics-${stamp}.txt`)

    const config = getConfig()
    const sanitized = {
      ...config,
      larkAppSecret: maskSecret(config.larkAppSecret),
      wechatToken: maskSecret(config.wechatToken),
      cursorApiKey: maskSecret(config.cursorApiKey),
      agentResources: (config.agentResources ?? []).map((r) => ({ ...r, apiKey: maskSecret(r.apiKey) })),
      channels: (config.channels ?? []).map((c) => ({ ...c, larkAppSecret: maskSecret(c.larkAppSecret), wechatToken: maskSecret(c.wechatToken) })),
    }

    const lock = readLockFile()
    let daemonHealth: unknown = null
    let queueSnapshot: unknown = null
    if (lock?.port) {
      daemonHealth = await httpGet(`http://127.0.0.1:${lock.port}/health`).catch(() => null)
      queueSnapshot = await httpGet(`http://127.0.0.1:${lock.port}/queue`).catch(() => null)
    }

    const logsDir = path.join(app.getPath("userData"), "logs")
    const sections = [
      "# Cursor Claw 诊断包",
      `生成时间: ${now.toISOString()}`,
      `应用版本: ${app.getVersion()}  平台: ${process.platform} ${os.release()}  Electron: ${process.versions.electron}`,
      "",
      "## 配置（凭据已脱敏）",
      JSON.stringify(sanitized, null, 2),
      "",
      "## Daemon 状态",
      JSON.stringify(daemonHealth, null, 2),
      "",
      "## 活跃会话",
      JSON.stringify(getSessionAgentList(), null, 2),
      "",
      "## Resume 映射",
      JSON.stringify(getResumableSummary(), null, 2),
      "",
      "## 消息队列快照",
      JSON.stringify(queueSnapshot, null, 2),
      "",
      "## app.log（尾部 400 行）",
      tailOfFile(path.join(logsDir, "app.log")),
      "",
      "## daemon.log（尾部 400 行）",
      tailOfFile(path.join(logsDir, "daemon.log")),
      "",
    ]
    fs.writeFileSync(file, sections.join("\n"), "utf-8")
    shell.showItemInFolder(file)
    return { ok: true, path: file }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 应用退出前的收尾：等 SDK run 取消落库后再放行退出。
 * fire-and-forget 的 kill 会让活跃 run 永远停在 active 状态（wedged），下次启动只能靠 force 自愈。
 */
export async function shutdownDaemonManager(): Promise<void> {
  daemonShouldRun = false
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  stopStatusPolling()
  _stopCliAgent()
  await stopAllSdkSessions()
  if (daemonProcess) {
    try { daemonProcess.kill() } catch { /* ignore */ }
    daemonProcess = null
  }
  cachedPort = null
  setDaemonPort(null)
  activeDaemonWorkspaceDir = null
}
