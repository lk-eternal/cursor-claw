# stdio MCP支持轻量变更说明

> **变更 ID**：`20260627230833-stdio MCP支持`
> **来源**：kb-lite
> **类型**：Enhancement（功能增强）
> **优先级**：P2
> **外部 PRD**：无
> **任务记录**：无
> **Figma 设计图**：无
> **lite 类型**：记录型 lite

---

## 背景

Cursor Claw 当前 MCP 集成存在两条路径，stdio 类型在 Settings 探测与 SDK Agent 运行时均未完整打通：

1. **Path B（Settings 工具探测）**：`electron/mcp-manager.ts` 已有未提交改动——`queryToolsViaProtocol` 需补 `cwd`、CLI 优先、修复 close 误报，使 Settings → MCP 能正确列出 stdio 服务（如 codegraph）的工具。
2. **Path A（SDK Agent 运行时）**：SDK `Agent.create` 尚未内联 stdio MCP 配置；需新建加载器合并 project/global `.cursor/mcp.json` 为 SDK `McpServerConfig`，并在 resident 模式 `agent.send` 时同步重传，使 SDK 会话可调用 stdio MCP。

两条路径需协同，且避免 `settingSources` 与 inline 重复注册：若同名重复则 stdio 仅走 inline、HTTP MCP 仍走 settings（以代码实测与 SDK 类型为准）。

## 变更说明

### LITE-01：Path B — mcp-manager stdio 探测

- 完善 `queryToolsViaProtocol`：stdio 启动时补 `cwd: workspaceDir`（或等价工作目录）
- CLI 探测优先于其他方式
- 修复进程 close 时的误报，避免工具列表探测失败

### LITE-02：Path A — SDK 内联 stdio MCP

- **新建** `electron/mcp-sdk-loader.ts`（≤300 行）：合并 project/global `.cursor/mcp.json` → SDK `McpServerConfig`；stdio 条目补 `cwd: workspaceDir`
- **修改** `electron/agent-sdk.ts`：
  - `Agent.create` 传入 `mcpServers: loadInlineMcpServers(workspaceDir)`
  - resident 模式 `agent.send` 同步重传 MCP 配置
  - 去重策略：与 `settingSources` 重复时，stdio 仅 inline、HTTP 仍走 settings

### 约束

- 中文注释；单文件 ≤300 行；最小 diff
- **不破坏**现有 HTTP MCP 行为
- **不包含** `electron/context-usage.ts`（属其他变更，不得纳入本变更 manifest）

### lite 判定

| 判定项 | 结论 |
|--------|------|
| 需求清晰度 | 双路径 scope 已明确，验收可验证 |
| 修改范围 | mcp-manager + 新建 loader + agent-sdk（+3 强相关文件） |
| 接口契约 | 内部 MCP 加载与 SDK 配置，非对外 proto（+0） |
| 数据/权限 | 不变（+0） |
| 跨端联动 | Electron 单仓（+0） |
| 知识库 | 记录型，实现后 05-summary 说明即可（+0） |
| **总分** | **≤2**，可走 lite |

## 验收标准

1. **Settings → MCP → codegraph**：工具列表正常展示，无 close 误报或 cwd 缺失导致的探测失败。
2. **SDK 会话 stdio MCP**：SDK Agent 会话可调用 stdio MCP（如 codegraph）；若 SDK 仍有未覆盖限制，在 `05-summary.md` 中明确说明剩余限制与规避方式。
3. **HTTP MCP 回归**：现有 HTTP MCP 配置与调用行为无退化。
4. **TypeScript 编译通过**。

## 影响范围

| 范围 | 说明 |
|------|------|
| `electron/mcp-manager.ts` | Path B：stdio 协议探测（cwd、CLI 优先、close 修复） |
| `electron/mcp-sdk-loader.ts` | Path A：**新建**，合并 mcp.json → SDK 内联配置 |
| `electron/agent-sdk.ts` | Path A：`Agent.create` / resident `send` 内联 MCP 与去重 |
| `electron/AGENTS.md`（可选） | 若沉淀 MCP 加载规矩则 builder 补充 |

**不在范围**：`electron/context-usage.ts`、proto/DB、飞书/微信通道、changelog（archive 阶段再定）。

## 待 builder 事项

- 实现 LITE-01、LITE-02 后更新 manifest：`tasks[].status`、`files[]` 写入实际代码路径
- 完成后由 kb-scribe 补写 `05-summary.md`；archive 时按需 bump 版本与 changelog
