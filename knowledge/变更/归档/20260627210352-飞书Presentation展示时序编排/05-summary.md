# 飞书 Presentation 展示时序编排 - 变更总结

> **变更 ID**：`20260627210352-飞书Presentation展示时序编排`
> **阶段**：`archived_with_debt`（代码层 + 静态验收通过；T6 E1–E7 飞书联调待人工）
> **关联 Rev1**：`07-prd-revisions.md`；lite 抑制由 `20260627220000-飞书抑制tool与thinking展示`（v1.6.2）承担

---

## 1、实际变更

### 代码与约定

| 文件 | 关键改动 |
|------|----------|
| `src/daemon.ts` | `PRESENTATION_ORDERING` 门控（默认开，MVP 主用户私聊 SDK）；`SessionProgressState` 编排字段（`presentationProcessActive`、`deferredAssistantText`、`assistantCardReleased` 等）；`handleStreamText` 过程活跃时 defer 首建；`releaseDeferredAssistantStream` 过程 idle 后首建 assistant CardKit（保留 `getPresentationReplyAnchor`）；tool/thinking handler 更新闩锁并在 idle 触发 release；NF1 `logPresentationOrderViolation`（含 `process_msg_id`）；Run 间 `resetPresentationOrderingFields` |
| `electron/agent-sdk.ts` | 双端门控对齐；`shouldDeferAssistantPost` / `schedulePreambleRelease`（400ms 短窗）；`markProcessEventSeen` 清 timer + 缓冲 assistant delta；`doFlushStreamPost` 非 final defer 复检（T-FIX-01）；`closeThinkingIfOpen` + `maybeReleaseDeferredAssistant`（T-FIX-02）；Run 收尾 force flush |
| `src/AGENTS.md` | Presentation 时序编排、`PRESENTATION_ORDERING`、defer/release 与 MergeBatch 不变声明 |
| `electron/AGENTS.md` | Electron defer 链、preamble 短窗、thinking final 闭合、Run 收尾 flush 约定 |

### 变更文档

| 文件 | 说明 |
|------|------|
| `00-manifest.json` | T1–T5、T7、T-FIX-01/02/03 done；T6 blocked（E2E 待人工） |
| `01-proposal.md` | 产品 PRD（Rev1 后部分表述与正文不一致，见 §2） |
| `02-design.md` | 方案 A 延迟首建设计 |
| `03-tasks.md` | T1–T7 + T-FIX 任务清单 |
| `04-review.md` | 初评未通过 → T-FIX 复评通过（R3-Daemon、preamble 400ms 残余警告） |
| `06-automation-test.md` | 静态 + E1–E7 联调清单（Rev1 口径） |
| `07-prd-revisions.md` | Rev1 scope 降级（F1→F1'） |
| `05-summary.md` | 本文件 |

**未改（显式）**：MergeBatch 状态机与 reply 锚点、CardKit 视觉、群聊/CLI 时序编排（阶段 2）、proto/DB。飞书 tool/thinking CardKit 抑制由 lite 变更 v1.6.2 独立实现，本变更 Daemon handler 在 lite 落地后对飞书为 no-op 出站，**仍更新 ordering 闩锁**。

---

## 2、与设计的差异

| 项 | 设计/01 原意 | 实际/Rev1 |
|----|-------------|-----------|
| **F1 / 验收 1** | 飞书「过程卡在上、结论卡在下」 | **Rev1 降级为 F1'**：飞书无过程 CardKit（lite v1.6.2）；本变更保证 **assistant defer 首 POST** 不早于本地过程 idle 闩锁释放 |
| **01 正文** | 多处「过程在上、结论在下」 | **以 Rev1 / `07-prd-revisions.md` 为准**；01 文首已加 Rev1 短注 |
| **方案 A 验收重心** | 过程卡时间轴 | 改为 assistant 单卡 defer + SDK UI 过程日志可读 |
| **T-FIX 后代码路径** | 02 §五 preamble 并入 defer | 主路径（preamble→tool）代码评估 ✅；**preamble >400ms 且 tool 未到**仍可能首 POST（R2 残余，accepted 警告） |
| **R3-Daemon** | thinking final 后 idle 释放 | Electron 已传 `final` 并本地闭合；Daemon `handleThinkingPresentationEvent` 对 **final-only** 仍 `!delta` 早退 → idle 偏晚，Run `final` 兜底 |

无 MergeBatch、`getPresentationReplyAnchor` 实现偏差。

---

## 3、影响范围

- **Daemon**：Presentation 编排状态、`/api/stream-text` defer 响应、`/api/presentation-event` 闩锁与 release；`PRESENTATION_ORDERING=0` 跳过 defer。
- **Electron**：SDK 流式 POST 缓冲与释放；与 Daemon 双端闩锁协同。
- **MVP 范围**：主用户私聊 SDK；群聊/CLI 不受本变更编排门控。
- **与 lite 变更交界**：飞书会话仅 assistant 流式卡；过程信息在桌面 SDK UI 日志。

### 3.1 Ponytail 技术债

无（本次 `git diff` 于 `src/daemon.ts`、`electron/agent-sdk.ts` 未新增 `ponytail:` 注释；文件内既有 ponytail 非本变更新增）。

### 3.2 用户可见影响

| 场景 | 改前 | 改后 |
|------|------|------|
| 主用户私聊、带 tool Run | assistant 卡可能先于过程卡置顶 | **defer 开启时**：飞书仅 1 条 assistant 流式卡，首 POST 在过程 idle 后；**无** tool/thinking 飞书卡（lite） |
| 纯对话、无 tool | 现网流式 | **不变**（无额外 defer 门控） |
| `PRESENTATION_ORDERING=0` | — | defer 跳过，恢复先到先展示；过程卡仍不展示（lite 独立保证） |
| MergeBatch | 合并预览/reply/排队 | **不回归**（锚点与控制器未改） |
| SDK UI | tool/thinking 日志 | **不变**（lite 保留 `[tool]` / `[thinking]`） |

---

## 4、知识库影响清单

- [x] `src/AGENTS.md`、`electron/AGENTS.md` — archive 确认（apply 已更新 Presentation 编排与 defer 链）
- [x] `knowledge/业务域/消息桥接/02-飞书通道.md` — defer 补句（librarian archive 最小补充 assistant defer 与 lite 抑制交叉说明）
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
- [x] Proto / MergeBatch / 微信 — 无 schema 或逻辑变更，无需更新

---

## 5、遗留债务

| 来源 | 债务 | 级别 | 阻塞 archive |
|------|------|------|--------------|
| T6 E1–E7 | 飞书/SDK 端到端联调未执行（E1 assistant defer、E2 P95、E3–E7 见 `07` Rev1） | 手工验收 | **否**（用户接受 `archived_with_debt`） |
| 04-review R3-Daemon | `handleThinkingPresentationEvent` final-only 无法清 Daemon `thinkingOpen`；含 thinking Run idle 释放偏晚 | warning | 否 |
| 04-review R2 残余 | preamble 停顿 >400ms 且 tool 未到时仍可能 assistant 首 POST | warning | 否 |
| 04-review §3 | `runPresentationEpoch` 预留未读写 | info | 否 |

---

## 归档结果

| 项 | 值 |
|----|-----|
| **归档阶段** | `archived_with_debt`（待 kb-release 迁移目录并写 manifest） |
| **版本** | **1.6.3**（patch bump，由 kb-release 执行） |
| **changelog** | `changelog/1.6.3.json`（由 kb-release 新建；scribe 不写正文） |
| **预期 changelog 要点** | 主用户私聊 assistant defer 首建、`PRESENTATION_ORDERING` 开关回滚、过程 idle 释放流式卡、NF1 顺序违规日志 |
| **E2E** | T6 E1–E7 飞书联调待后续人工，不阻塞本次 archive |
