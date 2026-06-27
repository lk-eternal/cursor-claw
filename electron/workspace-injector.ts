import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { getConfig } from "./config-store"
import { broadcastLog } from "./ui-logger"

// ── Types ──────────────────────────────────────────────────────

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

// ── State ──────────────────────────────────────────────────────

let daemonPort: number | null = null

const HOME_DIR = os.homedir()
const GLOBAL_MCP_PATH = path.join(HOME_DIR, ".cursor", "mcp.json")
const CLAW_MCP_KEYS = ["cursor-claw", "cursor-claw-admin"]

export function setDaemonPort(port: number | null): void {
  daemonPort = port
}

export function clearInjectionCache(_dir?: string): void {
  // ponytail: 注入缓存已废弃，保留符号供 daemon-manager 调用
}

// ── MCP helpers（仅 cleanup 使用）────────────────────────────────

export function buildMcpServers(): Record<string, unknown> {
  if (!daemonPort) return {}
  const base = `http://127.0.0.1:${daemonPort}`
  return {
    "cursor-claw": { url: `${base}/mcp` },
    "cursor-claw-admin": { url: `${base}/mcp-admin` },
  }
}

function removeClawMcpKeys(mcpPath: string): void {
  if (!fs.existsSync(mcpPath)) return
  try {
    const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf-8"))
    const servers = cfg.mcpServers as Record<string, unknown> | undefined
    if (!servers) return
    let changed = false
    for (const key of CLAW_MCP_KEYS) {
      if (key in servers) { delete servers[key]; changed = true }
    }
    if (!changed) return
    if (Object.keys(servers).length === 0 && Object.keys(cfg).filter((k) => k !== "mcpServers").length === 0) {
      fs.unlinkSync(mcpPath)
      broadcastLog(`已删除空的 MCP 配置: ${mcpPath}`)
    } else {
      cfg.mcpServers = servers
      fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2), "utf-8")
      broadcastLog(`已清理 MCP 残留: ${mcpPath}`)
    }
  } catch { /* ignore */ }
}

/** 可选：手动清理历史注入的 MCP 条目（不自动在 launch/启动时调用） */
export function cleanupLegacyInjection(wsDir?: string): void {
  removeClawMcpKeys(GLOBAL_MCP_PATH)
  const dir = wsDir ?? getConfig().workspaceDir
  if (dir) removeClawMcpKeys(path.join(dir, ".cursor", "mcp.json"))
}

// ponytail: 产品决策 — 启动/launch 不再写用户或项目 .cursor；符号保留供兼容

export async function injectMcpGlobal(): Promise<boolean> {
  return true
}

export function injectRulesToDir(_wsDir: string, _skipIdentity = false, _identityOverride?: string): boolean {
  return true
}

export function injectSkillsToDir(_wsDir: string): boolean {
  return true
}

export async function injectWorkspaceToDir(_dir: string, _skipIdentity = false, _identityOverride?: string): Promise<boolean> {
  return true
}

export async function injectWorkspaceMcpAndRules(): Promise<{ mcpOk: boolean; ruleOk: boolean; skillOk: boolean }> {
  return { mcpOk: true, ruleOk: true, skillOk: true }
}

// ── UI-triggered: inject admin skill (IPC) ─────────────────────

const ADMIN_SKILL_CONTENT = `# Cursor Claw — 自管理 Skill

你可以通过以下 MCP 工具管理 Cursor Claw 应用自身的运行状态、配置和环境。

## 可用 MCP 工具

### manage_agent
管理 Agent 生命周期。
| action | 说明 |
|--------|------|
| status | 查询运行状态 |
| stop | 停止 Agent |
| restart | 重启应用 |
| reset | 重置会话 |
| clean | 清空消息队列 |

### manage_mcp
管理 MCP 服务器配置（list / add / delete）。

### manage_rules
管理 Cursor Rules 文件（list / read / save / delete）。

### manage_skills
管理 Agent Skills（list / read / save / delete）。

### manage_tasks
管理定时任务（list / add / update / delete / toggle）。

### manage_workspace
管理工作目录（get / set）。
`

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function injectFile(filePath: string, content: string, forceUpdate = false): InjectResult {
  const relPath = path.basename(filePath)
  if (fs.existsSync(filePath) && !forceUpdate) {
    return { file: relPath, action: "skipped", message: "文件已存在" }
  }
  const action = fs.existsSync(filePath) ? "updated" as const : "created" as const
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, "utf-8")
  return { file: relPath, action, message: action === "updated" ? "文件已更新" : "文件已创建" }
}

export async function injectWorkspace(): Promise<{ results: InjectResult[] }> {
  const config = getConfig()
  if (!config.workspaceDir) {
    return { results: [{ file: "", action: "skipped", message: "工作目录未配置" }] }
  }
  const result = injectFile(
    path.join(config.workspaceDir, ".cursor", "skills", "cursor-claw-admin", "SKILL.md"),
    ADMIN_SKILL_CONTENT,
    true,
  )
  return { results: [result] }
}
