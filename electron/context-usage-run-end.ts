/**
 * Run 结束时从 SDK run.usage 解析 footer 用量，并与 turn-ended 快照对照打日志。
 */
import type { TokenUsage } from "@cursor/sdk"
import type {
  ContextUsageDisplaySession,
  ContextUsageState,
} from "./context-usage"
import {
  resolveDisplayContextTokens,
  totalContextTokens,
} from "./context-usage"

type UiLogFn = (channel: string, level: string, message: string) => void

/** SDK TokenUsage → 展示态（字段对齐 turn-ended） */
export function contextUsageFromTokenUsage(usage: TokenUsage | null | undefined): ContextUsageState | null {
  if (!usage) return null
  return {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
  }
}

/** Run 结束：对照 turn-ended 快照与 run.usage，footer 以 run.usage 为准 */
export function finalizeContextUsageAtRunEnd(
  session: ContextUsageDisplaySession & { sessionKey: string },
  runUsage: TokenUsage | undefined,
  log: UiLogFn,
): void {
  if (session.contextUsageFinalized) return

  const turnEnded = { ...session.contextUsage }
  const turnPeak = session.contextUsagePeakTokens
  const turnDisplay = resolveDisplayContextTokens(turnEnded, turnPeak)

  const runState = contextUsageFromTokenUsage(runUsage)
  const runPrompt = runState ? totalContextTokens(runState) : 0
  const runTotal = runUsage?.totalTokens ?? 0

  const runPart = runUsage && runState
    ? `in=${runState.inputTokens} out=${runState.outputTokens} cacheR=${runState.cacheReadTokens} cacheW=${runState.cacheWriteTokens} totalTokens=${runTotal} promptSum=${runPrompt}`
    : "absent"
  log(
    "SDK",
    "INFO",
    `[${session.sessionKey}] [context-usage] turn-ended: in=${turnEnded.inputTokens} out=${turnEnded.outputTokens} cacheR=${turnEnded.cacheReadTokens} cacheW=${turnEnded.cacheWriteTokens} display=${turnDisplay}${turnPeak != null ? ` peak=${turnPeak}` : ""} | run.usage: ${runPart}`,
  )

  session.contextUsageFromRunTotal = undefined
  if (runState && runTotal > 0) {
    session.contextUsage = runState
    session.contextUsageFromRunTotal = runTotal
    if (runPrompt > 0) {
      session.contextUsagePeakTokens = Math.max(session.contextUsagePeakTokens ?? 0, runPrompt)
    }
  } else if (runState && runPrompt > 0) {
    session.contextUsage = runState
    session.contextUsagePeakTokens = Math.max(session.contextUsagePeakTokens ?? 0, runPrompt)
  }

  session.contextUsageFinalized = true
}
