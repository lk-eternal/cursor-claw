import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { randomUUID } from "node:crypto"
import type { WorkflowDefinition, WorkflowInstance } from "../src/shared/workflow-types.js"

// workflow-store 在模块加载时固化 APP_DATA_DIR，必须先设 env 再动态导入
let dataDir: string
let engine: typeof import("../src/workflow-engine.js")
let store: typeof import("../src/workflow-store.js")

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-wf-"))
  process.env.APP_DATA_DIR = dataDir
  engine = await import("../src/workflow-engine.js")
  store = await import("../src/workflow-store.js")
})

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function makeDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  const now = Date.now()
  const def: WorkflowDefinition = {
    id: `wf_${randomUUID().slice(0, 8)}`,
    name: "测试流",
    nodes: [
      { id: "n1", name: "分析", prompt: "分析需求", maxRetries: 2 },
      { id: "n2", name: "编码", prompt: "写代码", maxRetries: 1 },
      { id: "n3", name: "审查", prompt: "检查产出", maxRetries: 2 },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  store.saveDefinition(def)
  return def
}

function startFresh(defOverrides: Partial<WorkflowDefinition> = {}, maxSteps?: number): { def: WorkflowDefinition; inst: WorkflowInstance } {
  const def = makeDef(defOverrides)
  const inst = engine.createInstance(def, { input: "初始输入", maxSteps })
  return { def, inst }
}

describe("createInstance / startWorkflow", () => {
  it("创建实例并启动第一个节点", () => {
    const { inst } = startFresh()
    expect(inst.status).toBe("pending")

    const r = engine.startWorkflow(inst.id)
    expect(r.failed).toBeUndefined()
    expect(r.node?.id).toBe("n1")
    expect(r.prompt).toContain("分析需求")
    expect(r.prompt).toContain("初始输入")

    const saved = store.getInstance(inst.id)!
    expect(saved.status).toBe("running")
    expect(saved.currentNodeId).toBe("n1")
    expect(saved.nodeHistory).toHaveLength(1)
    expect(saved.nodeHistory[0]).toMatchObject({ nodeId: "n1", attempt: 1, status: "running" })
  })

  it("实例不存在返回 failed", () => {
    expect(engine.startWorkflow("ghost").failed).toBe(true)
  })

  it("isolated 节点透传标记", () => {
    const { inst } = startFresh({
      nodes: [{ id: "n1", name: "独立", prompt: "p", maxRetries: 2, isolated: true }],
    })
    expect(engine.startWorkflow(inst.id).isolated).toBe(true)
  })
})

describe("handleNext", () => {
  it("提交产物后推进到下一节点", () => {
    const { inst } = startFresh()
    engine.startWorkflow(inst.id)

    const r = engine.handleNext(inst.id, { output: "分析结果" })
    expect(r.node?.id).toBe("n2")
    expect(r.prompt).toContain("分析结果")

    const saved = store.getInstance(inst.id)!
    expect(saved.context.n1).toBe("分析结果")
    expect(saved.currentNodeId).toBe("n2")
    expect(saved.stepCount).toBe(1)
    expect(saved.nodeHistory.find((h) => h.nodeId === "n1")?.status).toBe("completed")
  })

  it("最后一个节点提交后工作流完成", () => {
    const { inst } = startFresh()
    engine.startWorkflow(inst.id)
    engine.handleNext(inst.id, { output: "1" })
    engine.handleNext(inst.id, { output: "2" })
    const r = engine.handleNext(inst.id, { output: "3" })

    expect(r.done).toBe(true)
    const saved = store.getInstance(inst.id)!
    expect(saved.status).toBe("completed")
    expect(saved.currentNodeId).toBeNull()
    expect(saved.completedAt).toBeGreaterThan(0)
  })

  it("非运行状态拒绝提交", () => {
    const { inst } = startFresh()
    expect(engine.handleNext(inst.id, { output: "x" }).failed).toBe(true)
  })

  it("达到 maxSteps 熔断为 failed", () => {
    const { inst } = startFresh({}, 1)
    engine.startWorkflow(inst.id)
    const r = engine.handleNext(inst.id, { output: "1" })
    expect(r.failed).toBe(true)
    expect(store.getInstance(inst.id)!.status).toBe("failed")
  })
})

describe("handleReject", () => {
  function advanceTo(instId: string, outputs: string[]): void {
    engine.startWorkflow(instId)
    for (const o of outputs) engine.handleNext(instId, { output: o })
  }

  it("默认回退到上一节点，attempt 递增", () => {
    const { inst } = startFresh()
    advanceTo(inst.id, ["分析ok"])

    const r = engine.handleReject(inst.id, { reason: "不合格" })
    expect(r.node?.id).toBe("n1")
    expect(r.prompt).toContain("不合格")

    const saved = store.getInstance(inst.id)!
    expect(saved.currentNodeId).toBe("n1")
    const latest = saved.nodeHistory[saved.nodeHistory.length - 1]
    expect(latest).toMatchObject({ nodeId: "n1", attempt: 2, rejectFromNodeId: "n2" })
    expect(saved.nodeHistory.find((h) => h.nodeId === "n2")?.status).toBe("rejected")
  })

  it("可指定回退到更早的节点", () => {
    const { inst } = startFresh()
    advanceTo(inst.id, ["1", "2"])

    const r = engine.handleReject(inst.id, { reason: "从头返工", targetNodeId: "n1" })
    expect(r.node?.id).toBe("n1")
  })

  it("回退目标必须在当前节点之前", () => {
    const { inst } = startFresh()
    advanceTo(inst.id, ["1"])

    expect(engine.handleReject(inst.id, { reason: "r", targetNodeId: "n2" }).failed).toBe(true)
    expect(engine.handleReject(inst.id, { reason: "r", targetNodeId: "n3" }).failed).toBe(true)
  })

  it("第一个节点无法回退", () => {
    const { inst } = startFresh()
    engine.startWorkflow(inst.id)
    const r = engine.handleReject(inst.id, { reason: "r" })
    expect(r.failed).toBe(true)
    expect(r.message).toContain("第一个节点")
  })

  it("超过目标节点 maxRetries 时工作流终止", () => {
    const { inst } = startFresh({
      nodes: [
        { id: "n1", name: "做", prompt: "p1", maxRetries: 1 },
        { id: "n2", name: "审", prompt: "p2", maxRetries: 2 },
      ],
    })
    advanceTo(inst.id, ["v1"])

    expect(engine.handleReject(inst.id, { reason: "第一次驳回" }).failed).toBeUndefined()
    engine.handleNext(inst.id, { output: "v2" })
    const r = engine.handleReject(inst.id, { reason: "第二次驳回" })
    expect(r.failed).toBe(true)
    expect(r.message).toContain("最大重试次数")
    expect(store.getInstance(inst.id)!.status).toBe("failed")
  })
})

describe("recoverStaleInstances / resumeWorkflow", () => {
  it("running 实例恢复为 paused，可 resume 继续", () => {
    const { inst } = startFresh()
    engine.startWorkflow(inst.id)

    const recovered = engine.recoverStaleInstances()
    expect(recovered.map((i) => i.id)).toContain(inst.id)
    expect(store.getInstance(inst.id)!.status).toBe("paused")

    const r = engine.resumeWorkflow(inst.id)
    expect(r.failed).toBeUndefined()
    expect(r.node?.id).toBe("n1")
    expect(store.getInstance(inst.id)!.status).toBe("running")
  })

  it("非 paused 实例不可 resume", () => {
    const { inst } = startFresh()
    expect(engine.resumeWorkflow(inst.id).failed).toBe(true)
  })
})
