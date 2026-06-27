/**
 * 上下文占用 helper：usage 合并、模型上限查表、footer 格式化。
 * 供 agent-sdk 在 onDelta / final flush 路径调用。
 */
import type { InteractionUpdate } from "@cursor/sdk"

/** turn-ended.usage 最小字段（与 SDK TurnUsageInput 对齐） */
export interface TurnUsageSlice {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** 展示用 token 用量快照（turn-ended 时 replace 为最后一轮，非 Run 内累加） */
export interface ContextUsageState {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export const ZERO_CONTEXT_USAGE: ContextUsageState = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** models.list 查表结果缓存（apiKey:modelId → limit） */
const modelLimitCache = new Map<string, number>()

/** SDK ModelListItem 未声明但运行时可能存在的上限字段（待 API 稳定后收窄） */
const LIMIT_FIELD_CANDIDATES = [
  "contextWindow",
  "contextLimit",
  "maxContextTokens",
  "maxContextLength",
] as const

/** models.list 无上限字段时，按 modelId 启发式推断（便于飞书展示百分比） */
const MODEL_LIMIT_HEURISTICS: ReadonlyArray<{ pattern: RegExp; limit: number }> = [
  { pattern: /^composer/i, limit: 200_000 },
  { pattern: /claude/i, limit: 200_000 },
  { pattern: /gpt-4/i, limit: 128_000 },
  { pattern: /gpt-5/i, limit: 272_000 },
  { pattern: /^o[13]/i, limit: 200_000 },
  { pattern: /gemini/i, limit: 1_000_000 },
]

type UiLogFn = (channel: string, level: string, message: string) => void

/** 压缩阶段回调：started 时飞书下发进度通知 */
export type CompressionNotifyFn = (phase: "started" | "completed") => void

/** 从 models.list 条目提取上下文 token 上限；无则 null */
function extractContextLimitFromModel(model: unknown): number | null {
  if (!model || typeof model !== "object") return null
  const rec = model as Record<string, unknown>
  for (const field of LIMIT_FIELD_CANDIDATES) {
    const v = rec[field]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v)
  }
  return null
}

/** modelId 启发式推断上下文上限；无匹配则 null */
function inferContextLimitFromModelId(modelId: string): number | null {
  const id = modelId.trim()
  if (!id) return null
  for (const { pattern, limit } of MODEL_LIMIT_HEURISTICS) {
    if (pattern.test(id)) return limit
  }
  return null
}

/** 合并单 turn usage 到 session 累积态（字段-wise 求和；展示态勿用，见 setTurnUsage） */
export function mergeTurnUsage(state: ContextUsageState, usage: TurnUsageSlice): ContextUsageState {
  return {
    inputTokens: state.inputTokens + (usage.inputTokens || 0),
    outputTokens: state.outputTokens + (usage.outputTokens || 0),
    cacheReadTokens: state.cacheReadTokens + (usage.cacheReadTokens || 0),
    cacheWriteTokens: state.cacheWriteTokens + (usage.cacheWriteTokens || 0),
  }
}

/** 用单 turn usage 替换展示态（当前 turn 快照，供 peak 比较） */
export function setTurnUsage(_state: ContextUsageState, usage: TurnUsageSlice): ContextUsageState {
  return {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
  }
}

/** 含 peak / Run 结束时 footer 用量的 session 展示态 */
export interface ContextUsageDisplaySession {
  contextUsage: ContextUsageState
  contextUsagePeakTokens?: number
  /** Run 结束时 SDK run.usage.totalTokens；footer 优先使用 */
  contextUsageFromRunTotal?: number
  /** 本 Run 是否已 finalize（防重复 wait / 重复日志） */
  contextUsageFinalized?: boolean
}

/** turn-ended：更新当前快照，并抬升 session 级 peak（同 Run 末轮偏低时仍反映峰值） */
export function updateContextUsageDisplay(
  session: ContextUsageDisplaySession,
  usage: TurnUsageSlice,
): void {
  session.contextUsage = setTurnUsage(session.contextUsage, usage)
  const used = totalContextTokens(session.contextUsage)
  if (used > 0) {
    session.contextUsagePeakTokens = Math.max(session.contextUsagePeakTokens ?? 0, used)
  }
}

/** 压缩完成后清除 peak，后续 turn 以压缩后用量为基准 */
export function resetContextUsagePeak(session: ContextUsageDisplaySession): void {
  session.contextUsagePeakTokens = undefined
}

/** footer 展示用量：当前 turn 与 session peak 取大 */
export function resolveDisplayContextTokens(
  state: ContextUsageState,
  peakTokens?: number,
): number {
  const current = totalContextTokens(state)
  if (peakTokens == null || peakTokens <= 0) return current
  return Math.max(current, peakTokens)
}

/** 查模型上下文上限；失败或未声明字段返回 null */
export async function resolveModelContextLimit(modelId: string, apiKey: string): Promise<number | null> {
  const id = modelId?.trim()
  const key = apiKey?.trim()
  if (!id || !key) return null

  const cacheKey = `${key}:${id}`
  const cached = modelLimitCache.get(cacheKey)
  if (cached != null) return cached

  try {
    const { Cursor } = await import("@cursor/sdk")
    const models = await Cursor.models.list({ apiKey: key })
    for (const m of models) {
      if (m.id !== id) continue
      const limit = extractContextLimitFromModel(m)
      if (limit != null) {
        modelLimitCache.set(cacheKey, limit)
        return limit
      }
    }
  } catch {
    // 查表失败不阻断 send；尝试启发式
  }
  const heuristic = inferContextLimitFromModelId(id)
  if (heuristic != null) {
    modelLimitCache.set(cacheKey, heuristic)
    return heuristic
  }
  return null
}

/** 会话 send 前解析并缓存 contextLimitTokens（已有缓存则跳过） */
export async function resolveContextLimitForSession(session: {
  modelId?: string
  apiKey?: string
  contextLimitTokens?: number
}): Promise<void> {
  if (session.contextLimitTokens != null && session.contextLimitTokens > 0) return
  const modelId = session.modelId?.trim()
  const apiKey = session.apiKey?.trim()
  if (!modelId || !apiKey) return
  const limit = await resolveModelContextLimit(modelId, apiKey)
  if (limit != null) session.contextLimitTokens = limit
}

/** 计算 prompt 侧已用 token（input + cache 读写，不含 output，反映窗口占用而非 billing） */
export function totalContextTokens(state: ContextUsageState): number {
  return state.inputTokens + state.cacheReadTokens + state.cacheWriteTokens
}

/** token 数格式化为 k 单位（≥1000 用 k，整数省略小数） */
export function formatTokensK(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0"
  if (tokens < 1000) return String(Math.round(tokens))
  const k = tokens / 1000
  return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`
}

/**
 * 格式化 footer；usage 无效时返回 null。
 * 有上限：`上下文：{p}% ({usedK}/{limitK})`；无上限：`上下文：已用 {usedK}`
 */
export function formatContextFooter(
  state: ContextUsageState,
  limitTokens: number | null | undefined,
  peakTokens?: number,
  /** Run 结束时 run.usage.totalTokens，优先于 turn-ended 推算 */
  usedOverride?: number,
): string | null {
  const used = usedOverride != null && usedOverride > 0
    ? usedOverride
    : resolveDisplayContextTokens(state, peakTokens)
  if (used <= 0) return null
  const hasLimit = limitTokens != null && Number.isFinite(limitTokens) && limitTokens > 0
  if (hasLimit) {
    const percent = Math.min(100, Math.max(0, Math.round((used / limitTokens) * 100)))
    return `\n\n---\n上下文：${percent}% (${formatTokensK(used)}/${formatTokensK(limitTokens)})`
  }
  return `\n\n---\n上下文：已用 ${formatTokensK(used)}`
}

/** 在正文末尾安全 append footer；footer 为 null 或正文已含「上下文：」则原样返回 */
export function appendContextFooter(body: string, footer: string | null): string {
  if (!footer) return body
  if (body.includes("上下文：")) return body
  return body + footer
}

/** 生成 send 选项用的 onDelta 回调体 */
export function handleAgentSendDelta(
  session: ContextUsageDisplaySession & { sessionKey: string },
  update: InteractionUpdate,
  log: UiLogFn,
  onCompression?: CompressionNotifyFn,
): void {
  if (update.type === "turn-ended") {
    if (update.usage) {
      updateContextUsageDisplay(session, update.usage)
    }
    return
  }
  if (update.type === "summary-started") {
    log("SDK", "INFO", `[${session.sessionKey}] [compression] 上下文压缩开始`)
    onCompression?.("started")
    return
  }
  if (update.type === "summary-completed") {
    log("SDK", "INFO", `[${session.sessionKey}] [compression] 上下文压缩完成`)
    resetContextUsagePeak(session)
    onCompression?.("completed")
    return
  }
  if (update.type === "summary") {
    log("SDK", "INFO", `[${session.sessionKey}] [compression] ${update.summary}`)
  }
}

/** 为 agent.send 构造 onDelta 选项（压缩依赖 harness 默认 summarization，SDK 无 autoCompress 字段） */
export function createAgentSendOptions(
  session: ContextUsageDisplaySession & { sessionKey: string },
  log: UiLogFn,
  onCompression?: CompressionNotifyFn,
): { onDelta: (args: { update: InteractionUpdate }) => void } {
  return {
    onDelta: (args) => {
      try {
        handleAgentSendDelta(session, args.update, log, onCompression)
      } catch (e: unknown) {
        log(
          "SDK",
          "WARN",
          `[${session.sessionKey}] onDelta 处理异常: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    },
  }
}
