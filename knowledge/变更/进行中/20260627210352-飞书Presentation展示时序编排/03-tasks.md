# 飞书 Presentation 展示时序编排 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）
> **MVP 范围**：主用户私聊 SDK；`PRESENTATION_ORDERING` 开关控制；群聊/CLI 阶段 2 不在本批任务内。

## 1、执行计划

### （一）依赖图

```
T1 ──→ T2 ──→ T3 ──→ T4 ──→ T5 ──→ T6
                            └──→ T7
```

- **T1**：feature 开关与 eligible 门控（daemon + electron，小改动，无状态机）
- **T2**：`SessionProgressState` 编排字段 + 过程闩锁（tool/thinking 入口）
- **T3**：`handleStreamText` 延迟首建 + `releaseDeferredAssistantStream`（Daemon CardKit SSOT）
- **T4**：Electron `handleSdkEvent` 延迟 POST + 缓冲释放（依赖 T3 的 `deferred` 响应契约）
- **T5**：NF1 顺序违规日志 + Run 间状态清零强化（双端收尾）
- **T6**：MergeBatch 不回归 + 01 验收 1–6 端到端实测（无代码改动）
- **T7**：`src/AGENTS.md` / `electron/AGENTS.md` 文档同步（与 T6 可并行）

### （二）分组调度

| 轮次 | 任务 | 并行 | 说明 |
|------|------|------|------|
| **第一轮** | T1 | — | 新增 `presentationOrderingEnabled` / `presentationOrderingEligible`；无编排状态 |
| **第二轮** | T2 | — | **冲突**：`src/daemon.ts`（`SessionProgressState` 扩展 + tool/thinking 闩锁） |
| **第三轮** | T3 | — | **冲突**：`src/daemon.ts`（`handleStreamText` 门控 + 释放函数） |
| **第四轮** | T4 | — | **冲突**：`electron/agent-sdk.ts`（SDK 侧延迟 POST 链） |
| **第五轮** | T5 | — | **冲突**：`src/daemon.ts` + `electron/agent-sdk.ts`（NF1 日志 + reset 强化） |
| **第六轮** | T6, T7 | 可并行 | T6 联调验收；T7 文档（不写业务逻辑） |

**同文件冲突清单（须串行）**

| 文件 | 涉及任务（顺序） |
|------|------------------|
| `src/daemon.ts` | T1 → T2 → T3 → T5 |
| `electron/agent-sdk.ts` | T1 → T4 → T5 |

## 2、任务清单

---

## T1: PRESENTATION_ORDERING 功能开关与 MVP 范围门控

### 背景

时序编排须可回滚（01 F6、NF2；验收 6）。在 Daemon 与 Electron 双端引入 `PRESENTATION_ORDERING` 环境变量门控，默认开启，且**仅**作用于主用户私聊 SDK（与既有 `f41Eligible` / `isMainUserP2pEligible` 对齐）。开关关闭时走现网 S3-L「先到先展示」，本任务只落地门控函数，不改动流式/过程卡逻辑。

### 上下文文件

- CodeGraph: `f41Eligible` `isMainUserP2pEligible` — MVP 范围对齐
- 必读: `src/daemon.ts` — `isMainUserP2pEligible`（约 L373）、环境变量读取惯例
- 必读: `electron/agent-sdk.ts` — `f41Eligible` / `f41Stream`（约 L99–112、L644）
- 参考: `01-proposal.md` §功能需求 F6、§非功能 NF2、§验收 6

### 实现范围

- 修改: `src/daemon.ts` — 新增 `presentationOrderingEnabled(sessionKey: string): boolean`：
  - 读 `process.env.PRESENTATION_ORDERING`：未设置或 `1`/`true` 为开启；`0`/`false` 为关闭
  - 开启时须同时满足 `isMainUserP2pEligible(sessionKey)`
- 修改: `electron/agent-sdk.ts` — 新增 `presentationOrderingEligible(session: SdkSessionContext): boolean`：
  - 镜像 daemon 逻辑：`PRESENTATION_ORDERING` 开启 **且** `f41Stream && p2p`（与 `f41Eligible` 私聊分支一致）
- 不改: `handleStreamText`、`handleSdkEvent` 行为（后续任务接入）

### 接口契约

- `presentationOrderingEnabled(sessionKey: string): boolean` — Daemon 编排总开关；后续 T2–T5 在门控为 false 时**不得**写入编排字段或改变现网首建卡时机
- `presentationOrderingEligible(session): boolean` — Electron 是否参与延迟 POST；export 或同文件内可被 `handleSdkEvent` 调用

### 验收标准

- [ ] `PRESENTATION_ORDERING=0` 时两函数均返回 false（主用户私聊亦然）
- [ ] 未设置 env 时默认 true，且非主用户私聊 / 非 f41 流式路径返回 false
- [ ] 开关关闭路径下，现有 assistant 首 delta 即建卡行为**未被本任务意外改动**（回归 smoke：单条纯对话仍首包建卡）
- [ ] 01 验收 6 之「关闭开关恢复先到先展示」可在 T5/T6 完整验证；本任务仅保证门控函数正确
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T2, T4

---

## T2: SessionProgressState 编排字段与过程闩锁

### 背景

方案 A 核心状态：本 Run 一旦进入「过程活跃」，禁止 assistant 首建 CardKit，过程卡先发。须在 Daemon 内存 SSOT `SessionProgressState` 扩展编排字段，并在 tool/thinking 事件入口置闩锁。thinking **一律**视为过程；tool `running` 加入活跃集合，`completed`/`failed` 移除。

### 上下文文件

- CodeGraph: `SessionProgressState` `handleToolPresentationEvent` `handleThinkingPresentationEvent` — 状态与过程卡入口
- 必读: `src/daemon.ts` — `SessionProgressState`（约 L294）、`handleToolPresentationEvent`（约 L1130）、`handleThinkingPresentationEvent`（约 L1196）、`sessionProgressMap`（约 L616）
- 参考: `src/daemon.ts` — 既有 `toolCards` 分卡逻辑（多 tool 不重复刷屏，01 F4）

### 实现范围

- 修改: `src/daemon.ts` — 扩展 `SessionProgressState`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `presentationProcessActive` | `boolean` | 本 Run 已见过程且尚未 idle |
| `activeToolNames` | `Set<string>` | `started`/`running` 的 tool_name |
| `thinkingOpen` | `boolean` | 收到 thinking 且未收 `final` |
| `deferredAssistantText` | `string` | 延迟期间累积 assistant 全文 |
| `assistantCardReleased` | `boolean` | 已首建 assistant 卡，防重复 |
| `runPresentationEpoch` | `number` | 与 Electron `runStartedAt` 对齐 |

- 新增: `isPresentationProcessIdle(state): boolean` — `activeToolNames.size === 0 && !thinkingOpen`
- 修改: `handleToolPresentationEvent` — 当 `presentationOrderingEnabled(sessionKey)`：
  - `tool_status` 为 `started`/`running`：加入 `activeToolNames`，置 `presentationProcessActive = true`
  - `completed`/`failed`：从集合移除；若 idle 则**标记待释放**（实际释放由 T3 `releaseDeferredAssistantStream` 执行，本任务可留 hook 或空调用占位并在 T3 实现）
- 修改: `handleThinkingPresentationEvent` — 开关开启时首个 thinking delta：`thinkingOpen = true`、`presentationProcessActive = true`；thinking `final`：`thinkingOpen = false`
- 门控为 false 时：不写入上述编排字段，行为与现网一致

### 接口契约

- `SessionProgressState` 上述 6 字段 — T3/T5 读写 SSOT
- `isPresentationProcessIdle(state): boolean` — T3/T4 过程结束判定
- tool/thinking 处理仍调用既有 `getPresentationReplyAnchor(sessionKey)`（MergeBatch NF2 **不改**）

### 验收标准

- [ ] thinking 首 delta 后 `presentationProcessActive === true` 且 `thinkingOpen === true`
- [ ] tool `running` 期间 `activeToolNames` 非空；全部 `completed`/`failed` 且 thinking final 后 idle 为 true
- [ ] 开关关闭时不 mutate 编排字段
- [ ] 01 验收 3 之多 tool：`activeToolNames` + 既有 `toolCards` 不导致同一工具重复「开始/完成」卡（F4）
- [ ] 02 §八·（二）：新 Run 后字段初始为 false/空（与 T5 `startSdkRun` 清零联调；本任务须在新 Run 初始化路径清零编排字段）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1
- 后续任务: T3, T5

---

## T3: Daemon handleStreamText 延迟首建与 releaseDeferredAssistantStream

### 背景

CardKit 消息创建时间决定飞书时间轴顺序。当 `presentationProcessActive` 为 true 时，assistant delta **不得**触发首建 CardKit，仅累积 `deferredAssistantText`；过程 idle 或 Run `final` 时调用 `releaseDeferredAssistantStream` 首建卡并 PATCH。纯对话（本 Run 从未过程活跃）走现网 S5-P 首 delta 即建卡，满足 01 验收 2 / NF3。

### 上下文文件

- CodeGraph: `handleStreamText` `getPresentationReplyAnchor` — 首建门控与 MergeBatch reply
- 必读: `src/daemon.ts` — `handleStreamText`（约 L471）、`getPresentationReplyAnchor`（约 L398）
- 必读: `src/shared/lark-core.ts` — CardKit 创建/PATCH API（schema **不改**）
- 参考: T2 产出的 `SessionProgressState` 字段与 `isPresentationProcessIdle`

### 实现范围

- 修改: `src/daemon.ts` — `handleStreamText`：
  - 若 `presentationOrderingEnabled && presentationProcessActive && !assistantCardReleased && isFirst（或无 outboundMessageId）`：将 delta 追加到 `deferredAssistantText`，返回 `{ ok: true, deferred: true }`（可选字段），**不**调用 CardKit 创建
  - 若已 `assistantCardReleased` 或过程不活跃：走现网流式 PATCH 链
  - `final: true`：若尚未 release，**强制** `releaseDeferredAssistantStream` 再 flush（01 验收 5：异常/中止仍有结论）
- 新增: `releaseDeferredAssistantStream(sessionKey, state, opts?)`：
  - 仅在 `!assistantCardReleased` 且（idle 或 force）时执行
  - 以现网 `isFirst` 逻辑首建 assistant CardKit，初始内容为 `deferredAssistantText`（及当前 buffer）
  - 首建时传入 `getPresentationReplyAnchor(sessionKey)`（MergeBatch M-NF2 **不改锚点**）
  - 置 `assistantCardReleased = true`，后续 delta 走 PATCH
  - 失败：打 `presentation_failed` 日志，降级 `sendStreamMessage`，**不丢**缓冲全文（02 §八·（二）第 3 项）
- 修改: tool/thinking idle hook（T2 预留处）— idle 时调用 `releaseDeferredAssistantStream`
- 不改: `MergeBatchController`、`getPresentationReplyAnchor` 内部逻辑

### 接口契约

- `releaseDeferredAssistantStream(sessionKey, state, opts?: { force?: boolean })` — T4 Electron 在收到 daemon deferred 或本地过程结束后依赖此释放
- `POST /api/stream-text` 响应扩展：`{ ok: true, deferred?: true }` — Electron 据此设置 `presentationDeferStream`
- `handleStreamText` — 开关 off 时行为与现网逐字节一致

### 验收标准

- [ ] 含 tool Run：过程进行中 POST stream-text 返回 deferred，**无** `outbound_message_id`；idle 后首建 assistant 卡位于最后过程卡**之下**（01 验收 1、F1/F2）
- [ ] 纯对话（从未 `presentationProcessActive`）：首 delta 3 秒内可见，P95 ≤ 3s 或不明显劣于现网（01 验收 2、F3）
- [ ] Run `final: true` 时若仍 deferred，强制 release，避免「仅有过程、无结论」（01 验收 5）
- [ ] `releaseDeferredAssistantStream` 失败时：`presentation_failed` + `sendStreamMessage` 降级，全文不丢（02 §八·（二）第 3 项）
- [ ] MergeBatch collecting/ready 期间 release 首建仍带 `getPresentationReplyAnchor`（01 验收 4 / F5 之 daemon 侧；完整批次用例在 T6）
- [ ] 02 §八·（二）：同一 Run 3+ 串行 tool 仅 **1** 张 assistant 卡，位于最后过程卡之下
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2
- 后续任务: T4, T5, T6

---

## T4: Electron SDK 事件延迟 POST 与缓冲释放

### 背景

现网 `handleSdkEvent` 对 assistant delta **立即** `appendStreamDelta` → `postStreamText`，首包即 Daemon 建卡，早于后到的 tool/thinking 卡。须在 Electron 侧镜像过程感知：见 tool/thinking 后延迟 POST，过程 idle 或 Run 结束前 `flushDeferredStreamPost` 释放缓冲，与 Daemon T3 双端协调（Daemon 为 CardKit 创建 SSOT）。

### 上下文文件

- CodeGraph: `handleSdkEvent` `appendStreamDelta` `postStreamText` `resetSdkRunPresentationState` — 延迟改造主入口
- 必读: `electron/agent-sdk.ts` — `handleSdkEvent`（约 L471）、`postStreamText` / `appendStreamDelta` / `flushStreamPost`（约 L219–300）、`resetSdkRunPresentationState`（约 L69）、`streamRunEvents`
- 必读: T1 的 `presentationOrderingEligible`；T3 的 `deferred` 响应契约

### 实现范围

- 修改: `SdkSessionAgent`（或等价 session 状态）扩展：
  - `presentationDeferStream: boolean` — daemon 曾返回 deferred 或本地已见过程
  - `seenProcessEvent: boolean` — 本 Run 是否出现过 tool/thinking
- 修改: `handleSdkEvent`：
  - tool/thinking 分支：`seenProcessEvent = true`；若 eligible 则 `presentationDeferStream = true`
  - assistant 分支：若 `presentationOrderingEligible && (presentationDeferStream || seenProcessEvent)` 且过程未 release：只累积 `streamBuffer`，**不** `scheduleStreamPost`
  - 纯对话：`!seenProcessEvent` 时首包仍立即 POST（01 F3）
- 新增: `maybeReleaseDeferredAssistant(agent)` — idle 检测后 `flushDeferredStreamPost`（POST 累积 buffer，触发 T3 release）
- 修改: `streamRunEvents` — Run 收尾 `final: true` 前强制 release（与 T3 force 对齐）
- 修改: `resetSdkRunPresentationState` / `startSdkRun` — 清零 `presentationDeferStream`、`seenProcessEvent`、`streamBuffer` 编排相关状态

### 接口契约

- `maybeReleaseDeferredAssistant(agent): void` — tool completed / thinking final 后由 `handleSdkEvent` 调用
- `flushDeferredStreamPost(agent): Promise<void>` — 将 buffer POST 至 `/api/stream-text`，处理 `deferred` 与正常 outbound
- `resetSdkRunPresentationState` — 与 Daemon 编排字段同步清零（跨 Run 不继承闩锁，02 §八·（二）第 4 项）

### 验收标准

- [ ] 含 tool Run：assistant preamble 在过程结束前**不** POST；过程结束后一次 flush，飞书仅 **1** 张 assistant 卡且在过程卡下方（01 验收 1；preamble 与结论同卡，过程期间不可见可接受）
- [ ] 纯对话：首 delta 仍触发 POST，无明显额外空窗（01 验收 2）
- [ ] Run 异常中断：`final` 路径仍 flush，不出现永久缓冲卡死（01 验收 5）
- [ ] 新 Run `startSdkRun` 后 Electron 编排布尔均为 false（02 §八·（二）第 4 项）
- [ ] 开关关闭：恢复立即 `appendStreamDelta` → `postStreamText`（01 验收 6，与 T5 联调）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1, T3
- 后续任务: T5, T6

---

## T5: NF1 顺序违规日志与 Run 间状态清零强化

### 背景

可观测性与回滚安全：顺序违规须 WARN 日志归因（NF1）；开关关闭或新 Run 开始须无 `deferredAssistantText` / 闩锁残留，避免下一 Run 卡死或重复建卡（01 验收 6、NF4；02 §八·（二）第 1、4、5 项）。

### 上下文文件

- CodeGraph: `handleStreamText` `handleToolPresentationEvent` `resetSdkRunPresentationState` `startSdkRun` — 违规检测与清零挂点
- 必读: `src/daemon.ts` — T2/T3 编排字段、`handleStreamText`、过程卡 handler
- 必读: `electron/agent-sdk.ts` — T4 defer 字段、`resetSdkRunPresentationState`
- 参考: `01-proposal.md` §非功能 NF1、NF4、NF5

### 实现范围

- 新增: `src/daemon.ts` — `logPresentationOrderViolation(ctx)`：
  - 触发条件（debug 或开关关闭对比模式）：assistant 已有 `outboundMessageId` 后仍**首建** tool/thinking 过程卡 → WARN
  - 日志字段：`session_key`, `stream_id`, `assistant_msg_id`, `process_kind`, `process_msg_id`, `ordering_enabled`
  - 事件名可检索，如 `presentation_order_violation`；**仅 WARN，不阻断出站**（02 §八·（二）第 5 项）
- 修改: `handleToolPresentationEvent` / `handleThinkingPresentationEvent` — 在首建过程卡前检测顺序违规并调用上述日志
- 强化: `startSdkRun` / `resetSdkRunPresentationState` / session progress 初始化 — 清零全部编排字段（T2 六字段 + Electron T4 两字段）
- 强化: `PRESENTATION_ORDERING=0` 路径 — 跳过 defer 分支，且不保留 `deferredAssistantText` 跨 Run（02 §八·（二）第 1 项）
- 确认: 过程卡/结论卡文案仍不暴露 tool 内部模块名（NF5，沿用现网 render 链）

### 接口契约

- `logPresentationOrderViolation(ctx: { sessionKey, streamId, assistantMsgId, processKind, processMsgId, orderingEnabled }): void`
- Run 重置 — Daemon `sessionProgressMap` 与 Electron `SdkSessionAgent` 编排字段一并归零

### 验收标准

- [ ] 人为制造「assistant 先建、过程后建」时（如开关 off 现网路径）产生 `presentation_order_violation` WARN，字段齐全（NF1）
- [ ] 开关 on 的正常 defer 路径**不**误报 violation
- [ ] `PRESENTATION_ORDERING=0` 后下一 Run 无 defer 残留、无 assistant 卡死（01 验收 6；02 §八·（二）第 1 项）
- [ ] 新 Run 后 `presentationProcessActive === false`（02 §八·（二）第 4 项）
- [ ] 同 Run 重试事件不重复首建 assistant 卡（`assistantCardReleased` 幂等，NF4）
- [ ] UI/卡片文案不含内部 tool 模块名（NF5）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2, T3, T4
- 后续任务: T6, T7

---

## T6: MergeBatch 不回归与端到端验收

### 背景

本变更为 Presentation **时序**增量，须证明不破坏已归档 MergeBatch reply 锚定、合并预览、F1 抑制与排队反馈（01 验收 4、F5；场景 D）。同时执行 01 全部验收 1–6 与 02 §八·（二）工程项的联调实测，作为 MVP 放行门禁。

### 上下文文件

- 必读: `src/daemon.ts` — `MergeBatchController`、`getPresentationReplyAnchor`（**仅读**，验证不改）
- 必读: `knowledge/变更/归档/20260627162620-飞书作为Cursor展示与控制层/05-summary.md` — MergeBatch 与 NF2 基线
- 必读: `knowledge/变更/归档/20260627150041-飞书排队消息状态反馈与合并预览/05-summary.md` — 合并批次行为基线
- 参考: T1–T5 已实现代码（本任务**不修改**业务源码，仅测试与记录）

### 实现范围

- 不修改业务代码（除非发现阻塞性 bug，须单开 repair 任务）
- 执行联调用例并记录结果（可写入 `04-test-report.md`，由 `/kb-test` 正式落盘；本任务验收以 checklist 通过为准）：

| 用例 ID | 场景 | 01 关联 |
|---------|------|---------|
| E1 | 主用户私聊「git pull 最新代码」或等价 shell tool × **≥3** | 验收 1 |
| E2 | 无 tool 短问答 × **≥10**，测首段可见 P95 | 验收 2 |
| E3 | 多步 tool（读文件→命令→读结果）× **≥2** | 验收 3 |
| E4 | 连发触发 MergeBatch + 带 tool 回复 × **≥1** | 验收 4 |
| E5 | tool 失败或 Run 中止 | 验收 5 |
| E6 | `PRESENTATION_ORDERING=0` 后带 tool 任务 | 验收 6 |
| E7 | 同一 Run 3+ 串行 tool，数 assistant 卡张数 | 02 §八·（二）第 2 项 |

### 接口契约

- 无新增代码接口；交付物为**通过**的验收 checklist 与关键截图/日志片段（不粘贴完整终端日志）

### 验收标准

- [ ] E1：tool/thinking 整体在 assistant 最终回答**之上**，需滚到底见完整结论；无时间轴倒置
- [ ] E2：首段 P95 ≤ 3s 或不明显劣于现网同场景；流式不刷屏
- [ ] E3：过程卡顺序稳定，无重复语义重叠通知
- [ ] E4：合并预览、reply 锚定、排队反馈与归档变更一致；defer release 首建仍锚定 `lastInbound`
- [ ] E5：失败/中止时过程与结论/失败说明均可读，无「仅有结论、过程缺失」
- [ ] E6：关闭开关恢复 assistant 先于 tool 的现网顺序，无残留卡死
- [ ] E7：仅 1 张 assistant 卡，位于最后过程卡之下
- [ ] 02 §八·（二）第 3–5 项在 E1/E5/E6 中一并确认
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1, T2, T3, T4, T5
- 后续任务: 无（通过后进入 `/kb-archive`）

---

## T7: AGENTS.md Presentation 编排文档同步

### 背景

工程协作者须从 AGENTS 获知 `PRESENTATION_ORDERING`、延迟首建规则与 MergeBatch 协同不变声明（02 §十·（一））。本任务仅更新文档，不改运行时逻辑。

### 上下文文件

- 必读: `src/AGENTS.md` — 现有 `stream-text` / Presentation / MergeBatch NF2 小节
- 必读: `electron/AGENTS.md` — SDK 流式桥接与 presentation-event 小节
- 必读: T1–T5 最终实现（核对符号名与 env 名）

### 实现范围

- 修改: `src/AGENTS.md` — 增补：
  - `PRESENTATION_ORDERING` 开关语义与 MVP 范围（主用户私聊 SDK）
  - `SessionProgressState` 编排字段表与「过程在上、结论在下」规则
  - `releaseDeferredAssistantStream` / deferred 响应说明
  - 显式声明：`getPresentationReplyAnchor` / MergeBatch 逻辑**未改**
- 修改: `electron/AGENTS.md` — 增补：
  - `presentationOrderingEligible`、`seenProcessEvent`、`presentationDeferStream`
  - defer/release 与 `postStreamText` 关系
  - `resetSdkRunPresentationState` 清零编排状态

### 接口契约

- 文档描述与代码行为一致；env 名、函数名与实现一致

### 验收标准

- [ ] 两文件均含开关说明与回滚方式（01 F6）
- [ ] 纯对话 vs 含 tool 路径区分清晰（01 F3 vs F1）
- [ ] MergeBatch NF2 「不改锚点」有明确声明（01 F5）
- [ ] NF1 日志事件名与字段在 daemon 小节可查
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T5
- 后续任务: 无（archive 阶段 manifest 收录）
