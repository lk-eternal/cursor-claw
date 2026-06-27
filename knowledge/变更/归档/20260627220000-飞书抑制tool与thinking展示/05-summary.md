# 飞书抑制 tool 与 thinking 展示 - 变更总结

> **变更 ID**：`20260627220000-飞书抑制tool与thinking展示`
> **来源**：kb-lite
> **lite 类型**：知识同步型
> **阶段**：`tested`（LITE-01/02 done；E1–E6 飞书/微信 E2E 待人工，archive 门禁）

---

## 实际变更

| 文件 | 关键改动 |
|------|----------|
| `src/shared/feishu-presentation-gate.ts` | **新增**：`isFeishuProcessPresentationSuppressed` — 飞书全通道（群聊 + p2p）对 `tool`/`thinking` 返回 true，微信不适用 |
| `electron/agent-sdk.ts` | `postPresentationEvent` 入口经共享门控早退，不 POST tool/thinking；**保留** `pushUiLog [tool]` / `appendSdkLog [thinking]`；移除 v1.6.1 `isGroupChatPresentationEventAllowed` 及群聊 shell 双策略 |
| `src/daemon.ts` | `handleToolPresentationEvent` / `handleThinkingPresentationEvent` 飞书路径静默 `{ ok: true }`；抑制 return **前**仍更新 PRESENTATION_ORDERING 闩锁；移除 `isGroupChatSession`、`isGroupChatPresentationToolAllowed` |
| `src/AGENTS.md` | 补充飞书全通道 tool/thinking 抑制与 ordering 闩锁说明 |
| `electron/AGENTS.md` | 补充 Electron 侧飞书门控与 SDK UI 日志约定 |
| `knowledge/业务域/消息桥接/02-飞书通道.md` | 能力范围、设计决策、服务端规则、客户端流程、接口、数据、变更记录同步为「飞书不展示 tool/thinking CardKit，过程见 SDK UI」；标注取代 v1.6.1 群聊 shell 门控 |

**变更文档**：`01-proposal.md`、`00-manifest.json`、`06-automation-test.md`、`05-summary.md`（本文件）。

**统计**：1 新增共享门控 + 2 实现端 + 2 AGENTS + 1 业务域知识；双端 Presentation 出站同策略，不改 proto/DB/HTTP 契约。

**未改（显式）**：微信通道 Presentation、assistant stream-text CardKit、MergeBatch、CardKit 视觉样式；`tool-presentation.ts` / `lark-core.ts` shell 渲染能力保留（飞书不再调用出站）。

---

## 用户可见影响

| 场景 | 改前（v1.6.1） | 改后 |
|------|----------------|------|
| 飞书群聊 tool 卡 | 仅 shell 展示，read/grep 等抑制 | **全部 tool 不展示**（含 shell markdown 卡） |
| 飞书群聊 thinking 卡 | 展示 | **不展示** |
| 飞书私聊 tool/thinking 卡 | 展示 | **不展示** |
| 飞书 assistant 流式正文 | 正常 | **不变** |
| 桌面 SDK UI 日志 | tool/thinking 可见 | **不变**（`[tool]` / `[thinking]` 仍输出） |
| 微信通道 | 过程卡正常 | **不变** |

产品策略：**飞书会话只保留 assistant 结论卡**，工具执行与推理过程改在桌面 SDK UI 日志查看，减少 CardKit 刷屏。

**验收状态**（详见 `06-automation-test.md`）：静态项（编译、旧门控移除、双端门控、ordering 闩锁）✅；E1–E6 飞书/微信 E2E ⏳ 待人工。

---

## 关联变更

| 变更 | 关系 | 说明 |
|------|------|------|
| `20260627212713-群聊仅展示Shell工具卡片`（已归档，v1.6.1） | **supersedes** | 本变更**取代**其群聊「仅 shell + thinking」门控；`isGroupChatPresentationEventAllowed` / `isGroupChatPresentationToolAllowed` 已移除 |
| `20260627210352-飞书Presentation展示时序编排`（进行中） | **scope_downgrade** | 飞书无过程卡后，产品验收重心降为 **assistant defer 首建** + **Electron 本地闩锁**；不再要求「过程卡在上、结论卡在下」。用例映射见彼变更 `07-prd-revisions.md` **Rev1**（E1/E3/E5/E7 调整；F1 降级为 F1'） |
| `20260627162620-飞书作为Cursor展示与控制层`（已归档） | 继承 | Presentation Pipeline 保留；仅 outbound 过程类事件对飞书 no-op |
| `20260627113111-消息通道即时响应与流式输出`（已归档） | 继承 | stream-text / NF2 首段可见 SLA 仍适用 |

---

## Archive 待办（用户可见变更）

archive 时须 **patch** bump 版本并新建 changelog，说明「飞书不再展示 tool/thinking 过程卡，取代 v1.6.1 群聊 shell 策略」；E1–E5 至少一次飞书联调 + E6 微信 smoke 为归档门禁。
