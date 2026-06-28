# 多轮调度超上下文与超时取消降故障 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 1、执行计划

### 1.1 依赖图

T1 ──→ T2 ──→ T3 ──→ T4 ──→ T5

### 1.2 分组调度

- **第一轮**：T1
- **第二轮**：T2
- **第三轮**：T3
- **第四轮**：T4
- **第五轮**：T5
- 串行原因：`electron/agent-sdk.ts` 在 T2/T3 连续改动，且 T4 依赖前序稳定实现结果；T5 依赖验证结论与实际发布产物信息。

## 2、任务清单

## T1: 落地 RunGuard 与 watchdog 核心模块

### 背景
先提供可复用的单飞与超时收敛能力，给后续重试与上下文轮转提供稳定运行边界，避免同会话并发重入与悬挂 run。

### 上下文文件
- CodeGraph: `acquireRunGuard`、`watchRunGuard`、`finalizeSdkRunOnTimeout` — 定位 guard 与超时收尾调用点
- 必读: `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/02-design.md` — 对齐 S3/S6 与阈值口径
- 必读: `electron/finalize-sdk-run.ts` — 复用现有 timeout/cancel 收敛流程
- 参考: `electron/agent-sdk.ts` — 预判接入点，避免接口不兼容

### 实现范围
- 新建: `electron/agent-run-guard.ts` — 提供 token 单飞、watchdog 轮询、cancel 后 wait 收敛能力
- 修改: `electron/finalize-sdk-run.ts` — 暴露 guard 可复用的超时收尾辅助方法（不改变既有语义）

### 接口契约
- `acquireRunGuard(sessionKey: string): { token: string; acquired: boolean; holder?: string }` — 同 session 单飞入口
- `watchRunGuard(input: { sessionKey: string; token: string; timeoutMs: number; tickMs: number }): Promise<"completed" | "timeout" | "cancelled">` — watchdog 收敛结果
- `releaseRunGuard(sessionKey: string, token: string): void` — 幂等释放锁

### 验收标准
- [ ] 同一 `sessionKey` 并发请求时仅一个 token 生效，其他请求明确返回 busy/未获取状态
- [ ] watchdog 在超时窗口内给出确定终态，不出现无终态悬挂
- [ ] 与现有 `finalizeSdkRunOnTimeout` 兼容，不引入失败状态回归
- [ ] 新增/修改代码使用中文注释说明关键状态机；单文件不超过 300 行
- [ ] 无 `02`/`03` 未要求的抽象层或新依赖

### 依赖
- 前置任务: 无
- 后续任务: T2

## T2: 在调度主链路接入 RetryPolicy 与 busy 重排

### 背景
在单飞能力就绪后，给可恢复失败提供退避重试，并将 `agent_busy` 从立即失败改为延后重排，降低 v1.8.8 下取消/超时抖动。

### 上下文文件
- CodeGraph: `launchSdkAgent`、`dispatchToSdkAgent`、`completeSdkRun`、`runAgentDispatchLoop` — 定位重试与调度入口
- 必读: `electron/agent-sdk.ts` — 注入重试状态与 guard 调度
- 必读: `src/daemon.ts` — 实现 `agent_busy` 延后重排
- 参考: `electron/sdk-failure-messages.ts` — 补充终态与可重试提示文案

### 实现范围
- 修改: `electron/agent-sdk.ts` — 接入 `agent-run-guard`、实现 `shouldRetry` 与退避（次数/抖动/错误分类）
- 修改: `src/daemon.ts` — 将 `agent_busy` 路径改为可配置延迟后重排，不立即终止提案
- 修改: `electron/sdk-failure-messages.ts` — 统一 retryable / non-retryable 提示

### 接口契约
- `shouldRetry(err: unknown, attempt: number): { retryable: boolean; delayMs: number; reason: string }` — 重试判定唯一出口
- `dispatchToSdkAgent(...): Promise<{ status: "ok" | "failed"; attempts: number; finalReason?: string }>` — 回传实际重试次数与终态原因
- `scheduleBusyRetry(sessionKey: string, delayMs: number): void` — daemon 侧 busy 重排入口

### 验收标准
- [ ] `retryable` 错误按策略自动重试，`non-retryable` 快速失败且终态清晰
- [ ] `agent_busy` 场景不再立即失败，能在延后窗口内继续推进
- [ ] 重试次数、退避时间、最终 reason 均有结构化日志可追踪
- [ ] 新增/修改代码使用中文注释说明关键分支；单文件不超过 300 行
- [ ] 无 `02`/`03` 未要求的抽象层或新依赖

### 依赖
- 前置任务: T1
- 后续任务: T3

## T3: 接入 ContextRotation-lite 控制上下文膨胀

### 背景
在重试机制稳定后补充轻量上下文轮转，控制长轮次上下文增长，降低超上下文触发概率且不引入重型压缩链路。

### 上下文文件
- CodeGraph: `maybeRotateContext`、`dispatchToSdkAgent`、`sessionKey` — 定位轮转触发与幂等键位置
- 必读: `electron/agent-sdk.ts` — 接入 rotation 判定与 send 参数透传
- 必读: `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/02-design.md` — 对齐阈值、冷却与幂等约束
- 参考: `electron/agent-run-guard.ts` — 复用 session 级状态管理方式

### 实现范围
- 新建: `electron/context-rotation-lite.ts` — 提供阈值判定、冷却窗口、轻量摘要与会话轮转状态
- 修改: `electron/agent-sdk.ts` — 高压条件触发 `maybeRotateContext`，透传幂等键 `sessionKey+lastInboundId+attempt`

### 接口契约
- `maybeRotateContext(input: { sessionKey: string; usageRatio: number; nowMs: number }): { rotated: boolean; summary?: string; nextCooldownMs: number }` — 轮转判定与结果
- `buildIdempotencyKey(sessionKey: string, lastInboundId: string, attempt: number): string` — 重试与轮转共享幂等键

### 验收标准
- [ ] 在 `usage>=90%` 且满足连续轮次条件时触发轮转，冷却期间不重复轮转
- [ ] 轮转后请求仍保持幂等，不因重试/轮转导致重复执行
- [ ] 未引入新的重型上下文压缩链路或额外三方依赖
- [ ] 新增/修改代码使用中文注释说明轮转阈值与冷却逻辑；单文件不超过 300 行
- [ ] 无 `02`/`03` 未要求的抽象层或新依赖

### 依赖
- 前置任务: T2
- 后续任务: T4

## T4: 完成故障样本回归与构建验证

### 背景
实现完成后需用真实故障样本与构建流程验证效果，确认 `sdk_cancelled` 崩溃链路收敛且未破坏现有打包能力。

### 上下文文件
- CodeGraph: `runAgentDispatchLoop`、`notifySdkFailure` — 核对失败终态是否仍可追踪
- 必读: `crash_log/20260628181128/meta.json` — 回归场景输入与失败类型基线
- 必读: `crash_log/20260628181128/electron-log.txt` — 对照回归后日志关键字
- 参考: `package.json` — 构建/验证脚本入口

### 实现范围
- 修改: 无（以执行验证命令与记录结果为主）
- 产出: 回归与构建验证结论（供 `04-review.md`、`06-automation-test.md` 引用）

### 接口契约
- `回归结果记录格式`: `{ scenario: "20260628181128"; passed: boolean; reason?: string; keyLogs: string[] }`
- `构建验证记录格式`: `{ command: string; passed: boolean; durationSec?: number; artifact?: string }`

### 验收标准
- [ ] `20260628181128` 场景回归不再复现 `sdk_cancelled` 崩溃链路
- [ ] 至少完成一次主构建链路验证并输出可追踪结果
- [ ] 若回归失败，给出可复现步骤与阻断级别，禁止直接进入归档
- [ ] 验证记录可被后续文档直接引用，无需二次解释
- [ ] 无 `02`/`03` 未要求的抽象层或新依赖

### 依赖
- 前置任务: T3
- 后续任务: T5

## T5: 完成文档与版本/changelog 收尾

### 背景
在验证通过后，补齐用户可见变更的版本与变更日志，确保 `/kb-archive` 能按发布规则一次通过。

### 上下文文件
- CodeGraph: `updater changelog`、`build release notes` — 确认 changelog 消费路径
- 必读: `package.json` — bump 版本号（按 patch/minor/major 规则）
- 必读: `changelog/`（目标版本文件） — 新增版本变更条目
- 必读: `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/00-manifest.json` — 同步 `files` 与文档状态
- 参考: `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/05-summary.md` — 记录“实际变更”清单

### 实现范围
- 修改: `package.json` — 更新 `version`
- 新建: `changelog/<新版本>.json` — 写入中文 changes 列表
- 修改: `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/00-manifest.json` — 纳入 changelog 与版本文件状态
- 修改: `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/05-summary.md` — 标注版本与 changelog 变更

### 接口契约
- `changelog/<version>.json`: `{ "version": "...", "date": "YYYY-MM-DD", "changes": ["..."] }`
- `manifest.files` 必含 `package.json` 与 `changelog/<version>.json`，状态与来源可追踪

### 验收标准
- [ ] 版本号 bump 与变更级别匹配，且构建读取新版本无歧义
- [ ] changelog 条目为中文、面向用户可感知变化，不写任务 ID
- [ ] `05-summary.md` 与 `manifest.files` 已同步版本/changelog 实际变更
- [ ] 文档描述与实现事实一致，不粘贴完整终端日志
- [ ] 无 `02`/`03` 未要求的抽象层或新依赖

### 依赖
- 前置任务: T4
- 后续任务: 无

## T-FIX-01: 修复 ContextRotation 失败回滚路径（R1）

### 背景
`04-review.md` 的 R1 指出 ContextRotation 先关闭旧 agent 再新建，若新建失败会导致会话进入假存活状态，需要改为先建后切换或失败回滚。

### 上下文文件
- CodeGraph: `maybeRotateSessionForPressure`、`sendWithRetry`、`dispatchToSdkAgent`
- 必读: `electron/agent-sdk.ts` — 轮转触发、agent 重建与 send 主链路

### 实现范围
- 修改: `electron/agent-sdk.ts` — 轮转顺序改为“先建新实例，成功后切换并 best-effort 关闭旧实例”；创建失败时保留旧实例并继续发送

### 接口契约
- `maybeRotateSessionForPressure(...)` 在轮转失败时返回 `{ rotated: false }` 且不破坏既有 session 可用性

### 验收标准
- [x] 不再出现“先销毁旧 agent 再创建新 agent”的破坏性顺序
- [x] 新建失败时会话保持可继续 dispatch，不出现悬挂/假存活
- [x] 保持 RunGuard/Retry/Rotation 主体行为不变，仅修复切换语义

### 依赖
- 前置任务: T3
- 后续任务: T-FIX-02

## T-FIX-02: 统一 orchestrator busy 延后重排策略（R2）

### 背景
`04-review.md` 的 R2 指出 `agent_busy` 延后重排只覆盖 `/api/agent/dispatch`，主链路 `dispatchSessionToAgent -> /api/agent/launch` 仍按失败处理并提前 ack。

### 上下文文件
- CodeGraph: `dispatchSessionToAgent`、`scheduleBusyRetry`、`parseBusyRetryDelayMs`
- 必读: `src/daemon.ts` — orchestrator launch/dispatch 分支与 ack 路径

### 实现范围
- 修改: `src/daemon.ts` — 在 launch 失败分支复用 `parseBusyRetryDelayMs + scheduleBusyRetry`；busy 时不执行失败 notify 与 ack

### 接口契约
- `dispatchSessionToAgent(...)` 在 `agent_busy` 场景下与 `/api/agent/dispatch` 一致，走延后重排而非立即终止

### 验收标准
- [x] launch 路径命中 `agent_busy` 时触发延后重排
- [x] busy 场景不提前 ack 当前消息批次
- [x] dispatch 与 launch 的 busy 策略保持一致

### 依赖
- 前置任务: T-FIX-01
- 后续任务: 无
