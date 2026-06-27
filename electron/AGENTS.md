# Electron 主进程约定

## 会话进度通知（daemon `/api/send-text`）

- **三态文案**：冷启动附加「正在启动」；进入处理后统一「Agent 处理中…」；入队确认由 daemon 发「已收到，正在处理」（勿在 electron 侧重复近义句）。
- **落点**：`session-dispatcher.notifyChat` 负责调度器冷启动/CLI 成功；`agent-sdk` 在 `agent.send` 成功后、`streamRunEvents` 前发处理中（SDK 路径）；已运行 session early return 不得再发处理中。
- **失败 notify**：用户可见文案须可理解；路径、stack、进程细节仅写 UI 日志，不经 `/api/send-text` 下发。

## 模块边界

- `session-dispatcher`：队列调度、`launchAgent` 资源分流（CLI vs SDK）；不直接依赖 SDK 流式细节。
- `agent-sdk`：SDK 生命周期与事件流；通知 daemon 时用 `daemon-client.httpPost`，避免与 `session-dispatcher` 循环 import。
- **SDK 流式桥接（f41Eligible）**：主用户私聊 + SDK 资源时，`handleSdkEvent` assistant delta → `POST /api/stream-text`（累积全文、400ms 节流）；首包不带 `outbound_message_id`，后续回传 daemon 返回值。非 f41Eligible 仍走 `appendSdkLog`，不调 stream-text。
- **SDK 错误 notify**：`streamRunEvents` catch、`status` ERROR/EXPIRED/CANCELLED、`run.status === "error"` 经 `notifySessionChat` 下发用户可理解文案；stack/tool 名仅写 UI 日志。用户主动 `stopSdkSession`（aborted）不 notify。
