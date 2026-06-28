/**
 * Run 超时类终态主动收尾：判定 + finalizer（供 agent-sdk 挂接）。
 */
import type { Run, SDKAgent } from "@cursor/sdk"
import { reportSessionAgentPhase } from "./daemon-client"
import { pushUiLog } from "./ui-logger"

/** 观测约 23min 档 Run 超时；与 agent-sdk KEEPALIVE_TIMEOUT_MS 对齐 */
const KEEPALIVE_TIMEOUT_MS = 20 * 60 * 1000

/** finalizer 所需 session 字段（避免与 agent-sdk 循环 import） */
export interface SdkSessionForFinalizer {
  sessionKey: string
  agent: SDKAgent
  run: Run | null
  abortController: AbortController
  residentMode: boolean
  runFinalizing?: boolean
  errorNotified?: boolean
  lastStatus?: { status: string; message?: string }
  lastTool?: { name: string; status: string }
  runStartedAt?: number
  pendingDispatch: boolean
}

export interface FinalizerContext {
  sdkSessions: Map<string, SdkSessionForFinalizer>
  resetStreamPostChain: (session: SdkSessionForFinalizer) => void
  notifySdkFailure: (session: SdkSessionForFinalizer, override?: string, run?: Run | null) => Promise<void>
  broadcastSdkSessionStatus: () => void
}

function isUnsafeSdkMessage(msg?: string): boolean {
  const t = msg?.trim()
  return !t || /[/\\]|\.ts:|at |stack|Error:|ENOENT|spawn|EACCES|EPERM/i.test(t)
}

function resolveRunDurationMs(session: SdkSessionForFinalizer, run?: Run | null): number | undefined {
  const fromRun = run?.durationMs ?? session.run?.durationMs
  if (fromRun != null) return fromRun
  if (session.runStartedAt != null) return Date.now() - session.runStartedAt
  return undefined
}

/**
 * 判定是否为超时类失败（ERROR/EXPIRED、保活超时 F3.2、观测 Run 超时档）。
 * 工具失败/网络等通用 error 须返回 false。
 */
export function isRunTimeoutFailure(
  session: SdkSessionForFinalizer,
  run: Run,
  lastStatus?: { status: string; message?: string },
): boolean {
  const st = (lastStatus ?? session.lastStatus)?.status?.toUpperCase()
  if (st === "ERROR" || st === "EXPIRED") return true

  if (run.status !== "error") return false

  const message = (lastStatus ?? session.lastStatus)?.message
  const durationMs = resolveRunDurationMs(session, run)
  const lt = session.lastTool

  // F3.2：末次 shell 仍 running + 长 duration + 不安全 message
  const isKeepaliveTimeout =
    lt?.name === "shell" &&
    lt.status.toLowerCase() === "running" &&
    durationMs != null &&
    durationMs >= KEEPALIVE_TIMEOUT_MS &&
    isUnsafeSdkMessage(message)
  if (isKeepaliveTimeout) return true

  // 任务执行超时档：与 ERROR/EXPIRED 等价，duration 达阈值且无用户可理解 message
  if (
    durationMs != null &&
    durationMs >= KEEPALIVE_TIMEOUT_MS &&
    isUnsafeSdkMessage(message)
  ) {
    return true
  }

  return false
}

/**
 * 超时类终态主动收尾：cancel/abort → 清 run → notify → idle → 长驻删 session。
 * 不写 failedCooldowns；幂等靠 runFinalizing + session.run 空检查。
 */
export async function finalizeSdkRunOnTimeout(
  ctx: FinalizerContext,
  session: SdkSessionForFinalizer,
  run: Run,
  trigger: string,
): Promise<void> {
  const sessionKey = session.sessionKey

  if (session.runFinalizing || session.run === null) {
    pushUiLog(
      "SDK",
      "INFO",
      `[${sessionKey}] finalizeSdkRunOnTimeout 跳过（幂等 trigger=${trigger} finalizing=${!!session.runFinalizing} runNull=${session.run === null}）`,
    )
    return
  }

  session.runFinalizing = true

  try {
    await run.cancel()
  } catch {
    // best-effort：流可能已结束
  }
  session.abortController.abort()

  ctx.resetStreamPostChain(session)
  session.run = null
  session.pendingDispatch = false

  const durationMs = resolveRunDurationMs(session, run)
  const last = session.lastStatus
  const lt = session.lastTool
  const parts = [
    `sessionKey=${sessionKey}`,
    `trigger=${trigger}`,
    last && `lastStatus=${last.status}${last.message ? ` msg=${last.message}` : ""}`,
    durationMs != null && `durationMs=${durationMs}`,
    lt && `lastTool=${lt.name}:${lt.status}`,
    `run.status=${run.status}`,
  ].filter(Boolean)
  pushUiLog("SDK", "WARN", `[${sessionKey}] finalizeSdkRunOnTimeout 超时收尾: ${parts.join(" ")}`)

  await ctx.notifySdkFailure(session, undefined, run)
  await reportSessionAgentPhase(sessionKey, "idle")

  // 长驻模式超时：关闭 Agent 并删 session，下条消息走 launch 重建
  if (session.residentMode) {
    try {
      session.agent.close()
    } catch {
      /* best-effort */
    }
    ctx.sdkSessions.delete(sessionKey)
    ctx.broadcastSdkSessionStatus()
  }
}
