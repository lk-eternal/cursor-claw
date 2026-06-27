# MCP 授权状态读取修复

> **类型**：hotfix-lite  
> **来源**：用户反馈 — Settings → MCP 授权成功后刷新仍提示需重新授权

## 问题

`electron/mcp-manager.ts` 的 `findProjectDir` 用工作区路径编码去定位 `~/.cursor/projects/<dir>/mcp-approvals.json`，存在两处偏差：

1. 绝对路径首字符 `/` 编码为 `-`，生成 `-Users-...`，而 Cursor 实际目录为 `Users-...`（无前导 `-`）。
2. 工作区目录名中的 `_` 与 Cursor projects 目录中的 `-` 未归一化（如 `vkk_client_flutter` ↔ `vkk-client-flutter`）。

导致 `readApprovedServers` 恒返回空集，Settings 页 HTTP MCP 的「已认证」状态在每次刷新后被重置。

## 方案

### LITE-01 Settings 认证状态

- `encodeWorkspaceProjectKey` / `normalizeProjectDirKey` / `findCursorProjectDir`（`mcp-project-dir.ts`）

### LITE-02 SDK 会话 HTTP MCP

- `loadInlineMcpServers` 同时 inline **stdio + HTTP/sse**
- OAuth 服务从 `mcp-auth.json` 注入 `Authorization: Bearer …`
- API Key 服务（context7）保留 `mcp.json` headers

## 验收

- 工作区 `/Users/kiki/doger/swg/vkk_client_flutter` 能解析到 `Users-kiki-doger-swg-vkk-client-flutter` 并读到 `mcp-approvals.json`。
- Settings → MCP 刷新后 figma/context7/ZEGO 显示「已认证」（若 CLI 侧已授权）。
- `npm run build` 通过。
