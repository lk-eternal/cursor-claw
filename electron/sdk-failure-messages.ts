/**
 * SDK Run 失败用户可见文案分类器（纯函数，供 agent-sdk notify 路径调用）。
 * 优先级：超时 → 上下文已满 → 会话异常 → 可安全展示 message → 带建议兜底。
 */

/** 失败归因输入（由 agent-sdk 从 session / run 组装） */
export interface SdkFailureContext {
  status?: string
  message?: string
  errorCode?: string
  runResult?: string
  lastTool?: { name: string; status: string }
  durationMs?: number
  contextUsed?: number
  contextLimit?: number | null
  /** 由调用方传入 isRunTimeoutFailure 结果，本模块不 import finalizer */
  isTimeoutFailure: boolean
}

/** 上下文耗尽判定：peak/limit ≥ 95% */
const CONTEXT_EXHAUSTED_RATIO = 0.95

/** F3.2 保活超时阈值，与 agent-sdk / finalize-sdk-run 对齐 */
const KEEPALIVE_TIMEOUT_MS = 20 * 60 * 1000

/** message 含 context/token/limit 等模式 */
const CONTEXT_MESSAGE_PATTERNS = [
  /context/i,
  /token/i,
  /limit/i,
  /maximum/i,
  /too long/i,
  /exceed/i,
  /length/i,
  /窗口/i,
  /上下文/i,
  /超出/i,
] as const

/** errorCode 含上下文相关关键字 */
const CONTEXT_ERROR_CODE_PATTERNS = [/CONTEXT/i, /TOKEN/i, /LIMIT/i, /LENGTH/i] as const

/** 会话异常（非 EXPIRED 状态）message/errorCode 模式 */
const SESSION_ABNORMAL_PATTERNS = [/session/i, /invalid/i, /not found/i] as const

/** 与 agent-sdk isUnsafeSdkMessage 同等安全规则 */
function isUnsafeSdkMessage(msg?: string): boolean {
  const t = msg?.trim()
  return !t || /[/\\]|\.ts:|at |stack|Error:|ENOENT|spawn|EACCES|EPERM/i.test(t)
}

/** message 或 errorCode 是否指向上下文/token 类失败 */
function matchesContextExhaustion(message?: string, errorCode?: string): boolean {
  const msg = message?.trim() ?? ""
  const code = errorCode?.trim() ?? ""
  if (msg && CONTEXT_MESSAGE_PATTERNS.some((p) => p.test(msg))) return true
  if (code && CONTEXT_ERROR_CODE_PATTERNS.some((p) => p.test(code))) return true
  return false
}

/** peak≥95% limit 且处于 error 态 */
function isContextExhaustedByUsage(
  contextUsed?: number,
  contextLimit?: number | null,
  isError?: boolean,
): boolean {
  if (!isError) return false
  if (contextUsed == null || contextLimit == null || contextLimit <= 0) return false
  return contextUsed / contextLimit >= CONTEXT_EXHAUSTED_RATIO
}

/** F3.2：末次 shell 仍 running + 长 duration + 不安全 message */
function isKeepaliveTimeout(ctx: SdkFailureContext): boolean {
  const lt = ctx.lastTool
  return (
    lt?.name === "shell" &&
    lt.status.toLowerCase() === "running" &&
    ctx.durationMs != null &&
    ctx.durationMs >= KEEPALIVE_TIMEOUT_MS &&
    isUnsafeSdkMessage(ctx.message)
  )
}

/** 超时类文案（与现网 formatSdkStreamFailure F3.2 语义兼容） */
function formatTimeoutFailureMessage(ctx: SdkFailureContext): string {
  if (isKeepaliveTimeout(ctx)) {
    return "会话因等待超时已退出，请重新发送消息，我会继续为你处理。"
  }
  const msg = ctx.message?.trim()
  if (msg && !isUnsafeSdkMessage(msg)) {
    return `⚠️ Agent 处理失败：${msg}`
  }
  return "会话因等待超时已退出，请重新发送消息，我会继续为你处理。"
}

/**
 * 映射 SDK 失败为简体中文 IM 文案；禁止 stack/路径/内部 error 对象。
 */
export function formatUserSdkFailureMessage(ctx: SdkFailureContext): string {
  const st = ctx.status?.toUpperCase()

  // 超时类优先于 CANCELLED 固定句（平台长时取消展示等待超时文案）
  if (ctx.isTimeoutFailure) {
    return formatTimeoutFailureMessage(ctx)
  }

  if (st === "CANCELLED") return "Agent 任务已取消。"
  if (st === "EXPIRED") return "Agent 会话已过期，请重新发送消息。"

  const isError =
    st === "ERROR" ||
    ctx.runResult === "error" ||
    (ctx.errorCode != null && ctx.errorCode.trim() !== "")

  if (
    matchesContextExhaustion(ctx.message, ctx.errorCode) ||
    isContextExhaustedByUsage(ctx.contextUsed, ctx.contextLimit, isError)
  ) {
    return "⚠️ 上下文窗口已接近或达到上限，请精简需求或开启新话题后重新发送。"
  }

  const msg = ctx.message?.trim() ?? ""
  const code = ctx.errorCode?.trim() ?? ""
  if (SESSION_ABNORMAL_PATTERNS.some((p) => p.test(msg) || p.test(code))) {
    return "Agent 会话异常，请重新发送消息继续对话。"
  }

  if (msg && !isUnsafeSdkMessage(msg)) {
    return `⚠️ Agent 处理失败：${msg}`
  }

  // 带类别建议的兜底，禁止仅「请稍后重试」
  return "⚠️ Agent 处理失败，建议精简输入后重新发送；若仍失败请稍后重试。"
}
