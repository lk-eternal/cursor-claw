# Agent失败日志崩溃分析归档 - 验收记录

> **变更 ID**：`20260628165859-Agent失败日志崩溃分析归档`
> **阶段**：`/kb-test`（静态契约 + build 冒烟；E2E 落盘与 IM 联调为可选手工）
> **评审结论引用**：`04-review.md` 有条件通过；W2 写盘失败重复目录为 accepted_debt（T5 AGENTS.md 已于 apply 后补齐）

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **静态契约**（04-review + 挂接点/归档模块全量阅读）+ **build 冒烟**（`npm run build`）+ **可选手工/E2E**（Settings 持久化、两类失败落盘、±30 行计数、IM 文案回归） |
| **目标** | 覆盖 `01-proposal` 验收 1–8、`03-tasks` T1–T4 静态项；T5 文档对齐单独跟踪 |
| **通过口径** | 代码路径与 02/03/04 一致 + build exit 0；静态项标 ✅；需真实 Agent 失败链路的项标 ⏳ 待手工 |
| **与 review 分工** | 04 负责实现与规范；本文负责验收追溯与执行证据 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **01·1** 两类失败场景落盘（Run error / dispatch / stream / timeout） | 依赖 SDK + IM 调度链稳定复现失败；本地无轻量 mock |
| **01·2** 事件目录结构与文件可读性 | 须配置可写目录并触发真实失败后检查 FS |
| **01·3** ±30 行边界计数 | 须 logBuffer ≥61 且失败点居中；可手工 `wc -l` 或读 `meta.json.buffer` |
| **01·5** 重启后配置仍有效 | 须 Electron 应用重启 + `getConfig()` 或 Settings UI 复核 |
| **01·7** IM 侧文案/条数无回归 | 须飞书/微信通道联调观测 notify 条数与内容 |
| **W2** 写盘失败同次双目录 | 低概率；须 mock `writeFileSync` 失败或 accepted_debt |
| **`auto_test/` 脚本** | 本期未新增；以 build + 静态 + 手工清单为主 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1** | 至少两类失败产生 `yyyymmddhhmmss` 子目录；同次失败不重复建目录 | 04 静态挂接 + E2E | 代码 / 联调 | ✅ 静态；⏳ E2E |
| **01·2** | 根目录=配置项；一层时间戳子目录；子目录内可读日志文件 | `crash-log-archiver.ts` 产物约定 | 代码 / FS | ✅ 静态；⏳ E2E |
| **01·3** | buffer 充足时锚点 ± 至多 30 前/后行 | `CONTEXT_LINES=30`、`extractSnapshot` | 代码 / 计数 | ✅ 静态 |
| **01·4** | buffer 不足或锚点靠首尾：全量相邻行；无崩溃、无空文件（极低概率空 buffer 见 04 §7） | `extractSnapshot` 边界 + catch 不 throw | 代码 | ✅ 静态 |
| **01·5** | Settings 可配、持久化；重启后仍有效；新失败写入所配路径 | T1/T4 静态 + 重启联调 | 代码 / 手工 | ✅ 静态；⏳ 重启 |
| **01·6** | 未配置目录：notify/UI 正常；不建归档；不因归档阻断 | L114–122 WARN 跳过 | 代码 / E2E | ✅ 静态；⏳ E2E |
| **01·7** | IM 不出现完整堆栈/长日志；失败提示条数与现网一致 | archive 在 `notifySessionChat` 前 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **01·8** | 连续失败各独立目录；同秒 `-NNN`；单次失败幂等 | `failureArchiveDone` + `resolveUniqueDirName` | 代码 / E2E | ✅ 静态（W2 边缘）；⏳ E2E |
| **T1** | 三处 `AppConfig.crashAnalysisDir`；defaults `""` | config-store / preload / env.d.ts | 代码 | ✅ |
| **T2** | 单一入口、±30、未配置 WARN 节流、写盘不 throw | `crash-log-archiver.ts` 175 行 | 代码 | ✅ |
| **T3** | notifySdk/Dispatch + finalizer 先于 notify；stream/timeout/cancelled 类型 | agent-sdk / finalize-sdk-run | 代码 | ✅ |
| **T4** | Settings general 目录选择 + 清除 + autoSave | Settings.tsx | 代码 | ✅ |
| **T5** | AGENTS.md 失败归档约定 | `electron/AGENTS.md` 失败归档小节 | 文档 | ✅ |
| **04·W2** | 写盘失败时 `failureArchiveDone` 未置位可能双目录 | 04 §3 | accepted_debt | ⚠️ open |

## 4、场景摘要

### 4.1 可选手工/E2E 清单

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **K1 Run error 归档** | Settings 配置可写崩溃分析目录 | 触发 SDK Run `status=error` | 根目录下新增 `yyyymmddhhmmss`（或 `-001`）子目录；含 `electron-log.txt`、`meta.json` | 01·1/2 |
| **K2 dispatch 失败归档** | 同上；长驻 idle 二次 dispatch 失败 | 观察 dispatch catch | 同上结构；`meta.failureType=dispatch_failed` | 01·1 |
| **K3 超时 finalizer 单目录** | 触发 `sdk_timeout` finalizer 链 | 查事件目录数量 | **同次失败仅 1 个**目录（finalizer 先于 notify） | 01·1/8 |
| **K4 ±30 计数** | 会话产生 ≥61 条 UI 日志后失败 | 打开 `electron-log.txt` 或读 `meta.json.buffer` | `linesBefore`/`linesAfter` ≤30；触发行含 `[crash-archive-trigger]` | 01·3 |
| **K5 未配置跳过** | 清除崩溃分析目录并保存 | 触发任意失败 | IM 仍一条短提示；无新子目录；UI 见节流 WARN | 01·6 |
| **K6 Settings 持久化** | K1 目录路径 | 重启应用 → 打开 Settings | 路径仍显示；再失败仍写入同根目录 | 01·5 |
| **K7 IM 无回归** | 配置目录后失败 | 查飞书/微信消息 | 仍一条用户可读短句；**无** stack/长日志/额外 IM 条 | 01·7 |
| **K8 同秒连续失败** | 快速连续触发两次独立失败 | 查根目录 | 两个子目录（`-001` 或不同秒）；各含独立 meta | 01·8 |

### 4.2 静态/build 冒烟（已执行）

| 检查 | 操作指针 | 期望 |
|------|----------|------|
| 归档模块 | `electron/crash-log-archiver.ts` | 单一入口、`ANCHOR_MARKER`、±30、上海时区命名、`-NNN` 冲突 |
| SDK 失败挂接 | `agent-sdk.ts` `notifySdkFailure` L230、`notifyDispatchFailure` L254 | archive 在 `notifySessionChat` 前 |
| 超时 finalizer | `finalize-sdk-run.ts` L133–139 | archive 先于 `notifySdkFailure` |
| 幂等闩 | `failureArchiveDone` reset/startSdkRun | 新 Run 可再次归档 |
| 配置 SSOT | `config-store.ts` L32、L73 | 字段与 defaults |
| Settings UI | `Settings.tsx` L657–667 | 简体中文 + selectDirectory + 清除 |
| 类型贯通 | `preload.ts`、`env.d.ts` | `crashAnalysisDir: string` |
| 构建 | 项目根 `npm run build` | exit 0 |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无 `auto_test/` 新增脚本 |
| **运行依赖** | Electron 应用 + Daemon；SDK 模式 Agent；可写本地目录 |
| **环境变量** | 无新增必需项；通道凭据沿用既有 `LARK_*` / `WECHAT_*`（勿写入本文） |
| **手工建议** | K1–K3 至少覆盖 **两类**失败路径；K7 须在真实 IM 通道执行 |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- E2E 失败时区分：**配置/权限问题** vs **归档逻辑问题**（记备注列）。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-28 | 本地 dev | 04-review focused-review（T1–T4） | 通过 | 有条件；W1/W2 |
| 2026-06-28 | 本地 dev | 静态挂接复核（notify/finalizer/archiver） | 通过 | 01·3/4/6/7/8 静态 |
| 2026-06-28 | 本地 dev | `npm run build` | 通过 | exit 0 |
| 2026-06-28 | — | K1–K2 两类失败落盘 | 待执行 | 可选 E2E |
| 2026-06-28 | — | K3 超时单目录 | 待执行 | 可选 E2E |
| 2026-06-28 | — | K4 ±30 计数 | 待执行 | 可选手工 |
| 2026-06-28 | — | K5 未配置跳过 | 待执行 | 可选 E2E |
| 2026-06-28 | — | K6 Settings 重启持久化 | 待执行 | 可选手工 |
| 2026-06-28 | — | K7 IM 无回归 | 待执行 | 可选联调 |
| 2026-06-28 | — | K8 同秒连续失败 | 待执行 | 可选 E2E |
| 2026-06-28 | 本地 dev | T5 AGENTS.md 静态复核 | 通过 | 失败归档小节已写入 |
