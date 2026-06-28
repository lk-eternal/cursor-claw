# Agent Run 超时自动停止 - 验收记录

> **变更 ID**：`20260628163149-Agent Run 超时自动停止`
> **阶段**：`/kb-test`（静态契约 + build 冒烟；场景 B 与长时 Run 超时为手工/staging 必测）
> **评审结论引用**：`04-review.md` focused-review 通过（有条件）；R1/R2 为 warning 非阻断

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **静态契约**（04-review 全量 diff + 关键符号复核）+ **build 冒烟**（`npm run build`）+ **手工/staging 联调**（场景 A/B 超时收尾、≥30s 后发消息、验收 6/7 回归）；**不新增**单元测试/集成测试 |
| **目标** | 覆盖 `01-proposal` 验收 1–7、`02-design` §8.2 工程补充项、`03-tasks` T1–T2（T3 文档对齐已静态勾） |
| **通过口径** | 代码路径与 02/03 一致（04 已勾）+ build exit 0；**核心场景 B**（超时后 ≥30s 再发消息、不 Stop/Reset）与长时 Run 超时须 staging 实测后勾选 |
| **与 review 分工** | 04 负责实现与规范；本文负责验收追溯、可观测性对照与联调证据占位 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **01·1 / §8.2 场景 A**：Run 超时后 ≤5s finalizer 收尾 | 依赖 SDK 推送 ERROR/EXPIRED 或长任务达超时档（~20min+）；本地脚本无法稳定模拟完整 IM 调度链 |
| **01·2 / 场景 B（核心）**：超时后 **≥30s** 再发消息 | 须覆盖原 `FAIL_COOLDOWN_MS`（30s）与 Daemon phase idle→claim 时序；自动化无稳定 mock |
| **01·6 / 01·7**：主动 Stop、非超时 tool 失败回归 | 依赖真实用户操作与 SDK error 语义；04 R2/R3 提示 ERROR/EXPIRED 宽判定须联调确认 |
| **§8.2 resident 超时**：长驻模式删 session + launch 重建 | 须 IM 通道 E2E 观测 `dispatch_failed` 不出现 |
| **04 R1**：`SDK_RESIDENT_AGENT=0` 非长驻超时 | 非默认配置；须 opt-in 环境手工或记 accepted_debt |
| **`auto_test/` 脚本** | 本期未新增；验收以 build + 手工清单为主 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1** | 超时判定后 **数秒内** 自动结束 Run；会话不长期 processing | 04 静态 + 场景 A 联调 | 代码 / 联调日志 | ✅ 静态；⏳ 场景 A |
| **01·2** | **核心**：超时后 **≥30s** 同会话发新消息，**不** Stop/Reset → 新 Run 正常 | **手工/staging 必测** | 长时联调 | ⏳ **必测待跑** |
| **01·3** | 无需依次 Stop + Reset 即可继续同会话 | 依赖场景 B | 联调 | ⏳ 依赖 B |
| **01·4** | 无 stack/内部 error 码；同一超时 notify **≤1**；无长期「处理中」 | 04 静态（`notifySdkFailure` + `errorNotified`） | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **01·5** | F4 简体中文超时文案，与「请稍后重试」可区分 | 04 静态（`formatSdkStreamFailure`） | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **01·6** | 用户主动 Stop 行为不变；aborted 不误走 finalizer | 04 静态门控 + 手工 Stop | 代码 / 手工 | ✅ 静态；⏳ 手工 |
| **01·7** | 非超时 tool 失败仍通用文案 + cooldown；不误删 resident | 04 静态 + **R2/R3 重点联调** | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **§8.2·A** | 场景 A：≤5s finalizer 日志、`session.run` 空、`reportSessionAgentPhase(idle)` | **手工/staging 必测** | 长时/mock 联调 | ⏳ **必测待跑** |
| **§8.2·B** | 场景 B：≥30s 后发消息 → 新 Run；无 dispatch_failed | **手工/staging 必测** | 长时联调 | ⏳ **必测待跑** |
| **§8.2·cooldown** | 超时路径不写 `failedCooldowns` | 04 静态 | 代码复核 | ✅ 静态 |
| **§8.2·resident** | 长驻超时后 `sdkSessions` 无 key；下条 launch 重建 | 04 静态 + 联调 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **§8.2·F4** | 一条超时文案 + `stop_progress` | 同 01·5 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **§8.2·F3** | 无 stack；notify ≤1 | 同 01·4 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **§8.2·6/7** | 主动 Stop、非超时 error 无回归 | 同 01·6/7 | 手工 / 联调 | ✅ 静态；⏳ 联调 |
| **T1** | `finalizeSdkRunOnTimeout`、`isRunTimeoutFailure`、`runFinalizing` | 04 T1 表 | 代码复核 | ✅ 静态 |
| **T2** | ERROR/EXPIRED 即时 finalizer；`completeSdkRun` 幂等；WARN 早退 | 04 T2 表 | 代码复核 | ✅ 静态 |
| **04·R1** | 非长驻 `SDK_RESIDENT_AGENT=0` 超时后 agent/session 残留 | 04 §3 warning | 可选联调 / accepted_debt | ⚠️ open；非默认 |
| **04·R2** | ERROR/EXPIRED 一律视为超时类；验收 7 冲突风险 | 04 §3 warning | **验收 7 联调** | ⚠️ open；待联调 |

## 4、场景摘要

### 4.1 手工/staging 必测清单（优先）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **K1 场景 A·超时收尾** | IM 主用户私聊；发起长任务或 mock ERROR/EXPIRED | 观察超时判定后 **≤5s** UI/开发者日志 | 可见 finalizer 痕迹；`session.run` 已空；`reportSessionAgentPhase(idle)` 已调用；通道「处理中」结束 | 01·1、§8.2·A、T1 |
| **K2 场景 B·稍后发消息（核心）** | K1 或任意超时收尾完成 | **等待 ≥30s**（覆盖 `FAIL_COOLDOWN_MS`）；**不** Stop/Reset；同会话发新消息 | 新 Run 启动并有回复；**不** dispatch_failed / 消息被吞 / 须 Stop+Reset | 01·2/3、§8.2·B、T2 |
| **K3 场景 C·恢复后继续** | K2 通过后 | 再发 1–2 条正常消息 | Agent 正常处理；会话连贯 | 01·3 |
| **K4 F4 友好提示** | 超时类 finalizer 触发 | 观察 IM notify | **一条** 简体中文，语义含「已因超时结束、可重发消息」；**非**单独「请稍后重试」 | 01·5、§8.2·F4 |
| **K5 F3 通道防护** | 同 K4 | 查 notify 内容与进度展示 | 无 stack/内部 error 码；同一超时 **≤1** 条；无长期 typing/处理中 | 01·4、§8.2·F3 |
| **K6 主动 Stop 回归** | 正常 processing 中 | 用户点击 Stop | 行为与变更前一致；**不**误走超时 finalizer / 自动 idle 恢复 | 01·6、§8.2·6 |
| **K7 非超时失败回归** | 故意触发 tool 失败（非 ERROR/EXPIRED 超时档） | 观察 notify 与 session | 通用失败文案；仍写 `failedCooldowns`；**不**删 resident session；**不**误用 F3.2/超时文案 | 01·7、§8.2·7、**R2/R3** |
| **K8 cooldown 跳过** | 超时收尾后立即（或 K2 前置） | 同会话快速发消息 | `launchSdkAgent` **不**因冷却拒绝 | §8.2·cooldown、T2 |
| **K9 resident 重建** | 默认长驻模式 | 超时后查 session 状态；发下一条消息 | `sdkSessions` 无该 key；走 `Agent.create` 重建；**无** `dispatch_failed: no resident agent` | §8.2·resident、T1 |
| **K10 非长驻（可选）** | `SDK_RESIDENT_AGENT=0` | 重复 K1/K2 | 确认 agent/session 清理或记 **accepted_debt**（R1） | 04·R1 |

**长时 Run 说明**：真实任务执行超时（~20min+）须在 **staging 或专用测试账号** 执行 K1/K2，不可仅依赖 mock。

### 4.2 静态/build 冒烟（已执行）

| 检查 | 操作指针 | 期望 |
|------|----------|------|
| finalizer 模块 | `electron/finalize-sdk-run.ts` | `isRunTimeoutFailure`、`finalizeSdkRunOnTimeout` 收尾链完整 |
| ERROR/EXPIRED 挂接 | `electron/agent-sdk.ts` `handleSdkEvent` | 即时 finalizer，无 defer-only |
| completeSdkRun 幂等 | `electron/agent-sdk.ts` `completeSdkRun` | `runFinalizing \|\| session.run === null` early return；超时跳过 cooldown |
| stream 兜底 | `streamRunEvents` | abort break + 流结束超时类补调 finalizer |
| launch WARN | `launchSdkAgent` processing 早退 | UI WARN 日志（契约不变） |
| AGENTS 对齐 | `electron/AGENTS.md` | finalizer / cooldown / resident 超时 vs 非超时 |
| Daemon 无 diff | `git diff src/daemon.ts` | 无变更 |
| 构建 | 项目根 `npm run build` | exit 0 |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无 `auto_test/` 新增脚本 |
| **运行依赖** | Electron 应用 + `src/daemon`；SDK 模式 Agent；飞书/微信 IM 主用户私聊 |
| **环境变量** | 仅名称：`SDK_RESIDENT_AGENT`（默认长驻；K10 设 `0`）、`DAEMON_PORT`、通道 `LARK_*` / `WECHAT_*` |
| **staging 建议** | K1/K2 长时 Run 超时与场景 B **≥30s** 等待须在 staging 执行，避免占用生产会话 |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- 联调失败时区分：**操作/环境问题** vs **SDK/服务问题**（记备注列）；R1/R2 相关失败标注 warning ID。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-28 | 本地 dev | 04-review focused-review（T1/T2/T3） | 通过 | 静态契约；有条件 |
| 2026-06-28 | 本地 dev | `npm run build` | 通过 | exit 0 |
| 2026-06-28 | — | K1 场景 A 超时收尾 | 待执行 | **staging 必测** |
| 2026-06-28 | — | **K2 场景 B ≥30s 后发消息** | 待执行 | **核心必测** |
| 2026-06-28 | — | K3–K5 恢复/文案/防护 | 待执行 | 联调 |
| 2026-06-28 | — | K6–K7 Stop/非超时回归 | 待执行 | R2/R3 重点 |
| 2026-06-28 | — | K8–K9 cooldown/resident | 待执行 | 联调 |
| 2026-06-28 | — | K10 非长驻（可选） | 待执行 | R1 可选 |
