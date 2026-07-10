import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addProjectWorktree, isGitRepoRoot, removeProjectWorktree } from "../electron/project-worktree.js"

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "git failed")
}

describe("project-worktree", () => {
  let root: string
  let repo: string
  let wtRoot: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-wt-"))
    repo = path.join(root, "repo")
    wtRoot = path.join(root, "trees")
    fs.mkdirSync(repo)
    fs.mkdirSync(wtRoot)
    git(repo, ["init"])
    git(repo, ["config", "user.email", "t@t.com"])
    git(repo, ["config", "user.name", "t"])
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-m", "init"])
    git(repo, ["branch", "-M", "main"])
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("detects git root", () => {
    expect(isGitRepoRoot(repo)).toBe(true)
    expect(isGitRepoRoot(wtRoot)).toBe(false)
  })

  it("adds worktree and rolls back path on conflict", () => {
    const wt = path.join(wtRoot, "feat-a")
    const r = addProjectWorktree({
      repoPath: repo,
      worktreePath: wt,
      featureBranch: "feature/a",
      baseBranch: "main",
      fetch: false,
    })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
    const r2 = addProjectWorktree({
      repoPath: repo,
      worktreePath: wt,
      featureBranch: "feature/b",
      baseBranch: "main",
      fetch: false,
    })
    expect(r2.ok).toBe(false)
    removeProjectWorktree(repo, wt)
    expect(fs.existsSync(wt)).toBe(false)
  })
})
