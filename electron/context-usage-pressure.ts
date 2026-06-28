/**
 * 上下文压力评估：send 前与 turn-ended 高水位 `[compression]` 日志（只读，不阻断 send）。
 */

type UiLogFn = (channel: string, level: string, message: string) => void

/** turn-ended / pre-send 高水位阈值（占 contextLimit 比例） */
export const HIGH_WATERMARK_RATIO = 0.85

function formatUsagePercent(ratio: number): string {
  const pct = Math.round(ratio * 1000) / 10
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1)
}

function readRatio(used: number, limit: number | null | undefined): number | null {
  if (limit == null || limit <= 0) return null
  return used / limit
}

function logCompressionIfHigh(
  sessionKey: string,
  log: UiLogFn,
  label: "pre-send usage" | "high-watermark",
  ratio: number,
  threshold: number,
): void {
  if (ratio >= threshold) log("SDK", "INFO", `[${sessionKey}] [compression] ${label} ${formatUsagePercent(ratio)}%`)
}

/** send 前只读压力评估；ratio ≥ 阈值写 `[compression] pre-send usage`，不阻断 send */
export function evaluatePreSendContextPressureCore(
  sessionKey: string,
  used: number,
  limit: number | null | undefined,
  log: UiLogFn,
  options?: { highWatermarkRatio?: number },
): { ratio: number | null; used: number; limit: number | null } {
  const resolvedLimit = limit ?? null
  const ratio = readRatio(used, resolvedLimit)
  const threshold = options?.highWatermarkRatio ?? HIGH_WATERMARK_RATIO
  if (ratio != null) logCompressionIfHigh(sessionKey, log, "pre-send usage", ratio, threshold)
  return { ratio, used, limit: resolvedLimit }
}

/** turn-ended 后高水位 `[compression] high-watermark` 日志 */
export function logTurnEndedHighWatermark(
  sessionKey: string,
  used: number,
  limit: number | null | undefined,
  log: UiLogFn,
): void {
  const ratio = readRatio(used, limit)
  if (ratio != null) logCompressionIfHigh(sessionKey, log, "high-watermark", ratio, HIGH_WATERMARK_RATIO)
}
