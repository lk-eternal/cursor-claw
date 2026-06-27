# 群聊仅展示 Shell 工具卡片 - 变更总结

> **变更 ID**：`20260627212713-群聊仅展示Shell工具卡片`
> **来源**：kb-lite
> **lite 类型**：知识同步型

---

## 实际变更

| 文件 | 关键改动 |
|------|----------|
| `src/shared/tool-presentation.ts` | **新增**：`parseShellToolArgs` / `parseShellToolResult` 解析 shell args 与 result；`buildShellToolCardMarkdown` 构建 CardKit markdown（命令 `\`\`\`shell`、输出代码块）；`extractShellPresentationFields` / `mergeShellToolDetail` 映射 PATCH 缓存；`formatToolCallLogSuffix` / `stringifyToolPayload` 格式化 SDK 日志 |
| `src/shared/lark-core.ts` | 工具 CardKit 接入 `tool-presentation`：`formatToolProgressCardMarkdown` 对 shell 渲染命令与输出 markdown；创建/PATCH 路径透传 `shellDetail` |
| `electron/agent-sdk.ts` | 新增 `isGroupChatPresentationEventAllowed`：`postPresentationEvent` 群聊仅抑制非 shell **tool** POST，**thinking 仍 POST**；`tool_call` 经 `extractShellPresentationFields` 填充 `tool_shell_*`；`formatToolCallLogSuffix` 打印 shell args 摘要 |
| `src/daemon.ts` | 新增 `isGroupChatSession`、`isGroupChatPresentationToolAllowed`：`handleToolPresentationEvent` 群聊非 shell 静默 `{ ok: true }`；`handleThinkingPresentationEvent` **无群聊门控**；`mergeShellToolDetail` 合并 shell 详情传 CardKit |
| `electron/AGENTS.md` | Presentation 出站补充群聊门控：非 shell 工具抑制，thinking 保留 |
| `src/AGENTS.md` | 补充群聊 Presentation 门控、eligible 分层（thinking 全量保留；PRESENTATION_ORDERING 仍仅 p2p） |
| `knowledge/业务域/消息桥接/02-飞书通道.md` | 群聊 Presentation：保留 shell 工具 CardKit 与 thinking CardKit，抑制非 shell 工具 CardKit |
| `package.json` | 版本 bump 至 `1.6.1` |
| `changelog/1.6.1.json` | 用户可见变更条目 |

**变更文档**：`01-proposal.md`、`00-manifest.json`、`05-summary.md`（本文件）。

**统计**：4 个实现文件（含新增 `tool-presentation.ts`）+ 2 个 AGENTS + 1 处业务域知识 + changelog；双端 Presentation 出站同策略，不改 proto/DB/HTTP 契约。

**未改（显式）**：私聊 PRESENTATION_ORDERING（`20260627210352`）、CardKit 视觉/MergeBatch、stream-text 节流与降级链。

---

## 验收结论

对照 `01-proposal.md` 验收标准（实现口径：thinking **保留**，非 shell tool **抑制**）：

| # | 验收项 | 结论 |
|---|--------|------|
| 1 | 飞书群聊 @ 触发含 read/grep/write 等多工具 Run：群聊**不出现**非 shell 工具 CardKit | **通过（静态）** — Electron `isGroupChatPresentationEventAllowed` 与 Daemon `isGroupChatPresentationToolAllowed` 双端抑制非 shell tool；**待人工/集成验证** E2E |
| 2 | 同 Run 含 shell：群聊**仍出现** shell 工具 CardKit（started/completed PATCH），展示命令与输出 | **通过（静态）** — 门控仅过滤 `tool_name !== "shell"`；`tool-presentation` + `lark-core` 渲染 shell 详情；**待人工/集成验证** E2E |
| 3 | 同 Run 含 thinking：群聊**仍出现** thinking CardKit（delta PATCH） | **通过（静态）** — Electron `event.kind !== "tool"` 放行 thinking POST；Daemon `handleThinkingPresentationEvent` 无群聊门控；**待人工/集成验证** E2E |
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
- `changelog/1.6.1.json` 三条用户可见条目（群聊门控、shell 卡 markdown、SDK 日志 args）
