import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createProject,
  findBusyAction,
  getCurrentProject,
  getProject,
  initProjectStore,
  listProjects,
  setCurrentProjectId,
  startAction,
  updateAction,
} from "../src/shared/project-store.js"

describe("project-store", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-proj-"))
    initProjectStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates project and sets current", () => {
    const p = createProject({
      name: "login",
      goal: "add login",
      repoPath: "D:/repos/foo",
      baseBranch: "main",
      featureBranch: "feature/login",
      worktreePath: "D:/claw/login",
    })
    expect(p.id).toBeTruthy()
    expect(getCurrentProject()?.id).toBe(p.id)
    expect(listProjects()).toHaveLength(1)
  })

  it("enforces action mutex", () => {
    const p = createProject({
      name: "a",
      goal: "g",
      repoPath: "/r",
      baseBranch: "main",
      featureBranch: "f",
      worktreePath: "/w",
    })
    const r1 = startAction(p.id, "plan")
    expect(r1.ok).toBe(true)
    const r2 = startAction(p.id, "build")
    expect(r2.ok).toBe(false)
    if (r1.ok) {
      updateAction(p.id, r1.action.id, { status: "awaiting_ack" })
      expect(findBusyAction(getProject(p.id)!)?.status).toBe("awaiting_ack")
      expect(startAction(p.id, "build").ok).toBe(false)
      updateAction(p.id, r1.action.id, { status: "accepted", artifactPath: "x.md" })
      expect(startAction(p.id, "build").ok).toBe(true)
    }
  })

  it("switches current project", () => {
    const a = createProject({
      name: "a", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "fa", worktreePath: "/wa",
    })
    const b = createProject({
      name: "b", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "fb", worktreePath: "/wb",
    })
    expect(getCurrentProject()?.id).toBe(b.id)
    setCurrentProjectId(a.id)
    expect(getCurrentProject()?.id).toBe(a.id)
  })
})
