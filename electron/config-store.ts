import Store from "electron-store"

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
  independent?: boolean
}

export interface AppConfig {
  larkAppId: string
  larkAppSecret: string
  larkReceiveId: string
  workspaceDir: string
  model: string
  /** SDK 模型变体参数 (如 max mode), JSON 序列化的 {id,value}[] */
  modelParams: string
  autoStart: boolean
  setupComplete: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
  agentNewSession: boolean
  /** 点关闭主窗口时：ask=弹窗选择；minimize=隐藏到托盘；quit=直接退出应用 */
  closeWindowAction: "ask" | "minimize" | "quit"
  scheduledTasks: ScheduledTask[]
  verifiedMcpServers: string[]
  /** 主会话 chatId 映射（workspaceDir → chatId），用于 --resume 恢复上下文 */
  mainChatIds: Record<string, string>
  enableGroupChat: boolean
  digitalIdentity: string
  feishuEnabled: boolean
  wechatEnabled: boolean
  wechatToken: string
  wechatAccountId: string
  /** Agent 驱动模式: cli = Cursor CLI (默认), sdk = @cursor/sdk */
  agentMode: "cli" | "sdk"
  cursorApiKey: string
}

const defaults: AppConfig = {
  larkAppId: "",
  larkAppSecret: "",
  larkReceiveId: "",
  workspaceDir: "",
  model: "auto",
  modelParams: "",
  autoStart: false,
  setupComplete: false,
  httpProxy: "",
  httpsProxy: "",
  noProxy: "localhost,127.0.0.1,feishu.cn",
  agentNewSession: false,
  closeWindowAction: "ask",
  scheduledTasks: [],
  verifiedMcpServers: [],
  mainChatIds: {},
  enableGroupChat: false,
  digitalIdentity: "",
  feishuEnabled: false,
  wechatEnabled: false,
  wechatToken: "",
  wechatAccountId: "",
  agentMode: "cli",
  cursorApiKey: "",
}

let _store: Store<AppConfig> | null = null

function getStore(): Store<AppConfig> {
  if (!_store) {
    _store = new Store<AppConfig>({
      name: "cursor-claw-config",
      encryptionKey: "cursor-claw-desktop-v1",
      defaults,
    })
  }
  return _store
}

export function getConfig(): AppConfig {
  return { ...defaults, ...getStore().store }
}

export function saveConfig(partial: Partial<AppConfig>): void {
  const cleaned = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  )
  if (Object.keys(cleaned).length > 0) {
    getStore().set(cleaned as Partial<AppConfig>)
  }
}

