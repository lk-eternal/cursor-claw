/**
 * 轻量上下文轮转：高压连续命中后触发保守轮转，避免超上下文。
 */

type RotationState = {
  highPressureHits: number
  lastRotatedAt: number
}

export interface ContextRotationInput {
  sessionKey: string
  usageRatio: number
  nowMs: number
}

export interface ContextRotationDecision {
  rotated: boolean
  summary?: string
  nextCooldownMs: number
}

const stateBySession = new Map<string, RotationState>()
const ROTATION_RATIO = 0.9
const ROTATION_HITS = 2
const ROTATION_COOLDOWN_MS = 3 * 60 * 1000

/**
 * 规则（保守默认）：
 * 1) usageRatio >= 90%
 * 2) 连续命中至少 2 次
 * 3) 距上次轮转超过冷却窗口
 */
export function maybeRotateContext(input: ContextRotationInput): ContextRotationDecision {
  const state = stateBySession.get(input.sessionKey) ?? { highPressureHits: 0, lastRotatedAt: 0 }
  stateBySession.set(input.sessionKey, state)
  if (!Number.isFinite(input.usageRatio) || input.usageRatio < ROTATION_RATIO) {
    state.highPressureHits = 0
    return { rotated: false, nextCooldownMs: 0 }
  }
  state.highPressureHits += 1
  const cooldownRemain = Math.max(0, state.lastRotatedAt + ROTATION_COOLDOWN_MS - input.nowMs)
  if (cooldownRemain > 0) {
    return { rotated: false, nextCooldownMs: cooldownRemain }
  }
  if (state.highPressureHits < ROTATION_HITS) {
    return { rotated: false, nextCooldownMs: 0 }
  }
  state.highPressureHits = 0
  state.lastRotatedAt = input.nowMs
  return {
    rotated: true,
    // ponytail: 先用固定摘要模板，后续可接真实 summary 生成
    summary: "上下文压力较高，已进入新会话窗口，以下为上一轮关键约束：保持当前任务目标不变，继续按最新用户输入执行。",
    nextCooldownMs: ROTATION_COOLDOWN_MS,
  }
}

