import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** mcp-auth.json 单条 OAuth 令牌结构 */
export interface McpAuthEntry {
  tokens?: { access_token?: string; token_type?: string; [key: string]: unknown }
  clientInfo?: unknown
}

/** 工作区绝对路径 → Cursor projects 目录名；去掉前导 `-`（`/` 编码产物） */
export function encodeWorkspaceProjectKey(workspaceDir: string): string {
  return workspaceDir
    .trim()
    .replace(/\\/g, "-")
    .replace(/\//g, "-")
    .replace(/:/g, "")
    .replace(/^-+/, "")
}

/** 模糊匹配键：忽略大小写及 `_`/`-` 差异（如 vkk_client_flutter ↔ vkk-client-flutter） */
export function normalizeProjectDirKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "")
}

/** 定位 ~/.cursor/projects/<编码工作区> 目录 */
export function findCursorProjectDir(workspaceDir: string): string | null {
  const projectsBase = path.join(os.homedir(), ".cursor", "projects")
  if (!fs.existsSync(projectsBase)) return null

  const expected = encodeWorkspaceProjectKey(workspaceDir)
  if (!expected) return null

  const exactPath = path.join(projectsBase, expected)
  if (fs.existsSync(exactPath)) return exactPath

  try {
    const expectedLower = expected.toLowerCase()
    const expectedNorm = normalizeProjectDirKey(expected)
    for (const d of fs.readdirSync(projectsBase)) {
      if (d.toLowerCase() === expectedLower) return path.join(projectsBase, d)
      if (normalizeProjectDirKey(d) === expectedNorm) return path.join(projectsBase, d)
    }
  } catch { /* ignore */ }
  return null
}

/** 读取 Cursor 项目级 OAuth 令牌（agent mcp login 写入） */
export function readMcpAuthStore(workspaceDir: string): Record<string, McpAuthEntry> {
  const dir = findCursorProjectDir(workspaceDir)
  if (!dir) return {}
  const authPath = path.join(dir, "mcp-auth.json")
  try {
    if (!fs.existsSync(authPath)) return {}
    return JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, McpAuthEntry>
  } catch {
    return {}
  }
}
