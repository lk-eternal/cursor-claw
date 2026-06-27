# src 守护进程约定

## 会话进行中指示（sessionProgressMap）

- **启动**：入队确认后 `confirmEnqueueAndStartProgress` — 微信 `startProgressTyping`，飞书原消息 `Get` 表情。
- **停止**：统一经 `stopSessionProgress(sessionKey)` — 微信 `stopProgressTyping`，并 `delete` Map 条目防泄漏。
- **完成路径须 stop**：带 `message_id` 的最终回复经 `ackOnReply`（已含 stop）；异常 notify 经 `/api/send-text` 传 `stop_progress: true`；`/api/stream-text` 的 `final: true`（可选 `message_id` 触发 ack）；`/api/send-image|send-file` 成功且带 `message_id` 时经 `ackOnReply`。三态进度文案（「正在启动」「Agent 处理中…」）走 send-text **不带** `message_id`/`stop_progress`，**不** stop。
- **poll Get 去重**：`sessionGetReactedIds` 按 inbound `messageId` 记录已打 Get；入队确认与 orchestrator claim 均写入，`idsNeedingPollGetReaction` 按 id 过滤，不依赖 `sessionProgressMap` 生命周期。
- **勿在 sendText 内 cancelTyping**：最终回复与流式分段用 `{ skipTyping: true }`；进行中指示仅由进度状态机 stop。

## Orchestrator 调度（T7）

- **单进程闭环**：IM 入站 → 队列/合并 → `runAgentDispatchLoop` → Electron `POST /api/agent/launch|dispatch` → 展示出站。
- **触发**：`broadcastQueueEvent` debounce 300ms；`session-agent-phase` → idle 时 `flushReadyMergeBatches`。
- **门控**：`shouldDeferDispatch` + `sessionAgentPhaseMap` processing；合并 batch 须 `ready` 才 claim。
- **SSOT**：`POST /api/agent/launch|dispatch` 在 Daemon 暴露并转发 Electron；`GET /api/poll-message` 返回 404。
- **日志**：调度失败用 `dispatch_failed` 字段；SDK Run 错误在 Electron 侧用 `agent_failed`。

## 合并预览与 Agent 阶段（daemon 内存）

- **Agent 阶段**：`sessionAgentPhaseMap` 由 electron `reportSessionAgentPhase`（`daemon-client.ts`）写入；`idle` 即 delete 条目。与 `sessionProgressMap`（流式/typing）职责分离。
- **idle 补偿**：`POST /api/session-agent-phase` 转 `idle` 后刷新合并卡、`flushReadyMergeBatches`，并 **`scheduleAgentDispatch`**（processing 期间入队的 unclaimed 当时无法 claim，idle 后须重跑 dispatch）。

## 合并批次 CardKit（MergeBatch，daemon 内存）

- **状态机**：`mergeBatchBySession` 存 `MergeBatch`（phase: collecting→ready→locked→dispatched/cancelled）；`MERGE_QUIET_MS` 默认 2500，`MERGE_MIN_COUNT`=2。
- **入队**：`onMessageEnqueued` 在 `pushMessage` 写入成功后调用；≥2 条进入 collecting 并重置静默计时；`renderMergeBatchCardForSession` 单卡 PATCH（`lark-core.renderMergeBatchCard`）。
- **F1 门控**：`shouldSendEnqueueF1` — collecting 批次第 2+ 条不发逐条 F1，仅 Get 表情；单条仍 `confirmEnqueueAndStartProgress`。
- **dispatch 门控（T5）**：`shouldDeferDispatch` — collecting 静默窗口或 ready 但 Agent processing（M7）时禁止 claim；`isMergeDispatchAllowed` 读 `sessionAgentPhaseMap`；`performClaimAndMerge` / `pollClaimMessagesForSession` 仅 ready|locked 且 M7 通过；`flushReadyMergeBatches` 在 idle 或 send_now 后广播 queue-update。
- **HTTP**：`POST /api/merge-batch/action`（send_now|edit|split）；`POST /api/orchestrator/claim-and-merge` → `{ text, message_ids[] }`。
- **编辑 fallback**：`mergeCardRegistry` 仅注册 `cardMessageId`；`tryHandleMergePreviewReply` 只认合并卡 outbound id，更新 `overrideText`。
- **清理**：`clearMergeBatchState` 在 `ackOnReply` 与 claim 后调用。
- **Presentation**：`POST /api/presentation-event` 路由 `tool`/`thinking`/`assistant`/`merge_batch`；失败日志含可检索字段 `presentation_failed`。
- **eligible 分层**：`isMainUserP2pEligible`（合并批次）⊂ `isStreamTextEligible`（+ S1.8 飞书群聊且 `allowOthers`）；`sessionChatTypeMap` 在 `pushMessage` 写入。
- **NF2**：活跃 MergeBatch 时 stream/tool/thinking 首包经 `getPresentationReplyAnchor` → `sendStreamingCardMessage` reply 到 `lastInboundMessageId`，不争用合并卡首屏。

## stream-text（`/api/stream-text`）

- **微信**：首包 `sendText` + 后续分段，逻辑不变。
- **飞书首选 CardKit**：首包 `createStreamingCardEntity` → `sendStreamingCardMessage`，`SessionProgressState` 记 `cardId`/`elementId`/`cardSequence`/`streamCardKitMode`；后续 `updateStreamingCardText`（`cardSequence` 递增）；`final: true` 时 `closeStreamingCardMode(cardSequence+1)` 再 stop/ack。
- **CardKit 降级**：创建/发卡片任一步失败 → 回退 `sendStreamMessage`（`streamPatchMode`）；流式更新失败 → `streamCardKitMode=false`，再 PATCH 或 `sendStreamSegments` 分段。
- **节流**：`streamTextThrottleMs()`（500–1500ms）对 CardKit 更新同样生效；`isFirst`/`final` 不受节流跳过。
- **工具/思考 CardKit**：`lark-core.renderToolProgressCard` / `renderThinkingCard`；`SessionProgressState.toolCards` 按 `tool_name` 分卡（并发工具各自 PATCH/关闭 streaming）；`started` 仅清该工具条目并发新卡。
