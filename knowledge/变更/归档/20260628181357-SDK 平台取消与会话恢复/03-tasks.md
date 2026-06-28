# SDK 平台取消与会话恢复 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 1、执行计划

### （一）依赖图

```
T1 ──→ T2 ──→ T4 ──→ T5
T3 ──→ T4
```

- **T1**（`finalize-sdk-run.ts`）为平台长时判定 SSOT 与 finalizer 收尾链；**T2** 挂接 SDK 事件与 notify 门控，依赖 T1 导出的 `isRunTimeoutFailure` / `finalizeSdkRunOnTimeout` 行为。
- **T3**（文案）与 T1/T2 无 import 耦合，可与 T1 并行；**T4** 文档须在代码落地后对齐。
- **T5** 为 `/kb-archive` 阶段执行，依赖 T1–T4 验收通过。

### （二）分组调度

- **第一轮（并行）**：T1、T3
- **第二轮**：T2（读完 T1 diff 后再改 `agent-sdk.ts`）
- **第三轮**：T4（对照 T1–T3 实现更新约定）
- **归档阶段**：T5（`/kb-archive`，非 `/kb-apply`）

## 2、任务清单

## T1: finalize-sdk-run 平台长时判定与 finalizer 收尾

### 背景

根因之一是 `isRunTimeoutFailure` L56–57 对任意 `ERROR/EXPIRED` 恒 true（R2 宽判定），且平台约 7～8min 结束的 Run 未纳入超时档；同时 `finalizeSdkRunOnTimeout` 先 `abort()` 再 `notifySdkFailure`，导致超时 IM 可能被 aborted 闩跳过（F3/场景 D）。本任务在 `finalize-sdk-run.ts` 集中实现平台长时 SSOT、收紧判定、调整 notify/abort 顺序，并顺带非长驻清理（R1）。

### 上下文文件

- CodeGraph: `isRunTimeoutFailure finalizeSdkRunOnTimeout PLATFORM_RUN_LIMIT_MS` — 定位 finalizer 链与调用方（索引未命中时以源码为准）
- 必读: `electron/finalize-sdk-run.ts` — 现网 `isRunTimeoutFailure`（L51–84）、`finalizeSdkRunOnTimeout`（L90–152）
- 必读: `electron/agent-sdk.ts` L217–257、L596–611 — `notifySdkFailure` aborted 闩与 finalizer 委托
- 参考: `crash_log/20260628181128/meta.json` — 平台 ~8min ERROR 样本
- 参考: `knowledge/变更/进行中/20260628181357-SDK 平台取消与会话恢复/02-design.md` §1.2 S5b/S5c/S5e/S9、§6 步骤 1–2

### 实现范围

- 修改: `electron/finalize-sdk-run.ts`
  - **新增** `PLATFORM_RUN_LIMIT_MS = 7 * 60 * 1000`（与观测 7～8min 平台上限对齐；注释区分 `KEEPALIVE_TIMEOUT_MS` 20min）
  - **删除** `isRunTimeoutFailure` L56–57「`st === "ERROR" || st === "EXPIRED"` 即 true」宽判定
  - **扩展** `isRunTimeoutFailure`：在 `!session.abortController.signal.aborted` 前提下，`durationMs >= PLATFORM_RUN_LIMIT_MS` 且终态为 `CANCELLED` / `ERROR` / `EXPIRED` / `run.status === "error"` 时返回 true；保留 F3.2（shell:running + duration≥20min + 不安全 message）与既有 20min duration 档
  - **调整** `finalizeSdkRunOnTimeout`：清 `runFinalizing` 闩后，**先** `archiveAgentFailureLogs(failureType: "sdk_timeout")` + `await ctx.notifySdkFailure(...)`，**再** `run.cancel()` + `session.abortController.abort()`；其后 `resetStreamPostChain`、清 run、`reportSessionAgentPhase(idle)`
  - **长驻**：保留 `residentMode` 下 `agent.close()` + `sdkSessions.delete`
  - **R1（可选非长驻）**：`!session.residentMode` 时同样在 finalizer 末尾 `agent.close()` + `sdkSessions.delete`（与 `completeSdkRun` 非 resident 路径一致，不加剧 R1 债务）
- 删除: 无

### 接口契约

- `export const PLATFORM_RUN_LIMIT_MS` 或模块内常量（若仅本文件使用可 `const`，T2 通过 `isRunTimeoutFailure` 间接消费，**不**强制 export）
- `isRunTimeoutFailure(session, run, lastStatus?)` — 移除 ERROR/EXPIRED 无条件 true；新增平台长时（≥7min、非 aborted）分支含 `CANCELLED`
- `finalizeSdkRunOnTimeout(ctx, session, run, trigger)` — notify 先于 abort；归档 `sdk_timeout` 仍在 notify 前（现网 archiver 顺序可保留）

### 验收标准

- [ ] 短 ERROR（duration < 7min、非 F3.2）调用 `isRunTimeoutFailure` 返回 **false**（对齐 01 验收 6、02·八·（二）短 ERROR 项）
- [ ] 平台长时（≥7min、非 aborted）`CANCELLED` / `ERROR` / `EXPIRED` 返回 **true**
- [ ] `finalizeSdkRunOnTimeout` 执行后用户在 abort 前已完成 `notifySdkFailure` 调用（mock/联调：abort 后 `notifySdkFailure` 不应再被 aborted 闩跳过）（对齐 01 验收 4、02·八·（二）finalizer IM 必达）
- [ ] 平台长时 finalizer 归档 `failureType=sdk_timeout`（非 `sdk_cancelled`）（02·八·（二））
- [ ] `SDK_RESIDENT_AGENT=0` 下平台长时 finalizer 后 session/agent 已清理（02·八·（二）R1 回归）
- [ ] 用户主动 Stop（`abortController.signal.aborted`）不进入 finalizer（由 T2 门控，本任务判定函数对 aborted session 返回 false）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T2、T4

---

## T2: agent-sdk 事件挂接、兜底与 notify 门控

### 背景

现网 `handleSdkEvent` 对 `CANCELLED` 直调 `notifySdkFailure(..., "sdk_cancelled")` → IM「Agent 任务已取消」（F1）；`ERROR/EXPIRED` 无条件走 finalizer（与 T1 收紧后需改为经 `isRunTimeoutFailure` 门控）。`completeSdkRun` 对 `cancelled` 终态覆盖弱，场景 D 需兜底。本任务挂接 T1 判定与 finalizer，并视 T1 reorder 是否足够决定是否增 `notifySdkFailure` 的 `ignoreAborted` 选项。

### 上下文文件

- CodeGraph: `handleSdkEvent completeSdkRun notifySdkFailure streamRunEvents` — 事件链与幂等闩
- 必读: `electron/agent-sdk.ts` L217–257（`notifySdkFailure`）、L671–753（`streamRunEvents` / `completeSdkRun`）、L806–821（`handleSdkEvent` status 分支）
- 必读: `electron/finalize-sdk-run.ts` — T1 落地后的 `isRunTimeoutFailure` / `finalizeSdkRunOnTimeout`（**先读 T1 diff**）
- 参考: `electron/crash-log-archiver.ts` — `failureType` 映射
- 参考: `02-design.md` §1.2 S5/S5d、§6 步骤 4–7

### 实现范围

- 修改: `electron/agent-sdk.ts`
  - **`handleSdkEvent` `status` 分支**：
    - `CANCELLED && !aborted`：**不再**直调 `notifySdkFailure(sdk_cancelled)`；若 `session.run` 存在且 `isRunTimeoutFailure(session, run, lastStatus)` → `void finalizeSdkRunOnTimeout(..., "status")`；否则短取消路径保持通用失败或极少 `sdk_cancelled`（duration < 7min 且非平台长时）
    - `ERROR/EXPIRED && !aborted`：改为 **仅当** `isRunTimeoutFailure(...)` 为 true 时 `void finalizeSdkRunOnTimeout(..., "status")`；短 ERROR 不写 finalizer，留 `completeSdkRun` 通用失败 + `failedCooldowns`
  - **`completeSdkRun`**：扩展 `run.status === "cancelled"`（及等价未 notify 终态）：`!session.errorNotified && isRunTimeoutFailure` 时委托 `finalizeSdkRunOnTimeout` 或等价 notify+清理；维持 `runFinalizing || run === null` 幂等 early return
  - **`streamRunEvents` 流结束兜底**：保留 `run.status === "error"` + `isRunTimeoutFailure`；**补充** `run.status === "cancelled"` 同等兜底
  - **`notifySdkFailure`（若 T1 reorder 仍不足）**：可选增 `opts?: { ignoreAborted?: boolean }`，finalizer 路径传 `ignoreAborted: true`；**优先**采用 T1「先 notify 再 abort」，仅 diff 更小时才增参数
  - **`FinalizerContext.notifySdkFailure` 签名**：若增 `opts`，同步更新 `finalize-sdk-run.ts` 的 `FinalizerContext` 类型（最小类型扩展，归本任务或 T1 补一行，implement 取改动更少侧）
- 删除: 无

### 接口契约

- `handleSdkEvent` — 平台长时 `CANCELLED/ERROR/EXPIRED` 统一经 `isRunTimeoutFailure` → `finalizeSdkRunOnTimeout`
- `completeSdkRun` — cancelled 未 notify 兜底，幂等与 `runFinalizing` 闩一致
- `notifySdkFailure(session, override?, run?, failureType?, opts?)` — 可选 `ignoreAborted`（仅 finalizer 需要时）
- 用户 `stopSdkSession`（aborted）路径：**不改** early return 行为

### 验收标准

- [ ] 平台长时（≥7min、非 aborted）`CANCELLED` 走 finalizer，IM **不出现**「Agent 任务已取消」（对齐 01 验收 1、F1）
- [ ] 平台长时结束后同会话可发下一条消息并正常启动 Run（对齐 01 验收 2、3；依赖 T1 idle + 长驻重建）
- [ ] 平台长时结束 IM 收到 **一条** 等待超时类友好提示（对齐 01 验收 4）
- [ ] 用户主动 Stop：无 IM 失败/超时/取消 notify，无新增崩溃归档（对齐 01 验收 5、场景 B）
- [ ] 短 ERROR/工具失败：走 `completeSdkRun` 通用文案 + `failedCooldowns`，**不**走 finalizer 删 session（对齐 01 验收 6）
- [ ] `streamRunEvents` / `completeSdkRun` 在无 `status` 事件时仍能兜底平台长时 cancelled（场景 D / 02 S5d）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1
- 后续任务: T4

---

## T3: sdk-failure-messages 超时文案优先于 CANCELLED

### 背景

`formatUserSdkFailureMessage` 现网 L102 对 `st === "CANCELLED"` 固定返回「Agent 任务已取消。」，早于 `isTimeoutFailure` 分支，导致平台长时取消仍展示用户取消语义（F1）。本任务调整分支顺序，使调用方传入的 `isTimeoutFailure` 优先于 CANCELLED 固定句。

### 上下文文件

- CodeGraph: `formatUserSdkFailureMessage formatTimeoutFailureMessage` — 文案分支
- 必读: `electron/sdk-failure-messages.ts` L99–134 — `formatUserSdkFailureMessage` 全部分支
- 必读: `electron/agent-sdk.ts` L240–248 — `notifySdkFailure` 传入 `isTimeoutFailure: isRunTimeoutFailure(...)`
- 参考: `02-design.md` §1.2 S7、§6 步骤 3

### 实现范围

- 修改: `electron/sdk-failure-messages.ts`
  - 将 `if (ctx.isTimeoutFailure) return formatTimeoutFailureMessage(ctx)` **移至** `if (st === "CANCELLED")` **之前**
  - `EXPIRED` 独立句可保留在 CANCELLED 之前或之后（implement 保持与超时句不冲突即可）
  - 短且非平台长时的 `CANCELLED` 仍返回「Agent 任务已取消。」（极少路径）
- 删除: 无

### 接口契约

- `formatUserSdkFailureMessage(ctx: SdkFailureContext)` — `isTimeoutFailure === true` 时无论 `status` 是否为 `CANCELLED` 均输出「会话因等待超时已退出…」类文案（`formatTimeoutFailureMessage`）

### 验收标准

- [ ] `isTimeoutFailure=true` 且 `status=CANCELLED` 时不输出「Agent 任务已取消。」（02·八·（二））
- [ ] 超时文案语义含「等待超时已退出」与「可重新发送消息继续」（对齐 01 验收 1、4）
- [ ] `isTimeoutFailure=false` 且 `status=CANCELLED` 仍返回取消句（短取消极少路径）
- [ ] 非超时 ERROR 通用失败分支无回归（对齐 01 验收 6）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无（与 T1 并行；联调验收依赖 T2 传入正确 `isTimeoutFailure`）
- 后续任务: T4

---

## T4: electron/AGENTS.md 约定对齐

### 背景

`electron/AGENTS.md` 当前仍写「CANCELLED 仍独立走 `handleSdkEvent`」「**不改** `finalize-sdk-run.ts` 判定实现」等与本次变更冲突的表述。implement 完成后须将 SDK 错误 notify、平台长时结束、`sdk_timeout` vs 用户 Stop、notify 顺序、R2 收紧同步为 SSOT。

### 上下文文件

- 必读: `electron/AGENTS.md` — 「Agent 失败日志归档」「SDK 错误 notify」「保活失败文案（F3.2）」等节
- 必读: T1–T3 实际 diff（**以代码为准**）
- 参考: `02-design.md` §9–§10、`§1.2` 改动汇总

### 实现范围

- 修改: `electron/AGENTS.md`
  - 更新 **SDK 错误 notify**：平台长时（≥`PLATFORM_RUN_LIMIT_MS` 7min、非 aborted）`CANCELLED/ERROR/EXPIRED` 走 `finalizeSdkRunOnTimeout`，文案超时分支，归档 `sdk_timeout`
  - 更新 **notify 顺序**：finalizer 先 notify 再 abort（或 `ignoreAborted` 若 T2 采用）
  - 更新 **CANCELLED 路径**：不再默认「独立 sdk_cancelled notify」
  - 更新 **R2**：移除「任意 ERROR/EXPIRED 即超时」描述；短 ERROR 走 `completeSdkRun` + cooldown
  - 更新 **非长驻 R1**：平台长时 finalizer 可选清理说明（与 T1 实现一致）
  - 移除或修正「不改 finalize-sdk-run 判定」类过时句
- 删除: 无

### 接口契约

- 文档与 `finalize-sdk-run.ts` / `agent-sdk.ts` / `sdk-failure-messages.ts` 行为一致，供后续 kb-librarian archive 扫描

### 验收标准

- [ ] AGENTS.md 中平台长时、`PLATFORM_RUN_LIMIT_MS`、`sdk_timeout` vs 用户 Stop 静默边界与代码一致
- [ ] 无与现网实现矛盾的「CANCELLED 独立取消 notify / 不改 finalizer」表述
- [ ] 02·十·（一）「必须更新 `electron/AGENTS.md`」项闭合
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1、T2、T3
- 后续任务: T5

---

## T5: 归档发布物（archive 阶段执行）

### 背景

本变更对用户可见（IM 文案与会话恢复，F5）。按工作区规则与 01 验收 7，须在 `/kb-archive` 时 bump patch 版本并新增 changelog，**不在 `/kb-apply` 代码任务中执行**。

### 上下文文件

- 必读: `.cursor/rules/kb-archive-changelog.mdc` — bump 与 changelog 格式
- 必读: `package.json` — 当前 `version`（现网 `1.8.7`）
- 参考: `changelog/1.8.7.json` — 条目格式样例
- 参考: `01-proposal.md` F5、验收 7；`02-design.md` §1.2 S8、§6 步骤 9

### 实现范围

- 修改: `package.json` — `version` patch bump：`1.8.7` → `1.8.8`
- 新建: `changelog/1.8.8.json` — 用户可感知要点，例如：
  - 平台长时间运行结束后展示等待超时类提示（非「任务已取消」）
  - 超时后会话自动恢复，可直接发送下一条消息
- 修改: `knowledge/变更/.../00-manifest.json` — archive 时 `manifest.files` 登记上述文件（由 `/kb-archive` 主流程写入）
- 删除: 无

### 接口契约

- `changelog/1.8.8.json` 符合 `{ version, date, changes[] }` 结构；changes 为简体中文、用户可理解摘要
- `electron-builder.yml` / `electron/updater.ts` 无需另改（版本从 `package.json` 读取）

### 验收标准

- [ ] `package.json` version 为 `1.8.8`（或 archive 时当前 patch+1）
- [ ] `changelog/<新版本>.json` 存在且 changes 覆盖提示与会话恢复改进（对齐 01 验收 7）
- [ ] 05-summary「实际变更」列出 `package.json` 与 changelog 文件（archive 工序）
- [ ] **本任务仅在 `/kb-archive` 执行**；T1–T4 合并验收通过后再启动
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1、T2、T3、T4（及 `/kb-test` 通过）
- 后续任务: 无（archive 后变更目录迁归档）
