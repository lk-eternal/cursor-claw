# 多轮调度超上下文与超时取消降故障 - 变更总结

## 1、根因与方案

### 1.1 根因
- 连续多轮 `/kb-admin` 下，长上下文与取消/超时竞争叠加，出现 `sdk_cancelled`、会话 `ERROR`、重复调度与人工介入升高。
- 旧链路在三处存在稳定性缺口：同会话并发重入缺少单飞约束、`agent_busy` 延后重排策略覆盖不一致、上下文长期累积缺少轻量轮转。
- 复评前阻断问题 R1/R2 表明：rotation 失败回滚与 orchestrator launch busy 分支是主要风险放大点。

### 1.2 方案
- 引入 **RunGuard + watchdog**：同 `sessionKey` 单飞，超时/取消统一收敛到确定终态。
- 引入 **RetryPolicy**：仅对可恢复错误退避重试；对不可恢复错误快速失败并保留清晰原因。
- 引入 **ContextRotation-lite**：在高压阈值下执行轻量轮转，控制上下文膨胀，不引入重型压缩链路。
- 闭环修复 **R1/R2**：rotation 改为“先建后切”；launch/dispatch 双路径统一 `agent_busy` 延后重排语义。

## 2、实际变更（与 manifest.files 对齐）

### 2.1 变更目录文档
- `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/00-manifest.json`（状态与清单更新）
- `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/01-proposal.md`
- `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/02-design.md`
- `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/03-tasks.md`
- `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/04-review.md`
- `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/05-summary.md`
- `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/06-automation-test.md`

### 2.2 代码与运行链路变更
- `electron/agent-sdk.ts`：接入 RunGuard/Retry/Rotation 主链路，并完成 R1 修复。
- `electron/agent-run-guard.ts`：新增单飞 token 与 watchdog 收敛能力。
- `electron/context-rotation-lite.ts`：新增轻量轮转判定与冷却控制。
- `electron/retry-policy.ts`：新增可配置重试策略实现。
- `electron/finalize-sdk-run.ts`：补齐与 watchdog 协同的收尾能力。
- `electron/sdk-failure-messages.ts`：统一 retryable/non-retryable 失败提示语义。
- `src/daemon.ts`：统一 orchestrator launch/dispatch 的 `agent_busy` 延后重排（R2 修复）。

### 2.3 知识更新文件
- `knowledge/业务域/Agent调度/03-启动与自动重连.md`：同步本次稳定性改动结论（由 archive 知识合并流程纳入）。

## 3、验收结果

- 代码评审：`04-review.md` 初评未通过（R1/R2），复评已通过，阻断项清零，可进入归档前置阶段。
- 自动化验收：`06-automation-test.md` 已形成追溯记录；`npm run build` 主链路冒烟通过（退出码 0）。
- 覆盖结论：RunGuard、RetryPolicy、ContextRotation-lite、busy 延后重排一致性均已静态追溯覆盖。
- 未完成项：`crash_log/20260628181128` 仍缺少可重复自动化回放 harness，当前为“静态追溯 + 构建实跑”口径。

## 4、知识库更新清单

- [x] `knowledge/业务域/Agent调度/03-启动与自动重连.md`（已纳入本变更清单，需保持与实现一致）
- [x] `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/05-summary.md`（本文件）
- [x] `knowledge/变更/进行中/20260628184232-多轮调度超上下文与超时取消降故障/00-manifest.json`（清单与阶段状态）
- [x] 其余 `knowledge/业务域/**` 与 `knowledge/工程平台/**`：本轮无新增必须更新项
- [x] `knowledge/知识索引.md`：总入口未变化，无需更新

## 5、剩余风险/债务与归档前动作

### 5.1 剩余风险与技术债务
- CodeGraph 索引时效存在窗口，新增符号影响面核验仍需在归档前补一次刷新后扫描。
- `agent_busy` 语义现已覆盖当前 launch/dispatch 主路径；后续若新增调用入口需同步策略，避免再次分叉。
- 缺少故障样本全自动回放与长时高压压测脚本，线上阈值（如 rotation 冷却）仍需持续调参。

### 5.2 版本与 changelog（用户可见修复，归档必做）
- 本次属于**用户可见稳定性修复**，归档前必须执行版本号 bump（默认 `patch`，除非确认为 `minor/major`）。
- 必须新建 `changelog/<新版本>.json`（中文、面向用户可感知变化，不写任务 ID）。
- 必须将 `package.json` 与 `changelog/<新版本>.json` 同步写入 `00-manifest.json` 的 `files` 清单，并在本文件“实际变更”中补充对应条目后再 `/kb-archive`。

### 5.3 Ponytail 技术债
无（本轮未新增 `ponytail:` 注释）。
