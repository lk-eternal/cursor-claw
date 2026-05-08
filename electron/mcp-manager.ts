import { spawn } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { BrowserWindow } from "electron"
import { getConfig, useSdkMode } from "./config-store"
import { broadcastLog, logCursorAgentInvocation } from "./ui-logger"
import { resolveAgentBinary, applyProxyEnv, quoteArg, getAgentPaths } from "./agent-cli"

// ── Types ────────────────────────────────────────────────

export interface McpServerEntry {
  name: string
  type: "command" | "url"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  source: "global" | "project"
  authenticated?: boolean
  rawConfig?: Record<string, unknown>
  enabled?: boolean
}

export interface McpToolInfo {
  name: string
  description?: string
  params?: { name: string; type?: string; description?: string; required?: boolean }[]
}

// ── Internal helpers ─────────────────────────────────────


const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function isEnabledStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s !== "disabled" && !s.includes("not loaded")
}

function spawnAsync(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const mcpLabel = args.length >= 2 && args[0] === "mcp" ? `mcp-${args[1]}` : `mcp-${args[0] ?? "spawn"}`
    logCursorAgentInvocation(mcpLabel, args, cwd)
    let stdout = "", stderr = "", settled = false, didTimeout = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: didTimeout || undefined })
    }
    const { agentNodePath: np, agentIndexPath: ip } = getAgentPaths()
    const child = np && ip
      ? spawn(np, [ip, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env })
      : spawn("agent", args.map(quoteArg), { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env })
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.on("error", () => done(1))
    child.on("exit", (code) => done(code ?? 1))
    const timer = setTimeout(() => { didTimeout = true; try { child.kill() } catch { /* */ }; done(1) }, 30_000)
  })
}

// ── OAuth & Project helpers ──────────────────────────────

function findProjectDir(workspaceDir: string): string | null {
  const projectsBase = path.join(os.homedir(), ".cursor", "projects")
  if (!fs.existsSync(projectsBase)) return null

  const expected = workspaceDir.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "")
  const exactPath = path.join(projectsBase, expected)
  if (fs.existsSync(exactPath)) return exactPath

  try {
    const lower = expected.toLowerCase()
    const match = fs.readdirSync(projectsBase).find((d) => d.toLowerCase() === lower)
    if (match) return path.join(projectsBase, match)
  } catch { /* ignore */ }
  return null
}

function getProjectSlug(workspaceDir: string): string {
  const dir = findProjectDir(workspaceDir)
  if (dir) return path.basename(dir)
  return workspaceDir.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "")
}

function readMcpAuthFile(workspaceDir: string): Record<string, unknown> {
  const dir = findProjectDir(workspaceDir)
  if (!dir) return {}
  const authPath = path.join(dir, "mcp-auth.json")
  try {
    if (fs.existsSync(authPath)) return JSON.parse(fs.readFileSync(authPath, "utf-8"))
  } catch { /* ignore */ }
  return {}
}

function readAllMcpServers(): Record<string, Record<string, unknown>> {
  const config = getConfig()
  const servers: Record<string, Record<string, unknown>> = {}

  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  try {
    if (fs.existsSync(globalPath)) {
      const cfg = JSON.parse(fs.readFileSync(globalPath, "utf-8"))
      if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers)
    }
  } catch { /* ignore */ }

  if (config.workspaceDir) {
    const projectPath = path.join(config.workspaceDir, ".cursor", "mcp.json")
    try {
      if (fs.existsSync(projectPath)) {
        const cfg = JSON.parse(fs.readFileSync(projectPath, "utf-8"))
        if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers)
      }
    } catch { /* ignore */ }
  }

  return servers
}

// ── MCP Enabled Cache ────────────────────────────────────

interface McpListCache { enabled: Record<string, boolean>; status: Record<string, string>; ts: number; ws: string }
const MCP_ENABLED_CACHE_TTL_MS = 30_000
let mcpListCache: McpListCache | null = null
let mcpListInflight: Promise<McpListCache> | null = null

function fetchMcpListFromJson(ws: string): McpListCache {
  const enabled: Record<string, boolean> = {}
  const status: Record<string, string> = {}
  const servers = getMcpServerList()
  for (const s of servers) {
    const disabled = s.rawConfig && (s.rawConfig as Record<string, unknown>).disabled === true
    enabled[s.name] = !disabled
    status[s.name] = disabled ? "disabled" : "enabled"
  }
  const result: McpListCache = { enabled, status, ts: Date.now(), ws }
  mcpListCache = result
  return result
}

async function fetchMcpList(force = false): Promise<McpListCache> {
  const config = getConfig()
  const ws = (config.workspaceDir || "").trim()
  const empty: McpListCache = { enabled: {}, status: {}, ts: 0, ws }
  if (!ws) return empty
  if (!force && mcpListCache && mcpListCache.ws === ws && Date.now() - mcpListCache.ts < MCP_ENABLED_CACHE_TTL_MS) return mcpListCache

  if (useSdkMode()) return fetchMcpListFromJson(ws)
  if (!resolveAgentBinary()) return empty
  if (mcpListInflight) return mcpListInflight

  const p = (async (): Promise<McpListCache> => {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(env, config)
    try {
      const r = await spawnAsync(["mcp", "list"], ws, env)
      const clean = r.stdout.replace(ANSI_RE, "").replace(/\r/g, "")
      const enabled: Record<string, boolean> = {}
      const status: Record<string, string> = {}
      for (const line of clean.split("\n")) {
        const m = line.match(/^(.+?):\s+(.+)$/)
        if (m) {
          const name = m[1].trim(), raw = m[2].trim()
          enabled[name] = isEnabledStatus(raw)
          status[name] = raw.toLowerCase()
        }
      }
      const result: McpListCache = { enabled, status, ts: Date.now(), ws }
      mcpListCache = result
      return result
    } catch {
      return empty
    } finally {
      mcpListInflight = null
    }
  })()
  mcpListInflight = p
  return p
}

// ── Public API: Cache ────────────────────────────────────

export async function getMcpEnabledMap(force = false): Promise<Record<string, boolean>> {
  return (await fetchMcpList(force)).enabled
}

export async function getMcpStatusMap(force = false): Promise<Record<string, string>> {
  return (await fetchMcpList(force)).status
}

export function invalidateMcpEnabledCache(): void {
  mcpListCache = null
}

// ── Public API: Toggle ───────────────────────────────────

function toggleMcpServerViaJson(serverName: string, enabled: boolean): { ok: boolean; output: string } {
  const config = getConfig()
  const ws = config.workspaceDir
  if (!ws) return { ok: false, output: "工作目录未配置" }

  const sources: Array<{ scope: "global" | "project"; filePath: string }> = [
    { scope: "global", filePath: path.join(os.homedir(), ".cursor", "mcp.json") },
    { scope: "project", filePath: path.join(ws, ".cursor", "mcp.json") },
  ]

  for (const { scope, filePath } of sources) {
    try {
      if (!fs.existsSync(filePath)) continue
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      const servers = raw.mcpServers ?? raw.servers ?? {}
      if (!(serverName in servers)) continue
      if (enabled) {
        delete servers[serverName].disabled
      } else {
        servers[serverName].disabled = true
      }
      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), "utf-8")
      invalidateMcpEnabledCache()
      broadcastLog(`[MCP toggle] ${serverName} → ${enabled ? "enabled" : "disabled"} (${scope})`, "INFO")
      return { ok: true, output: `${serverName} ${enabled ? "enabled" : "disabled"} (${scope})` }
    } catch { /* ignore */ }
  }
  return { ok: false, output: `未找到 ${serverName}` }
}

export async function toggleMcpServer(serverName: string, enabled: boolean): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, output: "工作目录未配置" }

  if (useSdkMode()) return toggleMcpServerViaJson(serverName, enabled)
  if (!resolveAgentBinary()) return { ok: false, output: "Cursor CLI 未安装" }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)

  const sub = enabled ? "enable" : "disable"
  try {
    const r = await spawnAsync(["mcp", sub, serverName], config.workspaceDir, env)
    const out = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "").trim()
    broadcastLog(`[MCP ${sub}] ${serverName}: ${out}`, r.code === 0 ? "INFO" : "WARN")
    invalidateMcpEnabledCache()
    return { ok: r.code === 0, output: out }
  } catch (e: any) {
    return { ok: false, output: e?.message ?? "未知错误" }
  }
}

// ── Public API: CRUD ─────────────────────────────────────

export function getMcpServerList(): McpServerEntry[] {
  const config = getConfig()
  const ws = config.workspaceDir || ""
  const authData = ws ? readMcpAuthFile(ws) : {}
  const result: McpServerEntry[] = []

  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  try {
    if (fs.existsSync(globalPath)) {
      const cfg = JSON.parse(fs.readFileSync(globalPath, "utf-8"))
      const servers = cfg.mcpServers ?? cfg.servers ?? {}
      for (const [name, raw] of Object.entries(servers) as [string, Record<string, unknown>][]) {
        result.push(buildEntry(name, raw, "global", authData))
      }
    }
  } catch { /* ignore */ }

  if (ws) {
    const projectPath = path.join(ws, ".cursor", "mcp.json")
    try {
      if (fs.existsSync(projectPath)) {
        const cfg = JSON.parse(fs.readFileSync(projectPath, "utf-8"))
        const servers = cfg.mcpServers ?? cfg.servers ?? {}
        for (const [name, raw] of Object.entries(servers) as [string, Record<string, unknown>][]) {
          result.push(buildEntry(name, raw, "project", authData))
        }
      }
    } catch { /* ignore */ }
  }

  return result
}

function buildEntry(name: string, raw: Record<string, unknown>, source: "global" | "project", authData: Record<string, unknown>): McpServerEntry {
  const type: "command" | "url" = raw.url ? "url" : "command"
  return {
    name,
    type,
    command: raw.command as string | undefined,
    args: raw.args as string[] | undefined,
    url: raw.url as string | undefined,
    env: raw.env as Record<string, string> | undefined,
    source,
    authenticated: !!authData[name],
    rawConfig: raw,
    enabled: raw.disabled !== true,
  }
}

export function getMcpJsonPath(scope: "global" | "project"): string | null {
  if (scope === "global") return path.join(os.homedir(), ".cursor", "mcp.json")
  const ws = getConfig().workspaceDir
  if (!ws) return null
  return path.join(ws, ".cursor", "mcp.json")
}

export function readMcpJson(scope: "global" | "project"): Record<string, unknown> | null {
  const p = getMcpJsonPath(scope)
  if (!p) return null
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"))
  } catch { /* ignore */ }
  return null
}

export function writeMcpJson(scope: "global" | "project", data: Record<string, unknown>): boolean {
  const p = getMcpJsonPath(scope)
  if (!p) return false
  try {
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8")
    return true
  } catch { return false }
}

export function saveMcpServer(name: string, config: Record<string, unknown>, scope: "global" | "project"): { ok: boolean; error?: string } {
  const existing = readMcpJson(scope) ?? { mcpServers: {} }
  const servers = (existing.mcpServers ?? existing.servers ?? {}) as Record<string, unknown>
  servers[name] = config
  existing.mcpServers = servers
  if (existing.servers) delete existing.servers
  const success = writeMcpJson(scope, existing)
  if (success) invalidateMcpEnabledCache()
  return success ? { ok: true } : { ok: false, error: "写入失败" }
}

export function deleteMcpServer(name: string, scope: "global" | "project"): { ok: boolean; error?: string } {
  const existing = readMcpJson(scope)
  if (!existing) return { ok: false, error: "配置文件不存在" }
  const servers = (existing.mcpServers ?? existing.servers ?? {}) as Record<string, unknown>
  if (!(name in servers)) return { ok: false, error: `${name} 不存在` }
  delete servers[name]
  existing.mcpServers = servers
  if (existing.servers) delete existing.servers
  const success = writeMcpJson(scope, existing)
  if (success) invalidateMcpEnabledCache()
  return success ? { ok: true } : { ok: false, error: "写入失败" }
}

// ── Public API: OAuth login ──────────────────────────────

export async function loginMcpServer(serverName: string): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, output: "工作目录未配置" }
  if (!resolveAgentBinary()) return { ok: false, output: "Cursor CLI 未安装" }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)

  try {
    const child = spawn("agent", ["mcp", "login", serverName].map(quoteArg), {
      shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      cwd: config.workspaceDir, env,
    })

    let stdout = "", stderr = ""
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      const urlMatch = chunk.match(/https?:\/\/[^\s]+/)
      if (urlMatch) {
        const { shell } = require("electron")
        shell.openExternal(urlMatch[0])
      }
    })

    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => { try { child.kill() } catch { /* */ }; resolve(1) }, 60_000)
      child.on("exit", (c) => { clearTimeout(timer); resolve(c ?? 1) })
      child.on("error", () => { clearTimeout(timer); resolve(1) })
    })

    const out = (stdout + stderr).replace(ANSI_RE, "").replace(/\r/g, "").trim()
    return { ok: code === 0, output: out || (code === 0 ? "认证完成" : "认证失败") }
  } catch (e: any) {
    return { ok: false, output: e?.message ?? "启动失败" }
  }
}

// ── Public API: Tools Query ──────────────────────────────

function extractParams(schema: any): McpToolInfo["params"] {
  if (!schema?.properties) return undefined
  const required = new Set<string>(schema.required ?? [])
  return Object.entries(schema.properties).map(([k, v]: [string, any]) => ({
    name: k,
    type: v.type,
    description: v.description,
    required: required.has(k),
  }))
}

function queryToolsViaProtocol(cmd: string, args: string[], envOverride?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...(envOverride ?? {}) }
    if (!env.PATH && env.Path) env.PATH = env.Path

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(quoteArg(cmd), args.map(quoteArg), { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true })
    } catch (e: any) {
      resolve({ ok: false, tools: [], error: `启动失败: ${e.message}` })
      return
    }

    let stdout = ""
    let phase: "init" | "list" | "done" = "init"
    const timeout = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve({ ok: false, tools: [], error: "查询超时" })
    }, 15_000)

    const finish = (result: { ok: boolean; tools: McpToolInfo[]; error?: string }) => {
      if (phase === "done") return
      phase = "done"
      clearTimeout(timeout)
      try { child.kill() } catch { /* */ }
      resolve(result)
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
      for (const raw of stdout.split("\n")) {
        const line = raw.trim()
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && msg.result && phase === "init") {
            phase = "list"
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n")
          }
          if (msg.id === 2 && msg.result?.tools) {
            const tools: McpToolInfo[] = (msg.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
            finish({ ok: true, tools })
          }
        } catch { /* not json */ }
      }
    })

    child.on("error", (err) => finish({ ok: false, tools: [], error: `启动失败: ${err.message}` }))
    child.on("close", () => finish(phase === "init" ? { ok: false, tools: [], error: "进程退出，未获取到工具" } : { ok: true, tools: [] }))

    child.stdin?.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cursor-claw", version: "1.0.0" } },
    }) + "\n")
  })
}

async function queryToolsViaHttp(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const rpc = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params })
  const post = (body: string): Promise<any> => new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === "https:"
    const mod = isHttps ? require("node:https") : require("node:http")
    const req = mod.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(headers ?? {}) },
      timeout: 10_000,
    }, (res: any) => {
      let data = ""
      res.on("data", (chunk: Buffer) => { data += chunk.toString() })
      res.on("end", () => {
        try {
          if (res.headers["content-type"]?.includes("text/event-stream")) {
            for (const line of data.split("\n")) {
              if (line.startsWith("data:")) {
                const parsed = JSON.parse(line.slice(5).trim())
                if (parsed.id !== undefined) { resolve(parsed); return }
              }
            }
          }
          resolve(JSON.parse(data))
        } catch { resolve(null) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.write(body)
    req.end()
  })

  try {
    const initRes = await post(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cursor-claw", version: "1.0.0" } }))
    if (!initRes?.result) return { ok: false, tools: [], error: "initialize 失败" }
    const listRes = await post(rpc(2, "tools/list"))
    if (!listRes?.result?.tools) return { ok: false, tools: [], error: "tools/list 无结果" }
    const tools: McpToolInfo[] = (listRes.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
    return { ok: true, tools }
  } catch (e: any) {
    return { ok: false, tools: [], error: e?.message ?? "HTTP 请求失败" }
  }
}

function queryToolsViaCli(serverName: string): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const config = getConfig()
  if (!config.workspaceDir || !resolveAgentBinary()) return Promise.resolve({ ok: false, tools: [], error: "CLI 不可用" })
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)
  return spawnAsync(["mcp", "list-tools", serverName], config.workspaceDir, env).then((r) => {
    const clean = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "")
    if (r.code !== 0) return { ok: false, tools: [] as McpToolInfo[], error: clean.trim().split("\n").pop()?.trim() || `exit ${r.code}` }
    const tools: McpToolInfo[] = []
    for (const line of clean.split("\n")) {
      const m = line.match(/^[-–]\s+(\S+)/)
      if (m) tools.push({ name: m[1] })
    }
    return { ok: true, tools }
  })
}

export async function getMcpServerTools(serverName: string): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const servers = getMcpServerList()
  const server = servers.find((s) => s.name === serverName)
  if (!server) return { ok: false, tools: [], error: "MCP 服务器未找到" }

  if (server.type === "url" && server.url) {
    const headers = server.rawConfig?.headers as Record<string, string> | undefined
    const result = await queryToolsViaHttp(server.url, headers)
    if (result.ok && result.tools.length > 0) return result
  }

  if (server.type === "command" && server.command) {
    const result = await queryToolsViaProtocol(server.command, server.args ?? [], server.env)
    if (result.ok && result.tools.length > 0) return result
  }

  return queryToolsViaCli(serverName)
}
