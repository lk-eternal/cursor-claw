# SDK 保活与 Run 生命周期兼容 - 验收记录

> **变更 ID**：`20260627150751-SDK保活与Run生命周期兼容`
> **阶段**：`/kb-test`（静态契约 + build 冒烟；长时保活与通道联调为手工/staging 必测）
> **评审结论引用**：`04-review.md` full-review 通过；R1/R2 为 warning 非阻断

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **静态契约**（04-review 全量 diff + 关键符号复核）+ **build 冒烟**（`npm run build`）+ **手工/staging 联调**（SDK 私聊保活 ≥25min、error 路径、文案分支）；**不新增**单元测试/集成测试 |
| **目标** | 覆盖 `01-proposal` 验收 1–10、`02-design` §8.2 工程补充项、`03-tasks` T1–T3 |
| **通过口径** | 代码路径与 02/03 一致（04 已勾）+ build exit 0；长时保活与 F3.2 兜底文案须 staging 实测后勾选 |
| **与 review 分工** | 04 负责实现与规范；本文负责验收追溯、可观测性对照与联调证据占位 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **01·3 / §8.2 验收 3**：≥25min 无新消息保活 | SDK Run 生命周期与真实通道时序；本地脚本无法稳定模拟 25min+ idle 且观测 SDK 终态 |
| **01·5 / F3.2 保活失败文案**（SDK 仍 error 时） | 依赖 Run 实际终止时机与 `lastTool` 快照；04 R2 提示非阻塞路径下 `lastTool` 可能为 `completed`，须联调确认兜底 |
| **01·1/2 error 终态可观测性**（真实 error Run） | 可静态确认日志格式；完整字段需复现 `status=error` 或对照历史案例字段映射 |
| **01·4 SYSTEM OVERRIDE 衔接** | Daemon 25min blocking 仅 CLI/legacy 路径触发；SDK 保活已非 blocking，须 curl 不带 `wait=false` 手工触发 |
| **01·9 飞书无回归** | 本变更无飞书代码 diff；回归依赖通道 smoke，非本变更专属脚本 |
| **`auto_test/` 脚本** | 本期未新增；验收以 build + 手工清单为主 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1** | error 终态日志可见 `run.result`、errorCode、末次 tool ≥2 项 | 04 静态 + 复现 error 或对照历史 Run | 代码 / 联调日志 | ✅ 静态；⏳ error 复现 |
| **01·2** | 保活失败路径 `lastTool=shell:running` | 04 静态 + 历史模式对照 | 代码 / 联调 | ✅ 静态 |
| **01·3** | ≥25min 无新消息，Run 不因 blocking poll 被 SDK error | **手工/staging 必测** | 长时联调 | ⏳ **必测待跑** |
| **01·4** | SYSTEM OVERRIDE 后继续保活，无误导失败 notify | 规则静态 + blocking curl 手工 | 代码 / 手工 | ✅ 规则；⏳ OVERRIDE 手工 |
| **01·5** | 保活 Run error → F3.2 文案，非单独「请稍后重试」 | 04 静态 + 模拟/复现 error | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **01·6** | 非保活 tool 失败仍通用文案，不误 F3.2 | 04 静态（shell:running+20min 三条件） | 代码复核 | ✅ 静态 |
| **01·7** | CANCELLED/EXPIRED/stop 文案不变 | 04 静态 | 代码复核 | ✅ 静态 |
| **01·8** | `cursor-claw.mdc` 阶段 4 非阻塞 + sleep 循环 | 04 静态 + 新工作区注入目检 | 代码 / 目检 | ✅ 阶段 4；⚠️ 前文表 R1 |
| **01·9** | 飞书排队/合并/流式无回归 | diff 无相关文件 + 通道 smoke | 代码 / smoke | ✅ diff；⏳ smoke |
| **01·10** | 引用 Run id 或等价日志证明可观测性落地 | 对照 `run-4dac4a72` 字段映射 | 诊断对照 | ✅ 见 §4.3 |
| **§8.2·1** | 同 01·3 锁定：非阻塞 poll + sleep 5s，无 Shell ≥1min | **手工/staging 必测** | 长时联调 | ⏳ **必测待跑** |
| **§8.2·2** | error 日志含 result/lastTool/durationMs ≥2 项 | 04 静态 + §4.3 对照 | 代码 / 日志 | ✅ 静态 |
| **§8.2·3** | 保活 error → F3.2 notify | 同 01·5 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **§8.2·4** | 非保活失败不误 F3.2 | 同 01·6 | 代码复核 | ✅ 静态 |
| **§8.2·5** | 阶段 4 含 `wait=false` 与 sleep | 04 静态 | 代码复核 | ✅ 静态 |
| **§8.2·6** | Daemon poll 无 diff；blocking OVERRIDE 仍可触发 | diff + curl 手工 | 代码 / 手工 | ✅ diff；⏳ curl |
| **T1** | lastTool、error 日志、formatSdkStreamFailure F3.2 | 04 T1 表 | 代码复核 | ✅ 静态 |
| **T2** | 阶段 4 非阻塞规则、SYSTEM OVERRIDE、禁令 | 04 T2 表 | 代码复核 | ✅ 静态 |
| **T3** | `@cursor/sdk ^1.0.22` + build | build 执行 | 构建日志摘要 | ✅ build 通过 |

## 4、场景摘要

### 4.1 手工/staging 必测清单（优先）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **K1 长时保活** | SDK 主用户私聊；Agent 完成一轮回复 | 不发新消息，连续等待 **≥25 分钟**；观察 Run 状态与 UI 日志 | Run **不**因单次 blocking poll 被 SDK `status=error` 终止；Shell 均为秒级 poll/sleep | 01·3、§8.2·1、T2 |
| **K2 保活后仍可用** | K1 通过后或任意保活中 | 第 26min 发一条新消息 | Agent 正常处理；无需重启应用 | 01·3、场景 A |
| **K3 SDK error 可观测** | 可复现 error 或参考历史 | 触发 Run `status=error`；查 UI/开发者日志「运行错误详情」行 | 含 `sessionKey`、`durationMs`、`lastTool`、`run.result`/`errorCode`/`waitResult` 中 ≥2 项 | 01·1、01·10、§8.2·2 |
| **K4 F3.2 文案** | 保活类 error（shell:running + duration≥20min） | 观察用户 notify | 「会话在等待下一条消息时已结束（等待超时）。请重新发送消息…」；**非**单独「请稍后重试」 | 01·5、§8.2·3 |
| **K5 通用失败** | 非保活 tool 失败（如搜索/改文件报错） | 观察 notify | 通用失败或安全 message；**不**误用 F3.2 | 01·6、§8.2·4 |
| **K6 取消/过期** | 用户 stop / 会话 EXPIRED | 各触发 1 次 | 「Agent 任务已取消。」/「Agent 会话已过期…」；stop 无失败 notify | 01·7 |
| **K7 SYSTEM OVERRIDE** | Daemon 运行；curl **不带** `wait=false` | blocking poll 等待至 25min OVERRIDE | Agent 规则要求立即下一轮 poll；无误导失败（除非 Run 已终止） | 01·4、§8.2·6 |
| **K8 规则注入** | 新工作区注入 `cursor-claw.mdc` | 读阶段 4 | 含 `wait=false`、`sleep 5` 循环；不要求单次无限 blocking | 01·8、§8.2·5 |
| **K9 飞书 smoke** | 飞书已连接 | 完成 1 次私聊 E2E | 入队/三态/流式与变更前一致（本变更未改飞书代码） | 01·9 |

### 4.2 静态/build 冒烟（已执行）

| 检查 | 操作指针 | 期望 |
|------|----------|------|
| 依赖版本 | `package.json` / lock `@cursor/sdk` | `^1.0.22`，lock 解析 1.0.22 |
| 构建 | 项目根 `npm run build` | exit 0 |
| error 日志格式 | `electron/agent-sdk.ts` `launchSdkAgent` → `run.status === "error"` | 单行 `运行错误详情:` 含结构化字段 |
| F3.2 分支 | `formatSdkStreamFailure` | shell:running + duration≥20min + 不安全 message → F3.2 |
| 阶段 4 规则 | `cursor-claw.mdc` L119–126 | `wait=false` + `sleep 5` 循环 |
| Daemon 无 diff | `git diff src/daemon.ts` | 无变更 |

### 4.3 诊断对照（`run-4dac4a72`）

历史失败 Run（变更前，见 `01-proposal`）与现网实现日志字段对照：

| 字段 | 历史 `run-4dac4a72` | 现网实现（error 终态） |
|------|---------------------|------------------------|
| Run 标识 | `run-4dac4a72` | UI 日志 `agentId=` / 会话 `sessionKey=`（F1.5） |
| 通道/会话 | `ch_0b1b964e` | 日志 `sessionKey=` 含 channel 前缀 |
| 终态 | `status=error`，无可读 `message`/`result` | 日志 `run.result=`、`lastStatus=`、`waitResult=` |
| 时长 | `durationMs≈1395228`（~23.2min） | 日志 `durationMs=` |
| 末次 tool | `shell:running`（blocking poll 挂起） | 日志 `lastTool=shell:running`（`handleSdkEvent` 赋值） |
| 用户侧 | 通用「请稍后重试」 | 保活类 → F3.2；其它 → 通用/安全 message |

**等价日志片段（实现格式，非历史原文）**：

```text
[SDK] ERROR [ch_0b1b964e::…] 运行错误详情: sessionKey=… agentId=… durationMs=1395228 lastTool=shell:running run.result=… errorCode=… waitResult=…
```

验收 10 通过标准：联调或复现时能在 UI/开发者日志中找到与上表 **≥2 列** 对应的结构化字段；历史 Run id 仅作归因对照，不要求重跑同一 id。

环境变量与凭据：**不写密钥**；SDK/通道凭据以本地已配置为准。

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无 `auto_test/` 新增脚本 |
| **运行依赖** | Electron 应用 + `src/daemon`；SDK 模式 Agent；主用户私聊会话 |
| **环境变量** | 仅名称：`DAEMON_PORT`（或应用内端口）、通道相关 `LARK_*` / `WECHAT_*` |
| **staging 建议** | K1 长时保活须在 **staging 或专用测试账号** 执行，避免占用生产会话 |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- 联调失败时区分：**操作/环境问题** vs **SDK/服务问题**（记备注列）。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-27 | 本地 dev | 04-review 全量 diff（T1/T2/T3） | 通过 | 静态契约 |
| 2026-06-27 | 本地 dev | `npm run build` | 通过 | exit 0；T3 |
| 2026-06-27 | 本地 dev | §4.3 对照 `run-4dac4a72` 字段映射 | 通过 | 可观测性格式 |
| 2026-06-27 | — | K1–K2 ≥25min 保活 | 待执行 | **staging 必测** |
| 2026-06-27 | — | K3–K6 error/文案分支 | 待执行 | 联调 |
| 2026-06-27 | — | K7 SYSTEM OVERRIDE curl | 待执行 | 手工 |
| 2026-06-27 | — | K8 规则注入目检 | 待执行 | 新工作区 |
| 2026-06-27 | — | K9 飞书 smoke | 待执行 | 无回归 |
