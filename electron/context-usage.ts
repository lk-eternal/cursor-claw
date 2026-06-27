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

/** Run 内累积的 token 用量（多 turn merge） */
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

type UiLogFn = (channel: string, level: string, message: string) => void

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

/** 合并单 turn usage 到 session 累积态（字段-wise 求和） */
export function mergeTurnUsage(state: ContextUsageState, usage: TurnUsageSlice): ContextUsageState {
  return {
    inputTokens: state.inputTokens + (usage.inputTokens || 0),
    outputTokens: state.outputTokens + (usage.outputTokens || 0),
    cacheReadTokens: state.cacheReadTokens + (usage.cacheReadTokens || 0),
    cacheWriteTokens: state.cacheWriteTokens + (usage.cacheWriteTokens || 0),
  }
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
    // 查表失败不阻断 send；footer 将省略
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

/** 计算已用 token 总量（含 cache 读写，与 Cursor 展示口径对齐） */
export function totalContextTokens(state: ContextUsageState): number {
  return state.inputTokens + state.outputTokens + state.cacheReadTokens + state.cacheWriteTokens
}

/** token 数格式化为 k 单位（≥1000 用 k，整数省略小数） */
export function formatTokensK(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0"
  if (tokens < 1000) return String(Math.round(tokens))
  const k = tokens / 1000
  return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`
}

/**
 * 格式化 footer；limit 或 usage 无效时返回 null（避免 NaN 或空行）。
 * 格式：`\n\n---\n上下文：{p}% ({usedK}k/{limitK}k)`
 */
export function formatContextFooter(state: ContextUsageState, limitTokens: number | null | undefined): string | null {
  if (limitTokens == null || !Number.isFinite(limitTokens) || limitTokens <= 0) return null
  const used = totalContextTokens(state)
  if (used <= 0) return null
  const percent = Math.min(100, Math.max(0, Math.round((used / limitTokens) * 100)))
  return `\n\n---\n上下文：${percent}% (${formatTokensK(used)}/${formatTokensK(limitTokens)})`
}

/** 在正文末尾安全 append footer；footer 为 null 或正文已含「上下文：」则原样返回 */
export function appendContextFooter(body: string, footer: string | null): string {
  if (!footer) return body
  if (body.includes("上下文：")) return body
  return body + footer
}

/** 生成 send 选项用的 onDelta 回调体 */
export function handleAgentSendDelta(
  session: { sessionKey: string; contextUsage: ContextUsageState },
  update: InteractionUpdate,
  log: UiLogFn,
): void {
  if (update.type === "turn-ended") {
    if (update.usage) {
      session.contextUsage = mergeTurnUsage(session.contextUsage, update.usage)
    }
    return
  }
  if (update.type === "summary-started") {
    log("SDK", "INFO", `[${session.sessionKey}] [compression] 上下文压缩开始`)
    return
  }
  if (update.type === "summary-completed") {
    log("SDK", "INFO", `[${session.sessionKey}] [compression] 上下文压缩完成`)
    return
  }
  if (update.type === "summary") {
    log("SDK", "INFO", `[${session.sessionKey}] [compression] ${update.summary}`)
  }
}

/** 为 agent.send 构造 onDelta 选项（压缩依赖 harness 默认 summarization，SDK 无 autoCompress 字段） */
export function createAgentSendOptions(
  session: { sessionKey: string; contextUsage: ContextUsageState },
  log: UiLogFn,
): { onDelta: (args: { update: InteractionUpdate }) => void } {
  return {
    onDelta: (args) => {
      try {
        handleAgentSendDelta(session, args.update, log)
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
