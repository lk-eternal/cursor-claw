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

export function isGitRepoRoot(repoPath: string): boolean {
  if (!repoPath || !fs.existsSync(repoPath)) return false
  const r = runGit(repoPath, ["rev-parse", "--is-inside-work-tree"])
  if (!r.ok || r.stdout !== "true") return false
  const top = runGit(repoPath, ["rev-parse", "--show-toplevel"])
  if (!top.ok) return false
  return path.resolve(top.stdout) === path.resolve(repoPath)
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

  const startPoint = resolveStartPoint(repoPath, baseBranch)
  if (!startPoint.ok) return startPoint

  const add = runGit(repoPath, ["worktree", "add", "-b", featureBranch, worktreePath, startPoint.ref!])
  if (!add.ok) {
    removeProjectWorktree(repoPath, worktreePath)
    return { ok: false, error: `worktree add 失败: ${add.stderr || add.stdout}` }
  }
  return { ok: true }
}

function resolveStartPoint(repoPath: string, baseBranch: string): WorktreeResult & { ref?: string } {
  const remote = runGit(repoPath, ["rev-parse", "--verify", `origin/${baseBranch}`])
  if (remote.ok) return { ok: true, ref: `origin/${baseBranch}` }
  const local = runGit(repoPath, ["rev-parse", "--verify", baseBranch])
  if (local.ok) return { ok: true, ref: baseBranch }
  return { ok: false, error: `找不到基线分支: ${baseBranch}（本地与 origin 均无）` }
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
