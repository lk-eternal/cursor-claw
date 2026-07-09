// ── 工具箱：飞书 lark-cli / 飞书项目 lpm 的安装、更新与登录态检测 ──
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ipcMain } from "electron"

const execFileAsync = promisify(execFile)

export interface ToolboxToolStatus {
  installed: boolean
  version?: string
  /** 仅 lark-cli：已登录的用户名 */
  loggedIn?: boolean
  userName?: string
}

export interface ToolboxStatus {
  larkCli: ToolboxToolStatus
  meegle: ToolboxToolStatus
}

const TOOL_PACKAGES: Record<string, { pkg: string; bin: string; versionArgs: string[] }> = {
  larkCli: { pkg: "@larksuite/cli", bin: "lark-cli", versionArgs: ["--version"] },
  // meegle 不支持 --version，只认 version 子命令
  meegle: { pkg: "@lark-project/meegle", bin: "meegle", versionArgs: ["version"] },
}

/** Windows 下 npm 全局 bin 是 .ps1/.cmd，须经 shell 解析；输出统一按 UTF-8 处理 */
async function runCommand(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const isWin = process.platform === "win32"
    const { stdout, stderr } = isWin
      ? await execFileAsync("cmd.exe", ["/d", "/s", "/c", [cmd, ...args].join(" ")], { timeout: timeoutMs, encoding: "utf8", windowsHide: true })
      : await execFileAsync(cmd, args, { timeout: timeoutMs, encoding: "utf8" })
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" }
  } catch (e: any) {
    return { ok: false, stdout: e?.stdout ?? "", stderr: e?.stderr ?? (e?.message ?? String(e)) }
  }
}

async function detectTool(key: "larkCli" | "meegle"): Promise<ToolboxToolStatus> {
  const { bin, versionArgs } = TOOL_PACKAGES[key]
  const r = await runCommand(bin, versionArgs)
  const merged = `${r.stdout}\n${r.stderr}`
  const version = merged.match(/(\d+\.\d+\.\d+)/)?.[1]
  if (!r.ok && !version) return { installed: false }

  const status: ToolboxToolStatus = { installed: true, version }
  if (key === "larkCli") {
    const auth = await runCommand(bin, ["auth", "status"])
    try {
      const json = JSON.parse(auth.stdout.slice(auth.stdout.indexOf("{")))
      const user = json?.identities?.user
      status.loggedIn = user?.available === true
      status.userName = user?.userName
    } catch { status.loggedIn = false }
  }
  return status
}

export async function getToolboxStatus(): Promise<ToolboxStatus> {
  const [larkCli, meegle] = await Promise.all([detectTool("larkCli"), detectTool("meegle")])
  return { larkCli, meegle }
}

/** 安装与更新同一实现：npm install -g 最新版 */
export async function installTool(key: "larkCli" | "meegle"): Promise<{ ok: boolean; error?: string }> {
  const tool = TOOL_PACKAGES[key]
  if (!tool) return { ok: false, error: "未知工具" }
  const r = await runCommand("npm", ["install", "-g", `${tool.pkg}@latest`], 180_000)
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).slice(-500) }
  return { ok: true }
}

/** lark-cli 设备码登录：非交互执行，浏览器完成授权后命令自行退出 */
export async function loginLarkCli(): Promise<{ ok: boolean; error?: string }> {
  const r = await runCommand("lark-cli", ["auth", "login"], 300_000)
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).slice(-500) }
  return { ok: true }
}

export function initToolbox(): void {
  ipcMain.handle("toolbox:status", () => getToolboxStatus())
  ipcMain.handle("toolbox:install", (_e, key: "larkCli" | "meegle") => installTool(key))
  ipcMain.handle("toolbox:login-lark", () => loginLarkCli())
}