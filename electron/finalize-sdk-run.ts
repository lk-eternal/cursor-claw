/**
 * Run 超时类终态主动收尾：判定 + finalizer（供 agent-sdk 挂接）。
 */
import type { Run, SDKAgent } from "@cursor/sdk"
import { reportSessionAgentPhase } from "./daemon-client"
import { pushUiLog } from "./ui-logger"
import { archiveAgentFailureLogs } from "./crash-log-archiver"

/** 观测约 23min 档 Run 超时；与 agent-sdk KEEPALIVE_TIMEOUT_MS 对齐 */
const KEEPALIVE_TIMEOUT_MS = 20 * 60 * 1000

/** 平台侧 Run 长时上限观测档（约 7～8min）；与 KEEPALIVE_TIMEOUT_MS(20min) 区分 */
export const PLATFORM_RUN_LIMIT_MS = 7 * 60 * 1000

/** finalizer 所需 session 字段（避免与 agent-sdk 循环 import） */
export interface SdkSessionForFinalizer {
  sessionKey: string
  agent: SDKAgent
  run: Run | null
  abortController: AbortController
  residentMode: boolean
  runFinalizing?: boolean
  errorNotified?: boolean
  failureArchiveDone?: boolean
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

/** 取消后等待终态收敛的上限，避免 run.wait 长时间挂起。 */
const FINALIZE_WAIT_TIMEOUT_MS = 12_000

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
 * 判定是否为超时类失败（平台长时结束、保活超时 F3.2、观测 Run 20min 超时档）。
 * 短 ERROR/工具失败须返回 false；用户主动 Stop（aborted）须返回 false。
 */
export function isRunTimeoutFailure(
  session: SdkSessionForFinalizer,
  run: Run,
  lastStatus?: { status: string; message?: string },
): boolean {
  // 用户主动 Stop 不判超时
  if (session.abortController.signal.aborted) return false

  const st = (lastStatus ?? session.lastStatus)?.status?.toUpperCase()
  const message = (lastStatus ?? session.lastStatus)?.message
  const durationMs = resolveRunDurationMs(session, run)

  // 平台长时结束：非 aborted + duration≥7min + CANCELLED/ERROR/EXPIRED 或 run.status=error
  if (durationMs != null && durationMs >= PLATFORM_RUN_LIMIT_MS) {
    if (
      st === "CANCELLED" ||
      st === "ERROR" ||
      st === "EXPIRED" ||
      run.status === "error"
    ) {
      return true
    }
  }

  if (run.status !== "error") return false

  const lt = session.lastTool

  // F3.2：末次 shell 仍 running + 长 duration + 不安全 message
  const isKeepaliveTimeout =
    lt?.name === "shell" &&
    lt.status.toLowerCase() === "running" &&
    durationMs != null &&
    durationMs >= KEEPALIVE_TIMEOUT_MS &&
    isUnsafeSdkMessage(message)
  if (isKeepaliveTimeout) return true

  // 任务执行超时档：duration 达 20min 阈值且无用户可理解 message
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
 * 超时类终态主动收尾：先 notify 再 abort → 清 run → idle → 关闭 Agent 删 session。
 * 不写 failedCooldowns；幂等靠 runFinalizing + session.run 空检查。
 */
export async function finalizeSdkRunOnTimeout(
  ctx: FinalizerContext,
  session: SdkSessionForFinalizer,
  run: Run,
  trigger: string,
): Promise<boolean> {
  const sessionKey = session.sessionKey

  // 仅允许“当前活跃 run”进入收尾，避免旧 run 误删新会话。
  if (session.runFinalizing || session.run === null || session.run !== run) {
    pushUiLog(
      "SDK",
      "INFO",
      `[${sessionKey}] finalizeSdkRunOnTimeout 跳过（幂等 trigger=${trigger} finalizing=${!!session.runFinalizing} runNull=${session.run === null} runMismatch=${session.run !== null && session.run !== run}）`,
    )
    return false
  }

  session.runFinalizing = true

  try {
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

    // 先归档 + notify（abort 前，避免 aborted 闩跳过 IM）
    archiveAgentFailureLogs({
      sessionKey,
      failureType: "sdk_timeout",
      session,
      runStatus: run.status,
    })
    await ctx.notifySdkFailure(session, undefined, run)

    const waitOutcome = await cancelRunAndWait(run)
    pushUiLog("SDK", "INFO", `[${sessionKey}] finalizeSdkRunOnTimeout wait 结果: ${waitOutcome}`)
    session.abortController.abort()

    ctx.resetStreamPostChain(session)
    session.run = null
    session.pendingDispatch = false

    await reportSessionAgentPhase(sessionKey, "idle")

    // 超时路径统一关闭 Agent 并删 session（长驻重建 + 非长驻 R1 清理）
    try {
      session.agent.close()
    } catch {
      /* best-effort */
    }
    ctx.sdkSessions.delete(sessionKey)
    ctx.broadcastSdkSessionStatus()
    return true
  } finally {
    session.runFinalizing = false
  }
}

/**
 * 统一 cancel + wait 收敛逻辑：
 * - 先 best-effort cancel
 * - 再等待 run.wait 终态，超时即返回 timeout，避免重复 finalize 阻塞
 */
export async function cancelRunAndWait(run: Run, timeoutMs = FINALIZE_WAIT_TIMEOUT_MS): Promise<"completed" | "timeout" | "error"> {
  try {
    await run.cancel()
  } catch {
    // 流已结束或取消失败均不阻断 wait
  }
  return Promise.race([
    run.wait().then(() => "completed" as const).catch(() => "error" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ])
}
