import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { McpServerConfig } from "@cursor/sdk"

/** mcp.json 单条原始配置（与 mcp-manager buildEntry 对齐） */
type RawMcpEntry = Record<string, unknown>

/** 读取 mcp.json 中的 servers 块；文件缺失或解析失败返回空对象 */
function readMcpServersBlock(filePath: string): Record<string, RawMcpEntry> {
  try {
    if (!fs.existsSync(filePath)) return {}
    const cfg = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>
    return (cfg.mcpServers ?? cfg.servers ?? {}) as Record<string, RawMcpEntry>
  } catch {
    return {}
  }
}

/**
 * 合并 global ~/.cursor/mcp.json 与 project .cursor/mcp.json。
 * 同名 server 以 project 为准（覆盖 global）。
 */
function mergeMcpJsonEntries(workspaceDir: string): Record<string, RawMcpEntry> {
  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  const merged: Record<string, RawMcpEntry> = { ...readMcpServersBlock(globalPath) }

  const ws = workspaceDir.trim()
  if (ws) {
    const projectPath = path.join(ws, ".cursor", "mcp.json")
    Object.assign(merged, readMcpServersBlock(projectPath))
  }
  return merged
}

/**
 * command/stdio 型 → SDK stdio 配置。
 * HTTP/url 型返回 null（走 settingSources，避免与 inline 重复注册）。
 */
function toStdioInlineConfig(raw: RawMcpEntry, workspaceDir: string): McpServerConfig | null {
  if (raw.disabled === true) return null
  // url 优先判定为 HTTP 型，不 inline
  if (raw.url) return null
  const command = raw.command as string | undefined
  if (!command) return null

  const cfg: McpServerConfig = {
    type: "stdio",
    command,
    args: raw.args as string[] | undefined,
    env: raw.env as Record<string, string> | undefined,
  }
  // stdio spawn 必须带 workspace cwd（npx/相对路径/项目 env 依赖）
  const ws = workspaceDir.trim()
  if (ws) cfg.cwd = ws
  return cfg
}

/**
 * 加载需 inline 注入 SDK 的 MCP 配置。
 * 去重策略：agent-sdk 使用 settingSources: ["project","user"]，HTTP MCP 仍由 settings 加载；
 * 此处仅注入 stdio/command 型并补 cwd，避免 stdio 被 settings 与 inline 双重 spawn。
 */
export function loadInlineMcpServers(workspaceDir: string): Record<string, McpServerConfig> {
  const merged = mergeMcpJsonEntries(workspaceDir)
  const result: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(merged)) {
    const cfg = toStdioInlineConfig(raw, workspaceDir)
    if (cfg) result[name] = cfg
  }
  return result
}

/** agent.send 选项合并：在 createAgentSendOptions 返回值上追加 inline mcpServers（resident 模式每次 send 须重传） */
export function appendInlineMcpToSendOptions<T extends object>(
  sendOptions: T,
  workspaceDir?: string,
): T & { mcpServers: Record<string, McpServerConfig> } {
  return {
    ...sendOptions,
    mcpServers: loadInlineMcpServers(workspaceDir ?? ""),
  }
}
