# stdio MCP支持 - 变更总结

> **变更 ID**：`20260627230833-stdio MCP支持`
> **来源**：kb-lite
> **lite 类型**：记录型 lite
> **阶段**：`applied`（LITE-01/02 done；待 `/kb-archive` 迁移与 changelog）

---

## 1、实际变更

| 文件 | 关键改动 |
|------|----------|
| `electron/mcp-manager.ts` | **Path B**：`queryToolsViaProtocol` 增加 `cwd` 参数并在 spawn 时传入 workspace；`getMcpServerTools` **CLI 优先**（`agent mcp list-tools`），失败再回退 HTTP/stdio 直连；`close` 回调增加 `phase === "done"` 守卫，避免成功收包后误报「进程退出，未获取到工具」 |
| `electron/mcp-sdk-loader.ts` | **新建**（83 行）：合并 global `~/.cursor/mcp.json` 与 project `.cursor/mcp.json`（同名 project 覆盖）；`loadInlineMcpServers` 仅输出 stdio/command 型并补 `cwd`；HTTP/url 型返回 null；`appendInlineMcpToSendOptions` 供 resident 每次 `agent.send` 重传 |
| `electron/agent-sdk.ts` | **Path A**：`Agent.create` 传入 `mcpServers: loadInlineMcpServers(workspaceDir)`；resident 模式 `agent.send` 经 `appendInlineMcpToSendOptions` 同步重传 inline MCP；与 `settingSources: ["project","user"]` 去重——stdio 仅 inline，HTTP 仍走 settings |
| `electron/AGENTS.md` | 补充「SDK MCP 内联」约定：loader 职责、去重策略、resident 须每次 send 传 `mcpServers` |

**变更文档**：`01-proposal.md`、`00-manifest.json`、`05-summary.md`（本文件）。

**未纳入（显式）**：`electron/context-usage.ts`（属其他变更）；proto/DB、飞书/微信通道、changelog（archive 阶段再定）。

**统计**：1 新建 loader + 2 实现端 + 1 AGENTS；`npm run build` 已通过。

### Path A / Path B 职责

| 路径 | 模块 | 职责 |
|------|------|------|
| **Path B** | `mcp-manager.ts` | Settings → MCP 工具列表探测：workspace 下 CLI 优先，stdio 直连补 `cwd`，修复 close 误报 |
| **Path A** | `mcp-sdk-loader.ts` + `agent-sdk.ts` | SDK Agent 运行时：stdio MCP inline 注入 + resident send 重传；HTTP MCP 仍由 `settingSources` 加载，避免双重 spawn |

## 2、与设计的差异

无结构性偏差，与 `01-proposal.md` LITE-01/02 一致。

## 3、影响范围

- **涉及模块**：Electron MCP 管理（Settings 探测）、SDK Agent 创建与长驻 dispatch。
- **配置来源**：project/global `.cursor/mcp.json`；合并规则与 Path B 读取口径对齐。
- **去重策略**：同名 server 若同时可被 settings 与 inline 加载，**stdio/command 仅 inline**；**url/HTTP 仅 settings**。
- **接口/proto/数据**：无对外 HTTP/proto 契约变更；无持久化模型变更。
- **用户可见性**：Settings 页 stdio MCP（如 codegraph）工具列表可正常展示；SDK 会话可调用 stdio MCP 工具。

### 3.1 Ponytail 技术债

diff 中无 `ponytail:` 注释。**Lean already. Ship.**

| 位置 | 注释摘要 | 升级路径 |
|------|----------|----------|
| — | 无 | — |

### 3.2 SDK 限制与剩余风险

| 项 | 说明 |
|----|------|
| **inline 不持久化** | SDK `mcpServers` 仅在 `Agent.create` / 每次 `agent.send` 生效；resident 模式已用 `appendInlineMcpToSendOptions` 重传，若未来新增 send 入口须同样合并 |
| **Settings 探测 vs SDK 运行时** | Path B 与 Path A 独立：Settings 仍可能走 CLI 探测；SDK 走 inline stdio spawn，二者失败模式不同，需分别验收 |
| **无 workspace** | 未配置 `workspaceDir` 时 CLI 探测跳过、stdio `cwd` 为空，npx/相对路径类 MCP 仍可能失败 |
| **SDK 能力边界** | 依赖 `@cursor/sdk` 对 stdio MCP 的支持；若特定 server 在 SDK 内仍不可用，需在会话内实测 tool call，非本变更代码可完全保证 |
| **HTTP 回归** | 逻辑上 HTTP 未改 inline 路径，但 `settingSources` 与 loader 并存，archive 前建议抽测一条 HTTP MCP |

## 4、知识库影响清单

记录型 lite：**知识库无需更新**。

| 文件/分区 | 结论 | 原因 |
|-----------|------|------|
| `knowledge/业务域/**` | 无需更新 | 无 IM/调度/通道用户可见行为变更 |
| `knowledge/工程平台/**` | 无需更新 | MCP 加载为 Electron 内部实现细节；约定已写入 `electron/AGENTS.md`，非工程平台十段式文档范围 |
| `knowledge/知识索引.md` | 无需更新 | 无新领域/分区入口 |
| `electron/AGENTS.md` | 已更新（代码仓 AGENTS，非 KB） | builder 已沉淀 SDK MCP 内联规矩 |

- [x] 业务域 — 无用户可见行为变更
- [x] 工程平台 — 内部 MCP 集成，记录型不扩 KB
- [x] 知识索引 — 总入口未变化

## 5、验收步骤

| # | 项 | 操作 | 状态 |
|---|-----|------|------|
| 1 | Settings MCP 工具列表 | 打开 Settings → MCP → 选择 stdio 服务（如 **codegraph**），确认工具列表正常、无 close 误报 | ⏳ 建议人工 |
| 2 | SDK stdio MCP | 主会话/SDK 路径发起任务，确认 agent 可调用 codegraph 等 stdio 工具（UI 日志可见 tool_call） | ⏳ 建议人工 |
| 3 | HTTP MCP 回归 | 保留一条 url 型 MCP，确认 Settings 列表与 SDK 调用无退化 | ⏳ 建议人工 |
| 4 | 编译/build | `npm run build`（builder 已跑通）；可选 `npx tsc --noEmit` | ✅ build 通过 |

## 6、归档待办（`/kb-archive`）

- **版本/changelog**：用户可见功能增强，archive 时 **minor** bump 并新建 `changelog/<新版本>.json`（条目：Settings stdio MCP 探测修复、SDK stdio MCP 内联加载）
- **迁移**：`stage` → `archived`，目录 `mv` 至 `knowledge/变更/归档/`
