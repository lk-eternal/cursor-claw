import { describe, expect, it } from "vitest"
import { resolveSyncStatus } from "../../src/shared/flow-hub-sync.js"

describe("resolveSyncStatus", () => {
  it("returns missing without hubId", () => {
    expect(resolveSyncStatus(undefined, "h")).toBe("missing")
  })

  it("returns synced when hash matches", () => {
    expect(resolveSyncStatus({ hubId: "g1", hubContentHash: "same" }, "same")).toBe("synced")
  })

  it("returns local_modified when localRevision > 0 and hash differs", () => {
    expect(resolveSyncStatus({
      hubId: "g1",
      hubContentHash: "local",
      localRevision: 1,
    }, "remote")).toBe("local_modified")
  })

  it("returns outdated when revision behind", () => {
    expect(resolveSyncStatus({
      hubId: "g1",
      hubContentHash: "old",
      hubRevision: 1,
    }, "new", 2)).toBe("outdated")
  })
})
