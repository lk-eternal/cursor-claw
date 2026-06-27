# Agent 自动压缩与上下文占用展示 - 验收记录

> **变更 ID**：`20260627215516-Agent自动压缩与上下文占用展示`
> **阶段**：`/kb-test`（静态 build/tsc + 代码路径复核；飞书/SDK 真实 Run E2E 待联调）
> **实现状态**：`stage=applied` → 本文产出后 `tested`

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **静态契约**（03 任务与关键符号复核）+ **tsc 冒烟**（`npm run build:mcp`）+ **手工/staging E2E**（飞书私聊/群聊、流式 final、压缩日志）；**不新增**单元测试/集成测试 |
| **目标** | 覆盖 `01-proposal` 验收 1–8、`02-design` §八·（二）工程补充项、`03-tasks` T1–T6 |
| **通过口径** | helper 导出与 footer 格式化可静态确认 + tsc exit 0；用户可见 footer 与压缩日志须 **真实 SDK Run + 飞书通道** 联调后勾选 |
| **与 review 分工** | review 偏实现与规范；本文负责验收追溯、E2E 清单与执行记录 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **01·1/2 飞书私聊/群聊 footer** | 依赖 Cursor SDK 真实 Run、`turn-ended` usage 与 `Cursor.models.list` 上限；本地无稳定 mock |
| **01·3 流式 final-only** | 须观测 stream-text PATCH 序列与 final 包正文；CardKit 时序不可脚本化 |
| **01·5 自动压缩** | 须长上下文或接近上限场景触发 harness summarization；事件类型以 SDK 为准 |
| **01·4/6/7 短对话、占用不可得、错误 notify** | 需可控 Run 结果与 limit 解析失败分支；E2E 手工 |
| **§8.2·1 onDelta 不阻塞 send** | 可静态读代码；运行时异常路径须 SDK 联调 |
| **`auto_test/` 脚本** | 本期未新增；验收以 tsc + 手工 E2E 清单为主 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1** | 私聊最终回复末尾含 `上下文：{p}% ({used}k/{limit}k)` | E2E 手工 | 飞书消息截图/摘要 | ⏳ E2E 待跑 |
| **01·2** | 群聊 stream-text 路径同上 | E2E 手工 | 飞书群消息 | ⏳ E2E 待跑 |
| **01·3** | footer 仅 final 出现，中间 PATCH 无重复 | E2E + 流式日志 | stream-text 序列 | ⏳ E2E 待跑 |
| **01·4** | 短对话首轮仍展示 footer，数值非硬编码 | E2E 手工 | 飞书消息 | ⏳ E2E 待跑 |
| **01·5** | 接近上限可观察压缩；会话可继续 | E2E 长会话 + SDK UI 日志 | `[compression]` 或等价 | ⏳ E2E 待跑 |
| **01·6** | limit/usage 不可得时无 footer、无 NaN | E2E 或模拟 limit 失败 | 飞书消息 | ⏳ E2E 待跑 |
| **01·7** | 错误 notify：有数据附加、无则省略 | E2E 触发 error Run | notify 正文 | ⏳ E2E 待跑 |
| **01·8** | TypeScript 编译；单 helper ≤300 行 | `npm run build:mcp` + 行数 | 构建 / 静态 | ✅ tsc 通过；context-usage 180 行 |
| **§8.2·1** | onDelta 异常不阻塞 send | 静态 + 联调 | 代码 / 日志 | ✅ 静态；⏳ 联调 |
| **§8.2·2** | summary 事件可在 SDK UI 日志检索 | E2E 长会话 | UI 日志关键词 | ⏳ E2E 待跑 |
| **§8.2·3** | 新 Run 开始时 usage 清零 | 静态 `resetSdkRunPresentationState` | 代码复核 | ✅ 静态 |
| **§8.2·4** | 单 helper ≤300 行；中文注释 | 行数 + 抽样 | 静态 | ✅ 静态 |
| **§8.2·5** | `npm run build` / tsc 通过 | `npm run build:mcp` | 构建摘要 | ✅ tsc 通过 |
| **T1** | context-usage 导出与 format/append 契约 | 静态读 `electron/context-usage.ts` | 代码复核 | ✅ 静态 |
| **T2** | 两处 send 挂载 onDelta；summary 日志 | 静态读 `agent-sdk.ts` | 代码复核 | ✅ 静态 |
| **T3** | Run 边界 usage 清零；limit 缓存 | 静态 | 代码复核 | ✅ 静态 |
| **T4** | final flush 前 append；中间 chunk 不含 | 静态 `doFlushStreamPost` | 代码复核 | ✅ 静态 |
| **T5** | `electron/AGENTS.md` 与实现一致 | 文档对照 | 文档 | ✅ 静态 |
| **T6** | 06 文档 + build 记录 | 本文 + tsc | 验收记录 | ✅ 静态部分完成 |

## 4、场景摘要

### 4.1 E2E 手工/staging 清单（真实 SDK Run 必测）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **E1 私聊 footer** | Electron + daemon 运行；主用户私聊；SDK Agent | 发送简单问题，等待 Run 完成 | 最终飞书正文末尾一行 `上下文：…% (…k/…k)` | 01·1、T4 |
| **E2 群聊 footer** | 群聊已启用 stream-text | 群内 @Agent 完成一轮 | 同 E1 格式 | 01·2 |
| **E3 流式无重复** | f41Eligible 私聊/群聊 | 观察流式卡片更新过程 | 仅 **final** 消息含 footer；中间 PATCH 正文无 `上下文：` | 01·3 |
| **E4 短对话数值** | 新会话首轮 | 单轮问答 | footer 百分比较低且与用量合理 | 01·4 |
| **E5 占用不可得** | limit 解析失败或 mock 不可用（若可复现） | 完成 Run | 正文正常；**无** footer、`NaN`、`undefined` | 01·6、B4-a |
| **E6 错误 notify** | 触发 Run error 且仍有 usage | 读用户可见 notify | 有 usage 则附加 footer；无则省略 | 01·7 |
| **E7 压缩日志** | 长上下文多轮或接近上限 | 查 SDK UI 日志 | 可见 `summary-started` / `summary-completed` 或 `[compression]` 前缀 | 01·5、§8.2·2 |
| **E8 多 turn 累积** | 同 Run 多轮 send | 对比 footer 数值 | usage 单调累积；新 Run 从低占用重新开始 | T3、§8.2·3 |

### 4.2 静态/tsc 冒烟（已执行）

| 检查 | 操作指针 | 期望 |
|------|----------|------|
| TypeScript | 项目根 `npm run build:mcp` | exit 0 |
| helper 行数 | `electron/context-usage.ts` | ≤300 行（实测 180） |
| footer 格式化 | `formatContextFooter(90000, 200000)` | 含 `45%` 与 k 单位 |
| limit null | `formatContextFooter(state, null)` | 返回 null |
| 幂等 append | `appendContextFooter` 对已含 `上下文：` 正文 | 不重复追加 |
| onDelta 挂载 | `launchSdkAgent` / `dispatchToSdkAgent` send | 均传入 onDelta |
| final-only | `doFlushStreamPost(..., final=true)` | 先 `applyContextFooterToBuffer` |
| daemon 无 diff | 本变更不改 `src/daemon.ts` | footer 已在 agent-sdk 正文 |

环境变量与凭据：**不写密钥**；SDK API Key、飞书 `LARK_*` 以本地已配置为准。

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无 `auto_test/` 新增脚本 |
| **运行依赖** | Electron 应用 + `src/daemon`；SDK 模式 Agent；飞书通道已连接 |
| **环境变量** | 仅名称：`DAEMON_PORT`、`LARK_*`（或应用内等价配置）、Cursor API Key（已配置） |
| **staging 建议** | E1–E8 须在 **staging 或测试飞书租户** 执行，避免污染生产会话 |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- E2E 失败时区分：**操作/环境问题** vs **SDK/模型上限 API 问题**（记备注列）。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-27 | 本地 dev | T1–T5 静态契约（03 + 关键符号） | 通过 | 代码路径对齐 |
| 2026-06-27 | 本地 dev | `npm run build:mcp`（tsc） | 通过 | exit 0 |
| 2026-06-27 | 本地 dev | context-usage 行数 ≤300 | 通过 | 180 行 |
| 2026-06-27 | — | E1–E2 飞书私聊/群聊 footer | 待执行 | 需真实 SDK Run |
| 2026-06-27 | — | E3 流式 final-only | 待执行 | 需 stream-text |
| 2026-06-27 | — | E4–E6 短对话/不可得/error | 待执行 | 联调 |
| 2026-06-27 | — | E7 压缩日志 | 待执行 | 长会话 |
| 2026-06-27 | — | E8 多 turn 累积 | 待执行 | 联调 |
