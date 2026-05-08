import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { getConfig } from "./config-store"
import { broadcastLog } from "./ui-logger"

// ── Types ──────────────────────────────────────────────────────

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

export type EnableMcpFn = (wsDir: string, serverNames: string[]) => Promise<void>

// ── State ──────────────────────────────────────────────────────

let daemonPort: number | null = null
const injectedMcpHashes = new Map<string, string>()

export function setDaemonPort(port: number | null): void {
  daemonPort = port
}

// ── Path helpers ───────────────────────────────────────────────

export function getMcpServerPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "daemon", "mcp-server.mjs")
  const bundled = path.join(app.getAppPath(), "dist-bundle", "mcp-server.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "index.js")
}

export function getAdminMcpPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "daemon", "mcp-admin.mjs")
  const bundled = path.join(app.getAppPath(), "dist-bundle", "mcp-admin.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "server-admin-entry.js")
}

export function getRuleTemplatePath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "cursor-claw.mdc")
  return path.join(app.getAppPath(), "resources", "cursor-claw.mdc")
}

export function getSkillsTemplateDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "skills")
  return path.join(app.getAppPath(), "resources", "skills")
}

// ── MCP injection ──────────────────────────────────────────────

export function buildMcpServers(): Record<string, unknown> {
  if (!daemonPort) return {}
  const env: Record<string, string> = { LARK_DAEMON_PORT: String(daemonPort) }
  return {
    "cursor-claw": { command: "node", args: [getMcpServerPath()], env },
    "cursor-claw-admin": { command: "node", args: [getAdminMcpPath()], env },
  }
}

let _enableMcpFn: EnableMcpFn | null = null

export function registerEnableMcpFn(fn: EnableMcpFn): void {
  _enableMcpFn = fn
}

export async function injectMcpToDir(wsDir: string): Promise<boolean> {
  try {
    const newServers = buildMcpServers()
    const hash = JSON.stringify(newServers)
    if (injectedMcpHashes.get(wsDir) === hash) return true

    const mcpPath = path.join(wsDir, ".cursor", "mcp.json")
    let mcpConfig: Record<string, unknown> = {}
    if (fs.existsSync(mcpPath)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) } catch { mcpConfig = {} }
    }
    const existing = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>
    Object.assign(existing, newServers)
    mcpConfig.mcpServers = existing

    const dir = path.dirname(mcpPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), "utf-8")
    injectedMcpHashes.set(wsDir, hash)
    broadcastLog(`MCP 已注入: ${mcpPath}`)

    if (_enableMcpFn) await _enableMcpFn(wsDir, Object.keys(newServers))
    return true
  } catch (e: unknown) {
    broadcastLog(`MCP 注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

// ── Rules injection ────────────────────────────────────────────

export function injectRulesToDir(wsDir: string): boolean {
  try {
    const rulesDir = path.join(wsDir, ".cursor", "rules")
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true })
    const rulePath = path.join(rulesDir, "cursor-claw.mdc")
    const tplPath = getRuleTemplatePath()
    const ruleContent = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, "utf-8") : ""
    if (!ruleContent) {
      broadcastLog(`规则模板文件不存在: ${tplPath}`, "WARN")
      return false
    }
    fs.writeFileSync(rulePath, ruleContent, "utf-8")
    broadcastLog(`规则已注入: ${rulePath}`)

    const identity = getConfig().digitalIdentity?.trim()
    const identityPath = path.join(rulesDir, "digital-identity.mdc")
    if (identity) {
      const identityMdc = [
        "---",
        "description: 数字身份规则 - 定义 Agent 的角色、职责和行为边界",
        "alwaysApply: true",
        "---",
        "",
        identity,
      ].join("\r\n")
      fs.writeFileSync(identityPath, identityMdc, "utf-8")
    } else if (fs.existsSync(identityPath)) {
      fs.unlinkSync(identityPath)
    }

    return true
  } catch (e: unknown) {
    broadcastLog(`规则注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

// ── Skills injection ───────────────────────────────────────────

export function injectSkillsToDir(wsDir: string): boolean {
  try {
    const srcDir = getSkillsTemplateDir()
    if (!fs.existsSync(srcDir)) return false
    const destBase = path.join(wsDir, ".cursor", "skills")
    const entries = fs.readdirSync(srcDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillSrc = path.join(srcDir, entry.name)
      const skillDest = path.join(destBase, entry.name)
      if (!fs.existsSync(skillDest)) fs.mkdirSync(skillDest, { recursive: true })
      for (const file of fs.readdirSync(skillSrc)) {
        const s = path.join(skillSrc, file)
        const d = path.join(skillDest, file)
        if (fs.statSync(s).isFile()) fs.copyFileSync(s, d)
      }
    }
    broadcastLog(`Skills 已注入: ${destBase}`)
    return true
  } catch (e: unknown) {
    broadcastLog(`Skills 注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

// ── Composite: inject all into a directory ─────────────────────

export async function injectWorkspaceToDir(dir: string): Promise<boolean> {
  await injectMcpToDir(dir)
  injectSkillsToDir(dir)
  return injectRulesToDir(dir)
}

export async function injectWorkspaceMcpAndRules(): Promise<{ mcpOk: boolean; ruleOk: boolean; skillOk: boolean }> {
  const config = getConfig()
  if (!config.workspaceDir) return { mcpOk: false, ruleOk: false, skillOk: false }
  const mcpOk = await injectMcpToDir(config.workspaceDir)
  const ruleOk = injectRulesToDir(config.workspaceDir)
  const skillOk = injectSkillsToDir(config.workspaceDir)
  return { mcpOk, ruleOk, skillOk }
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

  const wsDir = config.workspaceDir
  const results: InjectResult[] = []

  results.push(
    injectFile(
      path.join(wsDir, ".cursor", "skills", "cursor-claw-admin", "SKILL.md"),
      ADMIN_SKILL_CONTENT,
      true,
    ),
  )

  return { results }
}
