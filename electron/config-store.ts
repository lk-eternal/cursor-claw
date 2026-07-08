import Store from "electron-store"
import { randomBytes } from "node:crypto"
import type { AgentResource, MessageChannel } from "../src/shared/channel-types"
import { channelIdFromSessionKey } from "../src/shared/channel-types"
import type { ScheduledTask } from "../src/shared/scheduled-task"

export type { AgentResource, MessageChannel, ScheduledTask }

export interface AppConfig {
  // ── 新模型：Agent 资源池 + 消息通道 ──
  agentResources: AgentResource[]
  channels: MessageChannel[]
  /** 旧配置 → 通道模型 一次性迁移标记 */
  channelsMigrated: boolean

  // ── 全局配置 ──
  workspaceDir: string
  autoStart: boolean
  setupComplete: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
  /** 点关闭主窗口时：ask=弹窗选择；minimize=隐藏到托盘；quit=直接退出应用 */
  closeWindowAction: "ask" | "minimize" | "quit"
  /** 主会话 chatId 映射（`channelId:workspaceDir` → chatId），用于 --resume 恢复上下文 */
  mainChatIds: Record<string, string>
  /** Daemon 固定端口（0 = 随机） */
  daemonPort: number

  // ── 旧字段（仅用于迁移，新代码不应再读取）──
  allowOthers: boolean
  digitalIdentity: string
  larkAppId: string
  larkAppSecret: string
  larkAppQuickCreated: boolean
  larkReceiveId: string
  model: string
  modelParams: string
  agentNewSession: boolean
  feishuEnabled: boolean
  wechatEnabled: boolean
  wechatToken: string
  wechatAccountId: string
  agentMode: "cli" | "sdk"
  cursorApiKey: string
  othersModel: string
  othersModelParams: string
  taskModel: string
  taskModelParams: string
}

const defaults: AppConfig = {
  agentResources: [],
  channels: [],
  channelsMigrated: false,

  workspaceDir: "",
  autoStart: false,
  setupComplete: false,
  httpProxy: "",
  httpsProxy: "",
  noProxy: "localhost,127.0.0.1,feishu.cn",
  closeWindowAction: "ask",
  mainChatIds: {},
  daemonPort: 19528,

  allowOthers: false,
  digitalIdentity: "",
  larkAppId: "",
  larkAppSecret: "",
  larkAppQuickCreated: false,
  larkReceiveId: "",
  model: "auto",
  modelParams: "",
  agentNewSession: false,
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

export function saveConfig(partial: Partial<AppConfig>): void {
  const cleaned = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  )
  if (Object.keys(cleaned).length > 0) {
    // electron-store 的 set(object) 重载要求完整 AppConfig，实际支持部分键合并
    getStore().set(cleaned as unknown as AppConfig)
  }
}

// ── 通道 / 资源 工具 ──────────────────────────────────────

export const CLI_RESOURCE_ID = "cli"

export function newChannelId(): string {
  return `ch_${randomBytes(4).toString("hex")}`
}

export function newSdkResourceId(): string {
  return `sdk_${randomBytes(4).toString("hex")}`
}

export function getChannels(): MessageChannel[] {
  const cfg = getConfig()
  // 旧版本迁移出的通道可能缺少通道级字段，用旧全局值兜底
  return (cfg.channels ?? []).map((c) => ({
    ...c,
    allowOthers: c.allowOthers ?? cfg.allowOthers ?? false,
    digitalIdentity: c.digitalIdentity ?? cfg.digitalIdentity ?? "",
  }))
}

export function getEnabledChannels(): MessageChannel[] {
  return getChannels().filter((c) => c.enabled)
}

export function getChannel(id?: string): MessageChannel | undefined {
  if (!id) return undefined
  return getChannels().find((c) => c.id === id)
}

/** 解析会话所属通道；解析不到时回退到第一个启用通道 */
export function resolveChannelForSession(sessionKey: string): MessageChannel | undefined {
  const id = channelIdFromSessionKey(sessionKey)
  return getChannel(id) ?? getEnabledChannels()[0]
}

export function getAgentResources(): AgentResource[] {
  const list = getConfig().agentResources ?? []
  if (!list.some((r) => r.id === CLI_RESOURCE_ID)) {
    return [{ id: CLI_RESOURCE_ID, type: "cli", name: "Cursor CLI" }, ...list]
  }
  return list
}

export function getAgentResource(id?: string): AgentResource {
  const cli: AgentResource = { id: CLI_RESOURCE_ID, type: "cli", name: "Cursor CLI" }
  if (!id) return cli
  return getAgentResources().find((r) => r.id === id) ?? cli
}

export function saveChannel(channel: MessageChannel): void {
  const channels = getChannels()
  const idx = channels.findIndex((c) => c.id === channel.id)
  if (idx >= 0) channels[idx] = channel
  else channels.push(channel)
  saveConfig({ channels })
}

export function updateChannel(id: string, partial: Partial<MessageChannel>): MessageChannel | undefined {
  const channels = getChannels()
  const idx = channels.findIndex((c) => c.id === id)
  if (idx < 0) return undefined
  channels[idx] = { ...channels[idx], ...partial }
  saveConfig({ channels })
  return channels[idx]
}

export type ModelScenario = "primary" | "others"

/** 解析通道在某场景下的模型（others 留空则跟随主模型） */
export function resolveChannelModel(channel: MessageChannel | undefined, scenario: ModelScenario): { model: string; modelParams: string } {
  if (!channel) return { model: "", modelParams: "" }
  if (scenario === "others" && channel.othersModel?.trim()) {
    return { model: channel.othersModel, modelParams: channel.othersModelParams ?? "" }
  }
  return { model: channel.model ?? "", modelParams: channel.modelParams ?? "" }
}

/** 通道的有效主工作目录（通道未配置则用全局） */
export function effectiveWorkspaceDir(channel?: MessageChannel): string {
  const dir = channel?.workspaceDir?.trim()
  return dir || getConfig().workspaceDir
}

// ── 旧配置迁移 ────────────────────────────────────────────

export interface LegacyMigrationHooks {
  /** 读取微信旧 state.json 的 lastChatId（迁移主用户绑定） */
  readWechatLastChatId?: () => string
  /** 迁移旧 wechat-data 目录到 wechat-data/<channelId> */
  moveWechatDataDir?: (channelId: string) => void
  /** 给 scheduled-tasks.json 中的任务补 channelId / model */
  patchScheduledTasks?: (patch: (t: ScheduledTask) => ScheduledTask) => void
}

/**
 * 把旧的单通道配置（larkApp* / wechat* / agentMode / 模型配置）升级为
 * agentResources + channels 模型。upsert 语义、可重入：
 * - 每种类型只迁移/更新第一个对应通道
 * - Setup 向导完成后会再次调用以同步向导写入的旧字段
 */
export function migrateLegacyConfig(hooks?: LegacyMigrationHooks): void {
  const cfg = getConfig()
  const partial: Partial<AppConfig> = {}

  // Agent 资源
  let resources = [...(cfg.agentResources ?? [])]
  if (!resources.some((r) => r.id === CLI_RESOURCE_ID)) {
    resources = [{ id: CLI_RESOURCE_ID, type: "cli", name: "Cursor CLI" }, ...resources]
  }
  let legacySdkId = resources.find((r) => r.type === "sdk" && r.apiKey === cfg.cursorApiKey?.trim())?.id
  if (cfg.cursorApiKey?.trim() && !legacySdkId) {
    legacySdkId = newSdkResourceId()
    resources.push({ id: legacySdkId, type: "sdk", name: "SDK Key", apiKey: cfg.cursorApiKey.trim() })
  }
  partial.agentResources = resources

  const agentResourceId = cfg.agentMode === "sdk" && legacySdkId ? legacySdkId : CLI_RESOURCE_ID
  const channels = [...(cfg.channels ?? [])]

  const baseModel = {
    model: cfg.model ?? "auto",
    modelParams: cfg.modelParams ?? "",
    othersModel: cfg.othersModel ?? "",
    othersModelParams: cfg.othersModelParams ?? "",
    allowOthers: cfg.allowOthers ?? false,
    digitalIdentity: cfg.digitalIdentity ?? "",
  }

  if (cfg.feishuEnabled && cfg.larkAppId?.trim() && cfg.larkAppSecret?.trim()) {
    const existing = channels.find((c) => c.type === "feishu")
    if (existing) {
      existing.larkAppId = cfg.larkAppId.trim()
      existing.larkAppSecret = cfg.larkAppSecret.trim()
      existing.larkAppQuickCreated = cfg.larkAppQuickCreated
      existing.enabled = true
      if (cfg.larkReceiveId?.trim()) {
        existing.mainUserEnabled = true
        existing.mainUserChatId = cfg.larkReceiveId.trim()
      }
    } else {
      channels.push({
        id: newChannelId(),
        name: "飞书",
        enabled: true,
        type: "feishu",
        larkAppId: cfg.larkAppId.trim(),
        larkAppSecret: cfg.larkAppSecret.trim(),
        larkAppQuickCreated: cfg.larkAppQuickCreated,
        agentResourceId,
        ...baseModel,
        mainUserEnabled: !!cfg.larkReceiveId?.trim(),
        mainUserChatId: cfg.larkReceiveId?.trim() ?? "",
        mainUserNewSession: cfg.agentNewSession ?? false,
        workspaceDir: "",
      })
    }
  }

  if (cfg.wechatEnabled && cfg.wechatToken?.trim()) {
    const existing = channels.find((c) => c.type === "wechat")
    if (existing) {
      existing.wechatToken = cfg.wechatToken.trim()
      existing.wechatAccountId = cfg.wechatAccountId?.trim() ?? ""
      existing.enabled = true
      const lastChatId = hooks?.readWechatLastChatId?.() ?? ""
      if (lastChatId && !existing.mainUserChatId) {
        existing.mainUserEnabled = true
        existing.mainUserChatId = lastChatId
      }
    } else {
      const id = newChannelId()
      const lastChatId = hooks?.readWechatLastChatId?.() ?? ""
      channels.push({
        id,
        name: "微信",
        enabled: true,
        type: "wechat",
        wechatToken: cfg.wechatToken.trim(),
        wechatAccountId: cfg.wechatAccountId?.trim() ?? "",
        agentResourceId,
        ...baseModel,
        mainUserEnabled: !!lastChatId,
        mainUserChatId: lastChatId,
        mainUserNewSession: cfg.agentNewSession ?? false,
        workspaceDir: "",
      })
      hooks?.moveWechatDataDir?.(id)
    }
  }

  partial.channels = channels

  // 定时任务补默认通道与旧任务模型
  if (!cfg.channelsMigrated && channels.length > 0) {
    const defaultChannelId = channels[0].id
    hooks?.patchScheduledTasks?.((t) => ({
      ...t,
      channelId: t.channelId || defaultChannelId,
      model: t.model ?? (cfg.taskModel?.trim() || undefined),
      modelParams: t.modelParams ?? (cfg.taskModel?.trim() ? cfg.taskModelParams : undefined),
    }))
  }

  // 旧 mainChatIds（workspaceDir → chatId）迁移为 channelId:workspaceDir 键
  if (!cfg.channelsMigrated && channels.length > 0) {
    const oldIds = cfg.mainChatIds ?? {}
    const newIds: Record<string, string> = {}
    for (const [key, chatId] of Object.entries(oldIds)) {
      if (key.startsWith("ch_") && key.includes(":")) {
        newIds[key] = chatId
      } else {
        newIds[`${channels[0].id}:${key}`] = chatId
      }
    }
    partial.mainChatIds = newIds
  }

  partial.channelsMigrated = true
  saveConfig(partial)
}

// ── 主会话 chatId（CLI resume）─────────────────────────────

export function mainChatScopeKey(channelId: string, workspaceDir: string): string {
  return `${channelId}:${workspaceDir}`
}

export function getMainChatIdForScope(scope: string): string {
  return (getConfig().mainChatIds ?? {})[scope]?.trim() || ""
}

export function setMainChatIdForScope(scope: string, chatId: string): void {
  const config = getConfig()
  const ids = { ...(config.mainChatIds ?? {}), [scope]: chatId }
  if (!chatId) delete ids[scope]
  saveConfig({ mainChatIds: ids })
}
