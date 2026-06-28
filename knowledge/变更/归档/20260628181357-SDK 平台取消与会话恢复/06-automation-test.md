# SDK 平台取消与会话恢复 - 验收记录

> **变更 ID**：`20260628181357-SDK 平台取消与会话恢复`
> **阶段**：`/kb-test`（静态契约 + 手工/staging 联调；T5 发布物留 `/kb-archive`）
> **评审结论引用**：`04-review.md` focused-review 通过（有条件）；W1–W5 为 warning，无 ≥90 阻断

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **静态契约**（04-review + 关键符号 grep/读源码）+ **手工/staging 联调**（平台长时 ≥7min、用户 Stop、短 ERROR、会话续聊）；**不新增**单元测试/集成测试 |
| **目标** | 覆盖 `01-proposal` 验收 1–7（7 留 archive）、`03-tasks` T1–T4、`04-review` W1–W5 |
| **通过口径** | T1–T4 静态与 02/03 一致（04 已勾）；**核心**平台长时会话续聊（01·2/3）与 IM 文案（01·1）须 staging 实测；静态已闭合 R1/R2、notify 顺序、crash_log 主路径 |
| **与 review 分工** | 04 负责实现与规范；本文负责验收追溯、场景清单与执行记录 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **01·1–3**：平台 ~7–8min 结束 + 同会话续聊 | 依赖 Cursor SDK 平台上限与完整 IM→Daemon→SDK 链；本地无法稳定压缩至 7min 内复现 |
| **01·5**：用户 Stop 无 notify/归档 | 须 UI/IM 真实 Stop 操作观测 |
| **04·W1**：无 `status` 事件且仅 `run.status=cancelled` 终态 | `isRunTimeoutFailure` 平台分支未含单独 `run.status===cancelled`；样本以 `status ERROR` 为主；**staging 待联调**，本地无法模拟 |
| **04·W3**：20min duration 宽超时档 | 继承债务；须长时 Run 或专门用例 |
| **04·W4**：短 EXPIRED 静默 | 极少路径；联调若复现记 accepted_debt |
| **`auto_test/` 脚本** | 本期未新增；以静态 + 手工清单为主 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1** | 平台长时 IM **等待超时已退出、可重发**；**非**「Agent 任务已取消」 | 静态 + K1 联调 | 代码 / IM | ✅ 静态；⏳ K1 |
| **01·2** | 平台长时结束后同会话新 Run 正常（不 Stop/Reset） | **staging 必测** K2 | 联调 | ⏳ **必测待跑** |
| **01·3** | 长驻可直接收下一条，无需 Reset | 依赖 K2 + 默认 resident | 联调 | ⏳ 依赖 K2 |
| **01·4** | 超时类 notify **可达、≤1 条**、无 stack | 静态 notify 顺序 + K4 | 代码 / IM | ✅ 静态；⏳ K4 |
| **01·5** | 用户 Stop：无 IM 失败/超时/取消、无新增归档 | 静态门控 + K3 | 代码 / 手工 | ✅ 静态；⏳ K3 |
| **01·6** | 短 ERROR/工具失败：通用文案 + cooldown；**不**走 finalizer 删 session | 静态 + K5 | 代码 / 联调 | ✅ 静态；⏳ K5 |
| **01·7** | patch bump + changelog | T5 `/kb-archive` | 发布物 | ⏳ archive |
| **T1·短 ERROR** | `duration<7min` 非 F3.2 → `isRunTimeoutFailure` false | 静态 L66–76 | 代码 | ✅ |
| **T1·平台长时** | ≥7min + CANCELLED/ERROR/EXPIRED/`run.status=error` → true | 静态 L66–76 | 代码 | ✅ |
| **T1·notify 顺序** | finalizer **先** notify **再** abort | 静态 L139–153 | 代码 | ✅ |
| **T1·归档** | 平台长时 `failureType=sdk_timeout` | 静态 L140–145 | 代码 | ✅ |
| **T1·R1** | 非长驻 finalizer 后 close+delete | 静态 L161–167 | 代码 | ✅ 静态；⏳ K8 可选 |
| **T2·CANCELLED 门控** | 平台长时走 finalizer，短走 `sdk_cancelled` | 静态 L821–829 | 代码 | ✅ |
| **T2·短 ERROR** | `handleSdkEvent` 不 finalizer；`completeSdkRun` + cooldown | 静态 L829、L735–737 | 代码 | ✅ |
| **T2·兜底** | `streamRunEvents` / `completeSdkRun` cancelled 兜底 | 静态 L671–677、L705–712 | 代码 | ✅；⚠️ W1 边界 |
| **T3·文案** | `isTimeoutFailure` 优先于 CANCELLED 固定句 | 静态 L102–107 | 代码 | ✅ |
| **T4·AGENTS** | 平台长时 / notify 顺序 / R2 与代码一致 | 04 T4 表 | 文档 | ✅ |
| **§8.2·IM 必达** | abort 前 `notifySdkFailure` 不被 aborted 闩跳过 | 静态 L223 + L139–153 | 代码 | ✅ |
| **§8.2·sdk_timeout** | 平台长时归档非 `sdk_cancelled` | 静态 + K6 | 代码 / crash_log | ✅ 静态；⏳ K6 |
| **crash_log 回归** | `20260628181128` ~8min `status ERROR` 对齐超时路径 | 静态对照 + K6 | 样本 / 联调 | ✅ 静态；⏳ K6 |
| **04·W1** | cancelled-only 无 status | **staging 待联调** K7 | 联调 | ⚠️ 待联调 |
| **04·W2** | agent-sdk 行数超 300 | 存量债务 | — | ⚠️ 不阻断 |
| **04·W3** | 20min 宽超时误判 | K5 延伸 / accepted_debt | 联调 | ⚠️ 继承 |
| **04·W4** | 短 EXPIRED 静默 | 极少路径 | 联调 | ⚠️ accepted_debt 候选 |
| **04·W5** | 01·1–3/5–6 端到端 | 本文 K1–K7 | 联调 | ⏳ 部分静态 |

## 4、场景摘要

### 4.1 手工/staging 必测清单

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **K1 平台长时 ≥7min** | IM 主用户；发起复杂长任务（或 staging 等待平台上限） | 观察 ~7–8min 后结束 | IM **一条**「会话因等待超时已退出…可重新发送消息」；**无**「Agent 任务已取消」 | 01·1、T2、T3 |
| **K2 会话续聊（核心）** | K1 完成后 | **不** Stop/Reset；同会话发新消息 | 新 Run 启动并有回复；无 dispatch_failed / 残留 processing | 01·2/3 |
| **K3 用户 Stop** | 正常 processing | 用户点击 Stop | **无** IM 失败/超时/取消 notify；**无** 新增 `crash_log` 归档 | 01·5、场景 B |
| **K4 notify 可达与单条** | K1 或 mock 平台长时 | 查 IM 与 UI 日志 | **≤1** 条同义超时提示；无 stack/内部码；「处理中」结束 | 01·4、F3 |
| **K5 短 ERROR** | 触发 <7min 工具失败（非平台长时） | 观察 notify 与 session | 通用失败文案；写 `failedCooldowns`；**不**走 finalizer 删 session；**不**超时专用句 | 01·6、T1/T2 |
| **K6 crash_log 回归** | 部署本变更后复现或对照样本 | 长任务至 ~8min；查 `crash_log/` 与 IM | 对应 `failureType=sdk_timeout`（非 `sdk_cancelled`）；IM 超时句（样本 `20260628181128`：18:03 RUNNING→18:11 ERROR） | 关联变更、T1 |
| **K7 W1 cancelled-only** | staging；若 SDK 仅 cancelled 终态、无 status | 观察是否走 finalizer | 若未走：记 **W1 复现** → T-FIX-01；主路径 ERROR status **不** 阻塞 archive | 04·W1 |
| **K8 非长驻（可选）** | `SDK_RESIDENT_AGENT=0` | 重复 K1/K2 | finalizer 后 session/agent 已清理；续聊仍 launch 重建 | T1·R1 |

### 4.2 静态契约（kb-recorder 已执行）

| 检查 | 落点 | 期望 | 结果 |
|------|------|------|------|
| 平台阈值 | `finalize-sdk-run.ts` `PLATFORM_RUN_LIMIT_MS` | 7min | ✅ |
| R2 收紧 | `isRunTimeoutFailure` L66–76 | 无 ERROR/EXPIRED 无条件 true | ✅ |
| aborted 门控 | L59–60；`notifySdkFailure` L223 | 用户 Stop 不判超时、不 notify | ✅ |
| notify 顺序 | `finalizeSdkRunOnTimeout` L139–153 | archive → notify → cancel → abort | ✅ |
| 三层挂接 | `handleSdkEvent` L821–829；`streamRunEvents` L671–677；`completeSdkRun` L705–712 | 平台长时 → finalizer | ✅ |
| 文案优先 | `sdk-failure-messages.ts` L102–107 | 超时先于 CANCELLED 固定句 | ✅ |
| W1 缺口 | `isRunTimeoutFailure` L66–76 | 平台分支无单独 `run.status===cancelled` | ⚠️ staging K7 |
| crash_log 样本 | `crash_log/20260628181128` | 变更前 `sdk_cancelled` + ~8min ERROR | ✅ 静态对齐预期 |

**静态验证命令指针**（仅摘要，不贴长输出）：

```bash
rg "PLATFORM_RUN_LIMIT_MS|isRunTimeoutFailure|finalizeSdkRunOnTimeout" electron/finalize-sdk-run.ts
rg "handleSdkEvent|completeSdkRun|streamRunEvents" electron/agent-sdk.ts
rg "isTimeoutFailure|CANCELLED" electron/sdk-failure-messages.ts
```

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无 `auto_test/` 新增 |
| **运行依赖** | Electron + Daemon；SDK Agent；飞书/微信 IM |
| **环境变量** | `SDK_RESIDENT_AGENT`（K8 设 `0`）、`DAEMON_PORT`、通道 `LARK_*` / `WECHAT_*` |
| **回归样本** | `crash_log/20260628181128/`（`meta.json` + `electron-log.txt` L29–30） |
| **staging 建议** | K1/K2/K6 须在 staging 或专用账号执行；K7（W1）**仅 staging 可验证** |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- 联调失败区分：**操作/环境** vs **SDK/服务**；W1–W4 相关标注 warning ID。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-28 | 本地 dev | 04-review focused-review（T1–T4） | 通过 | 有条件；无阻断 |
| 2026-06-28 | 本地 dev | 静态契约 §4.2（grep + 源码复核） | 通过 | T1–T4 对齐 |
| 2026-06-28 | 本地 dev | crash_log/20260628181128 静态对照 | 通过 | 主路径 ERROR ~8min |
| 2026-06-28 | — | K1 平台长时 ≥7min | 待执行 | **staging 必测** |
| 2026-06-28 | — | **K2 会话续聊** | 待执行 | **核心必测** |
| 2026-06-28 | — | K3 用户 Stop | 待执行 | 手工 |
| 2026-06-28 | — | K4 notify 单条/可达 | 待执行 | 联调 |
| 2026-06-28 | — | K5 短 ERROR | 待执行 | 联调 |
| 2026-06-28 | — | K6 crash_log 联调回归 | 待执行 | 部署后 |
| 2026-06-28 | — | K7 W1 cancelled-only | 待执行 | **staging 待联调** |
| 2026-06-28 | — | K8 非长驻（可选） | 待执行 | R1 可选 |
| 2026-06-28 | — | T5 patch + changelog | 待执行 | `/kb-archive` |
