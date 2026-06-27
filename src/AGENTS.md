# src 守护进程约定

## 会话进行中指示（sessionProgressMap）

- **启动**：入队确认后 `confirmEnqueueAndStartProgress` — 微信 `startProgressTyping`，飞书原消息 `Get` 表情。
- **停止**：统一经 `stopSessionProgress(sessionKey)` — 微信 `stopProgressTyping`，并 `delete` Map 条目防泄漏。
- **完成路径须 stop**：带 `message_id` 的最终回复经 `ackOnReply`（已含 stop）；异常 notify 经 `/api/send-text` 传 `stop_progress: true`；`/api/stream-text` 的 `final: true`（可选 `message_id` 触发 ack）；`/api/send-image|send-file` 成功且带 `message_id` 时经 `ackOnReply`。三态进度文案（「正在启动」「Agent 处理中…」）走 send-text **不带** `message_id`/`stop_progress`，**不** stop。
- **poll Get 去重**：`sessionGetReactedIds` 按 inbound `messageId` 记录已打 Get；入队确认与 poll 均写入，`idsNeedingPollGetReaction` 按 id 过滤，不依赖 `sessionProgressMap` 生命周期。
- **勿在 sendText 内 cancelTyping**：最终回复与流式分段用 `{ skipTyping: true }`；进行中指示仅由进度状态机 stop。

## 合并预览与 Agent 阶段（daemon 内存）

- **Agent 阶段**：`sessionAgentPhaseMap` 由 electron `reportSessionAgentPhase`（`daemon-client.ts`）写入；`idle` 即 delete 条目。与 `sessionProgressMap`（流式/typing）职责分离。
- **idle 补偿**：`POST /api/session-agent-phase` 转 `idle` 后，若 unclaimed≥2 且未抑制，daemon 须 `scheduleMergePreviewIfEligible`（processing 期间被 F4 跳过的 debounce 不会自动重跑）。
- **instant poll 守卫**：`blocking=false` 的 `/api/poll-message` 在 `claimSessionMessages` 前 `await ensureMergePreviewSentBeforeClaim`；`shouldSuppressMergePreview===true` 时仍可直接 claim。`clearMergePreviewState` 仅在 claim 完成且预览窗口已关闭后调用。
- **合并预览**：`mergePreviewBySession` / `mergePreviewRegistry` 生命周期与 poll 领取、`ackOnReply` 清理绑定；debounce 与超长分条逻辑留在 `daemon.ts` 内，勿散落至 file-queue。

## stream-text（`/api/stream-text`）

- **微信**：首包 `sendText` + 后续分段，逻辑不变。
- **飞书首选 CardKit**：首包 `createStreamingCardEntity` → `sendStreamingCardMessage`，`SessionProgressState` 记 `cardId`/`elementId`/`cardSequence`/`streamCardKitMode`；后续 `updateStreamingCardText`（`cardSequence` 递增）；`final: true` 时 `closeStreamingCardMode(cardSequence+1)` 再 stop/ack。
- **CardKit 降级**：创建/发卡片任一步失败 → 回退 `sendStreamMessage`（`streamPatchMode`）；流式更新失败 → `streamCardKitMode=false`，再 PATCH 或 `sendStreamSegments` 分段。
- **节流**：`streamTextThrottleMs()`（500–1500ms）对 CardKit 更新同样生效；`isFirst`/`final` 不受节流跳过。
