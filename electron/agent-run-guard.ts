import { randomUUID } from "node:crypto"

type GuardState = {
  token: string
  acquiredAt: number
  completed: boolean
}

export interface RunGuardAcquireResult {
  token: string
  acquired: boolean
  holder?: string
}

export interface WatchRunGuardInput {
  sessionKey: string
  token: string
  timeoutMs: number
  tickMs: number
  onTimeout?: () => Promise<void> | void
  onTick?: () => Promise<"completed" | "cancelled" | void> | "completed" | "cancelled" | void
}

const guardBySession = new Map<string, GuardState>()

/**
 * 同 session 严格单飞：仅一个 token 可持有执行权。
 */
export function acquireRunGuard(sessionKey: string): RunGuardAcquireResult {
  const existing = guardBySession.get(sessionKey)
  const token = randomUUID()
  if (existing && !existing.completed) {
    return { token, acquired: false, holder: existing.token }
  }
  guardBySession.set(sessionKey, { token, acquiredAt: Date.now(), completed: false })
  return { token, acquired: true }
}

/**
 * 幂等释放：token 不匹配或已释放均静默。
 */
export function releaseRunGuard(sessionKey: string, token: string): void {
  const state = guardBySession.get(sessionKey)
  if (!state || state.token !== token) return
  guardBySession.delete(sessionKey)
}

/**
 * 标记完成后 watchdog 将收敛为 completed。
 */
export function completeRunGuard(sessionKey: string, token: string): void {
  const state = guardBySession.get(sessionKey)
  if (!state || state.token !== token) return
  state.completed = true
}

/**
 * watchdog：统一超时判定入口，超时回调交由调用方执行 cancel/finalize。
 */
export async function watchRunGuard(input: WatchRunGuardInput): Promise<"completed" | "timeout" | "cancelled"> {
  const tick = Math.max(200, input.tickMs)
  const startedAt = Date.now()
  while (true) {
    const state = guardBySession.get(input.sessionKey)
    if (!state || state.token !== input.token) return "cancelled"
    if (state.completed) return "completed"
    const phase = await input.onTick?.()
    if (phase === "completed" || phase === "cancelled") return phase
    if (Date.now() - startedAt >= input.timeoutMs) {
      await input.onTimeout?.()
      return "timeout"
    }
    await new Promise((resolve) => setTimeout(resolve, tick))
  }
}

/** 调试辅助：返回当前持有时长（ms），无持有返回 null。 */
export function getRunGuardHeldMs(sessionKey: string): number | null {
  const state = guardBySession.get(sessionKey)
  if (!state) return null
  return Math.max(0, Date.now() - state.acquiredAt)
}

