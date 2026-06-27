# 验收问题报告

> 变更 ID：`20260627113111-消息通道即时响应与流式输出`

## 第 1 轮

### 反馈问题

本地已安装 profile（飞书 + Cursor SDK）。用户在飞书发一条消息后，Agent 开始工作时持续收到多条「半幅」递增消息，例如：

```
按
按 cursor-cl
按 cursor-claw 工作
```

期望应为同一条消息持续更新（F4.2）或段落分段降级（F4.3），不应刷屏。

### 归因结论

| 字段 | 值 |
|------|-----|
| 结论 | 代码实现问题 |
| reason | `code` |

### 判定依据

| 维度 | 说明 |
|------|------|
| PRD F4.2 | SDK 主用户私聊首选「在同一条 outbound 消息上持续更新内容」，使用户尽早看到产出并随增长而更新。 |
| PRD F4.3 | 通道不支持单条编辑时，降级为自然段落或节流策略分段发送，仍优于一次性发送。 |
| PRD NF6 | 流式更新须节流，可感知流畅且**不刷屏**。 |
| 实现链路 | `electron/agent-sdk.ts`：`appendStreamDelta` → `scheduleStreamPost`（400ms 节流，`void flushStreamPost` 未串行）→ `POST /api/stream-text` → `src/daemon.ts` `handleStreamText`（首包 `sendStreamMessage`，后续 `updateMessageContent` PATCH 或 `sendStreamSegments`）。 |
| 现象对照 | 短句多次递增更符合：并发 stream-text 请求均命中 `isFirst` 多次发新消息，和/或飞书 PATCH 路径未 Consolidate 为单条 UX；与 PRD 不符，非 PRD 故意要求的行为。 |

### 影响范围

- 通道：飞书
- 场景：SDK 模式 + 主用户私聊流式输出
- 关联实现：`electron/agent-sdk.ts`、`src/daemon.ts`、`src/shared/lark-core.ts`

### 后续处理

- 路径：`/kb-revise-apply` 或 `/kb-apply`
- 修复方向：串行化 stream 推送、飞书 PATCH/降级策略优化，使行为符合 F4.2 首选或 F4.3 降级，并满足 NF6 不刷屏

## 第 2 轮

### 反馈问题

应用重启后，会话队列目录残留 stale `.claimed` 文件；用户再次发消息时可能触发冷启动 orphan 回收或重复投递。

联调确认根因为 **T-FIX-04 债务**（见 `04-review.md` §7）：SDK 流式 `doFlushStreamPost(final=true)` 未向 daemon `POST /api/stream-text` 传 inbound `message_id`；daemon 侧 T-FIX-03 虽已支持 final ack，但 electron 桥接层未传 id，`.claimed` 仅依赖 Agent 另行 MCP `send_text(message_id)` 清理，主路径未闭环。

### 归因结论

| 字段 | 值 |
|------|-----|
| 结论 | 代码实现问题 |
| reason | `code` |

### 判定依据

| 维度 | 说明 |
|------|------|
| 02-design S12/T8 | 任务完成路径须 `ackOnReply` 确认队列并停止进行中指示；流式 `final: true` 为 S12 主完成路径之一。 |
| 04-review §7 R3 债务 | daemon `handleStreamText` final 已支持可选 `message_id` → `ackOnReply`（T-FIX-03）；但 `agent-sdk` 桥接层 `StreamTextPayload` 无 `message_id` 字段，`doFlushStreamPost(final=true)` 未传 inbound id；`dispatchSessionToAgent` → `POST /api/agent/launch` 亦未传 `message_ids`。 |
| CodeGraph / 源码核对 | `electron/agent-sdk.ts`：`StreamTextPayload`（约 L212–218）仅含 `session_key/text/stream_id/outbound_message_id/final`；`doFlushStreamPost`（约 L329–347）构造 payload 时不含 `message_id`。`src/daemon.ts`：`handleStreamText` final 分支（约 L785–786）仅在 `message_id` 存在时调用 `ackOnReply`；无 id 时仅 `stopSessionProgress`，`.claimed` 不清理。`electron/session-dispatcher.ts`：`launchAgent` 调用 `/api/agent/launch`（约 L290–302）未携带 poll 领取的 `message_ids`。 |
| 现象对照 | 联调复现：流式主路径完成后 `.claimed` 滞留；重启后 orphan 回收或重复投递风险与 PRD F3.5/NF3 队列确认语义不符，属实现缺口而非 PRD 故意设计。 |

### 影响范围

- 场景：SDK 流式主路径完成、应用重启后会话队列
- 关联实现：`electron/agent-sdk.ts`（`doFlushStreamPost`/`StreamTextPayload`）、`src/daemon.ts`（`handleStreamText` final ack）、`electron/session-dispatcher.ts`（launch 未传 message_ids）、`src/file-queue.ts`（`.claimed` 生命周期）
- 关联债务：`04-review.md` §7 T-FIX-04 建议项

### 后续处理

- 路径：`/kb-revise-apply` 或 `/kb-apply`
- 修复方向：在 `doFlushStreamPost(final=true)` 向 stream-text 传 inbound `message_id`（需 agent-sdk 跟踪 poll 领取 ids），或 daemon final 无 id 时 ack 会话全部 claimed；同步闭环 `dispatchSessionToAgent` → launch 的 message_ids 传递（若采用桥接层跟踪方案）
