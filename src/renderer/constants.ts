export const REQUIRED_FEISHU_SCOPES: { scope: string; desc: string }[] = [
  { scope: "im:message", desc: "发送消息（create / reply）" },
  { scope: "im:message.p2p_msg:readonly", desc: "接收私聊消息" },
  { scope: "im:message.group_at_msg:readonly", desc: "接收群聊 @消息" },
  { scope: "im:resource", desc: "上传/下载图片与文件" },
  { scope: "im:chat:read", desc: "获取群聊名称" },
  { scope: "contact:contact.base:readonly", desc: "获取用户名（私聊会话显示）" },
]

export const FEISHU_SCOPES_JSON = JSON.stringify(
  { scopes: { tenant: REQUIRED_FEISHU_SCOPES.map((p) => p.scope), user: [] } },
  null,
  2,
)
