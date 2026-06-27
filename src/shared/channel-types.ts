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
  /** 他人/群聊工作目录策略：isolated=按会话隔离临时目录；specified=指定目录 */
  othersWorkspaceMode: "isolated" | "specified";
  /** 仅 othersWorkspaceMode=specified 时生效；留空 = effectiveWorkspaceDir */
  othersWorkspaceDir: string;
  /** 对外身份规则，注入到其他人会话的临时工作目录 */
  digitalIdentity: string;
  // 工作目录，空 = 使用全局主工作目录
  workspaceDir: string;
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
  /** 是否响应其他人私聊及群聊 @ 消息 */
  allowOthers: boolean;
  /** 通道级工作目录，空 = 跟随全局 WORKSPACE_DIR */
  workspaceDir: string;
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

/** 从 sessionKey（`chatKey` 或 `chatKey::workspaceDir`）解析 channelId */
export function channelIdFromSessionKey(sessionKey: string): string | undefined {
  const idx = sessionKey.indexOf("::");
  const chatKey = idx > 0 ? sessionKey.slice(0, idx) : sessionKey;
  return parseChatKey(chatKey).channelId;
}
