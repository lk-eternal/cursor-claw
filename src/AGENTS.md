# src 守护进程约定

## 会话进行中指示（sessionProgressMap）

- **启动**：入队确认后 `confirmEnqueueAndStartProgress` — 微信 `startProgressTyping`，飞书原消息 `Get` 表情。
- **停止**：统一经 `stopSessionProgress(sessionKey)` — 微信 `stopProgressTyping`，并 `delete` Map 条目防泄漏。
- **完成路径须 stop**：带 `message_id` 的最终回复经 `ackOnReply`（已含 stop）；异常 notify 经 `/api/send-text` 传 `stop_progress: true`；`/api/stream-text` 的 `final: true`（可选 `message_id` 触发 ack）；`/api/send-image|send-file` 成功且带 `message_id` 时经 `ackOnReply`。三态进度文案（「正在启动」「Agent 处理中…」）走 send-text **不带** `message_id`/`stop_progress`，**不** stop。
- **poll Get 去重**：`sessionGetReactedIds` 按 inbound `messageId` 记录已打 Get；入队确认与 poll 均写入，`idsNeedingPollGetReaction` 按 id 过滤，不依赖 `sessionProgressMap` 生命周期。
- **勿在 sendText 内 cancelTyping**：最终回复与流式分段用 `{ skipTyping: true }`；进行中指示仅由进度状态机 stop。
