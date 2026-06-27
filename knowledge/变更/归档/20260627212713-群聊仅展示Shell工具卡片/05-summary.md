# 群聊仅展示 Shell 工具卡片 - 变更总结

> **变更 ID**：`20260627212713-群聊仅展示Shell工具卡片`
> **来源**：kb-lite
> **lite 类型**：知识同步型

---

## 实际变更

| 文件 | 关键改动 |
|------|----------|
| `electron/agent-sdk.ts` | 新增 `isGroupChatPresentationEventAllowed`；`postPresentationEvent` 入口群聊门控 — 仅 `kind === "tool" && tool_name !== "shell"` 抑制 POST；thinking 与 shell 工具放行；私聊行为不变 |
| `src/daemon.ts` | 新增 `isGroupChatSession`、`isGroupChatPresentationToolAllowed`；`handleToolPresentationEvent` 群聊非 shell 工具静默 `{ ok: true }` 跳过 CardKit；`handleThinkingPresentationEvent` 无群聊门控，thinking CardKit 照常渲染 |
| `src/shared/tool-presentation.ts` | **新增** shell 工具 Presentation 辅助：解析 command/cwd/output、构建 shell CardKit markdown（命令 `\`\`\`shell`、输出代码块）、SDK event 字段映射与 PATCH 缓存合并 |
| `src/shared/lark-core.ts` | 工具 CardKit 渲染接入 `tool-presentation`：`formatToolProgressCardMarkdown` / 创建与 PATCH 路径对 shell 展示命令与输出 |
| `electron/AGENTS.md` | Presentation 出站补充群聊门控约定（非 shell 工具抑制，thinking 保留；与 Daemon 一致） |
| `src/AGENTS.md` | 补充群聊 Presentation 门控、eligible 分层与 PRESENTATION_ORDERING 范围说明（thinking 保留口径） |
| `knowledge/业务域/消息桥接/02-飞书通道.md` | 群聊 Presentation 说明：保留 shell 工具 CardKit 与 thinking CardKit，抑制非 shell 工具 CardKit |
| `package.json` | 版本 bump 至 `1.6.1` |
| `changelog/1.6.1.json` | 用户可见变更条目 |

**变更文档**：`01-proposal.md`、`00-manifest.json`、`05-summary.md`（本文件）。

**统计**：6 个实现/约定文件 + 2 个共享渲染模块；双端 Presentation 出站路径同策略，不改 proto/DB/HTTP 契约。

**未改（显式）**：私聊 PRESENTATION_ORDERING（`20260627210352`）、CardKit 视觉/MergeBatch、stream-text 节流与降级链。

---

## 验收结论

对照 `01-proposal.md` 验收标准：

| # | 验收项 | 结论 |
|---|--------|------|
| 1 | 飞书群聊 @ 触发含 read/grep/write 等多工具 Run：群聊**不出现**非 shell 工具 CardKit | **通过（静态）** — SDK `postPresentationEvent` 与 Daemon `handleToolPresentationEvent` 群聊非 shell 均抑制；**待人工/集成验证** E2E |
| 2 | 同 Run 含 shell：群聊**仍出现** shell 工具 CardKit（started/completed PATCH），展示命令与输出 | **通过（静态）** — 门控仅过滤 `tool_name !== "shell"`；`tool-presentation` + `lark-core` 渲染 shell 详情；**待人工/集成验证** E2E |
| 3 | 同 Run 含 thinking：群聊**仍出现** thinking CardKit（delta PATCH） | **通过（静态）** — SDK `event.kind !== "tool"` 放行；Daemon `handleThinkingPresentationEvent` 无群聊门控；**待人工/集成验证** E2E |
| 4 | 主用户私聊 tool/thinking 卡片行为与改前一致 | **通过（静态）** — `chatType !== "group"` 时工具门控均放行；**待人工/集成验证** 私聊回归 |
| 5 | 群聊 assistant 流式回复（stream-text）正常 | **通过（静态）** — 未改动 stream-text 路径与 eligible；**待人工/集成验证** 群聊长回复 |
| 6 | TypeScript 编译通过 | **通过** — builder 已 `tsc` 通过 |

---

## 知识库结论

**知识同步型 lite** — 业务域须补充群聊 Presentation 门控说明：

| 文件 | 状态 |
|------|------|
| `knowledge/业务域/消息桥接/02-飞书通道.md` | **已同步** — 群聊保留 shell 工具 CardKit 与 thinking CardKit，抑制非 shell 工具 CardKit；stream-text 不变 |
| `src/AGENTS.md` | **已完成**（builder 实现期沉淀） |
| `electron/AGENTS.md` | **已完成**（builder 实现期沉淀） |
| `knowledge/知识索引.md` | 无需更新 — 总入口未变，单处子模块增量 |

---

## Archive 待办（用户可见变更）

本变更为飞书群聊体验优化，archive 已完成：

- **patch** bump `package.json` 至 `1.6.1`
- `changelog/1.6.1.json` 条目：「飞书群聊中仅展示 shell 工具执行卡片与 thinking 过程卡，抑制 read/grep 等非 shell 工具卡，减少卡片轰炸；主用户私聊行为不变」
