# 飞书作为 Cursor 展示与控制层 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）
> **MVP 范围**：阶段 0 + 阶段 1（T1–T7）；阶段 2/3（T8–T12）标注为后续迭代，依赖 MVP 闭环。

## 1、执行计划

### 1.1 依赖图

**MVP（阶段 0+1）**

```
T1 ──┐
T3 ──┼──→ T2 ──→ T4 ──→ T5 ──→ T6 ──→ T7
```

**阶段 2（后续迭代）**

```
T7 ──→ T8 ──→ T9 ──→ T10
```

**阶段 3（后续迭代）**

```
T7 ──→ T11 ──→ T12
```

### 1.2 分组调度

| 轮次 | 并行任务 | 说明 |
|------|----------|------|
| **第一轮** | T1, T3 | 无共享写文件；T1 去注入、T3 扩 SDK 事件 |
| **第二轮** | T2 | **冲突**：`src/daemon.ts`、`src/shared/lark-core.ts` |
| **第三轮** | T4 | **冲突**：`src/daemon.ts`（续）、`src/shared/lark-core.ts`（工具 CardKit） |
| **第四轮** | T5 | **冲突**：`src/daemon.ts`（claim/dispatch 门控） |
| **第五轮** | T6 | **冲突**：`electron/agent-sdk.ts` |
| **第六轮** | T7 | **冲突**：`src/daemon.ts`、`electron/session-dispatcher.ts`、`electron/config-store.ts` |
| **第七轮**（阶段 2） | T8 | 依赖 T7；冲突 `src/daemon.ts`、`lark-core.ts`、`command-handler.ts` |
| **第八轮**（阶段 2） | T9 | 依赖 T8；冲突 `electron/agent-sdk.ts`、`src/daemon.ts` |
| **第九轮**（阶段 2） | T10 | 依赖 T9；冲突 `src/daemon.ts`、`src/server-admin.ts` |
| **第十轮**（阶段 3） | T11 | 依赖 T7；冲突 `src/daemon.ts`、`electron/agent-sdk.ts` |
| **第十一轮**（阶段 3） | T12 | 依赖 T11；`electron/main.ts`、`electron/daemon-manager.ts` |

**同文件冲突清单（须串行）**

| 文件 | 涉及任务（顺序） |
|------|------------------|
| `src/daemon.ts` | T2 → T4 → T5 → T7 → T8 → T9 → T10 → T11 |
| `electron/agent-sdk.ts` | T3 → T6 → T9 → T11 |
| `src/shared/lark-core.ts` | T2 → T4 → T8 |
| `electron/session-dispatcher.ts` | T1（删 inject 调用）→ T7（SDK-only + 调度瘦身） |

## 2、任务清单

---

## T1: 移除 workspace-injector 写入路径（S0.0）

### 背景

产品决策：Daemon 启动后**不修改**用户/项目 `.cursor`（rules、mcp、skills）。现网 `injectWorkspaceToDir` 在 Agent launch 时写盘，须删除写入路径；可选保留只读清理入口。对应设计步骤 S0.0。

### 上下文文件

- CodeGraph: `injectWorkspaceToDir` — 定位 launch 调用链与 export 面
- 必读: `electron/workspace-injector.ts` — 删除 `injectMcpGlobal`、`injectRulesToDir`、`injectSkillsToDir` 写入实现
- 必读: `electron/session-dispatcher.ts` — 删除 launch 前 `injectWorkspaceToDir` 调用（约 L333）
- 参考: `electron/daemon-manager.ts` — 确认 re-export 是否仍被 UI 依赖

### 实现范围

- 修改: `electron/workspace-injector.ts` — 删除或 stub 写入函数；保留可选 `cleanupLegacyInjection()` 只读清理（若 02 允许）
- 修改: `electron/session-dispatcher.ts` — 移除 `injectWorkspaceToDir` import 与 await 调用
- 删除: launch 路径对 `cursor-claw.mdc` / MCP 注入的**运行时依赖**（不删 template 文件本身）

### 接口契约

- `injectWorkspaceToDir` — **不再写盘**；若保留符号则实现为 no-op 或仅 cleanup
- launch 流程 — 不再依赖 workspace-injector 即可拉起 SDK Agent

### 验收标准

- [ ] Agent launch 前后，用户 `~/.cursor/mcp.json` 与项目 `.cursor/rules` **mtime/内容不变**（02 §八·（二）第 12 项）
- [ ] `session-dispatcher.launchAgent` 不再 await 任何 inject 写入
- [ ] SDK Agent 工作区无 `cursor-claw.mdc` 注入仍可被后续 T6/T7 验收（本任务仅保证不写盘）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T7（调度迁入后彻底断开 inject 链）

---

## T2: MergeBatch 状态机与合并 CardKit（M-impl-1/2/3/4）

### 背景

连发 N 条消息时用户只感知**一张会更新的合并 CardKit**，替代现网 F1 逐条 + 文本预览 debounce 多轨刷屏。实现 `MergeBatch` 替代 `MergePreviewState`，含 collecting 静默计时、单卡 PATCH、F1 门控与编辑 fallback。对应 S0 步骤 M-impl-1～4。

### 上下文文件

- CodeGraph: `MergePreviewState` `scheduleMergePreview` `sendMergePreview` — 现网合并预览链
- 必读: `src/daemon.ts` — `mergePreviewBySession`、`buildEnqueueStatusText`、`tryHandleMergePreviewReply`、入队回调
- 必读: `src/shared/lark-core.ts` — `createStreamingCardEntity` 等 CardKit PATCH API
- 参考: `src/file-queue.ts` — 入队与 ack 语义

### 实现范围

- 修改: `src/daemon.ts` —
  - 新增 `MergeBatch` / `MergeBatchPhase` / `mergeBatchBySession: Map`（字段见 02 §五）
  - `onMessageEnqueued`：≥2 条进入 collecting，启动 `MERGE_QUIET_MS`（默认 2500）静默计时
  - **删除** `scheduleMergePreview`、`sendMergePreview`、`ensureMergePreviewSentBeforeClaim`
  - F1 门控（M3）：第 2+ 条 collecting 时 suppress 逐条 F1；单条仍正常 F1
  - `tryHandleMergePreviewReply` 仅认 `cardMessageId`（fallback 编辑路径）
  - rename `formatMergePreviewBody` → `formatMergeBody`
- 修改: `src/shared/lark-core.ts` — `renderMergeBatchCard`：单 `outbound_message_id` PATCH 更新（标题/条目列表/倒计时脚/按钮占位）
- 新增: `POST /api/presentation-event` 分支 `kind: "merge_batch"`（创建/更新卡）

### 接口契约

```typescript
type MergeBatchPhase = "collecting" | "ready" | "locked" | "dispatched" | "cancelled"
interface MergeBatch { sessionKey, batchId, phase, messageIds, overrideText?, cardEntityId?, cardMessageId?, quietTimer?, quietDeadlineAt?, lastInboundMessageId?, createdAt, updatedAt }
function onMessageEnqueued(sessionKey: string, messageId: string, ...): void
function renderMergeBatchCard(batch: MergeBatch): Promise<void>
function formatMergeBody(messages: QueuedMessage[]): string
```

### 验收标准

- [ ] 连发 3 条：用户仅见 **1 张**合并卡 PATCH 更新 + **≤1 条** F1（首条或 batch 汇总），无 3 条预览文本（01 MVP-1/4；02 §八·（二）第 5 项）
- [ ] ≥2 条进入 collecting，最后一条入队后静默计时重置；collecting 期间**不** claim/dispatch
- [ ] 回复合并卡全文可更新 `overrideText`（fallback 路径）
- [ ] 旧 `sendMergePreview` 多文本消息路径已删除
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无（与 T1/T3 可并行，但本任务独占 `daemon.ts` 须在第三轮前完成 T1/T3）
- 后续任务: T4, T5

---

## T3: SDK 侧 tool/thinking 执行事件出站（S1.5-a/b）

### 背景

统一 Presentation Pipeline 要求 SDK 执行流中的 **tool** 与 **thinking** 事件经 HTTP 推送至 Daemon，而非 Agent 自由 `send_text`。本任务仅改 `agent-sdk.ts` 事件解析与 POST，Daemon 路由由 T4 完成。

### 上下文文件

- CodeGraph: `handleSdkEvent` `postStreamText` `streamRunEvents` — SDK 事件链
- 必读: `electron/agent-sdk.ts` — `handleSdkEvent`、`postStreamText`、`f41Eligible`
- 参考: `src/daemon.ts` — 现有 `POST /api/stream-text` 契约

### 实现范围

- 修改: `electron/agent-sdk.ts` —
  - `handleSdkEvent` 扩展：识别 tool_call / thinking 类 SDKMessage，映射为 `PresentationEvent`
  - 新增 `postPresentationEvent(session, payload)` POST 至 `/api/presentation-event`（或扩展 stream-text，与 T4 对齐一种）
  - `SdkSessionAgent` 扩展：`presentationOutboundId?`（工具卡更新用）
  - assistant 流仍走现有 `postStreamText`，不重复发送进度文本

### 接口契约

```typescript
type PresentationKind = "assistant" | "thinking" | "tool" | "diff" | "merge_batch"
interface PresentationEvent { session_key, kind, delta?, tool_name?, tool_status?: "started"|"completed"|"failed", final?, outbound_message_id? }
async function postPresentationEvent(session: SdkSessionAgent, event: PresentationEvent): Promise<void>
```

### 验收标准

- [ ] SDK Run 中 tool 开始/完成时，Daemon 收到结构化 `PresentationEvent`（01 MVP-2；01 验收 2）
- [ ] thinking 摘要增量可 POST（供 T4 渲染）
- [ ] Agent **不**再主路径 `notifySessionChat` 发送与管道语义重叠的工具进度文本（01 验收 4）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T4, T6

---

## T4: Daemon Presentation 路由、工具 CardKit 与群聊 eligible（S1.5-c, S1.8）

### 背景

Daemon 侧统一接收 `PresentationEvent`，路由至飞书 CardKit：流式正文、思考摘要、**工具进度卡片**；并与合并卡 NF2 协调（同 session 不抢 stream 首屏）。扩展群聊 SDK 为阶段 0 第二验收通道。

### 上下文文件

- CodeGraph: `handleStreamText` `isStreamTextEligible` — 现网管道门控
- 必读: `src/daemon.ts` — `handleStreamText`、stream eligible 逻辑、新增 `handlePresentationEvent`
- 必读: `src/shared/lark-core.ts` — 工具进度 CardKit（参考 `createStreamingCardEntity`）
- 必读: `electron/agent-sdk.ts` — T3 产出的事件 payload 形状

### 实现范围

- 修改: `src/daemon.ts` —
  - 新增 `handlePresentationEvent(body: PresentationEvent)`：按 kind 路由 assistant/thinking/tool
  - 扩展 `isStreamTextEligible` / 群聊 SDK eligible（S1.8）
  - NF2：merge 卡与 stream 卡共存策略（reply 链挂首条 inbound 或 pin 底部，二选一实现）
  - 失败日志区分 `presentation_failed`（02 §八·（二）第 10 项）
- 修改: `src/shared/lark-core.ts` — 工具进度 CardKit 创建/PATCH（tool_name + status）

### 接口契约

- `POST /api/presentation-event` — Daemon 入口，body 为 `PresentationEvent`
- `handlePresentationEvent(event: PresentationEvent): Promise<{ ok: boolean; outbound_message_id?: string; error?: string }>`

### 验收标准

- [ ] 工具执行期间飞书出现结构化工具进度 CardKit，与流式正文不冲突刷屏（01 MVP-2/4；01 验收 2）
- [ ] **群聊 SDK** 通道流式/工具事件走同一管道（01 阶段 0 补充验收 5；02 §八·（二）第 3 项）
- [ ] 同 session 有 merge 卡时 stream 首包不争用首屏（NF2）
- [ ] 日志含 `presentation_failed` 可检索字段
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2, T3
- 后续任务: T5

---

## T5: 静默窗口、claim-and-merge 与 dispatch 门控（M-impl-5/6/7, S1.1）

### 背景

批次 `ready` 后才允许 claim 与 dispatch；支持 [立即发送]/[拆开逐条]；Agent processing 时 batch 排队，idle 后自动 flush。禁止 collecting 静默窗口内抢跑 claim。对应阶段 1 合并投递核心。

### 上下文文件

- CodeGraph: `pullMergedMessagesFromQueue` `sessionAgentPhaseMap` — claim 与 phase 协作
- 必读: `src/daemon.ts` — dispatch 触发点、`session-agent-phase` handler、merge 相关 HTTP
- 参考: `electron/session-dispatcher.ts` — 现网 `dispatchSessionAgents` 行为（T7 迁入参考）

### 实现范围

- 修改: `src/daemon.ts` —
  - `merge_send_now` → phase `ready`；`merge_split` → `cancelled` 并按单条 dispatch
  - 新增 `POST /api/merge-batch/action` `{ session_key, action, text? }`
  - 新增 `POST /api/orchestrator/claim-and-merge`：仅 `phase=ready|locked` 且 M7 通过；返回 `{ text, message_ids[] }`
  - dispatch 循环：**等待 batch ready**，collecting 不 claim
  - Agent `processing` 时卡片显示排队；`POST /api/session-agent-phase` idle → `flushReadyMergeBatches(sessionKey)`
  - 主动投递 P95 ≤ 3s（自 ready 起算，不含 collecting）

### 接口契约

```typescript
POST /api/merge-batch/action
POST /api/orchestrator/claim-and-merge → { text: string; message_ids: string[] }
function flushReadyMergeBatches(sessionKey: string): Promise<void>
function shouldDeferDispatch(sessionKey: string): boolean  // 替代 shouldSuppressMergePreview
```

### 验收标准

- [ ] 静默窗口内不 dispatch；点 [立即发送] 或窗口结束后 dispatch；内容与 `formatMergeBody` 一致（02 §八·（二）第 6 项）
- [ ] Agent processing 连发：合并卡显示排队；idle 后自动投递 ready batch（02 §八·（二）第 7 项；01 场景 A）
- [ ] [拆开逐条]：取消合并，按单条 dispatch（02 §八·（二）第 9 项）
- [ ] 编辑后投递内容 = `overrideText`（02 §八·（二）第 8 项）
- [ ] `claim-and-merge` 与 ack 语义一致：至少一次投递、reply 后清理 `.claimed`（02 §八·（二）第 4 项）
- [ ] ready → dispatch P95 ≤ 3s（01 NF1；02 §八·（二）第 10 项）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2, T4
- 后续任务: T6, T7

---

## T6: SDK 长驻 Agent 与主动二次 send（S1.2/S1.6/S1.3）

### 背景

修复现网 `launchSdkAgent` Run 结束即 `agent.close()` 导致每轮像新会话的问题。Run 结束后保持 Agent 实例；Orchestrator 通过 `agent.send()` 主动投递合并任务，废弃 poll 领取。Feature flag `SDK_RESIDENT_AGENT` 控制是否 close。

### 上下文文件

- CodeGraph: `launchSdkAgent` — impact 7 symbols（session-dispatcher 全 launch 链）
- 必读: `electron/agent-sdk.ts` — `launchSdkAgent`、`streamRunEvents` 收尾、`SdkSessionAgent`
- 参考: `src/daemon.ts` — T5 的 `claim-and-merge` 与 dispatch HTTP 调用点

### 实现范围

- 修改: `electron/agent-sdk.ts` —
  - `SdkSessionAgent` 增加 `residentMode: boolean`、`pendingDispatch: boolean`
  - `streamRunEvents` 收尾：`residentMode` 时 **不** `agent.close()`，phase → idle 通知 Daemon
  - 新增 `dispatchToSdkAgent(sessionKey, taskText)`：`agent.send(prompt)` 二次投递，防并发 `pendingDispatch`
  - `launchSdkAgent`：首次 create + send；后续由 dispatch 调 `dispatchToSdkAgent`
  - 暴露 `POST /api/agent/dispatch`（Electron HTTP 或 Daemon 转发，与 T7 对齐）

### 接口契约

```typescript
interface SdkSessionAgent { residentMode: boolean; pendingDispatch: boolean; /* 现有字段 */ }
async function dispatchToSdkAgent(sessionKey: string, taskText: string): Promise<{ ok: boolean; error?: string }>
// Run 结束：notifySessionPhase(sessionKey, "idle") 触发 T5 flushReadyMergeBatches
```

### 验收标准

- [ ] 主用户私聊 SDK：Agent 运行中连发 3 条，**无** blocking poll，合并内容正确投递（01 MVP-1/3；01 验收 1/3）
- [ ] Run 结束后 Agent 实例仍驻留，再次 `agent.send` 保留上下文（01 场景 E）
- [ ] 同 Agent 连续两次 `send` 行为记录至 implement 阶段 08-verify（02 §八·（二）第 11 项）
- [ ] 投递失败 notify 含 `dispatch_failed` 日志字段（01 NF5）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T3, T5
- 后续任务: T7

---

## T7: SDK-only 移除 CLI spawn/poll 与调度迁入 Daemon（CLI-1/2/3, S1.1-b）

### 背景

IM 调度 **SDK-only**：删除 CLI spawn、poll-message、SYSTEM OVERRIDE；通道配置迁移至 SDK 资源；`dispatchSessionAgents` 核心逻辑迁入 `daemon.ts`，Daemon 单进程闭环 IM→调度→展示。MVP 架构转折点收官任务。

### 上下文文件

- CodeGraph: `dispatchSessionAgents` `_launchCliAgent` `poll-message` — 调度与 poll 链
- 必读: `electron/session-dispatcher.ts` — `launchAgent` CLI 分支、`dispatchSessionAgents`
- 必读: `src/daemon.ts` — 删除 `GET /api/poll-message`；新增 dispatch 循环调用 `launchSdkAgent`/`dispatch`
- 必读: `electron/config-store.ts` — 通道 `agentResourceId` 默认与迁移
- 参考: `electron/daemon-manager.ts` — 停止 Electron 侧 queue 扫描（若存在）

### 实现范围

- 修改: `electron/session-dispatcher.ts` —
  - **删除** `_launchCliAgent` 及 `resource.type !== "sdk"` 分支
  - `launchAgent` 仅 HTTP 调 Daemon `/api/agent/launch`（SDK）
  - `dispatchSessionAgents` 瘦身为转发或删除，逻辑下沉 Daemon
- 修改: `src/daemon.ts` —
  - **删除** `GET /api/poll-message`、`waitForSessionMessages`、blocking SYSTEM OVERRIDE
  - 实现 Daemon 内 dispatch 循环：queue 变更 → claim-and-merge → launch/dispatch
  - 未配置 SDK Key：入队可确认，dispatch 失败 notify「请配置 SDK 资源」
- 修改: `electron/config-store.ts` — 启动时 `agentResourceId: "cli"` 自动切首个 SDK 资源或拒绝调度

### 接口契约

- `GET /api/poll-message` — **404/删除**
- `POST /api/agent/launch` / `POST /api/agent/dispatch` — Daemon SSOT
- `launchAgent` — 仅 `resource.type === "sdk"`

### 验收标准

- [ ] 全通道 IM 调度 **无** CLI 子进程；`poll-message` 404（02 §八·（二）第 1 项；01 验收 6）
- [ ] 通道未配置 SDK API Key：入队可确认，dispatch 失败 notify 可理解（02 §八·（二）第 2 项）
- [ ] 单 Daemon 进程：IM 入站 → 调度 → 展示出站闭环，无 Electron 自主 queue 扫描（02 §八·（二）第 13 项）
- [ ] Agent 规则无 poll/保活阶段用户可见副作用（01 验收 6）
- [ ] 日志区分 `dispatch_failed` / `agent_failed`（01 NF5）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T6
- 后续任务: T8, T11（阶段 2/3）

---

## T8: 飞书卡片控制与 merge 编辑表单（S2.1, S2.3）— 阶段 2

### 背景

阶段 2 产品化飞书控制层：停止、新话题、工作区、模型等高频操作经卡片回调进入指令总线；合并卡 [编辑] 正式表单态，与 control-command 幂等统一。后续迭代，依赖 MVP 闭环。

### 上下文文件

- CodeGraph: `command-handler` `/stop` `/chat new` — 现有斜杠处理
- 必读: `src/daemon.ts` — 控制指令总线（`Map` 内联）
- 必读: `src/shared/lark-core.ts` — 卡片 callback 注册
- 必读: `electron/command-handler.ts` — 复用 `/stop`、`/chat new`、`/model`、`/workspace`

### 实现范围

- 修改: `src/daemon.ts` — 飞书 `card.action.trigger` → `POST /api/control-command`；幂等键 `command_id`
- 修改: `src/shared/lark-core.ts` — 控制卡 + merge 编辑表单态
- 修改: `electron/command-handler.ts` — 卡片与斜杠统一入口映射

### 接口契约

- `POST /api/control-command` — `{ command_id, action: "stop"|"new_chat"|"merge_edit"|..., session_key, ... }`

### 验收标准

- [ ] 用户可通过飞书卡片完成停止与新话题，Orchestrator 正确终止或路由（01 阶段 2 验收 7）
- [ ] 合并预览可编辑与 50041 语义一致，Orchestrator 驱动（01 验收 8）
- [ ] 控制指令幂等或可识别重复点击（01 NF3）
- [ ] 日志含 `control_failed` 字段
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T7
- 后续任务: T9

---

## T9: 工具批准卡片闭环（S2.2）— 阶段 2

### 背景

Agent 请求敏感工具时，Orchestrator 渲染批准卡片；用户点击后 control-command 回传 SDK 继续或中止。对应场景 B。

### 上下文文件

- CodeGraph: `handleSdkEvent` — SDK 批准相关事件
- 必读: `electron/agent-sdk.ts` — 订阅批准事件、回传 SDK API
- 必读: `src/daemon.ts` — 批准总线与卡片 outbound

### 实现范围

- 修改: `electron/agent-sdk.ts` — 批准事件 → POST Daemon；接收 approve/reject 指令
- 修改: `src/daemon.ts` — 批准卡片创建/更新；`control-command` action `approve_tool`

### 接口契约

- `PresentationEvent` kind 扩展或专用 approve 事件
- `control-command` action `approve_tool` / `reject_tool`

### 验收标准

- [ ] 工具批准卡片闭环：批准/拒绝后 Agent 继续或中止，用户收到明确反馈（01 阶段 2 验收 9；场景 B）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T8
- 后续任务: T10

---

## T10: 废弃 MCP 与管理 HTTP 统一（S2.4）— 阶段 2

### 背景

cursor-claw 与 cursor-claw-admin MCP 能力合并至 Daemon HTTP；删除 `/mcp`、`/mcp-admin` 路由；`server-admin` 逻辑下沉为 HTTP handler，飞书/斜杠直连。

### 上下文文件

- CodeGraph: `createMcpServer` `registerAdminTools` — MCP 注册链
- 必读: `src/daemon.ts` — MCP 路由（约 L1543、L1611）
- 必读: `src/server-admin.ts` — `manage_agent` 等工具映射

### 实现范围

- 修改: `src/daemon.ts` — 删除 MCP 路由；补齐 `/api/agent`、`/api/status` 等 HTTP 覆盖 admin 分支
- 修改: `src/server-admin.ts` — 注册层删除，逻辑保留为 HTTP handler 调用

### 接口契约

- `/mcp`、`/mcp-admin` — **删除**
- 原 `manage_*` MCP tools → 等价 Daemon HTTP endpoints

### 验收标准

- [ ] MCP 路由不可访问；admin 能力经 Daemon HTTP 可用（01 F2.4）
- [ ] 启动后不写入用户 `.cursor` MCP 配置
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T9
- 后续任务: 无（阶段 2 收官）

---

## T11: Agent 标识持久化与 Daemon 重启恢复（S3.1）— 阶段 3

### 背景

阶段 3：Agent `agentId` 与会话状态写入 `~/.cursor-claw/sessions.json`，Daemon 重启后可 `Agent.resume` 或给出续聊引导。

### 上下文文件

- CodeGraph: `launchSdkAgent` `SdkSessionAgent` — 会话生命周期
- 必读: `src/daemon.ts` — 调度态持久化读写
- 必读: `electron/agent-sdk.ts` — `Agent.resume(agentId)`

### 实现范围

- 修改: `src/daemon.ts` — 读写 `sessions.json`；重启恢复流程
- 修改: `electron/agent-sdk.ts` — resume 路径与 agentId 持久化字段

### 接口契约

```typescript
// ~/.cursor-claw/sessions.json
{ [session_key: string]: { agent_id: string; workspace_dir: string; last_run_at: number } }
```

### 验收标准

- [ ] Daemon 重启后主用户私聊会话可恢复或明确续聊引导（01 阶段 3 验收 10）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T7
- 后续任务: T12

---

## T12: Electron 退为托盘 spawn-only（S3.2）— 阶段 3

### 背景

Electron 仅负责 spawn/monitor Daemon 与托盘配置；会话编排、IM、调度、展示主路径在 Daemon + 飞书。

### 上下文文件

- CodeGraph: `daemon-manager` `connectSseQueueEvents` — Electron 与 Daemon 耦合点
- 必读: `electron/main.ts` — 窗口与 Daemon 生命周期
- 必读: `electron/daemon-manager.ts` — 停止 queue 扫描/SSE 调度残留

### 实现范围

- 修改: `electron/main.ts` — 退为托盘 + 配置；不承载会话编排
- 修改: `electron/daemon-manager.ts` — 移除/降级 `dispatchSessionAgents` 触发；仅 health/monitor

### 接口契约

- Electron — 不直接 scan queue 或 launch Agent（除 monitor fallback）

### 验收标准

- [ ] 用户日常对话与控制不依赖 Electron 主窗口（01 阶段 3 验收 11）
- [ ] 新功能默认走 SDK；CLI 仅 fallback（01 F3.3）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T11
- 后续任务: 无
