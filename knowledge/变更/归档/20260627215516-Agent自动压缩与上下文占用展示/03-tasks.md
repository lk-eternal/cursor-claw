# Agent 自动压缩与上下文占用展示 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 一、执行计划

### （一）依赖图

```
T1 ──→ T3 ──→ T4 ──→ T5
T2 ──→ T3
```

### （二）分组调度

| 轮次 | 并行任务 | 说明 |
|------|----------|------|
| **第一轮** | T1, T2 | T1 新建 helper；T2 调研压缩与 onDelta（只读 SDK 类型 + agent-sdk send 挂钩设计） |
| **第二轮** | T3 | 依赖 T1 接口 + T2 onDelta 落点；**独占** `electron/agent-sdk.ts` |
| **第三轮** | T4 | footer 接入 final flush / notify；仍改 `agent-sdk.ts`，须 T3 完成后 |
| **第四轮** | T5 | 文档；依赖 T4 行为定稿 |

**同文件冲突**：`electron/agent-sdk.ts` 由 T2 → T3 → T4 **串行**（T2 若仅调研可合并进 T3，本计划 T2 含最小 onDelta 骨架时仍建议 T2 完成后再 T3 大改）。

## 二、任务清单

---

## T1: 上下文占用 helper 模块（context-usage.ts）

### 背景

footer 格式化、usage 合并与模型上限查表逻辑需从 `agent-sdk.ts`（已 1066 行）拆出，满足单文件 ≤300 行约束。对应设计 S1 / 步骤 B4。

### 上下文文件

- CodeGraph: `listSdkModels` `Cursor.models.list` — 模型列表与上限查表先例
- 必读: `electron/agent-sdk.ts` — `SdkSessionAgent`、`listSdkModels`（L1024+）
- 必读: `knowledge/变更/进行中/20260627215516-Agent自动压缩与上下文占用展示/02-design.md` — §四 §五 footer 契约
- 参考: `node_modules/@cursor/sdk` — `turn-ended` usage 与 model metadata 字段（**禁止编造**）

### 实现范围

- 新建: `electron/context-usage.ts` — `ContextUsageState`、`mergeTurnUsage`、`resolveModelContextLimit`、`formatContextFooter`、`appendContextFooter`；中文注释
- 修改: 无（本任务不碰 agent-sdk）

### 接口契约

- `export interface ContextUsageState { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens }`
- `export function mergeTurnUsage(state, usage): ContextUsageState`
- `export async function resolveModelContextLimit(modelId, apiKey): Promise<number | null>`
- `export function formatContextFooter(state, limitTokens): string | null` — 格式 `上下文：{p}% ({usedK}k/{limitK}k)`；limit 或 state 无效返回 null
- `export function appendContextFooter(body, footer): string` — footer 为 null 则原样返回；幂等防重复

### 验收标准

- [x] 新文件 ≤300 行，导出函数可被 agent-sdk import
- [x] `formatContextFooter` 对 used=90000 limit=200000 输出含 `45%` 与 `90k/200k`（或设计等价格式）
- [x] limit 为 null 时 `formatContextFooter` 返回 null（不输出 NaN）
- [x] `appendContextFooter` 对已含 `上下文：` 的正文不重复追加
- [x] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T3

---

## T2: 自动压缩验证与 onDelta 订阅骨架

### 背景

确认 SDK harness 默认启用接近上限的自动 summarization/compression，并在 `agent.send` 挂载 `onDelta` 接收 `turn-ended` usage 与 summary 事件日志。对应设计 S2 / B2、B2-a、B2-log。

### 上下文文件

- CodeGraph: `launchSdkAgent` `dispatchToSdkAgent` `agent.send` — send 调用点
- 必读: `electron/agent-sdk.ts` — L749-787 launch send、L804-831 dispatch send
- 必读: `node_modules/@cursor/sdk` — `Agent.send` 选项与 delta 类型（核实字段名）
- 参考: `knowledge/变更/进行中/20260627215516-Agent自动压缩与上下文占用展示/01-proposal.md` — 验收 5

### 实现范围

- 修改: `electron/agent-sdk.ts` —
  - 抽取 `createSendOptions(session)` 或内联 `onDelta` 回调（**禁止**编造 `autoCompress` SDK 字段）
  - `launchSdkAgent` 与 `dispatchToSdkAgent` 的 `agent.send` 均传入 onDelta
  - `summary-started` / `summary-completed`（或 SDK 实际类型名）→ `pushUiLog` INFO
  - 文档注释：压缩依赖 harness 默认行为；若核实需显式启用，记录结论于代码注释
- 修改: `electron/agent-sdk.ts` — `SdkSessionAgent` 预留 `contextUsage` 字段（初值零对象）

### 接口契约

- `function handleAgentSendDelta(session: SdkSessionAgent, delta: unknown): void` — 解析 turn-ended / summary 事件（类型以 SDK 为准）
- `agent.send(text, { onDelta: (d) => handleAgentSendDelta(session, d) })`

### 验收标准

- [x] 两处 `agent.send` 均挂载 onDelta，send 失败行为与改前一致
- [x] turn-ended 到达时 session.contextUsage 更新（可委托 T1 merge，或本任务临时内联后 T3 统一）
- [x] summary 类事件可在 SDK UI 日志看到 `[compression]` 或等价前缀
- [x] 未添加不存在的 SDK 配置字段；查不到的行为标注释「待核实」
- [x] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无（可与 T1 并行；merge 函数 T3 统一 import T1）
- 后续任务: T3

---

## T3: Session 用量累积与模型上限缓存

### 背景

将 T1 helper 与 T2 onDelta 整合：每 Run 清零 usage、send 前解析 context limit、turn-ended 持续 merge。对应设计 S3。

### 上下文文件

- 必读: `electron/context-usage.ts` — T1 导出
- 必读: `electron/agent-sdk.ts` — `resetSdkRunPresentationState`、`startSdkRun`、`SdkSessionAgent`
- CodeGraph: `resetSdkRunPresentationState` — Run 间状态清零挂点

### 实现范围

- 修改: `electron/agent-sdk.ts` —
  - import T1 模块；`handleAgentSendDelta` 调用 `mergeTurnUsage`
  - `resetSdkRunPresentationState` / `startSdkRun` 清零 `contextUsage`；可选保留 `contextLimitTokens` 跨 Run 缓存
  - `launchSdkAgent` 创建 session 后、`send` 前 `resolveModelContextLimit(modelId, apiKey)` 写入 session
- 修改: `electron/context-usage.ts` — 若 T1 缺 turn-ended 类型守卫，本任务补全

### 接口契约

- session 字段: `contextUsage: ContextUsageState`、`contextLimitTokens?: number`
- Run 边界: 新 Run 开始时 `contextUsage` 归零

### 验收标准

- [x] 单次 Run 多 turn 时 usage 单调累积（input/output/cache 合并）
- [x] 新 Run 开始时 usage 清零，limit 可复用缓存
- [x] `resolveModelContextLimit` 失败时 session 仍可 send，limit 为 undefined
- [x] agent-sdk.ts 行数因拆 helper 不显著膨胀（净增控制在合理范围）
- [x] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1, T2
- 后续任务: T4

---

## T4: 终态回复 append 上下文 footer

### 背景

在用户可见**最终回复**末尾附加占用摘要：流式 final 与非流式 notify 两路径，单一落点 agent-sdk。对应设计 S4–S6 / B3-a、B3-b、B4-a。

### 上下文文件

- 必读: `electron/agent-sdk.ts` — `doFlushStreamPost`、`streamRunEvents` final flush、`notifySdkFailure`、`appendSdkLog` 非流式路径
- 必读: `electron/context-usage.ts` — `formatContextFooter`、`appendContextFooter`
- 必读: `electron/AGENTS.md` — 现有 stream-text 约定
- 参考: `src/daemon.ts` — `handleStreamText` final 语义（**不改 daemon**）

### 实现范围

- 修改: `electron/agent-sdk.ts` —
  - 新增 `applyContextFooterToBuffer(session)`：读 `contextUsage` + `contextLimitTokens` → format → append 到 `streamBuffer`（仅 final 前调用一次）
  - `doFlushStreamPost` 当 `final===true` 时先 `applyContextFooterToBuffer`
  - 非 f41 且 Run 成功结束需 notify 正文时（若有路径），同样 append
  - `notifySdkFailure`：有 usage 时 optional append，无则省略
- 删除: 无

### 接口契约

- `function applyContextFooterToBuffer(session: SdkSessionAgent): void` — 幂等；不可用时 no-op

### 验收标准

- [x] f41Eligible 流式：仅 **final** POST 的 text 含 footer；中间 chunk 不含
- [x] footer 格式符合 01 F2 / 02 §五（含 `%` 与 k 单位）
- [x] limit/usage 不可得时 final 正文与改前一致（无 footer、无 NaN）
- [x] 错误 notify 路径符合 01 验收 7
- [x] 飞书 daemon 无需改动即可展示 footer（正文已含）
- [x] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T3
- 后续任务: T5

---

## T5: 更新 electron/AGENTS.md 回复约定

### 背景

将上下文 footer 与自动压缩日志约定写入 Electron AGENTS，供后续 builder 与 archive 知识同步。对应设计 S7 / §十·（一）。

### 上下文文件

- 必读: `electron/AGENTS.md` — 现有 SDK 流式与 notify 约定
- 必读: `knowledge/变更/进行中/20260627215516-Agent自动压缩与上下文占用展示/01-proposal.md` — F2 格式
- 必读: `knowledge/变更/进行中/20260627215516-Agent自动压缩与上下文占用展示/02-design.md` — §五 footer、§二 CLI 范围

### 实现范围

- 修改: `electron/AGENTS.md` — 新增小节：
  - 自动压缩：harness 默认 + summary 日志位置
  - 上下文 footer：final-only、格式、占用不可得省略、落点 agent-sdk
  - CLI 路径不在 IM 回复 scope

### 接口契约

- 无代码接口；文档与 T4 实现一致

### 验收标准

- [x] AGENTS 描述与 T4 代码行为一致（final-only、格式、省略条件）
- [x] 未声称 daemon 侧 append
- [x] 中文表述，与现有 AGENTS 条目风格一致
- [x] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T4
- 后续任务: 无

---

## T6: 静态验收与联调记录（可选，apply 后）

### 背景

编译门禁与飞书 E2E 用例记录，供 `/kb-test` / archive 消费。非 apply 阶段阻塞项，可在 T5 后由 test 流程执行。

### 上下文文件

- 必读: `01-proposal.md` §验收标准
- 必读: `02-design.md` §八·（二）

### 实现范围

- 新建: `knowledge/变更/进行中/20260627215516-Agent自动压缩与上下文占用展示/06-automation-test.md` — E1 私聊 footer、E2 群聊、E3 流式无重复 footer、E4 占用不可得、E5 压缩日志

### 接口契约

- 无

### 验收标准

- [ ] `npm run build` 通过
- [ ] 06 文档含可执行检查步骤与预期
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T5
- 后续任务: 无
