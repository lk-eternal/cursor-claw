// ── 工具箱：飞书 lark-cli / 飞书项目 meegle 的安装、更新与登录态检测 ──
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
  /** 本机是否可用 node/npm（一键安装前置） */
  nodeOk?: boolean
  nodeVersion?: string
}

const TOOL_PACKAGES: Record<string, { pkg: string; bin: string; versionArgs: string[] }> = {
  larkCli: { pkg: "@larksuite/cli", bin: "lark-cli", versionArgs: ["--version"] },
  meegle: { pkg: "@lark-project/meegle", bin: "meegle", versionArgs: ["version"] },
}

/** Windows cmd 默认 GBK：把明显乱码的 buffer/字符串尽量还原成可读中文 */
function decodeCmdText(raw: string | Buffer): string {
  if (Buffer.isBuffer(raw)) {
    const utf8 = raw.toString("utf8")
    if (!utf8.includes("\uFFFD")) return utf8
    try {
      // Node 无内置 gbk；用 TextDecoder 尝试（部分环境可用）
      return new TextDecoder("gbk").decode(raw)
    } catch {
      return utf8
    }
  }
  if (raw.includes("\uFFFD") || /npm.*[^\x00-\x7F]{0,5}\uFFFD/.test(raw)) {
    return raw // 已是坏串，调用方用友好文案覆盖
  }
  return raw
}

function looksLikeMissingCmd(text: string, cmd: string): boolean {
  const t = text.toLowerCase()
  return t.includes("enoent")
    || t.includes("not recognized")
    || t.includes("不是内部或外部命令")
    || t.includes("cannot find")
    || (t.includes(cmd.toLowerCase()) && t.includes("\ufffd"))
}

/** Windows 下 npm 全局 bin 是 .cmd/.ps1：优先经 cmd.exe 调 .cmd，避开 PowerShell 拦 .ps1 */
async function runCommand(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const isWin = process.platform === "win32"
    if (isWin) {
      // 对已知 CLI 显式走 .cmd，避免 PS 解析到 .ps1 触发「禁止运行脚本」
      const winCmd = (cmd === "meegle" || cmd === "lark-cli" || cmd === "npm") ? `${cmd}.cmd` : cmd
      const { stdout, stderr } = await execFileAsync("cmd.exe", ["/d", "/s", "/c", [winCmd, ...args].join(" ")], {
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      })
      return { ok: true, stdout: decodeCmdText(stdout ?? ""), stderr: decodeCmdText(stderr ?? "") }
    }
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs, encoding: "utf8" })
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" }
  } catch (e: any) {
    const stdout = decodeCmdText(e?.stdout ?? "")
    const stderr = decodeCmdText(e?.stderr ?? (e?.message ?? String(e)))
    return { ok: false, stdout, stderr }
  }
}

async function detectNode(): Promise<{ ok: boolean; version?: string }> {
  const r = await runCommand("node", ["-v"])
  if (!r.ok) return { ok: false }
  const version = (r.stdout || r.stderr).trim().replace(/^v/, "") || undefined
  return { ok: true, version }
}

function friendlyInstallError(raw: string): string {
  if (looksLikeMissingCmd(raw, "npm") || looksLikeMissingCmd(raw, "node")) {
    return "未检测到 Node.js / npm。请先安装 Node.js（https://nodejs.org ，勾选 Add to PATH），重新打开 Cursor Claw 后再点一键安装。"
  }
  if (/禁止运行脚本|running scripts is disabled|ExecutionPolicy/i.test(raw)) {
    return "PowerShell 禁止运行脚本。本应用已优先使用 .cmd；若仍失败，请用「以管理员打开 PowerShell」执行：Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
  }
  // 乱码兜底
  if ((raw.match(/\uFFFD/g)?.length ?? 0) > 3) {
    return "安装失败（错误信息编码异常）。请确认已安装 Node.js 并重新打开应用后再试。"
  }
  return raw.slice(-500) || "安装失败"
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
  const [larkCli, meegle, node] = await Promise.all([detectTool("larkCli"), detectTool("meegle"), detectNode()])
  return { larkCli, meegle, nodeOk: node.ok, nodeVersion: node.version }
}

/** 安装与更新同一实现：npm install -g 最新版 */
export async function installTool(key: "larkCli" | "meegle"): Promise<{ ok: boolean; error?: string }> {
  const tool = TOOL_PACKAGES[key]
  if (!tool) return { ok: false, error: "未知工具" }
  const node = await detectNode()
  if (!node.ok) {
    return { ok: false, error: "未检测到 Node.js。请先安装 Node.js（https://nodejs.org ，勾选 Add to PATH），重新打开 Cursor Claw 后再试。" }
  }
  const npmVer = await runCommand("npm", ["-v"])
  if (!npmVer.ok) {
    return { ok: false, error: "检测到 Node 但找不到 npm。请重装 Node.js 并勾选 Add to PATH。" }
  }
  const r = await runCommand("npm", ["install", "-g", `${tool.pkg}@latest`], 180_000)
  if (!r.ok) return { ok: false, error: friendlyInstallError(r.stderr || r.stdout) }
  return { ok: true }
}

/** lark-cli 设备码登录：非交互执行，浏览器完成授权后命令自行退出 */
export async function loginLarkCli(): Promise<{ ok: boolean; error?: string }> {
  // v1.0.70+ 必须显式指定授权范围，否则报 please specify the scopes / --scope
  const r = await runCommand("lark-cli", ["auth", "login", "--recommend"], 300_000)
  if (!r.ok) return { ok: false, error: friendlyInstallError(r.stderr || r.stdout) }
  return { ok: true }
}

export function initToolbox(): void {
  ipcMain.handle("toolbox:status", () => getToolboxStatus())
  ipcMain.handle("toolbox:install", (_e, key: "larkCli" | "meegle") => installTool(key))
  ipcMain.handle("toolbox:login-lark", () => loginLarkCli())
}
