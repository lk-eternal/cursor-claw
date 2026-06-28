# Agent Run 自动压缩 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 一、执行计划

### （一）依赖图

```
T1 ──┐
      ├──→ T4 ──→ T5
T2 ──→ T3 ──┘
```

**说明**：T1（失败分类器）与 T2（上下文压力评估）无交叉，可并行；T3 挂接 pre-send 依赖 T2 导出；T4 改造 `agent-sdk.ts` 失败路径与压缩 IM 回归，依赖 T1 接口与 T3 已完成 send 挂接；**`electron/agent-sdk.ts` 由 T3 → T4 串行**，避免并行写同一文件。T5 为文档与构建验收，依赖 T4。

### （二）分组调度

| 轮次 | 并行任务 | 说明 |
|------|----------|------|
| **第一轮** | T1, T2 | T1 新建 `sdk-failure-messages.ts`；T2 扩展 `context-usage.ts` pre-send / 高水位 |
| **第二轮** | T3 | 依赖 T2；`launchSdkAgent` / `dispatchToSdkAgent` send 前挂接 `evaluatePreSendContextPressure` |
| **第三轮** | T4 | 依赖 T1 + T3；**独占** `agent-sdk.ts`：失败归因、`notifySdkFailure`、压缩 IM 回归 |
| **第四轮** | T5 | 依赖 T4；`electron/AGENTS.md` 对齐 + `npm run build` 与回归清单 |

## 二、任务清单

---

## T1: SDK 失败归因分类器（sdk-failure-messages.ts）

### 背景

现网 `formatSdkStreamFailure`（`agent-sdk.ts`）在 SDK message 不可安全展示时一律回退「⚠️ Agent 处理失败，请稍后重试。」，未结合 errorCode、run.result、上下文 peak/limit 做归因。本任务新建纯函数模块，按优先级映射超时（委托调用方传入的 `isTimeoutFailure`）、上下文已满、会话异常、可安全展示 message、带建议兜底句，对应 F3 与流程 R13。

### 上下文文件

- CodeGraph: `formatSdkStreamFailure` `isUnsafeSdkMessage` `isRunTimeoutFailure` — 现网失败文案与超时判定入口
- 必读: `electron/agent-sdk.ts` — `formatSdkStreamFailure`（约 L195）、`isUnsafeSdkMessage` 同文件规则
- 必读: `electron/finalize-sdk-run.ts` — `isRunTimeoutFailure`（**只读**，本任务不改；分类器须优先尊重该结果）
- 必读: `knowledge/变更/进行中/20260628165558-Agent Run 自动压缩/01-proposal.md` — F3、场景 D、验收 5/6/8
- 参考: `electron/context-usage.ts` — `resolveDisplayContextTokens` 等用量换算（失败归因 peak/limit 输入格式）

### 实现范围

- 新建: `electron/sdk-failure-messages.ts` — `SdkFailureContext` 接口、`formatUserSdkFailureMessage`、message/errorCode 模式表（context/token/limit、EXPIRED 等）；复用或内联与 `isUnsafeSdkMessage` 同等安全规则；中文注释
- 不改: `agent-sdk.ts`（挂接归 T4）、`finalize-sdk-run.ts`

### 接口契约

- `export interface SdkFailureContext { status?: string; message?: string; errorCode?: string; runResult?: string; lastTool?: { name: string; status: string }; durationMs?: number; contextUsed?: number; contextLimit?: number | null; isTimeoutFailure: boolean }`
- `export function formatUserSdkFailureMessage(ctx: SdkFailureContext): string` — 简体中文 IM 文案；**禁止** stack/路径/内部 error 对象；优先级：`isTimeoutFailure` → 上下文已满（message/errorCode 模式或 peak≥95% limit 且 error）→ 会话异常 → 可安全展示 SDK message → 带类别兜底（如「上下文可能过长，请精简后重发」），**禁止**在可归因场景仅输出「请稍后重试」
- 超时类：`isTimeoutFailure === true` 时输出与现网 `formatSdkStreamFailure` 超时/F3.2 语义兼容的文案（调用方传入标志，本模块不 import finalizer 以免循环依赖）

### 验收标准

- [ ] **01 验收 5**：`contextUsed/limit` 达 ≥95% 且 message 不安全时，输出含「上下文」类建议，**非**仅「请稍后重试」
- [ ] **01 验收 6**：不可读 technical message 时映射为可理解类别（上下文/超时/会话异常等之一），**非**唯一通用句
- [ ] **01 验收 8**：输出文案不含 stack、路径、内部 error 对象
- [ ] **02 八·（二）第 2 项**：模拟 peak≥95% limit + 不安全 message → IM 文案含「上下文」类建议
- [ ] **02 八·（二）第 3 项**：`isTimeoutFailure: true` 时输出超时类文案，**不出现**上下文类文案
- [ ] 新文件 ≤300 行；中文注释；导出可被 `agent-sdk.ts` import
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T4

---

## T2: 上下文压力评估与高水位可观测（context-usage.ts）

### 背景

长驻 SDK Agent 跨 Run 保留上下文，第三轮 Run 可能在 harness 触发压缩前即触及上限。本任务在 `context-usage.ts` 增加 send 前只读压力评估与 turn-ended 高水位日志，便于压缩在失败前被观测，对应 F1、R3、R7。

### 上下文文件

- CodeGraph: `createAgentSendOptions` `handleAgentSendDelta` `resolveContextLimitForSession` `contextUsagePeakTokens` — onDelta 与 peak/limit 现网逻辑
- 必读: `electron/context-usage.ts` — `handleAgentSendDelta`（约 L224）、`createAgentSendOptions`（约 L253）、`resolveContextLimitForSession`（约 L167）、`resetContextUsagePeak`（约 L120）
- 必读: `electron/agent-sdk.ts` — `SdkSessionAgent` 字段 `contextUsagePeakTokens`、`contextLimitTokens`（约 L36）
- 必读: `knowledge/变更/进行中/20260628165558-Agent Run 自动压缩/01-proposal.md` — F1、验收 1/2/4

### 实现范围

- 修改: `electron/context-usage.ts`
  - 新增常量 `HIGH_WATERMARK_RATIO = 0.85`（可经 options 覆盖）
  - 新增 `evaluatePreSendContextPressure(session, log, options?)`：只读评估 `resolveDisplayContextTokens(peak) / contextLimitTokens`；当 ratio ≥ 阈值时写 UI 日志 `[compression] pre-send usage {pct}%`；**不阻断** send
  - 修改 `handleAgentSendDelta`：`turn-ended` 分支当占用 ≥85% limit 时写 `[compression] high-watermark`（或等价 `[compression]` 前缀日志）
  - 保持既有 `summary-started` / `summary-completed` → `[compression]` UI 日志与 `resetContextUsagePeak` 行为不变
- 不改: `agent-sdk.ts`（挂接归 T3）、footer 路径

### 接口契约

- `export function evaluatePreSendContextPressure(session: ContextUsageDisplaySession & { sessionKey: string; contextLimitTokens?: number }, log: UiLogFn, options?: { highWatermarkRatio?: number }): { ratio: number | null; used: number; limit: number | null }`
- turn-ended 高水位：ratio ≥ `HIGH_WATERMARK_RATIO` 时 `log('[compression] high-watermark …')` 或设计等价格式
- pre-send 日志格式：`[compression] pre-send usage {pct}%`（pct 为整数或一位小数，以实现为准）

### 验收标准

- [ ] **01 验收 2**：接近上限场景可观察到 `[compression] pre-send` 或 turn-ended `[compression] high-watermark` 至少其一（单元或手工 mock peak/limit）
- [ ] **01 验收 4**：`summary-completed` 仍调用 `resetContextUsagePeak`，压缩后 peak 清零逻辑无回归
- [ ] **01 验收 7**：既有 `[compression]` / `[context-usage]` UI 日志前缀与 summary 事件处理无退化
- [ ] **02 八·（二）第 1 项**：为连续三轮 pre-send / compression 日志观测提供函数导出（端到端在 T3+T4 验证）
- [ ] `evaluatePreSendContextPressure` 在 limit 缺失时安全 no-op（ratio null，不抛错）
- [ ] 改动后 `context-usage.ts` ≤300 行；中文注释
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T3

---

## T3: send 前 pre-send 挂接（agent-sdk.ts）

### 背景

T2 提供 `evaluatePreSendContextPressure` 后，须在 `launchSdkAgent` 与 `dispatchToSdkAgent` 的 `resolveContextLimitForSession` 之后、`agent.send` 之前调用，使多轮 resident dispatch 在第三轮 send 前即可打出 pre-send 压力日志，对应 R3、R4。

### 上下文文件

- CodeGraph: `launchSdkAgent` `dispatchToSdkAgent` `resolveContextLimitForSession` — send 调用链
- 必读: `electron/agent-sdk.ts` — `launchSdkAgent`（约 L887）、`dispatchToSdkAgent`（约 L990）、两处 `agent.send` 与 `createAgentSendOptions` 挂接
- 必读: `electron/context-usage.ts` — T2 完成的 `evaluatePreSendContextPressure`、`createAgentSendOptions`
- 必读: `knowledge/变更/进行中/20260628165558-Agent Run 自动压缩/01-proposal.md` — F1、验收 1/2

### 实现范围

- 修改: `electron/agent-sdk.ts`
  - `launchSdkAgent`：`resolveContextLimitForSession` 之后调用 `evaluatePreSendContextPressure(session, pushUiLog)`（或等价 log 函数）
  - `dispatchToSdkAgent`：同上，二次 send 前评估
  - **不改** `formatSdkStreamFailure`、`makeCompressionNotify`、`completeSdkRun`（归 T4）
  - **不改** `createAgentSendOptions` / onDelta 构造逻辑（已在 context-usage，仅确保两处 send 仍传入）
- 不改: `finalize-sdk-run.ts`、footer 路径、Daemon API

### 接口契约

- 两处 send 路径在 `agent.send` 前调用 `evaluatePreSendContextPressure`，传入含 `sessionKey`、`contextLimitTokens`、`contextUsagePeakTokens` 的 session 视图
- send 失败行为与改前一致；pre-send 仅日志副作用

### 验收标准

- [ ] **01 验收 1（可观测段）**：连续 resident dispatch 第三轮 send 前 UI 日志可见 `[compression] pre-send`（需真实或 mock 高 peak/limit）
- [ ] **01 验收 2**：pre-send 或后续 onDelta `[compression]` 在 Run 失败前可观测
- [ ] `launchSdkAgent` / `dispatchToSdkAgent` 两处均已挂接，无遗漏 send 路径
- [ ] pre-send 评估**不**阻断 send；limit 未解析时不影响 send 成功/失败语义
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2
- 后续任务: T4

---

## T4: 失败归因挂接与压缩 IM 回归（agent-sdk.ts）

### 背景

T1 提供分类器、T3 完成 pre-send 后，本任务改造 `formatSdkStreamFailure` / `notifySdkFailure` / `completeSdkRun` error 路径：组装 `SdkFailureContext`（含 errorCode、run.result、peak/limit），先 `isRunTimeoutFailure` 再委托 `formatUserSdkFailureMessage`；回归 `makeCompressionNotify` 每 Run 至多一条「正在压缩上下文…」IM，对应 R9、R11、R13、F2、F3。

### 上下文文件

- CodeGraph: `notifySdkFailure` `completeSdkRun` `makeCompressionNotify` `resetSdkRunPresentationState` `streamRunEvents` — 失败 notify 与压缩 IM 链
- 必读: `electron/agent-sdk.ts` — `formatSdkStreamFailure`（约 L195）、`notifySdkFailure`（约 L219）、`makeCompressionNotify`（约 L538）、`NOTIFY_COMPRESSING`（约 L107）、`resetSdkRunPresentationState`（约 L119）、`completeSdkRun`（约 L685）、`compressionNotified` 字段
- 必读: `electron/sdk-failure-messages.ts` — T1 导出
- 必读: `electron/finalize-sdk-run.ts` — `isRunTimeoutFailure`（**只读调用**，**不改** finalizer 与超时阈值）
- 必读: `electron/context-usage-run-end.ts` — `finalizeContextUsageAtRunEnd`（footer 路径只读，**不改**）
- 必读: `knowledge/变更/进行中/20260628165558-Agent Run 自动压缩/01-proposal.md` — F2/F3/F4、场景 A～D、验收 1～8

### 实现范围

- 修改: `electron/agent-sdk.ts`
  - **`formatSdkStreamFailure`**：保留对外签名；内部组装 `SdkFailureContext` 并调用 `formatUserSdkFailureMessage`；`isTimeoutFailure` 由调用方传入 `isRunTimeoutFailure(...)` 结果
  - **`notifySdkFailure`**：从 session 读取 peak/limit（`contextUsagePeakTokens`、`contextLimitTokens`）传入分类上下文；仍 optional append footer（`applyContextFooterToBuffer` 路径**不改**）
  - **`completeSdkRun` error 路径**：传入 `errorCode`、`run.result`、用量等到 notify 链
  - **压缩 IM（R9）**：确认 `makeCompressionNotify` + `compressionNotified` 闩；`summary-started` → IM `NOTIFY_COMPRESSING`（「正在压缩上下文…」），不传 `stop_progress`；`resetSdkRunPresentationState` 重置 `compressionNotified`；`summary-completed` **不**发第二条压缩进行中 notify
- **不改**: `finalizeSdkRunOnTimeout`、`isRunTimeoutFailure` 实现、`formatContextFooter` / `appendContextFooter`、`applyContextFooterToBuffer`、Daemon / CardKit

### 接口契约

- `formatSdkStreamFailure(...)` 签名不变；内部委托 `formatUserSdkFailureMessage`
- `notifySdkFailure(session, …)` 失败文案经分类器；同一失败事件 `errorNotified` 闩保证 ≤1 条 IM
- 压缩 IM：每 Run `compressionNotified` 至多一次；与「Agent 处理中…」语义衔接

### 验收标准

- [ ] **01 验收 1**：第三轮 Run 失败时 IM 文案**非**仅「请稍后重试」，含可归因类别与建议
- [ ] **01 验收 3**：压缩开始时 IM 收到「正在压缩上下文…」或等价表述；同一 Run **≤1** 条压缩进行中 notify
- [ ] **01 验收 4**：压缩完成后 Run 继续（harness + 现网 onDelta 行为）；用户无需 Stop+Reset 即可同会话发下一条
- [ ] **01 验收 5/6**：上下文耗尽与不可读 message 场景映射正确（见 T1 用例，本任务端到端验证）
- [ ] **01 验收 7**：footer 展示、`[compression]`/`[context-usage]` 日志、超时 finalizer 与主动 Stop 路径**无行为回归**（抽样）
- [ ] **01 验收 8**：失败 notify 无 stack/路径；同一失败事件 ≤1 条
- [ ] **02 八·（二）第 1 项**：连续三轮 resident dispatch，第三轮 Run 结束前可见 `[compression] pre-send` 或 `[compression] 上下文压缩开始` 至少其一
- [ ] **02 八·（二）第 2～3 项**：peak≥95% 失败文案 / 超时类仍走 finalizer 文案（不冲突）
- [ ] **02 八·（二）第 4 项**：同一 Run 压缩 IM ≤1；`summary-completed` 无第二条压缩进行中 notify
- [ ] **02 八·（二）第 5 项**：footer、`[compression]`、`[context-usage]` 格式与 archive 基线一致
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1, T3
- 后续任务: T5

---

## T5: electron/AGENTS.md 约定与构建验收

### 背景

代码落地后须同步 `electron/AGENTS.md`：失败归因类别表、pre-send `[compression]` 日志、与 `finalize-sdk-run` 超时 finalizer 分工边界，供 archive 与后续维护检索；并完成构建与文件行数约束验收。

### 上下文文件

- CodeGraph: `formatUserSdkFailureMessage` `evaluatePreSendContextPressure` `makeCompressionNotify` — 确认 T1～T4 实现
- 必读: `electron/AGENTS.md` — 现有「SDK 错误 notify」「压缩」「保活失败文案 F3.2」段落
- 必读: `electron/sdk-failure-messages.ts`、`electron/context-usage.ts`、`electron/agent-sdk.ts` — T1～T4 完成态
- 必读: `electron/finalize-sdk-run.ts` — 超时边界（只读，文档描述分工）
- 参考: `knowledge/变更/进行中/20260628165558-Agent Run 自动压缩/01-proposal.md` — 非目标（footer/超时不重复定义）

### 实现范围

- 修改: `electron/AGENTS.md`
  - 补充失败归因类别表（timeout / context_exhausted / session_abnormal / safe_sdk_message / fallback_actionable）与用户文案要点
  - 补充 pre-send `[compression] pre-send usage` 与 turn-ended `high-watermark` 可观测约定
  - 明确本变更与 `finalize-sdk-run.ts` 分工：超时类仍走 finalizer，非超时上下文/会话类走 `sdk-failure-messages`
  - 压缩 IM：`NOTIFY_COMPRESSING` 每 Run 一次、与 processing notify 衔接
- 不改: `knowledge/业务域/**`（archive 阶段由 kb-librarian）；footer 统计口径文档

### 接口契约

- 文档与 T1～T4 代码行为一致；不描述未实现的 SDK 字段（如 `autoCompress`）

### 验收标准

- [ ] **01 验收 7（文档段）**：AGENTS 不误导 footer/超时/Stop 路径行为
- [ ] **02 八·（二）第 6 项**：新建/改动文件 ≤300 行；中文注释；`npm run build` 通过
- [ ] `electron/AGENTS.md` 含失败类别、pre-send 日志、与 finalizer 边界三节
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T4
- 后续任务: 无（下一步 `/kb-apply` 或 `/kb-test`）
