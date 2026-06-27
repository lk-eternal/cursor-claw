# MCP 授权与 SDK 内联修复 - 变更总结

> **hotfix-lite** | stage: `archived` | v1.8.3

## 实际变更

| 文件 | 改动 |
|------|------|
| `electron/mcp-project-dir.ts` | **新建**：Cursor projects 路径解析 + `readMcpAuthStore` |
| `electron/mcp-sdk-loader.ts` | HTTP/sse 内联；合并 `mcp-auth.json` OAuth Bearer |
| `electron/mcp-manager.ts` | 复用 `findCursorProjectDir` |
| `electron/AGENTS.md` | 更新 SDK MCP 内联约定 |
| `package.json` | `1.8.3` |
| `changelog/1.8.2.json` / `1.8.3.json` | 新建 |

## 根因（两层）

1. **Settings 误报未认证**：projects 目录路径编码不匹配 → 读不到 `mcp-approvals.json`。
2. **SDK 会话仅 codegraph 可用**：loader 只 inline stdio；HTTP MCP 依赖 `settingSources`，在飞书/SDK 远程会话中未注入。

## 验收

| 项 | 状态 |
|----|------|
| vkk 路径 + OAuth 解析脚本 | ✅ |
| `loadInlineMcpServers` 输出 4 服务 | ✅ |
| `npm run build` | ✅ |
| 重启 + reset 后会话 MCP 列表 | ⏳ 人工 |

## 用户操作

重启 Cursor Claw 后，对现有 SDK 长驻会话执行 **`/reset`**（或发新消息触发新 Agent），再询问可用 MCP 列表。
