import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  readScheduledTasksFile,
  writeScheduledTasksFile,
  type ScheduledTask,
} from "../src/shared/scheduled-task.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-task-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "任务",
    cron: "0 9 * * *",
    content: "做点事",
    enabled: true,
    ...overrides,
  }
}

describe("readScheduledTasksFile", () => {
  it("文件不存在返回空数组", () => {
    expect(readScheduledTasksFile(path.join(dir, "none.json"))).toEqual([])
  })

  it("损坏 JSON 返回空数组", () => {
    const file = path.join(dir, "bad.json")
    fs.writeFileSync(file, "{not json", "utf-8")
    expect(readScheduledTasksFile(file)).toEqual([])
  })

  it("顶层非数组返回空数组", () => {
    const file = path.join(dir, "obj.json")
    fs.writeFileSync(file, JSON.stringify({ id: "x" }), "utf-8")
    expect(readScheduledTasksFile(file)).toEqual([])
  })

  it("过滤缺少必填字段的项", () => {
    const file = path.join(dir, "mixed.json")
    fs.writeFileSync(file, JSON.stringify([
      makeTask(),
      { id: "no-name", cron: "* * * * *", content: "x" },
      "not-an-object",
      null,
    ]), "utf-8")
    const tasks = readScheduledTasksFile(file)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("t1")
  })

  it("enabled 缺省归一化为 true，显式 false 保留", () => {
    const file = path.join(dir, "enabled.json")
    const noEnabled = { id: "a", name: "n", cron: "* * * * *", content: "c" }
    fs.writeFileSync(file, JSON.stringify([noEnabled, makeTask({ id: "b", enabled: false })]), "utf-8")
    const tasks = readScheduledTasksFile(file)
    expect(tasks.find((t) => t.id === "a")?.enabled).toBe(true)
    expect(tasks.find((t) => t.id === "b")?.enabled).toBe(false)
  })
})

describe("writeScheduledTasksFile", () => {
  it("自动创建父目录并可往返读取", () => {
    const file = path.join(dir, "nested", "deep", "tasks.json")
    const tasks = [makeTask(), makeTask({ id: "t2", channelId: "ch_x", model: "composer-2" })]
    writeScheduledTasksFile(file, tasks)
    expect(readScheduledTasksFile(file)).toEqual(tasks)
  })
})
