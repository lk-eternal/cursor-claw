import { describe, it, expect } from "vitest"
import { buildDashboardTree, classifySessionGroup } from "../src/shared/dashboard-tree.js"

describe("classifySessionGroup", () => {
  it("maps project_ key to project", () => {
    expect(classifySessionGroup("ch_x|ou_y::project_abc", "project")).toBe("project")
  })
  it("maps temp/task to task", () => {
    expect(classifySessionGroup("temp_123", "temp")).toBe("task")
    expect(classifySessionGroup("task-id", "task")).toBe("task")
  })
  it("maps group to group", () => {
    expect(classifySessionGroup("ch_x|oc_g::D:\\ws", "group")).toBe("group")
  })
  it("maps non-main p2p to other_p2p", () => {
    expect(classifySessionGroup("ch_x|ou_other::D:\\ws", "p2p", { mainChatId: "ch_x|ou_main" })).toBe("other_p2p")
  })
  it("maps main p2p to main", () => {
    expect(classifySessionGroup("ch_x|ou_main::D:\\ws", "p2p", { mainChatId: "ch_x|ou_main" })).toBe("main")
  })
})

describe("buildDashboardTree", () => {
  it("main group keeps idle switchable sessions; other groups only running", () => {
    const tree = buildDashboardTree({
      channels: [{ id: "c1", name: "飞书", connected: true, mainUserChatId: "ch|ou_main" }],
      running: [
        { sessionKey: "ch|ou_main::D:\\a", chatType: "p2p", model: "grok-4.5", label: "a" },
        { sessionKey: "ch|ou_other::D:\\b", chatType: "p2p", model: "composer-2.5", label: "b" },
      ],
      mainSwitchable: [
        { channelId: "c1", sessionKey: "ch|ou_main::D:\\idle", label: "idle-dir", kind: "dir" },
      ],
      activeKeyByChat: { "ch|ou_main": "ch|ou_main::D:\\a" },
      queue: [],
    })
    const ch = tree.channels[0]
    expect(ch.groups.main.sessions.map((s) => s.sessionKey)).toEqual([
      "ch|ou_main::D:\\a",
      "ch|ou_main::D:\\idle",
    ])
    expect(ch.groups.main.sessions[0].current).toBe(true)
    expect(ch.groups.other_p2p.sessions).toHaveLength(1)
    expect(ch.groups.group.sessions).toHaveLength(0)
  })

  it("attaches queue items to matching session", () => {
    const tree = buildDashboardTree({
      channels: [{ id: "c1", name: "飞书", connected: true, mainUserChatId: "ch|ou_main" }],
      running: [{ sessionKey: "ch|ou_main::D:\\a", chatType: "p2p", label: "a" }],
      mainSwitchable: [],
      activeKeyByChat: {},
      queue: [
        { sessionKey: "ch|ou_main::D:\\a", fileId: "f1", preview: "hi", status: "pending" },
        { sessionKey: "other", fileId: "f2", preview: "x", status: "pending" },
      ],
    })
    expect(tree.channels[0].groups.main.sessions[0].queue).toEqual([
      { fileId: "f1", preview: "hi", status: "pending" },
    ])
  })
})
