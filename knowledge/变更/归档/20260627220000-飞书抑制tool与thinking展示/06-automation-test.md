# 飞书抑制 tool 与 thinking 展示 - 验收记录

> **变更 ID**：`20260627220000-飞书抑制tool与thinking展示`
> **阶段**：`/kb-test`（lite；LITE-01 静态已通过；飞书/微信 E2E 待人工）
> **追溯来源**：`01-proposal.md` 验收 1–8；任务 LITE-01

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **编译门禁**（`npm run build`、`tsc --noEmit`）+ **静态契约**（门控 grep/精读）+ **飞书/SDK/微信联调**（E1–E7） |
| **目标** | 飞书全通道抑制 tool/thinking CardKit；assistant stream-text 不变；SDK UI 日志保留；ordering 闩锁仍更新；移除 v1.6.1 群聊 shell 双策略 |
| **排除范围** | CardKit 视觉样式、MergeBatch、proto/DB；`02-飞书通道.md` 知识同步（LITE-02，scribe 待办） |
| **通过口径** | 静态项全 ✅ → `stage=tested`；**归档门禁**须 E1–E5 至少一次飞书联调 + E6 微信 smoke |
| **与 review 分工** | 无独立 04；本文承担静态证据与 E2E 占位 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **E1–E5** 飞书 tool/thinking/assistant 目检 | 须 SDK Run + 飞书 IM + CardKit；无 headless 契约 |
| **E6** 微信过程展示回归 | 须微信通道运行态；本变更未改微信路径，仅 smoke |
| **E7** ordering defer 仍生效 | 须 p2p + `PRESENTATION_ORDERING` 默认开，观察 assistant 首建时机（无过程卡） |
| **`auto_test/`** | 本期未新增；Presentation 门控无独立 HTTP 契约可替代 E2E |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1** | 飞书群聊：无 tool CardKit（含 shell） | 飞书 E2E E1 | 联调 | ⏳ 待联调 |
| **01·2** | 飞书私聊：无 tool CardKit | 飞书 E2E E2 | 联调 | ⏳ 待联调 |
| **01·3** | 飞书群聊+私聊：无 thinking CardKit | 飞书 E2E E3 | 联调 | ⏳ 待联调 |
| **01·4** | assistant stream-text 群聊/私聊正常 | 飞书 E2E E4 | 联调 | ⏳ 待联调 |
| **01·5** | SDK UI 仍见 `[tool]` / `[thinking]` 日志 | Electron UI E5 | 联调 | ⏳ 待联调 |
| **01·6** | 微信 tool/thinking/流式与改前一致 | 微信 E6 | 联调 | ⏳ 待联调 |
| **01·7** | v1.6.1 群聊 shell 门控已移除 | grep 代码树 | 静态 | ✅ |
| **01·8** | TypeScript 编译通过 | `npm run build` + `tsc` | 静态 | ✅ |
| **LITE-01** | 共享门控 `feishu-presentation-gate.ts` | 双端 import + 单元逻辑 | 静态 | ✅ |
| **LITE-01** | Electron `postPresentationEvent` 飞书早退 | L240 抑制 + L617/606 日志先于 POST | 静态 | ✅ |
| **LITE-01** | Daemon 静默 `{ ok: true }` + ordering 闩锁 | L1347–1362 tool；L1457–1477 thinking | 静态 | ✅ |
| **LITE-01** | 微信路径不经飞书门控 | `channelType !== "feishu"` 早 false | 静态 | ✅ |
| **LITE-02** | `02-飞书通道.md` 与 AGENTS 同步 | 文档 diff | 文档 | ⚠️ AGENTS ✅；02 待 scribe |

## 4、场景摘要

### 4.1 飞书/SDK 联调清单（优先）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **E1 群聊多 tool** | 飞书群 @；SDK 资源；含 shell + read/grep | 发送「拉代码并读 README」类任务 | 会话内**无任何** tool CardKit（含 shell markdown 卡） | 01·1 |
| **E2 私聊多 tool** | 主用户私聊 SDK | 同 E1 工具组合 | **无任何** tool CardKit | 01·2 |
| **E3 thinking** | 群聊或私聊；模型产出 thinking | 触发含 reasoning 的 Run | **无** thinking CardKit | 01·3 |
| **E4 assistant 流式** | 群聊 + 私聊各 1 次 | 短问答或带 tool 的长任务 | **有** stream-text CardKit；PATCH 正常；`final` 收口 | 01·4 |
| **E5 SDK UI 日志** | Electron 窗口打开 UI 日志 | 同 E1–E3 | 可见 `pushUiLog [tool]`、`appendSdkLog [thinking]`，内容与抑制前等价 | 01·5 |
| **E7 ordering defer** | 私聊；`PRESENTATION_ORDERING` 默认开 | 带 tool 任务 × 1 | 飞书无过程卡；assistant 卡**不**抢在 tool 完成前首建（defer 仍生效） | 挂靠 20260627210352 Rev1 |

### 4.2 微信对照（若适用）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **E6 微信 smoke** | 微信通道已连接 | 触发含 tool 的 Run × 1 | tool/thinking/流式展示与改前一致（本变更未改 daemon 微信分支） | 01·6 |

### 4.3 静态冒烟（本次已执行）

| 检查 | 命令/方式 | 期望 | 结果 |
|------|-----------|------|------|
| 全量构建 | `npm run build` | exit 0 | ✅ |
| TypeScript | `npx tsc --noEmit` | exit 0 | ✅ |
| 旧门控移除 | `rg isGroupChatPresentationEventAllowed\|isGroupChatPresentationToolAllowed`（排除 knowledge） | 0 命中 | ✅ |
| 新门控存在 | `feishu-presentation-gate.ts` + 双端 wrapper | 仅 `tool`/`thinking` + `feishu` | ✅ |
| SDK 日志保留 | `agent-sdk.ts` `handleSdkEvent` | `pushUiLog`/`appendSdkLog` 在 `postPresentationEvent` 之前 | ✅ |
| ordering 闩锁 | `daemon.ts` tool/thinking handler | 抑制 return **前**更新 `presentationProcessActive` 等 | ✅ |

### 4.4 联调观察点（失败判责）

| 现象 | 优先怀疑 | 备注 |
|------|----------|------|
| 飞书仍出现 tool/thinking 卡 | 非 feishu 会话或旧进程未重启 | 查 `resolveChannel` / sessionKey |
| 飞书无 assistant 流式 | stream-text 回归，非本变更门控 | 查 CardKit 创建日志 |
| SDK 无 tool/thinking 日志 | Electron 未走 SDK 路径 | 查 f41Eligible / 资源绑定 |
| assistant 仍抢首建 | ordering defer 回归 | 查 `releaseDeferredAssistantStream`；过程卡已不存在属预期 |
| 微信过程展示异常 | 非本 diff 范围 | 对比 git 基线 daemon 微信分支 |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 无新增 `auto_test/` |
| **运行依赖** | Electron 或 Daemon + 飞书应用；可选微信通道 |
| **环境变量** | `PRESENTATION_ORDERING`（默认开，E7）；`DAEMON_PORT`；飞书 `LARK_*` 仅写变量名 |
| **重启** | 门控变更后须重启 Electron/Daemon 进程 |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景、结果、备注（一词结论）。
- 失败时区分：**脚本/操作问题** vs **服务/通道/SDK 问题**。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-28 | 本地 | `npm run build` | 通过 | exit 0 |
| 2026-06-28 | 本地 | `npx tsc --noEmit` | 通过 | exit 0 |
| 2026-06-28 | 本地 | 旧门控符号 grep（代码树） | 通过 | 0 命中 |
| 2026-06-28 | 本地 | 双端门控 + ordering 闩锁精读 | 通过 | LITE-01 |
| 2026-06-28 | — | E1–E5/E7 飞书/SDK 联调 | 待执行 | 无通道环境 |
| 2026-06-28 | — | E6 微信 smoke | 待执行 | 可选 |
