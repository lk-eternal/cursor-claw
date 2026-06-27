# Electron 主进程约定

## 会话进度通知（daemon `/api/send-text`）

- **三态文案**：冷启动「正在启动」由 **Daemon orchestrator** 下发；进入处理后「Agent 处理中…」由 `agent-sdk` 在 `agent.send` 成功后发送；入队确认由 daemon `buildEnqueueStatusText` 发（勿在 electron 侧重复近义句）。
- **Agent 阶段上报**：`daemon-client.reportSessionAgentPhase` → `POST /api/session-agent-phase`；与三态 notify 同挂点、失败仅 WARN、不阻断启动。
- **落点**：`agent-sdk` 在 `agent.send` 成功后、`streamRunEvents` 前发处理中；已运行 session early return 不得再发处理中。
- **失败 notify**：用户可见文案须可理解；路径、stack、进程细节仅写 UI 日志，不经 `/api/send-text` 下发。

## 模块边界

- `session-dispatcher`：任务/工作流/`/chat` 经 Daemon `POST /api/agent/launch` 启动；**不**扫描 IM 队列（T7 迁入 Daemon）；**launch 前不得**调用 `workspace-injector` 写盘。
- `workspace-injector`：自动注入（rules/mcp/skills）已废弃为 no-op；`cleanupLegacyInjection` 仅作可选手动清理，**禁止**在 launch 或 Daemon 启动路径自动调用。
- `agent-sdk`：SDK 生命周期与事件流；通知 daemon 时用 `daemon-client.httpPost`，避免与 `session-dispatcher` 循环 import。
- **SDK 流式桥接（f41Eligible）**：主用户私聊或飞书群聊（`allowOthers`）+ SDK 资源时，`handleSdkEvent` assistant delta → `POST /api/stream-text`（累积全文、400ms 节流）；首包不带 `outbound_message_id`，后续回传 daemon 返回值。`flushStreamPost` 经 `session.streamPostChain` 串行 in-flight：每次 POST 入链并 await 上一包完成后再发，避免并发首包；`final` 包同样入链末尾，且携带 `message_id`（当次 claim 末条 inbound id，经 launch/dispatch `message_ids` → `session.inboundMessageIds`）。会话结束或 `stopSdkSession` 时 `resetStreamPostChain` 清 timer 与链。非 f41Eligible 仍走 `appendSdkLog`，不调 stream-text。eligible 须与 Daemon `isStreamTextEligible` 一致。
- **Presentation 时序编排（PRESENTATION_ORDERING）**：`presentationOrderingEligible(session)` = 开关开启 **且** `f41Stream && p2p`（主用户私聊 SDK）。`seenProcessEvent` / `presentationDeferStream` 见 tool/thinking 后置闩；含过程 Run 内 assistant delta 只累积 `streamBuffer` 不 `scheduleStreamPost`；首包未见过程事件时 `schedulePreambleRelease`（400ms 与 stream 节流对齐）短窗等待 tool/thinking，`doFlushStreamPost` 非 final 复检 `shouldDeferAssistantPost`；过程事件 `clearStreamPostTimer`。thinking 结束 `closeThinkingIfOpen` 传 `final: true` 并 `maybeReleaseDeferredAssistant`。Run 收尾 `streamRunEvents` 强制 flush。daemon 返回 `deferred: true` 时设 `presentationDeferStream`。纯对话（始终无过程事件）经 preamble 短窗后 POST，不额外延迟于现网 400ms 节流。`resetSdkRunPresentationState` / `startSdkRun` 清零编排布尔与 buffer。
- **Presentation 出站（tool/thinking）**：`handleSdkEvent` 中 `tool_call` / `thinking` → `POST /api/presentation-event`（`PresentationEvent`）；工具 `running` 时清该 `tool_name` 的 `toolPresentationOutboundIds` 以新建 CardKit，完成/失败回传 `outbound_message_id` 供 PATCH；assistant 正文仍仅走 stream-text，不经 notify 发工具进度。**飞书门控**：`postPresentationEvent` 入口 `isFeishuProcessPresentationSuppressed` — 飞书全通道（私聊+群聊）抑制 tool/thinking POST，过程见 SDK UI 日志；微信不受影响。PRESENTATION_ORDERING 仍仅 p2p。
- **SDK 错误 notify**：`streamRunEvents` catch、`status` ERROR/EXPIRED/CANCELLED、`run.status === "error"` 经 `notifySessionChat` 下发用户可理解文案；stack/tool 名仅写 UI 日志。用户主动 `stopSdkSession`（aborted）不 notify。
- **SDK MCP 内联**：`mcp-sdk-loader.loadInlineMcpServers` 注入 stdio/command（补 `cwd`）与 HTTP/sse（合并 `mcp.json` headers + `mcp-auth.json` OAuth）；`mcp-project-dir` 统一解析 Cursor projects 目录。`Agent.create` 与 resident 模式每次 `agent.send` 均须传入 `mcpServers`（SDK inline 不持久化）。
- **SDK 自动压缩**：`Agent.create` / `agent.send` 无显式 `autoCompress` 配置项；接近上下文上限时由 harness **默认** summarization/compression。`agent.send` 挂载 `onDelta`，`summary-started` / `summary-completed`（及 `summary`）写入 SDK UI 日志，前缀 `[compression]`。
- **SDK 上下文 footer（IM 回复）**：**单一落点** `agent-sdk` — Run 流结束后 `finalizeRunContextUsage` 读 `run.usage`（必要时 `run.wait()`），与 `onDelta` turn-ended 快照 **并排打 `[context-usage]` 日志**；`doFlushStreamPost(..., final=true)` 前 `applyContextFooterToBuffer` 写入 `streamBuffer`；中间 chunk 不含 footer。footer **优先** `run.usage.totalTokens`，不可得时回退 turn-ended/peak；格式 `\n\n---\n上下文：{p}% ({usedK}k/{limitK}k)`（有上限）或 `\n\n---\n上下文：已用 {usedK}`；上限来自 `Cursor.models.list` 或 modelId 启发式（session 级缓存）。`appendContextFooter` 对已含「上下文：」的正文幂等。CLI 路径不在 IM scope。
- **SDK 自动压缩飞书通知**：`summary-started` 经 `notifySessionChat` 下发「正在压缩上下文…」（与「Agent 处理中…」同语义，不传 `stop_progress`）；每 Run 至多一次（`compressionNotified`）；`summary-completed` 仅写 UI 日志。
- **SDK 长驻 Agent（`SDK_RESIDENT_AGENT`）**：默认开启；设 `SDK_RESIDENT_AGENT=0` 回退 Run 结束 `close()`。`completeSdkRun` 在 `residentMode` 时保留实例、`reportSessionAgentPhase(idle)` 触发 Daemon flush；`isSdkSessionRunning` 仅表 processing（`run`/`pendingDispatch`），idle 长驻用 `hasSdkSession`。二次任务走 `dispatchToSdkAgent`；失败日志含 `dispatch_failed`，Run 错误含 `agent_failed`。`ensureAgentSdkHttpServer` 在应用 init 启动，端口写入 `userData/agent-api-port.json`；Daemon SSOT 转发 `POST /api/agent/launch|dispatch`。
- **IM 调度 SDK-only**：无 CLI spawn、无 `poll-message`。

## 通道配置字段

- `MessageChannel` 增删字段须同步：`src/shared/channel-types.ts`、`electron/preload.ts`、`src/renderer/env.d.ts`（`ChannelConfig`）。
- 旧通道读时兜底写在 `config-store.getChannels`，与 `ChannelPanel` reload / `emptyChannel` 保持一致。
- **SDK error 可观测性**：`handleSdkEvent` 在 `tool_call` 时写入 `session.lastTool`；`run.status === "error"` 时 UI 日志单行 `运行错误详情:` 含 `sessionKey`、`agentId`、`durationMs`、`lastTool`、`run.result`、`errorCode`、`waitResult` 等结构化字段。
- **保活失败文案（F3.2）**：`formatSdkStreamFailure` 在末次 tool 为 `shell:running` 且 `durationMs ≥ 20min` 且 SDK message 不安全（空/stack/路径）时，notify「会话因等待超时已退出…」；ERROR/EXPIRED 在 `completeSdkRun` 再 notify（避免 `durationMs` 未就绪误判为通用失败）。其它 tool 失败仍走通用文案。CANCELLED/EXPIRED 分支不变。
