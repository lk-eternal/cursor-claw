/**
 * 调度重试策略：仅对可恢复错误做退避重试，busy 单独延后重排。
 */

export interface RetryDecision {
  retryable: boolean
  delayMs: number
  reason: string
  isBusy: boolean
}

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /temporarily/i,
  /temporary/i,
  /rate limit/i,
  /429/,
  /econnreset/i,
  /eai_again/i,
  /network/i,
] as const

const BUSY_PATTERNS = [/agent busy/i, /busy/i] as const
const BASE_BACKOFF_MS = [600, 1200, 2400] as const

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** 仅 retryable 错误才进入退避；busy 路径交给 daemon 延后重排。 */
export function shouldRetry(err: unknown, attempt: number): RetryDecision {
  const msg = normalizeErrorMessage(err).trim()
  const isBusy = BUSY_PATTERNS.some((p) => p.test(msg))
  if (isBusy) {
    return { retryable: false, delayMs: 1500, reason: "agent_busy", isBusy: true }
  }
  const retryable = RETRYABLE_PATTERNS.some((p) => p.test(msg))
  if (!retryable) {
    return { retryable: false, delayMs: 0, reason: "non_retryable", isBusy: false }
  }
  const idx = Math.max(0, Math.min(BASE_BACKOFF_MS.length - 1, attempt - 1))
  return { retryable: true, delayMs: BASE_BACKOFF_MS[idx], reason: "retryable_error", isBusy: false }
}

/** 重试/轮转共用幂等键，避免重复 run。 */
export function buildIdempotencyKey(sessionKey: string, lastInboundId: string, attempt: number): string {
  return `${sessionKey}::${lastInboundId || "no-inbound"}::${attempt}`
}

