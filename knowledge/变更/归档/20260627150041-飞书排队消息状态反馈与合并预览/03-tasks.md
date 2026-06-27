# 飞书排队消息状态反馈与合并预览 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 1、执行计划

### （一）依赖图

```
T1 ──→ T6 ──→ T7 ──→ T8
T2 ──→ T3
T2 ──→ T4 ──→ T6
T2 ──→ T5 ──→ T6
```

**文件冲突说明**：T4、T5、T6、T7、T8 均修改 `src/daemon.ts`，须严格按轮次串行，不得并行。T1 与 T2 可并行（`file-queue.ts` / `daemon.ts` 无交叉写）。T3 仅改 `electron/`，依赖 T2 端点就绪后可与 T4 串行前的空窗独立执行。

### （二）分组调度

- **第一轮（并行）**：T1、T2
- **第二轮**：T3（electron phase 上报，依赖 T2）
- **第三轮**：T4（F1 入队文案，依赖 T2）
- **第四轮**：T5（F4 预览抑制守卫，依赖 T2）
- **第五轮**：T6（合并预览核心，依赖 T1、T4、T5）
- **第六轮**：T7（F3 回复预览拦截，依赖 T1、T6）
- **第七轮**：T8（poll override 交付与状态清理，依赖 T1、T6、T7）

## 2、任务清单

## T1: 待领取队列计数与 override 替换

### 背景

实现 S9 数据层基础。F2 合并预览触发需仅统计 `.qmsg`（待领取），与既有 `getSessionPendingCount`（含 `.claimed`）区分；F3 用户修改合并内容需将多条 `.qmsg` 折叠为单条 override；poll 交付与预览正文读取依赖 `listUnclaimedMessages`。

### 上下文文件

- CodeGraph: `getSessionPendingCount` `claimSessionMessages` `hasPendingMessages` — 理解 `.qmsg`/`.claimed` 语义与目录结构
- 必读: `src/file-queue.ts` — `getSessionPendingCount`（L174–182）、`claimSessionMessages`（L192–225）、`pushToFileQueue`（L40–70）
- 参考: `knowledge/变更/进行中/20260627150041-飞书排队消息状态反馈与合并预览/01-proposal.md` — F2.1/F2.4、F3.4、验收 4/6/9

### 实现范围

- 修改: `src/file-queue.ts`
  - 新增并导出 `getSessionUnclaimedCount(sessionKey: string): number` — 仅计 `.qmsg`
  - 新增并导出 `listUnclaimedMessages(sessionKey: string): QueueMessage[]` — 按 timestamp 升序返回 `.qmsg` 解析结果
  - 新增并导出 `replaceSessionUnclaimedMessages(sessionKey: string, newText: string, meta?: QueueMessageMeta): { ok: boolean; messageId?: string; error?: string }` — 删除该会话全部 `.qmsg`，写入单条新 `.qmsg`（新 internal messageId）；`.claimed` 不动
- 删除: 无

### 接口契约

- `export function getSessionUnclaimedCount(sessionKey: string): number`
- `export function listUnclaimedMessages(sessionKey: string): QueueMessage[]`
- `export function replaceSessionUnclaimedMessages(sessionKey: string, newText: string, meta?: QueueMessageMeta): { ok: boolean; messageId?: string; error?: string }`

### 验收标准

- [ ] 会话含 2 个 `.qmsg`、1 个 `.claimed` 时 `getSessionUnclaimedCount` 返回 `2`；`getSessionPendingCount` 仍返回 `3`
- [ ] `listUnclaimedMessages` 仅返回 `.qmsg` 条目且按 timestamp 升序
- [ ] `replaceSessionUnclaimedMessages` 后该会话仅剩 1 条 `.qmsg`，正文为 `newText`；`.claimed` 条数不变
- [ ] 空会话、目录不存在、`queueDir` 未初始化时计数为 `0`、列表为空、replace 返回 `{ ok: false }`，不抛未捕获异常
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T6、T7、T8

---

## T2: Agent 阶段 Map 与 phase API

### 背景

实现 F1/F4 的 Agent 阶段数据源。electron 调度器需上报 starting/processing/idle，daemon 在入队确认与预览抑制时读取；`idle` 时删除 Map 条目以控内存。

### 上下文文件

- CodeGraph: `confirmEnqueueAndStartProgress` `sessionProgressMap` — 区分 phase Map 与进度 Map 职责
- 必读: `src/daemon.ts` — HTTP 路由注册区（`/api/poll-message` 附近）、`sessionProgressMap`（L550 附近）
- 参考: `knowledge/变更/进行中/20260627150041-飞书排队消息状态反馈与合并预览/02-design.md` §四 `POST /api/session-agent-phase` 字段表

### 实现范围

- 修改: `src/daemon.ts`
  - 新增模块级 `sessionAgentPhaseMap: Map<string, AgentPhase>`，`type AgentPhase = "starting" | "processing" | "idle"`
  - 新增 `POST /api/session-agent-phase` 处理器：校验 `session_key` + `phase`；写入 Map；`phase === "idle"` 时 `delete` 条目；响应 `{ ok: true }`
  - 导出或内部暴露 `getSessionAgentPhase(sessionKey: string): AgentPhase | undefined`（供 T4/T5 读取；可 inline getter）

### 接口契约

- `type AgentPhase = "starting" | "processing" | "idle"`
- `sessionAgentPhaseMap: Map<string, AgentPhase>`（daemon 内存）
- `POST /api/session-agent-phase` 请求体 `{ session_key: string; phase: AgentPhase }`，响应 `{ ok: true }`
- `getSessionAgentPhase(sessionKey: string): AgentPhase | undefined` — 读取当前阶段

### 验收标准

- [ ] `curl` 或单元测试：依次 POST starting → processing → idle 后 Map 状态正确；idle 后 `getSessionAgentPhase` 返回 `undefined`
- [ ] 缺少 `session_key` 或非法 `phase` 返回 400，不污染 Map
- [ ] 不影响既有 `/api/poll-message`、`/api/send-text`、`/api/stream-text` 路由
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T3、T4、T5

---

## T3: Electron Agent 阶段上报

### 背景

electron 在既有 notify 挂点向 daemon 上报 Agent 阶段，使 F1 文案与 F4 抑制能感知冷启动/处理中/空闲。不新建 electron 模块，在 `session-dispatcher` / `agent-sdk` 各加 HTTP 调用。

### 上下文文件

- CodeGraph: `notifyChat` `NOTIFY_STARTING` `launchSdkAgent` `handleSessionClosed` — 上报挂点
- 必读: `electron/session-dispatcher.ts` — `notifyChat`（L53）、`NOTIFY_STARTING` 调用（L690）、`NOTIFY_PROCESSING` 路径（L363）、`handleSessionClosed`（L115）
- 必读: `electron/agent-sdk.ts` — `launchSdkAgent` 内 `agent.send` 成功后 `notifySessionChat`（L465–468）、会话结束/stop 路径
- 参考: `electron/AGENTS.md` — 三态文案分工；`electron/session-dispatcher.ts:201–223` — 与 daemon 通信用 `httpPost` 模式

### 实现范围

- 修改: `electron/session-dispatcher.ts`
  - 新增 `reportSessionAgentPhase(sessionKey: string, phase: "starting" | "processing" | "idle"): Promise<void>` — 经 `daemon-client.httpPost` 调 `POST /api/session-agent-phase`；失败打 WARN 不抛
  - `NOTIFY_STARTING` 发送前 → `reportSessionAgentPhase(sessionKey, "starting")`
  - CLI/SDK 进入处理成功（现有 `notifyChat(..., NOTIFY_PROCESSING)` 同路径）→ `"processing"`
  - `handleSessionClosed` / Agent stop 路径 → `"idle"`
- 修改: `electron/agent-sdk.ts`
  - `launchSdkAgent` 在 `agent.send` 成功、`notifySessionChat(NOTIFY_PROCESSING)` 同刻 → `reportSessionAgentPhase(sessionKey, "processing")`
  - SDK 会话结束/stop 时 → `"idle"`（与 session-dispatcher 关闭路径不重复上报即可，择一主路径 + 兜底）

### 接口契约

- `reportSessionAgentPhase(sessionKey: string, phase: "starting" | "processing" | "idle"): Promise<void>` — electron 内部 helper，POST daemon `/api/session-agent-phase`

### 验收标准

- [ ] 冷启动路径：用户发消息后日志可见 starting → processing 上报；Agent 退出后 idle 上报（对齐 02 §八·（二）第 1 项）
- [ ] 上报失败（daemon 未就绪）仅 WARN，不阻断 Agent 启动
- [ ] 不重复发送与 F1 近义的额外 send-text（遵守 `electron/AGENTS.md` 三态分工）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2
- 后续任务: 无（与 T4 联调验收 F1）

---

## T4: F1 入队确认文案增强

### 背景

实现 S6 / F1.1–F1.3。将 `confirmEnqueueAndStartProgress` 固定文案改为按 Agent 阶段 + 排队数组合；保留 Get/typing 进度启动逻辑不变。

### 上下文文件

- CodeGraph: `confirmEnqueueAndStartProgress` `getSessionPendingCount` — 入队确认挂点
- 必读: `src/daemon.ts` — `confirmEnqueueAndStartProgress`（L593–626）、`pushMessage` 调用链（L874）
- 必读: `knowledge/变更/进行中/20260627150041-飞书排队消息状态反馈与合并预览/01-proposal.md` — F1 文案表、验收 1–3
- 参考: T2 产出的 `getSessionAgentPhase`；`src/file-queue.ts` `getSessionPendingCount` — 兜底：phase 缺失且存在 `.claimed` 时视为 processing

### 实现范围

- 修改: `src/daemon.ts`
  - 新增 `buildEnqueueStatusText(sessionKey: string, pending: number): string`
    - 读 `getSessionAgentPhase(sessionKey)`；无 phase 时：若会话目录存在 `.claimed` → processing；否则 idle
    - `starting` → F1.2；`processing` → F1.1；`idle` → F1.3（仅本条 vs 有积压两种措辞，见 01 文案表）
    - `pending > 1` 时附加 `（前面还有 ${pending - 1} 条待处理）`
  - 改造 `confirmEnqueueAndStartProgress`：用 `buildEnqueueStatusText` 替换硬编码「已收到，正在处理」；Get/typing 分支不动

### 接口契约

- `function buildEnqueueStatusText(sessionKey: string, pending: number): string` — 内部；输出简体中文，无工具名/文件名

### 验收标准

- [ ] Agent 处理中连发 B、C：入队反馈均含「正在处理上一条」类表述且排队数正确（验收 1）
- [ ] Agent 空闲连发 2 条：不误报「正在处理上一条」（验收 2）
- [ ] 冷启动首条：体现「正在启动」+ 已排队（验收 3）
- [ ] phase 未上报 + 仅有 `.claimed`：F1 显示处理中不误报空闲（02 §八·（二）第 2 项）
- [ ] 每条成功入队仍单独发一次 F1（F1.5）；指令路径不走本函数（F1.4）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2
- 后续任务: T6（`pushMessage` 同文件后续扩展）

---

## T5: F4 合并预览抑制守卫

### 背景

实现 S8 / F4.1。Agent 处理中、存在 `.claimed` 或流式 outbound 活跃时，新入队消息仅发 F1，不 schedule 合并预览。

### 上下文文件

- CodeGraph: `sessionProgressMap` `SessionProgressState` — 流式活跃判定
- 必读: `src/daemon.ts` — `SessionProgressState`（L291 附近）、`sessionProgressMap`（L550）、`stopSessionProgress`
- 必读: `src/file-queue.ts` — 判断会话是否存在 `.claimed`（可复用 `getSessionPendingCount - getSessionUnclaimedCount` 或读目录）
- 参考: `src/AGENTS.md` — sessionProgressMap 与 stream-text 边界；01 验收 10、NF6

### 实现范围

- 修改: `src/daemon.ts`
  - 新增 `shouldSuppressMergePreview(sessionKey: string): boolean`
    - `getSessionAgentPhase(sessionKey) === "processing"` → true
    - 会话存在任意 `.claimed` → true
    - `sessionProgressMap.get(sessionKey)` 存在活跃流式 outbound（`streamCardKitMode` 或 `streamPatchMode` 或等价字段）→ true
    - 否则 false
  - 本任务仅实现函数，不在 `pushMessage` 调用（由 T6 接入）

### 接口契约

- `function shouldSuppressMergePreview(sessionKey: string): boolean` — 内部；true 时跳过 S10 预览

### 验收标准

- [ ] phase=processing 时返回 true
- [ ] 仅有 `.qmsg`、phase idle、无流式时返回 false
- [ ] 存在 `.claimed` 无 phase 上报时返回 true
- [ ] 流式 CardKit/PATCH 进行中返回 true（02 §八·（二）第 6 项 / 验收 10）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2
- 后续任务: T6

---

## T6: 合并预览状态机与发送

### 背景

实现 S10 / F2.1–F2.6。入队成功后 debounce 检查待领取 ≥2 且未抑制，生成 MG-id 合并预览并发送；更新时沿用同一 ID；超长分条（NF4）。

### 上下文文件

- CodeGraph: `trackMessageSession` `pushMessage` `replyToMessage` — 预览 outbound 注册与发送
- 必读: `src/daemon.ts` — `trackMessageSession`（L750）、`pushMessage`（L850–881）、`resolveChannel` / 飞书 sender 发送路径
- 必读: `electron/session-dispatcher.ts:221–223` — `【消息 N】` 拼接 SSOT（`formatMergePreviewBody` 对齐此规则）
- 必读: `knowledge/变更/进行中/20260627150041-飞书排队消息状态反馈与合并预览/01-proposal.md` — F2/F3 引导模板、验收 4/5/9/11
- 参考: T1 的 `getSessionUnclaimedCount` / `listUnclaimedMessages`；T5 的 `shouldSuppressMergePreview`

### 实现范围

- 修改: `src/daemon.ts`
  - 新增 `MergePreviewState` 接口与 `mergePreviewBySession: Map<string, MergePreviewState>`、`mergePreviewRegistry: Map<feishuMessageId, { sessionKey, mergeId }>`
  - 新增 `formatMergePreviewBody(messages: QueueMessage[]): string` — 与 `pullMergedMessagesFromQueue` 相同 `【消息 N】` 规则
  - 新增 `buildMergeId(sessionKey, meta?)` — MG-{profile}-{YYYYMMDDHHmmss}，规则见 02 §五
  - 新增 `scheduleMergePreview(sessionKey, chatId, chatType, senderOpenId?)` — debounce 500ms（NF2）；回调内：`getSessionUnclaimedCount < 2` 或 `shouldSuppressMergePreview` 则 return
  - 新增 `sendMergePreview(sessionKey, ...)` — 飞书 p2p + 主用户 gated；发送预览/更新文案；`trackMessageSession`；registry 登记；F2.5 更新时标题含「已更新」
  - 超长（>~15KB 测试，生产 ~30KB）：首条含 ID+引导，续条「（合并预览续 N/M）」；registry 支持回复旧版 previewMessageId（02 §八·（二）第 4 项）
  - 修改 `pushMessage`：写入成功且飞书 p2p 时末尾 `scheduleMergePreview`（不 await）
- 删除: 无

### 接口契约

- `interface MergePreviewState { mergeId: string; mergedText: string; previewMessageIds: string[]; lastPreviewMessageId?: string; updated: boolean; debounceTimer?: NodeJS.Timeout }`
- `mergePreviewRegistry: Map<string, { sessionKey: string; mergeId: string }>`
- `function scheduleMergePreview(sessionKey: string, chatId?: string, chatType?: string, senderOpenId?: string): void`
- `function sendMergePreview(sessionKey: string, ...): Promise<void>`
- `function formatMergePreviewBody(messages: QueueMessage[]): string`

### 验收标准

- [ ] 连发 3 条未领取：Agent 领取前收到 1 次预览，含【消息 1】～【消息 3】与 01 示例格式（验收 4）
- [ ] 预览含可见 MG-id，格式 `MG-{profile}-{日期到时分秒}`（验收 5）
- [ ] 仅 1 条待领取时不发预览（验收 9 / F2.4）
- [ ] 预览后再发第 4 条：同一 ID +「已更新」+ 4 段内容（验收 11）
- [ ] debounce：连发 4 条 ≤5s 内收到 1 次预览且含 4 段（02 §八·（二）第 3 项）
- [ ] Agent 流式进行中连发：无合并预览（与 T5 联调，验收 10）
- [ ] 超长合并分条后用户可见完整全文（02 §八·（二）第 5 项）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1、T4、T5
- 后续任务: T7、T8

---

## T7: F3 回复合并预览拦截与修改

### 背景

实现 S3 / F3.1–F3.6。飞书 inbound 带 `parentId` 且命中预览 registry 时，解析用户提交的完整合并正文，替换待领取队列，回复确认/失败；**不入常规 pushMessage 队列**。

### 上下文文件

- CodeGraph: `startFeishuChannel` `parentId` `pushMessage` — 拦截挂点须在 enqueue 前
- 必读: `src/daemon.ts` — `startFeishuChannel`（L939–1019）、`replyToMessage`（L1049 附近）、T6 的 `mergePreviewRegistry`
- 必读: `src/shared/lark-core.ts` — `LarkMessageEvent.parentId`（L657 附近）
- 参考: T1 的 `replaceSessionUnclaimedMessages`；01 修改成功/失败文案表、验收 6–8

### 实现范围

- 修改: `src/daemon.ts`
  - 新增 `tryHandleMergePreviewReply(parentId: string | undefined, text: string, messageId: string, chatKey: string, chatType: string, senderOpenId?: string, meta?: QueueMessageMeta): Promise<boolean>`
    - `parentId` 未命中 registry → return false
    - 命中：校验非空正文；调用 `replaceSessionUnclaimedMessages`；更新 `MergePreviewState.mergedText`
    - 成功：`replyToMessage` 发送修改成功文案（含 ID）
    - 失败/空正文/已领取：`replyToMessage` 纠错文案，**必须同时含** mergeId + 当前全文 +「回复本条预览消息」说明（F3.3）
    - return true 表示已消费，调用方不得再 `pushMessage`
  - 修改 `startFeishuChannel`：`enqueue` 前对 text 消息先 `await tryHandleMergePreviewReply(...)`，true 则 return
  - 修改路径成功时**不**触发 F1 二次入队确认

### 接口契约

- `async function tryHandleMergePreviewReply(parentId, text, messageId, chatKey, chatType, senderOpenId?, meta?): Promise<boolean>`

### 验收标准

- [ ] 回复预览并发送新全文：确认成功；Agent 领取后处理新全文（验收 6）
- [ ] 预览与失败提示均含 ID + 全文 + 操作说明（验收 7–8）
- [ ] 未回复预览的普通消息仍走常规入队
- [ ] 回复**旧版** preview messageId（F2.5 更新后）仍可修改成功（02 §八·（二）第 4 项）
- [ ] 批次已领取时提示「已开始处理，无法修改」（F3.6 / 01 文案表）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1、T6
- 后续任务: T8

---

## T8: Poll override 交付与预览状态清理

### 背景

实现 S11 / S13。Agent poll 领取时若存在用户 override 合并全文，交付 override 而非多段原文；领取或 ack 后清除 `MergePreviewState` 与 debounce timer。

### 上下文文件

- CodeGraph: `claimSessionMessages` `poll-message` `ackOnReply` — 领取与确认钩子
- 必读: `src/daemon.ts` — `/api/poll-message` 处理器（L1970–2003）、`ackOnReply`（L799）
- 必读: `electron/session-dispatcher.ts:201–225` — Agent 侧合并消费路径（验证 override 全文与预览一致）
- 参考: T6 的 `MergePreviewState`；T1 的 `listUnclaimedMessages`

### 实现范围

- 修改: `src/daemon.ts`
  - 新增 `clearMergePreviewState(sessionKey: string): void` — 清除 Map 条目、debounce timer、registry 中该 session 相关 previewMessageId
  - 新增 `applyMergeOverrideForPoll(sessionKey: string, messages: QueueMessage[]): QueueMessage[]` — 若 `mergePreviewBySession` 存在且 unclaimed 仅 1 条（或 override 语义），将返回给 poll 的单条 `text` 替换为 `mergedText` override；多 messageId ack 语义与现网整批一致
  - 在 `/api/poll-message` 返回前对 `messages` 调用 `applyMergeOverrideForPoll`；领取成功后 `clearMergePreviewState`
  - 在 `ackOnReply` 成功路径增加 `clearMergePreviewState` 兜底
- 修改: 无（若 override 仅 daemon poll 响应即可满足 Agent 侧，则不改 electron；否则在 `pullMergedMessagesFromQueue` 消费端对齐，以实现范围最小为准）

### 接口契约

- `function clearMergePreviewState(sessionKey: string): void`
- `function applyMergeOverrideForPoll(sessionKey: string, messages: QueueMessage[]): QueueMessage[]`

### 验收标准

- [ ] 用户 F3 修改成功后，Agent poll 领取到的合并正文为用户新全文（验收 6）
- [ ] poll 领取（`.qmsg→.claimed`）后不再对该批次发预览或接受修改（F2.6）
- [ ] `ackOnReply` 后会话 preview 状态已清理，后续新批次生成新 MG-id
- [ ] override 与多 messageId ack 不破坏既有「至少一次」投递语义
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1、T6、T7
- 后续任务: 无
