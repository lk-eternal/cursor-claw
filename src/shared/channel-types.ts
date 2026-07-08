// ── 多消息通道共享类型与工具 ─────────────────────────────
// Electron 主进程与 Daemon 子进程共用。

/** Agent 资源：1 个本机 CLI（id 固定 "cli"）+ N 个 SDK Key */
export interface AgentResource {
  id: string;            // "cli" | "sdk_<uuid>"
  type: "cli" | "sdk";
  name: string;
  apiKey?: string;       // 仅 SDK
  /** 校验成功后缓存的账号邮箱（仅展示用） */
  email?: string;
}

/** 消息通道：一个飞书自建应用 或 一个微信账号 */
export interface MessageChannel {
  id: string;            // "ch_<hex>"
  name: string;
  enabled: boolean;
  type: "feishu" | "wechat";
  // 飞书凭据
  larkAppId?: string;
  larkAppSecret?: string;
  larkAppQuickCreated?: boolean;
  /** 飞书机器人应用名缓存（凭据校验时解析，离线可显示） */
  larkBotName?: string;
  // 微信凭据
  wechatToken?: string;
  wechatAccountId?: string;
  // Agent 绑定
  agentResourceId: string;        // "cli" 或 sdk 资源 id
  model: string;                  // 主模型（"" / "auto" = 默认）
  modelParams: string;            // JSON 序列化的 {id,value}[]，仅 SDK
  othersModel: string;            // 其他人/群聊模型，空 = 跟随主模型
  othersModelParams: string;
  // 主用户（可选）
  mainUserEnabled: boolean;
  mainUserChatId: string;         // 原始 chatId（不含通道前缀）
  /** 主用户私聊每次新建会话（原全局 agentNewSession） */
  mainUserNewSession: boolean;
  // 其他人使用（通道级）
  allowOthers: boolean;
  /** 对外身份规则，注入到其他人会话的临时工作目录 */
  digitalIdentity: string;
  // 工作目录，空 = 使用全局主工作目录
  workspaceDir: string;
  /** 保留会话：run 结束后保留上下文（记录 agentId），新消息 Resume 延续对话（默认 true） */
  keepSession?: boolean;
  /** 保持长连接：无限 poll 保活，次数套餐推荐（默认 true；false = 回答完收回合按需唤醒） */
  persistentPoll?: boolean;
}

/** 下发给 Daemon 的通道配置（含运行所需的全部字段） */
export interface DaemonChannelConfig {
  id: string;
  name: string;
  type: "feishu" | "wechat";
  appId?: string;
  appSecret?: string;
  wechatToken?: string;
  wechatAccountId?: string;
  mainUserEnabled: boolean;
  mainUserChatId: string;
  /** 通道级工作目录，空 = 跟随全局 WORKSPACE_DIR */
  workspaceDir: string;
  /** 合成开关（keepSession && persistentPoll）：poll 响应随路下发，作为 Agent 收尾方式的权威来源 */
  keepAlive?: boolean;
}

/** Daemon 上报的通道状态 */
export interface ChannelStatusInfo {
  id: string;
  name: string;
  type: "feishu" | "wechat";
  connected: boolean;
  /** wechat: disconnected/qr_pending/logging_in/connected/error；feishu: connected/connecting */
  status: string;
  mainUserBound: boolean;
  /** 飞书机器人应用名（app_name，群内显示名） */
  botName?: string;
}

// ── chatKey：全局唯一聊天标识 `${channelId}|${rawChatId}` ──

export const CHAT_KEY_SEP = "|";

export function makeChatKey(channelId: string, chatId: string): string {
  if (!channelId) return chatId;
  return `${channelId}${CHAT_KEY_SEP}${chatId}`;
}

export function parseChatKey(chatKey: string): { channelId?: string; chatId: string } {
  const idx = chatKey.indexOf(CHAT_KEY_SEP);
  if (idx > 0 && chatKey.startsWith("ch_")) {
    return { channelId: chatKey.slice(0, idx), chatId: chatKey.slice(idx + 1) };
  }
  return { chatId: chatKey };
}

/** 从 sessionKey（`chatKey` 或 `chatKey::workspaceDir`）提取 chatKey 部分 */
export function chatIdFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf("::");
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey;
}

/** 从 sessionKey（`chatKey` 或 `chatKey::workspaceDir`）解析 channelId */
export function channelIdFromSessionKey(sessionKey: string): string | undefined {
  return parseChatKey(chatIdFromSessionKey(sessionKey)).channelId;
}

/** 从 sessionKey 提取 `::` 后缀的工作目录；仅路径形态有效（排除 wf_xxx 等非路径后缀） */
export function workspaceDirFromSessionKey(sessionKey: string): string | undefined {
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return undefined;
  const dir = sessionKey.slice(idx + 2);
  return dir && /[\\/]/.test(dir) ? dir : undefined;
}
