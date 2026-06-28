/**
 * Agent 失败时将 UI logBuffer 片段归档到用户配置的崩溃分析目录。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { getConfig } from "./config-store"
import { getLogBuffer, pushUiLog } from "./ui-logger"

/** 失败类型（写入 meta.json.failureType） */
export type FailureArchiveType =
  | "sdk_run_error"
  | "sdk_stream_exception"
  | "sdk_timeout"
  | "sdk_cancelled"
  | "dispatch_failed"

export interface FailureArchiveContext {
  sessionKey: string
  failureType: FailureArchiveType
  /** 幂等：同一 SdkSession 单次失败只归档一次 */
  session?: { failureArchiveDone?: boolean }
  agentId?: string
  runStatus?: string
  detail?: string
}

const ANCHOR_MARKER = "[crash-archive-trigger]"
const CONTEXT_LINES = 30
/** 未配置目录 WARN 节流（同进程） */
let lastUnconfiguredWarnAt = 0
const UNCONFIGURED_WARN_INTERVAL_MS = 60_000

/** 上海时区 14 位目录名 yyyymmddhhmmss */
function shanghaiDirTimestamp(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date())
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  return `${g("year")}${g("month")}${g("day")}${g("hour")}${g("minute")}${g("second")}`
}

/** 上海时区 ISO 8601（meta.archivedAt） */
function shanghaiIsoTimestamp(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date())
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}+08:00`
}

/** 根目录下解析唯一事件子目录名（同秒冲突追加 -001） */
function resolveUniqueDirName(root: string, baseName: string): string {
  if (!fs.existsSync(path.join(root, baseName))) return baseName
  for (let n = 1; n <= 999; n++) {
    const candidate = `${baseName}-${String(n).padStart(3, "0")}`
    if (!fs.existsSync(path.join(root, candidate))) return candidate
  }
  // 极端情况：追加毫秒后缀避免覆盖
  return `${baseName}-${Date.now()}`
}

/** 从 buffer 截取锚点 ±30 行 */
function extractSnapshot(buffer: string[]): {
  lines: string[]
  anchorIndex: number
  linesBefore: number
  linesAfter: number
  truncatedBefore: boolean
  truncatedAfter: boolean
} {
  let anchorIndex = -1
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].includes(ANCHOR_MARKER)) {
      anchorIndex = i
      break
    }
  }
  // 找不到锚点时取 buffer 末尾，保证仍有输出
  if (anchorIndex < 0) anchorIndex = Math.max(0, buffer.length - 1)

  const start = Math.max(0, anchorIndex - CONTEXT_LINES)
  const end = Math.min(buffer.length - 1, anchorIndex + CONTEXT_LINES)
  return {
    lines: buffer.slice(start, end + 1),
    anchorIndex,
    linesBefore: anchorIndex - start,
    linesAfter: end - anchorIndex,
    truncatedBefore: start > 0,
    truncatedAfter: end < buffer.length - 1,
  }
}

/**
 * 同步 best-effort 归档；内部 catch，不向外抛。
 */
export function archiveAgentFailureLogs(ctx: FailureArchiveContext): void {
  try {
    if (ctx.session?.failureArchiveDone === true) return

    const root = getConfig().crashAnalysisDir.trim()
    if (!root) {
      const now = Date.now()
      if (now - lastUnconfiguredWarnAt >= UNCONFIGURED_WARN_INTERVAL_MS) {
        lastUnconfiguredWarnAt = now
        pushUiLog("Electron", "WARN", "未配置崩溃分析目录，跳过归档")
      }
      return
    }

    // 先写入触发行，再从 buffer 定位锚点
    pushUiLog(
      "Electron",
      "WARN",
      `${ANCHOR_MARKER} failureType=${ctx.failureType} sessionKey=${ctx.sessionKey}`,
    )

    const buffer = getLogBuffer()
    const snap = extractSnapshot(buffer)
    const baseName = shanghaiDirTimestamp()
    const directoryName = resolveUniqueDirName(root, baseName)
    const eventDir = path.join(root, directoryName)

    fs.mkdirSync(eventDir, { recursive: true })
    fs.writeFileSync(
      path.join(eventDir, "electron-log.txt"),
      snap.lines.join("\n") + (snap.lines.length > 0 ? "\n" : ""),
      "utf-8",
    )

    const meta: Record<string, unknown> = {
      sessionKey: ctx.sessionKey,
      failureType: ctx.failureType,
      archivedAt: shanghaiIsoTimestamp(),
      directoryName,
      anchorMarker: ANCHOR_MARKER,
      buffer: {
        totalInSnapshot: snap.lines.length,
        anchorIndex: snap.anchorIndex,
        linesBefore: snap.linesBefore,
        linesAfter: snap.linesAfter,
        truncatedBefore: snap.truncatedBefore,
        truncatedAfter: snap.truncatedAfter,
      },
    }
    if (ctx.agentId) meta.agentId = ctx.agentId
    if (ctx.runStatus) meta.runStatus = ctx.runStatus
    if (ctx.detail) meta.detail = ctx.detail

    fs.writeFileSync(
      path.join(eventDir, "meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf-8",
    )

    if (ctx.session) ctx.session.failureArchiveDone = true
    pushUiLog("Electron", "INFO", `[crash-archive] 已归档至 ${eventDir}`)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    pushUiLog("Electron", "WARN", `[crash-archive] 归档失败: ${msg}`)
  }
}
