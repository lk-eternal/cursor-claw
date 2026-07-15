import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createProject,
  findBusyAction,
  getCurrentProject,
  getNodeGroups,
  getProject,
  getProjectNodes,
  initProjectStore,
  listProjects,
  projectNodeLabel,
  resolveNodeGroup,
  saveNodeGroups,
  setCurrentProjectId,
  startAction,
  updateAction,
} from "../src/shared/project-store.js"
import { DEFAULT_NODE_GROUP_ID } from "../src/shared/project-types.js"

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
      // 产出即完成：awaiting_ack（旧数据）不再算忙，可直接推进下一节点
      updateAction(p.id, r1.action.id, { status: "awaiting_ack" })
      expect(findBusyAction(getProject(p.id)!)).toBeUndefined()
      const r3 = startAction(p.id, "build")
      expect(r3.ok).toBe(true)
      if (r3.ok) {
        updateAction(p.id, r3.action.id, { status: "accepted", artifactPath: "x.md" })
        expect(startAction(p.id, "review").ok).toBe(true)
      }
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

  it("seeds default node groups without ship", () => {
    const groups = getNodeGroups()
    expect(groups.map((g) => g.id)).toEqual(["develop", "test"])
    const develop = resolveNodeGroup("develop")
    expect(develop.nodes.map((n) => n.id)).toEqual(["plan", "build", "review", "deploy", "submit-test", "analyze-bug", "fix-bug", "fill-release-doc"])
    expect(develop.workspace).toBe("worktree")
    expect(resolveNodeGroup("test").nodes).toHaveLength(7)
    expect(resolveNodeGroup("test").workspace).toBe("plain")
    expect(develop.nodes.some((n) => n.id === "ship")).toBe(false)
  })

  it("resolves nodes by project group with fallback", () => {
    expect(getProjectNodes("test").map((n) => n.id)).toContain("test-exec")
    // 未知组回落默认组
    expect(getProjectNodes("nonexistent").map((n) => n.id)).toContain("plan")
    // 跨组兜底找 label（历史 action 的节点可能在别的组）
    expect(projectNodeLabel("test-exec", "develop")).toBe("测试")
  })

  it("migrates legacy flat nodes into develop group", () => {
    fs.writeFileSync(path.join(dir, "projects", "project-nodes.json"), JSON.stringify([
      { id: "plan", label: "规划改", prompt: "自定义要求", builtin: true },
      { id: "ship", label: "交付", builtin: true },
      { id: "my-node", label: "自定义节点" },
    ]), "utf-8")
    const develop = resolveNodeGroup(DEFAULT_NODE_GROUP_ID)
    const plan = develop.nodes.find((n) => n.id === "plan")
    expect(plan?.label).toBe("规划改")
    expect(plan?.prompt).toBe("自定义要求")
    expect(develop.nodes.some((n) => n.id === "ship")).toBe(false)
    expect(develop.nodes.some((n) => n.id === "my-node")).toBe(true)
    // 迁移结果已持久化为组文件
    expect(fs.existsSync(path.join(dir, "projects", "project-node-groups.json"))).toBe(true)
  })

  it("saves and roundtrips custom groups", () => {
    saveNodeGroups([
      { id: "develop", name: "开发", nodes: [{ id: "plan", label: "规划" }] },
      { id: "qa", name: "质检", nodes: [{ id: "check", label: "检查", prompt: "查一切" }] },
    ])
    const groups = getNodeGroups()
    expect(groups).toHaveLength(2)
    expect(getProjectNodes("qa").map((n) => n.id)).toEqual(["check"])
    expect(projectNodeLabel("check", "qa")).toBe("检查")
  })

  it("stores groupId on created project", () => {
    const p = createProject({
      name: "g", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "fg", worktreePath: "/wg", groupId: "test",
    })
    expect(getProject(p.id)?.groupId).toBe("test")
  })
})
