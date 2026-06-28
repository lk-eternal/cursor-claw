# Agent Run 超时自动停止 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 1、执行计划

### 1.1 依赖图

```
T1 ──→ T2 ──→ T3
```

**说明**：T1/T2 均串行修改 `electron/agent-sdk.ts`（必要时同目录 `finalize-sdk-run.ts`），避免并行写同一文件；T3 仅文档，依赖 T2 实现落地后再对齐 `electron/AGENTS.md`。

### 1.2 分组调度

- **第一轮**：T1（超时判定与 finalizer 核心）
- **第二轮**：T2（事件流挂接与 `completeSdkRun` 幂等，依赖 T1）
- **第三轮**：T3（`electron/AGENTS.md` 约定对齐，依赖 T2）

## 2、任务清单

## T1: 超时判定与 finalizer 核心（S5-F1、S5-F2）

### 背景

现网 `handleSdkEvent` 收到 `status ERROR/EXPIRED` 仅记 `lastStatus` 并延至 `completeSdkRun`，未主动 `run.cancel()` / `abortController.abort()`，导致 `session.run` 残留、`isSdkSessionProcessing` 长期 true、Daemon phase 阻塞 claim。本任务实现 `isRunTimeoutFailure` 与 `finalizeSdkRunOnTimeout` 核心收尾链（幂等闩 → cancel/abort → 清 run → idle 上报 → 一次 notify → 长驻超时删 session），对应设计 S5-F1、S5-F2 与 01 F1/F2/F4 基础能力。

### 上下文文件

- CodeGraph: `finalizeSdkRunOnTimeout`、`isRunTimeoutFailure`、`formatSdkStreamFailure`、`stopSdkSession`、`completeSdkRun` — 定位 finalizer 可复用片段与 notify/phase 入口
- 必读: `electron/agent-sdk.ts` — `SdkSessionAgent`（L11–37）、`failedCooldowns`/`FAIL_COOLDOWN_MS`（L94–95）、`KEEPALIVE_TIMEOUT_MS`（L100）、`isSdkSessionProcessing`（L107）、`formatSdkStreamFailure`（L183）、`notifySdkFailure`（L207）、`resetStreamPostChain`（L344）、`resetSdkRunPresentationState`、`stopSdkSession`（L1098）
- 必读: `knowledge/变更/进行中/20260628163149-Agent Run 超时自动停止/01-proposal.md` — F1、F2、F4、验收 1/3/4/5
- 必读: `knowledge/变更/进行中/20260628163149-Agent Run 超时自动停止/02-design.md` — §1.2 S5c/S5e、§5.1–5.2、§6 步骤 S5-F1/S5-F2、§8.2 场景 A / F4 / F3 兜底 / resident 超时
- 参考: `electron/daemon-client.ts` — `reportSessionAgentPhase` 只读调用契约（本任务不改）
- 参考: `knowledge/变更/归档/20260627150751-SDK保活与Run生命周期兼容/` — F3.2 保活超时文案与 `formatSdkStreamFailure` 上下文

### 实现范围

- 修改: `electron/agent-sdk.ts`
  - **`SdkSessionAgent`**：新增 `runFinalizing?: boolean`；`resetSdkRunPresentationState`（或等价 Run 重置入口）将其置 `false`
  - **新增私有 `isRunTimeoutFailure(session, run, lastStatus?)`**：命中任一即 true —（1）`lastStatus.status` 为 `ERROR`/`EXPIRED`；（2）`run.status === "error"` 且 `formatSdkStreamFailure` 上下文命中 F3.2 保活超时（`shell:running` + `durationMs ≥ KEEPALIVE_TIMEOUT_MS` + 不安全 message）；（3）`run.status === "error"` 且观测 Run 超时档（与 ERROR/EXPIRED 等价、无更安全 message 时）。**非**工具失败/网络等通用 error 须返回 false
  - **新增 `finalizeSdkRunOnTimeout(session, run, trigger)`**（名称可微调）：入口幂等 — 已 `runFinalizing` 或 `session.run === null` 则日志后 return；否则设 `runFinalizing = true` → best-effort `run.cancel()` → `abortController.abort()` → `resetStreamPostChain` → `session.run = null`、`session.pendingDispatch = false` → 结构化 UI 日志（含 `sessionKey`、`trigger`、duration 等）→ `notifySdkFailure`（F4，经 `notifySessionChat` 第三参 `stopProgress=true`；复用 `formatSdkStreamFailure` 超时文案，依赖 `errorNotified` 闩保证 ≤1 条）→ `reportSessionAgentPhase(idle)` → **长驻模式超时专用**：`agent.close()` + `sdkSessions.delete(sessionKey)` + `broadcastSdkSessionStatus`（非超时 error 路径不在此任务删除 resident）
  - finalizer **不**写入 `failedCooldowns`（或写入后立即清除，以实现为准）
- 可选提取: 若 `agent-sdk.ts` 行数/复杂度超限，将 `isRunTimeoutFailure` + `finalizeSdkRunOnTimeout` 提取至同目录 `electron/finalize-sdk-run.ts` 并由 `agent-sdk.ts` import；**不**新建模块目录或第三方依赖
- 不改: `handleSdkEvent` ERROR/EXPIRED 即时调用（归 T2）、`completeSdkRun` 幂等分支（归 T2）、`src/daemon.ts`、`electron/daemon-client.ts`

### 接口契约

- `SdkSessionAgent.runFinalizing?: boolean` — 本 Run 正在执行超时/终态收尾，供 T2 `completeSdkRun` 幂等
- `isRunTimeoutFailure(session: SdkSessionAgent, run: Run, lastStatus?: StatusEvent): boolean` — 私有；true 走 finalizer 超时路径
- `finalizeSdkRunOnTimeout(session: SdkSessionAgent, run: Run, trigger: "status" | "stream" | string): Promise<void>` — 超时类终态主动收尾；副作用：`session.run = null`、`reportSessionAgentPhase(idle)`、至多一次用户 notify、resident 超时删 session
- 用户 notify：F4 简体中文超时友好文案 + `stop_progress`；技术 stack/errorCode 仅 UI 日志

### 验收标准

- [ ] **01 验收 1（自动停止·finalizer 段）**：mock 或复现 ERROR/EXPIRED 触发 finalizer 后 **≤5s** 内 UI 日志可见 finalizer 痕迹，`session.run === null`，`isSdkSessionProcessing(session) === false`
- [ ] **01 验收 3（无需 Stop+Reset·finalizer 段）**：finalizer 完成后 `reportSessionAgentPhase(idle)` 已调用（可查 Daemon phase 或 UI 日志）；用户 **未** 执行 Stop/Reset 时会话已 idle 化
- [ ] **01 验收 4（通道防护·finalizer 段）**：finalizer notify **不含** stack/内部 error 码；同一超时事件经 `errorNotified` **≤1** 条用户消息；`stop_progress` 结束「处理中」展示
- [ ] **01 验收 5（友好提示）**：F4 文案为简体中文，语义含「已因超时结束、可重发消息继续」，与通用「请稍后重试」可区分
- [ ] **02 §8.2 场景 A**：长任务或 mock ERROR/EXPIRED 后 **≤5s** 内 finalizer 日志、`session.run` 已空、`reportSessionAgentPhase(idle)` 已调用
- [ ] **02 §8.2 F4**：仅 **一条** 简体中文超时文案 + `stop_progress`；通道无长期「处理中」
- [ ] **02 §8.2 F3 兜底**：无 stack/内部 error 码；同一超时事件 notify **≤1** 条
- [ ] **02 §8.2 resident 超时**：长驻模式下 finalizer 后 `sdkSessions` **无**该 `sessionKey`（为 T2 稍后发消息重建铺路）
- [ ] **02 §8.2 failedCooldowns（finalizer 段）**：finalizer 路径 **不** 写入 `failedCooldowns`（或立即清除）
- [ ] `isRunTimeoutFailure` 对故意工具失败等非超时 `run.status === "error"` 返回 **false**（为 01 验收 7 铺路，T2 回归确认）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径；finalizer 保持单一函数，必要时 **仅** 提取 `finalize-sdk-run.ts`，不新建服务层/目录）

### 依赖

- 前置任务: 无
- 后续任务: T2

---

## T2: 事件流挂接与 completeSdkRun 幂等（S5-F3、S5-F4、S5-F5、S7-F6）

### 背景

T1 提供 finalizer 后，须在 SDK 事件流 **正确挂接** 并消除与 `completeSdkRun` 的竞态/重复 notify：ERROR/EXPIRED 不再 defer-only；`streamRunEvents` 在 abort 后及时 break 且流结束路径补调 finalizer；`completeSdkRun` 对超时类跳过 `failedCooldowns` 并与 finalizer 幂等合并；`launchSdkAgent` processing 静默返回处增加防御性 WARN 日志。对应设计 S5-F3–F5、S7-F6 与 01 验收 2/6/7 及 02 §8.2 场景 B。

### 上下文文件

- CodeGraph: `handleSdkEvent`、`streamRunEvents`、`completeSdkRun`、`launchSdkAgent`、`startSdkRun` — 定位 defer 注释与 error/cooldown 分支
- 必读: `electron/agent-sdk.ts` — T1 完成后的 `finalizeSdkRunOnTimeout` / `isRunTimeoutFailure` / `runFinalizing`；`handleSdkEvent` case `status`（L720–726 ERROR/EXPIRED defer 注释处）；`streamRunEvents`（L590，L593 aborted break）；`completeSdkRun`（L619，L640 `failedCooldowns`，L655 idle，L657–660 resident 保留）；`launchSdkAgent`（L787，L793–795 processing 静默返回）；`startSdkRun`（L668）
- 必读: `knowledge/变更/进行中/20260628163149-Agent Run 超时自动停止/01-proposal.md` — 场景 B/C、F1–F3、验收 1–7
- 必读: `knowledge/变更/进行中/20260628163149-Agent Run 超时自动停止/02-design.md` — §1.2 S5a–S5d/S7、§6 步骤 S5-F3–F5/S7-F6、§8.2 全项
- 参考: `electron/daemon-client.ts` — idle 触发 Daemon flush（只读）
- 参考: T1 可选 `electron/finalize-sdk-run.ts`（若 T1 已提取）

### 实现范围

- 修改: `electron/agent-sdk.ts`（及 T1 可选 `finalize-sdk-run.ts`，若有则同步挂接）
  - **S5-F3 `handleSdkEvent` case `status`**：`ERROR`/`EXPIRED` 写 `lastStatus` 后 **立即** `void finalizeSdkRunOnTimeout(session, session.run!, "status")`（消除 defer-only）；`CANCELLED` 保持现网（aborted 路径不 notify）；用户主动 `stopSdkSession`（aborted）**不**误触发 finalizer
  - **S5-F4 `streamRunEvents`**：循环内保留 `abortController.signal.aborted` break；流正常结束后若 `run.status === "error"` 且 `isRunTimeoutFailure` 且尚未 `runFinalizing`，在 `completeSdkRun` 前调用 finalizer（或于 `completeSdkRun` 内统一分支，以实现为准）
  - **S5-F5 `completeSdkRun`**：入口若 `runFinalizing` 或 `session.run === null`（已被 finalizer 清理）则幂等 return/仅日志；error 路径 `failedCooldowns.set` 包在 `!isRunTimeoutFailure(...)` 内；`errorNotified` 时跳过二次 notify；**非超时** error 仍保留 resident 实例（L657–660 现网行为）
  - **S7-F6 `launchSdkAgent`**：`isSdkSessionProcessing(existing)` 静默 `{ ok: true }` 处增加 UI **WARN** 日志（不改 HTTP 返回契约），便于观测 processing 残留
- 不改: `src/daemon.ts` M7 claim / flush 逻辑；`stopSdkSession` 主动 Stop 主路径语义；`formatSdkStreamFailure` 文案规则（T1 已复用）

### 接口契约

- `handleSdkEvent`：`status ERROR/EXPIRED` → 同步触发 finalizer，不再仅 defer 至 `completeSdkRun`
- `streamRunEvents`：finalizer abort 后循环提前 break；流结束超时类 error 补调 finalizer（幂等）
- `completeSdkRun(session, run, err?)`：与 finalizer 幂等；超时类 **不** 写 `failedCooldowns`；非超时 error 仍写 `failedCooldowns` + resident 保留
- `launchSdkAgent(opts)`：签名与 `{ ok: true }` 静默语义不变；processing 早退仅增 WARN 日志

### 验收标准

- [ ] **01 验收 1（端到端）**：可复现 Run 超时后 **数秒内** 自动结束 Run，会话 **不** 长期停留 processing
- [ ] **01 验收 2（核心·场景 B）**：超时收尾后 **等待 ≥30s**（覆盖原 `FAIL_COOLDOWN_MS`），**不** Stop/Reset，同会话发新消息 → 新 Run 正常启动并有回复（或明确非超时失败，但 **不** dispatch_failed / 消息被吞）
- [ ] **01 验收 3**：超时自动停止与会话恢复后，用户 **不需要** 依次 Stop + Reset 即可继续同会话
- [ ] **01 验收 4**：超时场景 IM 通道无 stack/原始 error；同一超时 notify **≤1**；停止后无长期「处理中」
- [ ] **01 验收 5**：若启用 F4，文案符合 01 F4 且与 T1 finalizer notify 一致、不重复
- [ ] **01 验收 6（主动取消无回归）**：用户主动 Stop 后行为与变更前一致；aborted 路径 **不** 误走 finalizer / 超时自动恢复
- [ ] **01 验收 7（非超时失败无回归）**：故意工具失败等非超时 error 仍走通用文案 + `failedCooldowns`；**不** 删除 resident session（除非用户 Stop）；**不** 误用超时专用文案
- [ ] **02 §8.2 场景 B（核心）**：同上 ≥30s 后发新消息 → 新 Run 正常；无 dispatch_failed
- [ ] **02 §8.2 failedCooldowns**：超时路径后立即 `launchSdkAgent` **不因** 冷却拒绝
- [ ] **02 §8.2 resident 超时**：超时后下条消息走 `Agent.create` 重建，**不**出现 `dispatch_failed: no resident agent` 或 send 失败
- [ ] **02 §8.2 验收 6/7**：与 01 验收 6/7 一致，手工回归通过
- [ ] `handleSdkEvent` ERROR/EXPIRED 路径 **无**「仅记 lastStatus 等 completeSdkRun」defer-only 行为
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径；挂接逻辑内联于既有函数，不新增事件总线/中间层）

### 依赖

- 前置任务: T1
- 后续任务: T3

---

## T3: electron/AGENTS.md 约定对齐

### 背景

现网 `electron/AGENTS.md`「SDK 错误 notify」「保活失败文案（F3.2）」「SDK 长驻 Agent」仍描述 ERROR/EXPIRED 在 `completeSdkRun` 再 notify、resident error 后保留实例。T2 落地 finalizer 后须同步文档：ERROR/EXPIRED 即时 finalizer、超时跳过 `failedCooldowns`、长驻 **超时** close+删 session vs **正常** error 保留实例，供 archive 与后续维护检索。对应设计 §9–§10 与 02 §8.2 文档侧验收。

### 上下文文件

- CodeGraph: `finalizeSdkRunOnTimeout`、`completeSdkRun`、`formatSdkStreamFailure` — 确认 T2 实现与文档一致
- 必读: `electron/AGENTS.md` — 「SDK 错误 notify」（约 L18）、「保活失败文案 F3.2」（约 L31–32）、「SDK 长驻 Agent」（约 L23）
- 必读: `electron/agent-sdk.ts` — T1/T2 完成后的 finalizer、`runFinalizing`、cooldown 分支、resident 超时分支
- 参考: `knowledge/变更/进行中/20260628163149-Agent Run 超时自动停止/02-design.md` — §9 知识库影响、§10.2 可能更新

### 实现范围

- 修改: `electron/AGENTS.md`
  - **「SDK 错误 notify」**：补充 Run 超时类（ERROR/EXPIRED / `isRunTimeoutFailure`）经 `finalizeSdkRunOnTimeout` **即时** cancel/abort、`session.run` 清空、`reportSessionAgentPhase(idle)`、一次 notify + `stop_progress`；与 `completeSdkRun` 幂等（`runFinalizing` / `errorNotified`）
  - **「保活失败文案（F3.2）」**：修正 ERROR/EXPIRED 不再 **仅** defer 至 `completeSdkRun`；保活超时 F3.2 文案仍经 `formatSdkStreamFailure`，但状态收尾由 finalizer 闭环
  - **「SDK 长驻 Agent」**：区分 **超时** 路径（finalizer → `agent.close()` + `sdkSessions.delete`，下条消息 `launchSdkAgent` 重建）vs **非超时 Run error**（仍 `failedCooldowns` + resident 保留实例）；超时路径 **跳过** `failedCooldowns`
  - 可选一句：`launchSdkAgent` processing 静默早退增 WARN 日志（S7-F6，不改契约）
- 不改: 其它 AGENTS 段落（MCP、Presentation、压缩等）；`knowledge/业务域/**`（archive 阶段由 kb-librarian 处理）

### 接口契约

- 无新增代码接口；文档与 T1/T2 代码行为一致，供 CodeGraph / 后续变更检索

### 验收标准

- [ ] `electron/AGENTS.md` 明确写出 `finalizeSdkRunOnTimeout`、`runFinalizing`、ERROR/EXPIRED 即时收尾（非 defer-only）
- [ ] 文档写明超时路径 **跳过** `failedCooldowns`，非超时 error 仍写 cooldown
- [ ] 文档写明长驻 **超时** close+删 session vs **正常/非超时** error 保留实例的差异
- [ ] 文档与 T2 实际 `handleSdkEvent` / `completeSdkRun` / resident 分支 **无矛盾**
- [ ] **01 验收 4/5**：文档侧可检索到 F3/F4 防护与友好提示约定（实现已在 T1/T2 验收）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径；仅更新既有 AGENTS 段落，不新建知识文件）

### 依赖

- 前置任务: T2
- 后续任务: 无（实现完成后运行 `/kb-test` 做 01 验收 1–7 与 02 §8.2 端到端验证；`/kb-archive` 处理 changelog 与 `knowledge/业务域/Agent调度/03-启动与自动重连.md`）
