import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface WorktreeAddInput {
  repoPath: string
  worktreePath: string
  featureBranch: string
  baseBranch: string
  fetch?: boolean
}

export interface WorktreeResult {
  ok: boolean
  error?: string
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  return {
    ok: r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    code: r.status ?? 1,
  }
}

function resolveReal(p: string): string {
  try {
    return fs.realpathSync.native(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

export function isGitRepoRoot(repoPath: string): boolean {
  if (!repoPath || !fs.existsSync(repoPath)) return false
  const r = runGit(repoPath, ["rev-parse", "--is-inside-work-tree"])
  if (!r.ok || r.stdout !== "true") return false
  const top = runGit(repoPath, ["rev-parse", "--show-toplevel"])
  if (!top.ok) return false
  return resolveReal(top.stdout) === resolveReal(repoPath)
}

export function addProjectWorktree(input: WorktreeAddInput): WorktreeResult {
  const { repoPath, worktreePath, featureBranch, baseBranch } = input
  if (!isGitRepoRoot(repoPath)) {
    return { ok: false, error: `主仓无效或不是 git 根目录: ${repoPath}` }
  }
  if (!featureBranch.trim() || !baseBranch.trim()) {
    return { ok: false, error: "基线分支与 feature 分支不能为空" }
  }
  if (fs.existsSync(worktreePath)) {
    return { ok: false, error: `worktree 路径已存在: ${worktreePath}` }
  }
  const parent = path.dirname(worktreePath)
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true })

  if (input.fetch !== false) {
    const fetch = runGit(repoPath, ["fetch", "--all", "--prune"])
    if (!fetch.ok) {
      return { ok: false, error: `git fetch 失败: ${fetch.stderr || fetch.stdout}` }
    }
  }

  const existing = resolveExistingBranch(repoPath, featureBranch)
  if (existing.ok && existing.ref) {
    // origin/xxx 用 --track -b 建本地分支（直接挂远程 ref 会 detached HEAD）；本地分支原样检出
    const add = existing.ref.startsWith("origin/")
      ? runGit(repoPath, ["worktree", "add", "--track", "-b", featureBranch, worktreePath, existing.ref])
      : runGit(repoPath, ["worktree", "add", worktreePath, existing.ref])
    if (!add.ok) {
      removeProjectWorktree(repoPath, worktreePath)
      return { ok: false, error: `挂接已有分支失败: ${add.stderr || add.stdout}` }
    }
    ensureFeatureUpstream(worktreePath, featureBranch)
    return { ok: true }
  }

  const startPoint = ensureLocalBase(repoPath, baseBranch)
  if (!startPoint.ok) return startPoint

  const add = runGit(repoPath, ["worktree", "add", "-b", featureBranch, worktreePath, startPoint.ref!])
  if (!add.ok) {
    removeProjectWorktree(repoPath, worktreePath)
    return { ok: false, error: `worktree add 失败: ${add.stderr || add.stdout}` }
  }
  ensureFeatureUpstream(worktreePath, featureBranch)
  return { ok: true }
}

/** feature 的 upstream 只允许指向 origin 同名分支：有则对齐，无则清掉（防止跟踪生产基线导致误推） */
function ensureFeatureUpstream(worktreePath: string, featureBranch: string): void {
  const remote = runGit(worktreePath, ["rev-parse", "--verify", `origin/${featureBranch}`])
  if (remote.ok) {
    runGit(worktreePath, ["branch", `--set-upstream-to=origin/${featureBranch}`, featureBranch])
  } else {
    runGit(worktreePath, ["branch", "--unset-upstream"])
  }
}

function ensureLocalBase(repoPath: string, baseBranch: string): WorktreeResult & { ref?: string } {
  const name = baseBranch.trim()
  if (!name) return { ok: false, error: "基线分支为空" }
  const local = runGit(repoPath, ["rev-parse", "--verify", name])
  if (local.ok) return { ok: true, ref: name }
  const remote = runGit(repoPath, ["rev-parse", "--verify", `origin/${name}`])
  if (!remote.ok) {
    return { ok: false, error: `找不到基线分支: ${name}（本地与 origin 均无）` }
  }
  // 建本地同名分支指向 origin/base，不设置 upstream（避免绑生产远程）
  const created = runGit(repoPath, ["branch", "--no-track", name, `origin/${name}`])
  if (!created.ok) {
    // 可能已存在竞争；再读一次
    const again = runGit(repoPath, ["rev-parse", "--verify", name])
    if (again.ok) return { ok: true, ref: name }
    return { ok: false, error: `无法创建本地基线 ${name}: ${created.stderr || created.stdout}` }
  }
  return { ok: true, ref: name }
}

function resolveExistingBranch(repoPath: string, branch: string): WorktreeResult & { ref?: string } {
  const name = branch.trim()
  if (!name) return { ok: false, error: "分支名为空" }
  const local = runGit(repoPath, ["rev-parse", "--verify", name])
  if (local.ok) return { ok: true, ref: name }
  const remote = runGit(repoPath, ["rev-parse", "--verify", `origin/${name}`])
  if (remote.ok) return { ok: true, ref: `origin/${name}` }
  return { ok: false, error: "分支不存在" }
}

export function removeProjectWorktree(repoPath: string, worktreePath: string): void {
  try {
    if (fs.existsSync(repoPath)) {
      runGit(repoPath, ["worktree", "remove", "--force", worktreePath])
    }
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(repoPath)) runGit(repoPath, ["worktree", "prune"])
  } catch { /* ignore */ }
}

export function ensureArtifactDir(worktreePath: string): string {
  const dir = path.join(worktreePath, ".cursor-claw", "artifacts")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}
