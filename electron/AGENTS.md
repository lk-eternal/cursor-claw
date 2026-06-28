# Electron 主进程约定

## 会话进度通知（daemon `/api/send-text`）

- **三态文案**：冷启动「正在启动」由 **Daemon orchestrator** 下发；进入处理后「Agent 处理中…」由 `agent-sdk` 在 `agent.send` 成功后发送；入队确认由 daemon `buildEnqueueStatusText` 发（勿在 electron 侧重复近义句）。
- **Agent 阶段上报**：`daemon-client.reportSessionAgentPhase` → `POST /api/session-agent-phase`；与三态 notify 同挂点、失败仅 WARN、不阻断启动。
- **落点**：`agent-sdk` 在 `agent.send` 成功后、`streamRunEvents` 前发处理中；已运行 session early return 不得再发处理中。
- **失败 notify**：用户可见文案须可理解；路径、stack、进程细节仅写 UI 日志，不经 `/api/send-text` 下发。

## Agent 失败日志归档

- **配置**：`AppConfig.crashAnalysisDir`（Settings general「崩溃分析目录」，存绝对路径；空字符串=未配置，跳过归档）。复用 `config:get`/`config:save`，无新 IPC。
- **入口**：`crash-log-archiver.archiveAgentFailureLogs(ctx)` — 同步 best-effort，内部 catch 不 throw，**不阻断** `notifySdkFailure` / `notifyDispatchFailure`。
- **挂接点**（与失败 notify 同路径）：
  - `notifySdkFailure`：`errorNotified` 闩通过后、`notifySessionChat` 前；默认 `sdk_run_error`，CANCELLED→`sdk_cancelled`；`streamRunEvents` catch 经 notify 传 `sdk_stream_exception`
  - `notifyDispatchFailure`：`dispatch_failed` UI 日志后、IM notify 前（`failureType=dispatch_failed`）；无 session 时不传 `session` 字段
  - `finalizeSdkRunOnTimeout`：在 `await notifySdkFailure` **之前**调用（`sdk_timeout`）；notify 内见闩跳过重复归档
- **幂等**：`SdkSessionAgent.failureArchiveDone`；`startSdkRun` / `resetSdkRunPresentationState` 清零；写盘成功后 archiver 置 `true`；finalizer→notify 同次失败只产生**一个**事件目录
- **产物**：`{crashAnalysisDir}/{yyyymmddhhmmss[-NNN]}/` — `electron-log.txt`（UTF-8，行格式与 UI 日志一致）+ `meta.json`；目录名上海时区 14 位，根下已存在则 `-001`、`-002`…
- **快照**：归档前 `pushUiLog` 写入 `[crash-archive-trigger] failureType=… sessionKey=…`；从 `getLogBuffer()` 定位**最后一条**含该 marker 的行为锚点，取锚点及前最多 30、后最多 30 行（不足取全部）；`meta.json.buffer` 含 `totalInSnapshot`、`anchorIndex`、`linesBefore`/`linesAfter`、`truncatedBefore`/`truncatedAfter`
- **边界**：**不改** IM 文案；**不**读/复制 `daemon.log`（本阶段）；**不**覆盖 CLI 路径；`dispatchToSdkAgent` 早退 `no resident agent`（仅 pushUiLog）**不**触发归档；未配置时 WARN「未配置崩溃分析目录，跳过归档」（同进程节流）

## 模块边界

- `session-dispatcher`：任务/工作流/`/chat` 经 Daemon `POST /api/agent/launch` 启动；**不**扫描 IM 队列（T7 迁入 Daemon）；**launch 前不得**调用 `workspace-injector` 写盘。
- `workspace-injector`：自动注入（rules/mcp/skills）已废弃为 no-op；`cleanupLegacyInjection` 仅作可选手动清理，**禁止**在 launch 或 Daemon 启动路径自动调用。
- `agent-sdk`：SDK 生命周期与事件流；通知 daemon 时用 `daemon-client.httpPost`，避免与 `session-dispatcher` 循环 import。
- **SDK 流式桥接（f41Eligible）**：主用户私聊或飞书群聊（`allowOthers`）+ SDK 资源时，`handleSdkEvent` assistant delta → `POST /api/stream-text`（累积全文、400ms 节流）；首包不带 `outbound_message_id`，后续回传 daemon 返回值。`flushStreamPost` 经 `session.streamPostChain` 串行 in-flight：每次 POST 入链并 await 上一包完成后再发，避免并发首包；`final` 包同样入链末尾，且携带 `message_id`（当次 claim 末条 inbound id，经 launch/dispatch `message_ids` → `session.inboundMessageIds`）。会话结束或 `stopSdkSession` 时 `resetStreamPostChain` 清 timer 与链。非 f41Eligible 仍走 `appendSdkLog`，不调 stream-text。eligible 须与 Daemon `isStreamTextEligible` 一致。
- **Presentation 时序编排（PRESENTATION_ORDERING）**：`presentationOrderingEligible(session)` = 开关开启 **且** `f41Stream && p2p`（主用户私聊 SDK）。`seenProcessEvent` / `presentationDeferStream` 见 tool/thinking 后置闩；含过程 Run 内 assistant delta 只累积 `streamBuffer` 不 `scheduleStreamPost`；首包未见过程事件时 `schedulePreambleRelease`（400ms 与 stream 节流对齐）短窗等待 tool/thinking，`doFlushStreamPost` 非 final 复检 `shouldDeferAssistantPost`；过程事件 `clearStreamPostTimer`。thinking 结束 `closeThinkingIfOpen` 传 `final: true` 并 `maybeReleaseDeferredAssistant`。Run 收尾 `streamRunEvents` 强制 flush。daemon 返回 `deferred: true` 时设 `presentationDeferStream`。纯对话（始终无过程事件）经 preamble 短窗后 POST，不额外延迟于现网 400ms 节流。`resetSdkRunPresentationState` / `startSdkRun` 清零编排布尔与 buffer。
- **Presentation 出站（tool/thinking）**：`handleSdkEvent` 中 `tool_call` / `thinking` → `POST /api/presentation-event`（`PresentationEvent`）；工具 `running` 时清该 `tool_name` 的 `toolPresentationOutboundIds` 以新建 CardKit，完成/失败回传 `outbound_message_id` 供 PATCH；assistant 正文仍仅走 stream-text，不经 notify 发工具进度。**飞书门控**：`postPresentationEvent` 入口 `isFeishuProcessPresentationSuppressed` — 飞书全通道（私聊+群聊）抑制 tool/thinking POST，过程见 SDK UI 日志；微信不受影响。PRESENTATION_ORDERING 仍仅 p2p。
- **SDK 错误 notify**：失败经 `notifySdkFailure` → `notifySessionChat(..., stop_progress: true)`。用户可见文案经 `sdk-failure-messages.formatUserSdkFailureMessage`（`formatSdkStreamFailure` 委托）；`notifySdkFailure` 组装 peak/limit、`errorCode`、`run.result` 与 `isRunTimeoutFailure` 标志。**失败归因类别**（优先级）：`timeout`（`isTimeoutFailure`）→ `context_exhausted` → `session_abnormal` → `safe_sdk_message` → `fallback_actionable`。路径：`streamRunEvents` catch（非 aborted）、短 `CANCELLED`（极少）、`run.status === "error"` 且非超时（`completeSdkRun`）。stack/tool 名仅写 UI 日志；用户主动 `stopSdkSession`（aborted）不 notify。**平台长时结束**（非 aborted + `durationMs ≥ PLATFORM_RUN_LIMIT_MS` 7min）：`CANCELLED`/`ERROR`/`EXPIRED`/`run.status=error` 经 `isRunTimeoutFailure` → `finalizeSdkRunOnTimeout`（trigger `status`/`stream`/`complete`），IM 走超时分支，归档 `sdk_timeout`；**finalizer 先 notify 再 abort**（避免 aborted 闩跳过 IM）。**短 ERROR**（<7min、非 F3.2）：不走 finalizer，走 `completeSdkRun` 通用文案 + `failedCooldowns`。**F3.2 / 20min 保活超时档**仍由 `isRunTimeoutFailure` 判定。`runFinalizing` + `session.run` 空检查幂等；`completeSdkRun` 已收尾则跳过。
- **SDK MCP 内联**：`mcp-sdk-loader.loadInlineMcpServers` 注入 stdio/command 与 HTTP/sse（经 `toHttpInlineConfig`，合并 `mcp.json` headers + `mcp-auth.json` OAuth）；`mcp-project-dir` 统一解析 Cursor projects 目录。**stdio**（`toStdioInlineConfig`）：`workspaceDir` 非空时 `cwd=workspaceDir`，并将路径型 `command`/`args` resolve 为绝对路径（segment 含 `/`、`\` 或以 `./`/`../` 开头；bare 命令名与 `--` 前缀 flag 不 resolve）；`workspaceDir` 空时不 resolve、不设 `cwd`。`Agent.create` 与 resident 模式每次 `agent.send` 均须传入 `mcpServers`（SDK inline 不持久化；Settings Path B `mcp-manager` 未改）。
- **SDK 自动压缩**：`Agent.create` / `agent.send` 无显式 `autoCompress` 配置项；接近上下文上限时由 harness **默认** summarization/compression。`agent.send` 挂载 `onDelta`，`summary-started` / `summary-completed`（及 `summary`）写入 SDK UI 日志，前缀 `[compression]`。**pre-send 可观测**：`launchSdkAgent` / `dispatchToSdkAgent` 在 `resolveContextLimitForSession` 之后、`agent.send` 之前调用 `evaluatePreSendContextPressure` → UI 日志 `[compression] pre-send usage {pct}%`（≥85% limit，不阻断 send）。**turn-ended 高水位**：占用 ≥85% limit 时 `[compression] high-watermark {pct}%`（`context-usage-pressure` + `handleAgentSendDelta`）。
- **SDK 上下文 footer（IM 回复）**：**单一落点** `agent-sdk` — Run 流结束后 `finalizeRunContextUsage` 读 `run.usage`（必要时 `run.wait()`），与 `onDelta` turn-ended 快照 **并排打 `[context-usage]` 日志**；`doFlushStreamPost(..., final=true)` 前 `applyContextFooterToBuffer` 写入 `streamBuffer`；中间 chunk 不含 footer。footer **优先** `run.usage.totalTokens`，不可得时回退 turn-ended/peak；格式 `\n\n---\n上下文：{p}% ({usedK}k/{limitK}k)`（有上限）或 `\n\n---\n上下文：已用 {usedK}`；上限来自 `Cursor.models.list` 或 modelId 启发式（session 级缓存）。`appendContextFooter` 对已含「上下文：」的正文幂等。CLI 路径不在 IM scope。
- **SDK 自动压缩飞书通知**：`summary-started` 经 `notifySessionChat` 下发「正在压缩上下文…」（与「Agent 处理中…」同语义，不传 `stop_progress`）；每 Run 至多一次（`compressionNotified`）；`summary-completed` 仅写 UI 日志。
- **SDK 长驻 Agent（`SDK_RESIDENT_AGENT`）**：默认开启；`SDK_RESIDENT_AGENT=0` 回退 Run 结束 `close()`。**非超时 error**：`completeSdkRun` 在 `residentMode` **保留**实例、`reportSessionAgentPhase(idle)` 触发 Daemon flush。**超时类**：`finalizeSdkRunOnTimeout` 后 `agent.close()` + 删 session（长驻与非长驻均清理），下条 launch 重建；**不写 `failedCooldowns`**。`isSdkSessionRunning` 仅 processing（`run`/`pendingDispatch`），idle 用 `hasSdkSession`。二次任务 `dispatchToSdkAgent`；`launchSdkAgent` 遇 processing 会话 WARN 早退 `{ ok: true }`。失败日志 `dispatch_failed` / `agent_failed`。`ensureAgentSdkHttpServer` 应用 init 启动，端口 `userData/agent-api-port.json`；Daemon 转发 `POST /api/agent/launch|dispatch`。
- **IM 调度 SDK-only**：无 CLI spawn、无 `poll-message`。

## 通道配置字段

- `MessageChannel` 增删字段须同步：`src/shared/channel-types.ts`、`electron/preload.ts`、`src/renderer/env.d.ts`（`ChannelConfig`）。
- 旧通道读时兜底写在 `config-store.getChannels`，与 `ChannelPanel` reload / `emptyChannel` 保持一致。
- **SDK error 可观测性**：`handleSdkEvent` 在 `tool_call` 时写入 `session.lastTool`；`run.status === "error"` 时 UI 日志单行 `运行错误详情:` 含 `sessionKey`、`agentId`、`durationMs`、`lastTool`、`run.result`、`errorCode`、`waitResult` 等结构化字段。
- **保活失败文案（F3.2）**：超时类由 `isRunTimeoutFailure` 判定后 `formatUserSdkFailureMessage` 输出「会话因等待超时已退出…」（含 F3.2 shell:running + duration≥20min、平台长时 ≥7min）；`isTimeoutFailure` 分支**优先于** CANCELLED 固定「任务已取消」句。`notifySdkFailure` 用 `run`/`runStartedAt` 解析 duration。平台长时 `CANCELLED/ERROR/EXPIRED` 经 finalizer 即时 notify；短 ERROR 走 `completeSdkRun`。非超时 tool/上下文失败走 `sdk-failure-messages` 归因。
