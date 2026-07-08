import { describe, it, expect } from "vitest"
import { parseWorkflowDefinitionText } from "../src/shared/workflow-parse.js"
import { normalizePrompt, normalizeWorkflowDefinition } from "../src/shared/workflow-types.js"
import type { WorkflowDefinition } from "../src/shared/workflow-types.js"

const YAML_DEF = `
id: wf_demo
name: 演示流
nodes:
  - id: n1
    name: 分析
    prompt:
      - 第一行
      - 第二行
  - id: n2
    name: 编码
    prompt: 单行提示
    maxRetries: 5
`

describe("parseWorkflowDefinitionText", () => {
  it("解析 YAML 并归一化 prompt 数组与 maxRetries 默认值", () => {
    const def = parseWorkflowDefinitionText(YAML_DEF)
    expect(def.id).toBe("wf_demo")
    expect(def.nodes).toHaveLength(2)
    expect(def.nodes[0].prompt).toBe("第一行\n第二行")
    expect(def.nodes[0].maxRetries).toBe(2)
    expect(def.nodes[1].prompt).toBe("单行提示")
    expect(def.nodes[1].maxRetries).toBe(5)
  })

  it("以 { 开头的文本自动按 JSON 解析", () => {
    const json = JSON.stringify({
      id: "wf_json", name: "J", nodes: [{ id: "a", name: "A", prompt: "p" }],
      createdAt: 0, updatedAt: 0,
    })
    const def = parseWorkflowDefinitionText(json)
    expect(def.id).toBe("wf_json")
    expect(def.nodes[0].maxRetries).toBe(2)
  })

  it("显式 format=yaml 时不误判 JSON", () => {
    const def = parseWorkflowDefinitionText(YAML_DEF, "yaml")
    expect(def.name).toBe("演示流")
  })

  it("非法 JSON 抛错", () => {
    expect(() => parseWorkflowDefinitionText("{broken", "json")).toThrow()
  })
})

describe("normalizePrompt", () => {
  it("undefined 返回空串", () => {
    expect(normalizePrompt(undefined)).toBe("")
  })

  it("数组按换行 join", () => {
    expect(normalizePrompt(["a", "b"])).toBe("a\nb")
  })

  it("字符串原样返回", () => {
    expect(normalizePrompt("x")).toBe("x")
  })
})

describe("normalizeWorkflowDefinition", () => {
  it("保留显式 maxRetries=0（不被默认值覆盖）", () => {
    const def: WorkflowDefinition = {
      id: "d", name: "n", nodes: [{ id: "a", name: "A", prompt: "p", maxRetries: 0 }],
      createdAt: 0, updatedAt: 0,
    }
    expect(normalizeWorkflowDefinition(def).nodes[0].maxRetries).toBe(0)
  })
})
