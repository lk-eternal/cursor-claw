# PRD 修订记录

> **变更 ID**：`20260627210352-飞书Presentation展示时序编排`
> **说明**：按轮次追加；实现由 `/kb-revise-apply` 执行，完成后更新「实现状态」。

## Rev1

| 字段 | 内容 |
|------|------|
| **轮次编号** | Rev1 |
| **日期** | 2026-06-27 |
| **变更摘要** | 飞书全通道不再展示 tool/thinking 过程 CardKit；本变更时序编排 **scope 降级**——产品验收侧重 assistant 延迟首建（defer）与 Electron 本地闩锁，不再要求飞书侧「过程卡在上、结论卡在下」。 |
| **动因/来源** | 产品决策：lite 变更 `20260627220000-飞书抑制tool与thinking展示`；取代 v1.6.1 群聊仅 shell 门控 |
| **与上一版差异要点** | ① **F1 降级**：由「过程类 CardKit 整体先于 assistant」改为「飞书无过程卡；defer 保证 assistant 首 POST 不早于本地过程事件闩锁释放」。② **场景 A/C 期望调整**：用户不再在飞书看到 tool/thinking 卡；过程信息改 SDK UI 日志。③ **验收 1/3/5 中与过程卡顺序相关的条目**：飞书 E2E 不再目检过程卡时间轴。④ **非目标补充**：飞书过程 CardKit 展示归属 lite 变更，本变更不重复实现抑制逻辑。 |
| **影响范围** | 产品：`01-proposal.md` 验收与场景描述（本 Rev 文档为准，01 正文待 `/kb-revise` 或 archive 前同步）；测试：`06-automation-test.md` E1–E7 用例；代码：**已实现** defer 链可保留，Daemon tool/thinking handler 在 lite 落地后变为飞书 no-op |
| **关联变更** | `20260627220000-飞书抑制tool与thinking展示`（lite，supersedes 1.6.1 门控） |
| **关联 03 任务** | T6（E1–E7 用例调整）；无新增代码任务（抑制由 lite 变更承担） |
| **实现状态** | **本变更代码已 apply 并复评通过**；lite 抑制变更 **已归档 v1.6.2**（`20260627220000-飞书抑制tool与thinking展示`）；`06-automation-test.md` Rev1 口径已同步；**T6 E1–E7 飞书 E2E 待人工**，不阻塞 `archived_with_debt` |

### E1–E7 用例调整（Rev1）

| ID | 原验收（01 / 06） | Rev1 调整后 |
|----|-------------------|-------------|
| **E1** | shell tool × ≥3：过程卡在上，滚到底见结论 | **assistant defer**：带 tool Run × ≥3，飞书**无** tool/thinking 卡；仅 1 条 assistant 流式卡，首 POST 不早于过程 idle 释放；过程在 SDK UI 日志可见 |
| **E2** | 无 tool 短问答 P95 | **不变** — 纯对话无额外 defer |
| **E3** | 多步 tool：过程卡顺序稳定 | **无过程卡**：飞书仅 assistant 卡；SDK UI 日志中 tool 顺序可读、无重复刷屏 |
| **E4** | MergeBatch + tool | **不变** MergeBatch 行为；飞书无 tool 卡；defer 首建仍锚定 reply |
| **E5** | 异常：过程+结论可读 | 飞书：结论/失败说明；**过程仅 SDK UI** |
| **E6** | `PRESENTATION_ORDERING=0` 回滚 | **不变** — 开关 off 时 defer 跳过；仍无过程卡（由 lite 变更独立保证） |
| **E7** | 3+ 串行 tool，assistant 卡张数 | **保留**：单 Run 仅 1 张 assistant 卡；**删除**「位于最后过程卡下」目检 |

### 01 功能需求映射（Rev1）

| 编号 | 原 F | Rev1 |
|------|------|------|
| F1 | 过程卡先于 assistant | **降级为 F1'**：assistant 首 POST 服从 defer/闩锁；飞书不展示过程卡 |
| F2 | assistant 流式 | **不变** |
| F3 | 无 tool 不劣化 | **不变** |
| F4 | 多 tool 过程卡不重复 | **改为**：SDK UI tool 日志不重复；飞书无过程卡 |
| F5 | MergeBatch 不回归 | **不变** |
| F6 | 可回滚开关 | **不变**（仅 defer 回滚；过程卡抑制由 lite 变更管理） |
