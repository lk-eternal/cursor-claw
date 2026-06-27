# 飞书作为 Cursor 展示与控制层 - 验收记录

> **变更 ID**：`20260627162620-飞书作为Cursor展示与控制层`
> **阶段**：`/kb-test`（MVP T1–T7；T8–T12 标注跳过）
> **评审结论引用**：`04-review.md` focused-review 通过；无严重项；R2/R3 为 info 债务

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **静态契约**（04-review + 符号/grep 复核）+ **build 冒烟**（`npm run build:mcp` / `tsc`）+ **Daemon HTTP 契约探测**（可选 curl）+ **飞书/SDK 联调**（主用户私聊 + 群聊 SDK） |
| **MVP 范围** | 阶段 0+1（T1–T7）；对应 `01` MVP 验收 1–4、阶段 0 补充 5、阶段 1 补充 6 |
| **排除范围** | T8–T12（阶段 2/3）**pending，本轮回测跳过**；01 阶段 2/3 验收 7–11 留待后续迭代 |
| **通过口径** | 代码路径与 02/03 一致（04 已勾）+ tsc exit 0；联调项满足 NF1/NF2/NF5；P95 与同 Agent 双 send 须 `08-verify` 实测 |
| **与 review 分工** | 04 负责实现与规范；本文负责验收追溯、静态证据与联调占位 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **01 MVP-1/3**：连发 3 条无 poll、合并投递 | 依赖真实飞书 IM + SDK Agent 长驻时序；无 headless 契约 |
| **01 MVP-2/4**：工具 CardKit + 管道一致性 | 需 SDK Run 触发 tool 事件与飞书 CardKit PATCH；通道 API 限流 |
| **§八·(二)·10**：ready→dispatch P95 ≤ 3s | 须联调计时；collecting 静默窗口（默认 2.5s）不计入 |
| **§八·(二)·11**：同 Agent 连续两次 `send` | SDK Run 关系须 spike；约定写入 `08-verify-issue` |
| **§八·(二)·5–9**：合并卡交互（立即发送/拆开/编辑） | 卡片按钮 callback 属 T8；MVP 可用静默窗口、回复编辑、`POST /api/merge-batch/action` |
| **T8–T12** | 阶段 2/3 未实现；本轮回测 **跳过** |
| **`auto_test/` 脚本** | 本期未新增；可参考 `auto_test/20260627150041-feishu-merge-preview/` 契约脚本做 HTTP 探测 |
| **inject mtime 目检** | T1 需 launch 前后对比 `~/.cursor` mtime；须本地手工或 staging |

## 3、验收追溯表

### 3.1 MVP 任务（T1–T7）

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **T1** | launch 不写盘；`launchAgent` 无 inject | 04 静态；`injectWorkspaceToDir` no-op | 代码复核 | ✅ 静态 |
| **T1** | `~/.cursor` mtime 不变 | launch 前后目检 | 手工 | ⏳ 待目检 |
| **T2** | 连发 3 条仅 1 合并卡 + ≤1 F1 | 04 静态 + 飞书联调 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T2** | collecting 不 claim/dispatch | `shouldDeferDispatch` 静态 | 代码复核 | ✅ 静态 |
| **T2** | 回复合并卡改 `overrideText` | `tryHandleMergePreviewReply` | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T3** | tool/thinking → `PresentationEvent` | 04 静态 + daemon 日志 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T3** | 无主路径 notify 工具进度 | 04 静态 | 代码复核 | ✅ 静态 |
| **T4** | 工具 CardKit + 流式不刷屏 | 04 静态 + 私聊联调 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T4** | 群聊 SDK 同管道（R1 修复后） | 04 复评 + 群聊联调 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T4** | `presentation_failed` 可检索 | grep `logPresentationFailed` | 代码复核 | ✅ 静态 |
| **T5** | 静默窗口不 dispatch；ready 后 dispatch | 04 静态 + 联调 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T5** | processing 排队 + idle flush | `flushReadyMergeBatches` | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T5** | [拆开逐条] | HTTP `split` ✅；卡片按钮 T8 | API / 联调 | ⚠️ HTTP 可用；按钮跳过 |
| **T5** | ready→dispatch P95 ≤ 3s | 联调计时 | 联调 | ⏳ 待 08-verify |
| **T6** | 连发无 poll + 合并投递 | 04 静态 + 进程/日志观察 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T6** | Run 结束保留实例 + 二次 send | `SDK_RESIDENT_AGENT` 静态 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T6** | 同 Agent 连续 send spike | 手工/staging | 08-verify | ⏳ 待 08-verify |
| **T6** | `dispatch_failed` 日志 | grep 静态 | 代码复核 | ✅ 静态 |
| **T7** | 无 CLI；`poll-message` 404 | grep + 可选 curl | 代码 / HTTP | ✅ 静态 |
| **T7** | 无 SDK Key 时 notify 可理解 | 04 静态 + 脱 Key 联调 | 代码 / 联调 | ✅ 静态；⏳ 联调 |
| **T7** | 单 Daemon IM→调度→展示闭环 | 04 静态 | 代码复核 | ✅ 静态 |
| **T7** | 无 poll 保活用户可见副作用 | poll 端点 404 | 代码复核 | ✅ 静态 |

### 3.2 阶段 2/3（T8–T12，本轮回测跳过）

| 来源 | 验收要点 | 状态 |
|------|----------|------|
| **T8** | 卡片控制 + merge 编辑表单 | ⏭️ pending 跳过 |
| **T9** | 工具批准闭环 | ⏭️ pending 跳过 |
| **T10** | 废弃 MCP / admin HTTP | ⏭️ pending 跳过 |
| **T11** | Agent 标识持久化 | ⏭️ pending 跳过 |
| **T12** | Electron 托盘 spawn-only | ⏭️ pending 跳过 |

### 3.3 `01-proposal` 与 `02` §八·（二）

| 来源 | 验收要点 | 验证方式 | 状态 |
|------|----------|----------|------|
| **01 MVP-1** | active Agent 合并后主动投递 | 联调 M1 | ⏳ 联调 |
| **01 MVP-2** | 工具进度 CardKit | 联调 M2 | ⏳ 联调 |
| **01 MVP-3** | 连发 3 条无 blocking poll | 联调 M1 + 进程观察 | ⏳ 联调 |
| **01 MVP-4** | 进度来自管道非 Agent 自发 | 联调 M2 | ⏳ 联调 |
| **01·5** | 群聊 SDK 统一管道 | 联调 M3 | ⏳ 联调 |
| **01·6** | 无 poll 保活副作用 | 静态 + 联调 | ✅ 静态 |
| **§八·(二)·1** | 无 CLI；poll-message 404 | 静态 | ✅ 静态 |
| **§八·(二)·2** | 无 Key 入队可确认、dispatch 失败 notify | 联调 M4 | ⏳ 联调 |
| **§八·(二)·3** | 群聊 SDK 第二通道 | 联调 M3 | ⏳ 联调 |
| **§八·(二)·4** | claim-and-merge 与 ack 一致 | 04 静态 | ✅ 静态 |
| **§八·(二)·5** | 1 合并卡 + ≤1 F1 | 联调 M1 | ⏳ 联调 |
| **§八·(二)·6** | 静默窗口 / 立即发送 dispatch | 联调 M1；按钮 T8 | ⚠️ 窗口可用 |
| **§八·(二)·7** | processing 排队 + idle flush | 联调 M5 | ⏳ 联调 |
| **§八·(二)·8** | 编辑后投递 = override | 联调 M6 | ⏳ 联调 |
| **§八·(二)·9** | [拆开逐条] | HTTP / T8 按钮 | ⚠️ HTTP 可用 |
| **§八·(二)·10** | P95 ≤ 3s + 日志字段 NF5 | 08-verify | ⏳ 待实测 |
| **§八·(二)·11** | 同 Agent 双 send spike | 08-verify | ⏳ 待 spike |
| **§八·(二)·12** | 启动不写 `.cursor` | 目检 | ⏳ 待目检 |
| **§八·(二)·13** | 单 Daemon 闭环 | 04 静态 | ✅ 静态 |
| **§八·(二)·14** | 无 cursor-claw.mdc 仍可 MVP | 联调 | ⏳ 联调 |

## 4、场景摘要

### 4.1 手工/联调清单（MVP 优先）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **M1 主动投递+合并** | 主用户私聊 SDK Agent 已运行；`SDK_RESIDENT_AGENT` 默认开 | 连发 3 条（间隔 &lt;2s）；观察进程无 blocking poll/shell 保活 | 仅 1 张合并卡 PATCH；静默后或 ready 后合并投递；无 poll-message 调用 | 01 MVP-1/3、T2/T5/T6 |
| **M2 工具 CardKit** | 同上；触发含 tool 的任务 | 观察飞书工具卡与流式正文 | 结构化工具进度卡；与正文不重复刷屏 | 01 MVP-2/4、T3/T4 |
| **M3 群聊 SDK** | 飞书群 + `allowOthers` + SDK 通道 | 发消息触发 tool/长回复 | 流式+工具走同一 presentation 管道 | 01·5、T4、§八·3 |
| **M4 无 SDK Key** | 临时移除/留空通道 SDK Key | 入队 1 条 | 入队确认可达；dispatch 失败 notify 可理解 | T7、§八·2 |
| **M5 processing 排队** | Agent 处理中 | 再连发 2 条 | 合并卡脚本文案示排队；idle 后 auto flush | T5、§八·7 |
| **M6 编辑 override** | collecting/ready 态合并卡 | 回复卡片全文或 edit fallback | 投递内容 = `overrideText` | T5、§八·8 |
| **M7 dispatch 失败** | 模拟 launch/dispatch 失败 | 观察日志与队列 | 含 `dispatch_failed`；用户 notify（R3：claim 已 ack，须手动重发） | T6/T7、R3 |

### 4.2 可选 HTTP 契约探测（Daemon 已启动）

| 检查 | 方法 | 期望 |
|------|------|------|
| poll 已废弃 | `GET /api/poll-message` | 404 |
| presentation 入口 | `POST /api/presentation-event` 缺参 | 4xx |
| merge 动作 | `POST /api/merge-batch/action` 合法 body | `ok` 或业务错误可理解 |
| claim 门控 | `POST /api/orchestrator/claim-and-merge` collecting 态 | 拒绝或非 ready |

端口见本地 `DAEMON_PORT` 或 lock 文件；**不写密钥**。

### 4.3 静态冒烟（本次已执行）

| 检查 | 期望 |
|------|------|
| `npm run build:mcp` | exit 0 |
| grep `sendMergePreview` / `_launchCliAgent` | 无匹配 |
| `poll-message` handler | 返回 404 JSON |
| `dispatch_failed` / `presentation_failed` / `agent_failed` | daemon/agent-sdk 可检索 |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无新增 `auto_test/`；可参考 `auto_test/20260627150041-feishu-merge-preview/phase-api-contract.sh` 扩展 merge/presentation 探测 |
| **运行依赖** | Electron 或独立 Daemon；飞书应用已配置；SDK 资源与 API Key 已配置 |
| **环境变量** | `SDK_RESIDENT_AGENT`（默认开）、`MERGE_QUIET_MS`、`DAEMON_PORT`；飞书 `LARK_*` 仅名称 |
| **数据准备** | 主用户私聊会话；可选群聊（allowOthers）；可选脱 Key 测 M4 |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景、结果、备注（一词结论）。
- 失败时区分：**脚本/操作问题** vs **服务/通道/SDK 问题**。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-27 | 本地 | 04-review T1–T7 静态复核 | 通过 | 无严重项 |
| 2026-06-27 | 本地 | `npm run build:mcp`（tsc） | 通过 | exit 0 |
| 2026-06-27 | 本地 | grep 静态（poll 404、无 CLI/preview） | 通过 | 符号复核 |
| 2026-06-27 | — | M1–M7 飞书/SDK 联调 | 待执行 | 需通道 |
| 2026-06-27 | — | T1 mtime 目检 | 待执行 | 需 launch |
| 2026-06-27 | — | P95 + 双 send spike | 待执行 | 08-verify |
| 2026-06-27 | — | T8–T12 | 跳过 | pending 阶段 2/3 |
