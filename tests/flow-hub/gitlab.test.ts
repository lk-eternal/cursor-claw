import { describe, expect, it } from "vitest"
import { parseHubRepoUrl } from "../../src/shared/flow-hub-gitlab.js"

describe("parseHubRepoUrl", () => {
  it("parses full gitlab URL", () => {
    const r = parseHubRepoUrl("https://gitlab.wukongedu.net/internal-shared/cursor-claw-flow-hub")
    expect(r).toEqual({
      host: "https://gitlab.wukongedu.net",
      projectPath: "internal-shared/cursor-claw-flow-hub",
    })
  })

  it("strips trailing slash and .git", () => {
    const r = parseHubRepoUrl("https://gitlab.com/foo/bar.git/")
    expect(r?.projectPath).toBe("foo/bar")
  })

  it("returns null for invalid", () => {
    expect(parseHubRepoUrl("")).toBeNull()
    expect(parseHubRepoUrl("not-a-url")).toBeNull()
  })
})
