import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { McpServerConfig } from "@cursor/sdk"
import { readMcpAuthStore, type McpAuthEntry } from "./mcp-project-dir"

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

/** 从 mcp-auth.json 解析 OAuth access_token（兼容 plugin-* 别名键） */
function resolveOAuthAccessToken(serverName: string, authStore: Record<string, McpAuthEntry>): string | undefined {
  const candidates = [serverName, `plugin-${serverName}-${serverName}`]
  for (const key of candidates) {
    const token = authStore[key]?.tokens?.access_token
    if (typeof token === "string" && token.trim()) return token.trim()
  }
  return undefined
}

/** command/stdio 型 → SDK stdio 配置 */
function toStdioInlineConfig(raw: RawMcpEntry, workspaceDir: string): McpServerConfig | null {
  if (raw.disabled === true) return null
  if (raw.url) return null
  const command = raw.command as string | undefined
  if (!command) return null

  const cfg: McpServerConfig = {
    type: "stdio",
    command,
    args: raw.args as string[] | undefined,
    env: raw.env as Record<string, string> | undefined,
  }
  const ws = workspaceDir.trim()
  if (ws) cfg.cwd = ws
  return cfg
}

/** HTTP/sse 型 → SDK remote 配置；合并 mcp.json headers 与 mcp-auth OAuth */
function toHttpInlineConfig(
  raw: RawMcpEntry,
  serverName: string,
  authStore: Record<string, McpAuthEntry>,
): McpServerConfig | null {
  if (raw.disabled === true) return null
  const url = raw.url as string | undefined
  if (!url) return null

  const rawType = raw.type as string | undefined
  const type = rawType === "sse" ? "sse" : "http"

  const headers: Record<string, string> = {
    ...(raw.headers as Record<string, string> | undefined),
  }
  const accessToken = resolveOAuthAccessToken(serverName, authStore)
  if (accessToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${accessToken}`
  }

  const cfg: McpServerConfig = { type, url }
  if (Object.keys(headers).length > 0) cfg.headers = headers

  const auth = raw.auth
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    cfg.auth = auth as Extract<McpServerConfig, { auth?: unknown }>["auth"]
  }
  return cfg
}

/**
 * 加载需 inline 注入 SDK 的 MCP 配置（stdio + HTTP/sse）。
 * settingSources 在 SDK 远程会话中常无法加载 HTTP MCP，故 mcp.json 条目均 inline；
 * stdio 仍补 cwd；HTTP 合并 mcp-auth OAuth 与 headers。
 */
export function loadInlineMcpServers(workspaceDir: string): Record<string, McpServerConfig> {
  const merged = mergeMcpJsonEntries(workspaceDir)
  const authStore = readMcpAuthStore(workspaceDir)
  const result: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(merged)) {
    const cfg = raw.url
      ? toHttpInlineConfig(raw, name, authStore)
      : toStdioInlineConfig(raw, workspaceDir)
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
