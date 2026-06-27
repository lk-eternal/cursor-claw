# 飞书 Presentation 展示时序编排 - 验收记录

> **变更 ID**：`20260627210352-飞书Presentation展示时序编排`
> **阶段**：`/kb-test`（T1–T5、T7、T-FIX-01/02/03 已实现；T6 E1–E7）
> **评审结论引用**：`04-review.md` 复评通过（R1/R2/R4 已关闭；R3-Daemon、preamble 400ms 为残余警告）

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **编译门禁**（`tsc --noEmit`）+ **静态契约**（04 复评 + defer 链 grep/精读）+ **飞书/SDK 联调**（T6 E1–E7，须主用户私聊 + CardKit） |
| **MVP 范围** | 主用户私聊 SDK；`PRESENTATION_ORDERING` 默认开；对应 `01` 验收 1–6 与 `02` §八·（二） |
| **排除范围** | 群聊/CLI 时序编排（阶段 2）；`runPresentationEpoch` 预留字段（info 债务，不测） |
| **通过口径** | 代码层与 02/03/04 一致 + tsc exit 0；**归档门禁**须 T6 E1/E2/E7 至少一次飞书联调通过 |
| **与 review 分工** | 04 负责实现评审；本文负责验收追溯、静态证据与 E2E 占位 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **E1/E3/E7** | 须 SDK Run 触发 tool/thinking + 飞书 CardKit 时间轴目检；无 headless 契约 |
| **E2 P95** | 首段可见延迟须联调计时（≥10 次样本）；纯对话路径仅可静态证明无额外 defer |
| **E4 MergeBatch** | 连发合并 + tool 回复须真实 IM 与 MergeBatch 状态机；`getPresentationReplyAnchor` 仅静态未改 |
| **E5 异常/中止** | tool 失败或 Run 中止须可控触发；代码层有 `final` force release |
| **E6 回滚** | 须重启进程设 `PRESENTATION_ORDERING=0` 后实测顺序与无卡死 |
| **preamble >400ms 竞态** | R2 残余；仅 E1 实测可量化 |
| **R3-Daemon** | `handleThinkingPresentationEvent` 对 final-only 早退；含 thinking Run idle 偏晚，Run `final` 兜底 |
| **`auto_test/`** | 本期未新增脚本；Presentation defer 无独立 HTTP 契约可替代 E2E |

## 3、验收追溯表

### 3.1 实现任务（T1–T5、T7、T-FIX）

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **T1** | 双端门控 + MVP 范围 | grep + 04 复评 | 代码复核 | ✅ |
| **T2** | 编排字段 + tool/thinking 闩锁 | 04 + `SessionProgressState` | 代码复核 | ✅ |
| **T3** | defer 响应 + `releaseDeferredAssistantStream` | 04 §10.3 + L523–569 | 代码复核 | ✅ |
| **T3** | MergeBatch reply 锚点不变 | `getPresentationReplyAnchor` L558 调用 | 代码复核 | ✅ |
| **T4** | Electron defer POST + preamble 短窗 | T-FIX-01 + L277–375 | 代码复核 | ✅ |
| **T4** | Run 收尾 force flush | `streamRunEvents` L484–489 | 代码复核 | ✅ |
| **T5** | NF1 `presentation_order_violation` | T-FIX-03 + `processMsgId` | 代码复核 | ✅ |
| **T5** | Run 间 reset | `resetPresentationOrderingFields` | 代码复核 | ✅ |
| **T7** | AGENTS 与代码一致 | 04 §10.3 文档项 | 文档复核 | ✅ |
| **T-FIX-01** | `doFlushStreamPost` defer 复检 | L280 | 代码复核 | ✅ |
| **T-FIX-01** | 过程事件 `clearStreamPostTimer` | `markProcessEventSeen` L370 | 代码复核 | ✅ |
| **T-FIX-02** | Electron thinking final + idle 释放 | `closeThinkingIfOpen` L362–367 | 代码复核 | ⚠️ Electron ✅；Daemon final-only 残余 |
| **T-FIX-03** | NF1 `process_msg_id` | daemon L1364、L1459 | 代码复核 | ✅ |

### 3.2 T6 端到端（E1–E7）

| ID | 场景 | 01/02 关联 | 验证方式 | 代码层 | E2E |
|----|------|------------|----------|--------|-----|
| **E1** | shell tool × ≥3 | 验收 1 | 飞书联调 | ✅ 主路径 defer 链 | ⏳ 待联调 |
| **E2** | 无 tool 短问答 × ≥10 | 验收 2 | 联调计时 | ✅ 无额外 defer | ⏳ 待联调 |
| **E3** | 多步 tool × ≥2 | 验收 3 | 飞书联调 | ✅ `toolCards`+闩锁 | ⏳ 待联调 |
| **E4** | MergeBatch + tool × ≥1 | 验收 4 | 飞书联调 | ✅ 锚点未改 | ⏳ 待联调 |
| **E5** | tool 失败/Run 中止 | 验收 5 | 联调 | ✅ final force release | ⏳ 待联调 |
| **E6** | `PRESENTATION_ORDERING=0` | 验收 6 | 联调+重启 | ✅ 门控 off 跳过 defer | ⏳ 待联调 |
| **E7** | 3+ 串行 tool，assistant 卡张数 | §八·（二）·2 | 飞书目检 | ✅ `assistantCardReleased` 幂等 | ⏳ 待联调 |

### 3.3 defer 链静态完整性（T6 代码证据）

| 步骤 | Electron | Daemon | 结论 |
|------|----------|--------|------|
| preamble 首 delta | `appendAssistantStreamDelta` → `schedulePreambleRelease`（400ms） | — | ✅ 不立即 POST |
| tool/thinking 到达 | `markProcessEventSeen` 清 timer + 缓冲 | `presentationProcessActive` 置闩 | ✅ |
| 过程进行中 stream-text | `shouldDeferAssistantPost` 仅 buffer | 返回 `{ deferred: true }` | ✅ |
| 过程 idle | `maybeReleaseDeferredAssistant` → flush | `releaseDeferredAssistantStream` 首建 | ✅ |
| Run 收尾 | `closeThinkingIfOpen` + `flushDeferredStreamPost` + `final` | `handleStreamText` force release | ✅ |
| stale timer 防护 | `doFlushStreamPost` L280 defer 复检 | — | ✅ T-FIX-01 |

## 4、场景摘要

### 4.1 飞书/SDK 联调清单（T6 优先）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **E1 shell tool** | 主用户私聊 SDK；`PRESENTATION_ORDERING` 默认开 | 发送「git pull 最新代码」等 × ≥3 | 过程卡在上；滚到底见结论；无倒置 | 验收 1；R2 400ms 量化 |
| **E2 纯对话 P95** | 同上 | 短问答 × ≥10，记首段可见时间 | P95 ≤ 3s 或不劣于现网 | 验收 2 |
| **E3 多步 tool** | 同上 | 读文件→命令→读结果 × ≥2 | 过程顺序稳定；无重复刷屏 | 验收 3 |
| **E4 MergeBatch** | collecting/ready 态 | 连发触发合并 + 带 tool 回复 × ≥1 | 合并预览/reply/排队不回归；defer 首建仍锚定 | 验收 4 |
| **E5 异常** | 同上 | 触发 tool 失败或中途 stop | 过程+结论/失败说明可读 | 验收 5 |
| **E6 回滚** | 设 `PRESENTATION_ORDERING=0` 重启 | 带 tool 任务 × 1 | assistant 先于 tool（现网）；无卡死 | 验收 6 |
| **E7 卡张数** | 同上 | 单 Run 3+ 串行 tool | 仅 1 张 assistant 卡，位于最后过程卡下 | §八·（二）·2 |

### 4.2 静态冒烟（本次已执行）

| 检查 | 命令/方式 | 期望 | 结果 |
|------|-----------|------|------|
| TypeScript 编译 | `npx tsc --noEmit` | exit 0 | ✅ |
| defer 链符号 | grep 双端关键函数 | 齐全且 T-FIX 已落地 | ✅ |
| MergeBatch 未改 | diff 无 `MergeBatch*` 逻辑变更 | 仅 Presentation 增量 | ✅ |
| NF1 字段 | `logPresentationOrderViolation` 含 `process_msg_id` | 非空 | ✅ |

### 4.3 联调观察点（失败判责）

| 现象 | 优先怀疑 | 备注 |
|------|----------|------|
| assistant 仍置顶 | preamble >400ms 竞态或 timer 未清 | 查 `presentation_order_violation` WARN |
| 纯对话首段 >3s | 通道/SDK 非编排回归 | 编排路径无 defer 门控 |
| MergeBatch reply 错 | 合并批次基线问题 | 非本变更 diff 范围 |
| 过程卡后无结论 | release 失败 | 查 `presentation_failed` + 降级 send |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 无新增 `auto_test/`；可参考 `auto_test/20260627150041-feishu-merge-preview/` 做 merge HTTP 探测 |
| **运行依赖** | Electron 或 Daemon + 飞书应用；SDK 资源与 API Key 已配置 |
| **环境变量** | `PRESENTATION_ORDERING`（默认开）、`DAEMON_PORT`；飞书 `LARK_*` 仅写变量名 |
| **E6 数据准备** | 进程级设 `PRESENTATION_ORDERING=0` 或 `false` 后重启 |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景、结果、备注（一词结论）。
- 失败时区分：**脚本/操作问题** vs **服务/通道/SDK 问题**。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-27 | 本地 | `npx tsc --noEmit` | 通过 | exit 0 |
| 2026-06-27 | 本地 | 04-review 复评 + defer 链静态精读 | 通过 | R1/R2/R4 关闭 |
| 2026-06-27 | 本地 | MergeBatch / `getPresentationReplyAnchor` 未改复核 | 通过 | diff 范围 |
| 2026-06-27 | — | E1–E7 飞书/SDK 联调 | 待执行 | 无通道环境 |
| 2026-06-27 | — | E2 P95 ≥10 样本 | 待执行 | 须联调计时 |
| 2026-06-27 | — | E6 开关回滚 | 待执行 | 须重启进程 |
