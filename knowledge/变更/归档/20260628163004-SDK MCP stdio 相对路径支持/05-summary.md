# SDK MCP stdio 相对路径支持 - 变更总结

> **变更 ID**：`20260628163004-SDK MCP stdio 相对路径支持`
> **来源**：kb-propose（standard）
> **阶段**：`tested`（T1–T2 done；04-review 通过；`/kb-test` build 通过；S1–S3 E2E 待用户，不阻断 archive）

---

## 1、实际变更

| 文件 | 关键改动 |
|------|----------|
| `electron/mcp-sdk-loader.ts` | 新增私有 `resolvePathLikeSegment`：路径型 segment（含 `/`、`\` 或以 `./`/`../` 开头）在有效 workspace 下 `path.resolve` 为绝对路径；bare 命令名（`npx`/`node` 等）与已是绝对路径则原样返回。`toStdioInlineConfig`：`workspaceDir` 非空时对 `command` 与 `args` 逐元素 resolve（以 `--` 开头的 flag 跳过），并设置 `cwd=workspaceDir`；`workspaceDir` 空时不 resolve、不设 `cwd`，输出与变更前一致 |
| `electron/AGENTS.md` | 「SDK MCP 内联」段补充 stdio resolve 规则、路径型判定、无 workspace 边界；明确 Settings Path B（`mcp-manager`）与 HTTP inline 未改 |

**变更文档**：`01-proposal.md`、`02-design.md`、`03-tasks.md`、`04-review.md`、`06-automation-test.md`、`00-manifest.json`、`05-summary.md`（本文件）。

**未纳入本变更 manifest（显式）**：`package.json`、`changelog/`（archive 阶段由 kb-release bump **1.8.3 → 1.8.4** 并新建 changelog）；`electron/agent-sdk.ts`、`electron/mcp-manager.ts` 未改。

**统计**：1 代码文件改动 + 1 AGENTS 约定；`mcp-sdk-loader.ts` 约 140 行（≤300）；`npm run build` 已通过（见 `06-automation-test.md`）。

## 2、与设计的差异

无。实现与 `02-design.md` §五路径型判定、§六实现步骤 1–4 及 S3/S5/S6 边界一致；04-review 结论为通过，无 open 阻断项。

**已知限制（不阻断 archive，见 04-review §7）**：

- `--config=./path` 等整段以 `--` 开头的 arg 不 resolve；可依赖 `cwd=workspaceDir` 缓解，或后续单独 design。
- `loadInlineMcpServers` 块注释未重复 resolve 规则（T2 已写入 `electron/AGENTS.md`）。
- 01 验收 1–3（相对路径脚本、node_modules/.bin、Settings 与 SDK 一致）端到端待用户手工验收（S1–S3）。

## 3、影响范围

- **涉及模块**：SDK inline MCP 配置生成（`mcp-sdk-loader.toStdioInlineConfig`）；调用链 `agent-sdk` → `loadInlineMcpServers` / `appendInlineMcpToSendOptions` 签名与行为不变。
- **配置来源**：仍读取 global `~/.cursor/mcp.json` 与 project `.cursor/mcp.json` 合并结果；无 schema 扩展。
- **运行时语义**：有效 workspace 下传给 `@cursor/sdk` 的 stdio `command`/`args` 由相对路径变为绝对路径，配合 `cwd` 使无 shell spawn 可正确 exec `./scripts/...`、`node_modules/.bin/...` 等。
- **未触碰**：Settings Path B（`mcp-manager` CLI 优先 + stdio `shell:true`+`cwd`）、HTTP/sse inline（`toHttpInlineConfig`）、OAuth/`mcp-auth.json`。
- **用户可见性**：已绑定工作区时，SDK Agent 会话中 stdio MCP 相对路径行为与 IDE/Settings「相对工作区根」语义对齐；无工作区时行为与变更前一致。

### 3.1 Ponytail 技术债

diff 中无 `ponytail:` 注释。**Lean already. Ship.**

| 位置 | 注释摘要 | 升级路径 |
|------|----------|----------|
| — | 无 | — |

## 4、知识库影响清单

与 `02-design.md` §十一致；业务域与工程平台 KB 叶子无需更新。

- [x] `electron/AGENTS.md` — 「SDK MCP 内联」段已补充 resolve 规则、路径型判定、无 workspace 边界（T2 done）
- [x] `knowledge/业务域/**` — 无 IM/调度/通道用户可见行为变更，无需更新
- [x] `knowledge/工程平台/**` — MCP resolve 为 Electron 内部实现；约定已写入 `electron/AGENTS.md`，无独立叶子文档需同步
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
- [ ] `knowledge/变更/归档/20260627230833-stdio MCP支持/` — 可选交叉引用（design §十·（二））；非 archive 阻断项

**archive 待办（kb-release）**：`package.json` patch bump 至 **1.8.4** + 新建 `changelog/1.8.4.json`（用户可见：SDK 会话 stdio MCP 相对路径支持）。
