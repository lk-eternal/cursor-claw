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
  allowOthers: boolean
  digitalIdentity: string
  feishuEnabled: boolean
  wechatEnabled: boolean
  wechatToken: string
  wechatAccountId: string
  /** Agent 驱动模式: cli = Cursor CLI (默认), sdk = @cursor/sdk */
  agentMode: "cli" | "sdk"
  cursorApiKey: string
  /** 其他用户 & 群聊使用的模型（留空则跟随主模型） */
  othersModel: string
  othersModelParams: string
  /** 定时任务 / 独立任务使用的模型（留空则跟随主模型） */
  taskModel: string
  taskModelParams: string
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
  allowOthers: false,
  digitalIdentity: "",
  feishuEnabled: false,
  wechatEnabled: false,
  wechatToken: "",
  wechatAccountId: "",
  agentMode: "cli",
  cursorApiKey: "",
  othersModel: "",
  othersModelParams: "",
  taskModel: "",
  taskModelParams: "",
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

export function useSdkMode(): boolean {
  return getConfig().agentMode === "sdk"
}

export type ModelScenario = "primary" | "others" | "task"

export function resolveModel(scenario: ModelScenario): { model: string; modelParams: string } {
  const c = getConfig()
  if (scenario === "others" && c.othersModel?.trim()) {
    return { model: c.othersModel, modelParams: c.othersModelParams ?? "" }
  }
  if (scenario === "task" && c.taskModel?.trim()) {
    return { model: c.taskModel, modelParams: c.taskModelParams ?? "" }
  }
  return { model: c.model, modelParams: c.modelParams ?? "" }
}

export function saveConfig(partial: Partial<AppConfig>): void {
  const cleaned = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  )
  if (Object.keys(cleaned).length > 0) {
    getStore().set(cleaned as Partial<AppConfig>)
  }
}

