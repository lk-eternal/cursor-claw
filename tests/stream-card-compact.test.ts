import { describe, it, expect } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

type Segment =
  | { type: "thinking"; text: string; title?: string; expanded?: boolean }
  | { type: "tools"; title?: string; expanded?: boolean; steps: Array<{ title: string; status: string; detail?: string; icon?: string }> }
  | { type: "reply"; text: string }

const mkTools = (n: number, tag: string): Segment => ({
  type: "tools",
  steps: Array.from({ length: n }, (_, i) => ({ title: `${tag}-step${i}`, status: "success", detail: `detail-${tag}-${i}` })),
})
const mkThink = (tag: string): Segment => ({ type: "thinking", text: `思考内容 ${tag} `.repeat(20) })
const mkReply = (tag: string): Segment => ({ type: "reply", text: `send_text 正文 ${tag}` })

function buildCard(segments: Segment[], showThinking = true): { json: string; count: number } {
  const card = LarkSender.buildStreamingCardJson({ status: "streaming", showThinking, segments }) as {
    body: { elements: unknown[] }
  }
  return { json: JSON.stringify(card), count: LarkSender.countCardElements(card.body.elements) }
}

describe("流式卡超限收敛（越新精度越高）", () => {
  it("不超限时原样保留：detail 不剥、无省略占位", () => {
    const { json, count } = buildCard([mkThink("s"), mkTools(5, "S"), mkReply("s")])
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(json).toContain("detail-S-4")
    expect(json).not.toContain("已省略")
  })

  it("超限时从最早段剔除；reply 全保留；最新工具块完整精度", () => {
    const segments: Segment[] = []
    for (let i = 0; i < 12; i++) {
      segments.push(mkThink(`t${i}`))
      segments.push(mkTools(8, `g${i}`))
      if (i % 4 === 1) segments.push(mkReply(`r${i}`))
    }
    segments.push(mkThink("latest"))
    segments.push(mkTools(30, "LATEST"))
    segments.push(mkReply("final"))

    const { json, count } = buildCard(segments)
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    // send_* 正文一条不丢
    for (const r of ["r1", "r5", "r9", "final"]) {
      expect(json).toContain(`send_text 正文 ${r}`)
    }
    // 最新工具块 30 步全在、detail 保留
    for (let i = 0; i < 30; i++) expect(json).toContain(`LATEST-step${i}`)
    expect(json).toContain("detail-LATEST-29")
    // 最早的段被剔除并留占位
    expect(json).not.toContain("g0-step0")
    expect(json).toContain("已省略更早的")
  })

  it("单个超大工具块兜底：从头截步、尾部保留", () => {
    const { json, count } = buildCard([mkReply("head"), mkTools(300, "BIG"), mkReply("tail")])
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(json).toContain("BIG-step299")
    expect(json).not.toContain("\"BIG-step0\"")
    expect(json).toContain("send_text 正文 head")
    expect(json).toContain("send_text 正文 tail")
  })

  it("showThinking=false 时 thinking 不渲染也不计入省略", () => {
    const segments: Segment[] = []
    for (let i = 0; i < 30; i++) {
      segments.push(mkThink(`t${i}`))
      segments.push(mkTools(8, `g${i}`))
    }
    segments.push(mkReply("final"))
    const { json, count } = buildCard(segments, false)
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(json).not.toContain("思考内容")
    expect(json).toContain("send_text 正文 final")
  })
})
