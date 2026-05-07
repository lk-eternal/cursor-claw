import { Agent, type SDKAgent, type Run, type SDKMessage } from "@cursor/sdk"
import { resolve, join, dirname } from "node:path"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import http2 from "node:http2"
import net from "node:net"
import tls from "node:tls"
import { EventEmitter } from "node:events"
import { getConfig } from "./config-store"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import { type ChatType, type LaunchMeta, buildPrompt } from "./agent-launcher"

interface SdkSessionAgent {
  sessionKey: string
  agent: SDKAgent
  run: Run | null
  agentId: string
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  workspaceDir?: string
  senderOpenId?: string
  chatName?: string
  abortController: AbortController
}

const sdkSessions = new Map<string, SdkSessionAgent>()
const pendingLaunches = new Set<string>()
const failedCooldowns = new Map<string, number>()
const FAIL_COOLDOWN_MS = 30_000

function ensureSdkBinaryPaths(): void {
  if (process.env.CURSOR_RIPGREP_PATH) return

  const platformPkg = `@cursor/sdk-${process.platform}-${process.arch}`
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg"

  const candidates: string[] = []
  try {
    const req = createRequire(import.meta.url)
    const pkgDir = dirname(req.resolve(`${platformPkg}/package.json`))
    candidates.push(join(pkgDir, "bin", binaryName))
  } catch { /* package not resolvable */ }

  // fallback: walk up from app dir
  const appDir = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath)
  for (const base of [appDir, resolve(".")]) {
    candidates.push(join(base, "node_modules", platformPkg, "bin", binaryName))
    candidates.push(join(base, "resources", "node_modules", platformPkg, "bin", binaryName))
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      process.env.CURSOR_RIPGREP_PATH = p
      pushUiLog("SDK", "INFO", `Ripgrep 路径: ${p}`)
      return
    }
  }
  pushUiLog("SDK", "WARN", `未找到 ${binaryName}，SDK 可能报错 (searched: ${candidates.join(", ")})`)
}

// ── HTTP/2 代理 (monkey-patch http2.connect) ─────────────────────────

let h2ProxyInstalled = false
const origH2Connect = http2.connect

function buildTunnel(proxyHost: string, proxyPort: number, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf("\r\n\r\n")
      if (idx === -1) return
      sock.removeListener("data", onData)
      const line = buf.subarray(0, idx).toString().split("\r\n")[0]
      const code = parseInt(line.split(" ")[1], 10)
      if (code !== 200) { sock.destroy(); return reject(new Error(`CONNECT ${code}: ${line}`)) }
      const leftover = buf.subarray(idx + 4)
      if (leftover.length) sock.unshift(leftover)
      resolve(sock)
    }
    sock.on("data", onData)
    sock.on("error", reject)
  })
}

function upgradeTls(rawSock: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({ socket: rawSock, servername: host, ALPNProtocols: ["h2"] })
    tlsSock.on("secureConnect", () => resolve(tlsSock))
    tlsSock.on("error", reject)
  })
}

class LazyH2Session extends EventEmitter {
  _real: http2.ClientHttp2Session | null = null
  _err: Error | null = null
  _closed = false
  _pending: { args: unknown[]; resolve: (s: http2.ClientHttp2Stream) => void }[] = []

  constructor(authority: string | URL, options: http2.ClientSessionOptions | undefined, listener: (() => void) | undefined) {
    super()
    this._bootstrap(authority, options, listener)
  }

  private async _bootstrap(authority: string | URL, options: http2.ClientSessionOptions | undefined, listener: (() => void) | undefined) {
    const proxyEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ""
    const target = new URL(String(authority))
    const targetHost = target.hostname
    const targetPort = parseInt(target.port, 10) || 443
    const proxy = new URL(proxyEnv.startsWith("http") ? proxyEnv : `http://${proxyEnv}`)
    const proxyHost = proxy.hostname
    const proxyPort = parseInt(proxy.port, 10) || 1080

    try {
      pushUiLog("SDK", "DEBUG", `[h2-proxy] ${targetHost}:${targetPort} via ${proxyHost}:${proxyPort}`)
      const rawSock = await buildTunnel(proxyHost, proxyPort, targetHost, targetPort)
      const tlsSock = await upgradeTls(rawSock, targetHost)
      pushUiLog("SDK", "DEBUG", `[h2-proxy] tunnel+TLS OK, ALPN=${tlsSock.alpnProtocol}`)

      if (this._closed) { tlsSock.destroy(); return }

      const opts = Object.assign({}, options ?? {})
      ;(opts as any).createConnection = () => tlsSock

      const real = origH2Connect.call(http2, authority, opts, listener)
      this._real = real

      for (const ev of ["connect", "error", "close", "goaway", "ping", "stream", "timeout", "frameError"] as const) {
        real.on(ev, (...args: unknown[]) => this.emit(ev, ...args))
      }

      for (const { args, resolve: res } of this._pending) {
        res((real.request as (...a: unknown[]) => http2.ClientHttp2Stream)(...args))
      }
      this._pending = []
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err))
      pushUiLog("SDK", "ERROR", `[h2-proxy] failed: ${e.message}`)
      this._err = e
      this.emit("error", e)
    }
  }

  request(...args: unknown[]): http2.ClientHttp2Stream | EventEmitter {
    if (this._real) return (this._real.request as (...a: unknown[]) => http2.ClientHttp2Stream)(...args)
    if (this._err) throw this._err

    let res!: (s: http2.ClientHttp2Stream) => void
    const p = new Promise<http2.ClientHttp2Stream>((r) => { res = r })
    this._pending.push({ args, resolve: res })

    const ph = new EventEmitter() as EventEmitter & Record<string, (...a: unknown[]) => void>
    ph.end = () => {}; ph.write = () => {}; ph.close = () => {}
    ph.destroy = () => {}; ph.setTimeout = () => {}

    p.then((real) => {
      for (const ev of ["response", "data", "end", "error", "trailers", "close"] as const) {
        real.on(ev, (...a: unknown[]) => ph.emit(ev, ...a))
      }
    })
    return ph
  }

  close(...args: unknown[]) { this._closed = true; if (this._real) (this._real.close as Function)(...args) }
  destroy(...args: unknown[]) { this._closed = true; if (this._real) (this._real.destroy as Function)(...args) }
  get closed() { return this._real ? this._real.closed : this._closed }
  get destroyed() { return this._real ? this._real.destroyed : this._closed }
  get encrypted() { return true }
  get alpnProtocol() { return "h2" }
  get socket() { return this._real?.socket ?? null }
  ping(...a: unknown[]) { if (this._real) (this._real.ping as Function)(...a) }
  settings(...a: unknown[]) { if (this._real) (this._real.settings as Function)(...a) }
  setTimeout(...a: unknown[]) { if (this._real) (this._real.setTimeout as Function)(...a); return this }
  ref() { this._real?.ref(); return this }
  unref() { this._real?.unref(); return this }
}

function installH2Proxy(): void {
  if (h2ProxyInstalled) return
  h2ProxyInstalled = true

  ;(http2 as any).connect = function proxiedH2Connect(
    authority: string | URL,
    options?: http2.ClientSessionOptions | http2.SecureClientSessionOptions,
    listener?: () => void,
  ) {
    const proxyEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ""
    const s = String(authority)
    pushUiLog("SDK", "DEBUG", `[h2-proxy] connect called: authority=${s} proxyEnv=${proxyEnv ? "set" : "empty"}`)
    if (!proxyEnv) return origH2Connect.call(http2, authority, options as any, listener)
    return new LazyH2Session(authority, options as http2.ClientSessionOptions, listener) as unknown as http2.ClientHttp2Session
  }

  pushUiLog("SDK", "INFO", "HTTP/2 代理 patch 已安装")
}

function broadcastSdkSessionStatus(): void {
  const list = [...sdkSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    pid: 0,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType as string,
    chatName: s.chatName,
    workspaceDir: s.workspaceDir,
  }))
  broadcastSessionStatus(list)
}

// prompt 由 agent-launcher.buildPrompt 统一构建

async function streamRunEvents(session: SdkSessionAgent, run: Run): Promise<void> {
  try {
    for await (const event of run.stream()) {
      if (session.abortController.signal.aborted) break
      session.lastActivityAt = Date.now()
      handleSdkEvent(session.sessionKey, event)
    }
  } catch (e: unknown) {
    if (!session.abortController.signal.aborted) {
      const msg = e instanceof Error ? `[${e.constructor.name}] ${e.message}` : String(e)
      const stack = e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : ""
      const cause = (e as any)?.cause ? JSON.stringify((e as any).cause) : ""
      pushUiLog("SDK", "ERROR", `[${session.sessionKey}] 流处理异常: ${msg}${stack ? ` stack=${stack}` : ""}${cause ? ` cause=${cause}` : ""}`)
    }
  }
}

function handleSdkEvent(sessionKey: string, event: SDKMessage): void {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text.trim()) {
          pushUiLog("SDK", "INFO", `[${sessionKey}] ${block.text.slice(0, 200)}`)
        }
      }
      break
    case "thinking":
      if (event.text.trim()) {
        pushUiLog("SDK", "DEBUG", `[${sessionKey}] [thinking] ${event.text.slice(0, 120)}`)
      }
      break
    case "tool_call":
      pushUiLog("SDK", "INFO", `[${sessionKey}] [tool] ${event.name}: ${event.status}`)
      break
    case "status": {
      const lvl = event.status === "ERROR" ? "ERROR" as const : "INFO" as const
      pushUiLog("SDK", lvl, `[${sessionKey}] [status] ${event.status}${event.message ? ` - ${event.message}` : ""} raw=${JSON.stringify(event)}`)
    }
      break
  }
}

// ── 公开 API ────────────────────────────────────────

export function isSdkSessionRunning(sessionKey: string): boolean {
  const s = sdkSessions.get(sessionKey)
  return s !== undefined && !s.abortController.signal.aborted
}

export function getSdkSessionCount(): number {
  let count = 0
  for (const s of sdkSessions.values()) {
    if (!s.abortController.signal.aborted) count++
  }
  return count
}

export function getSdkSessionList() {
  return [...sdkSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    agentId: s.agentId,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType,
    workspaceDir: s.workspaceDir,
    senderOpenId: s.senderOpenId,
    chatName: s.chatName,
  }))
}

export interface SdkLaunchOptions {
  sessionKey: string
  chatType: ChatType
  meta?: LaunchMeta
  workspaceDir: string
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
}

export async function launchSdkAgent(opts: SdkLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, workspaceDir, senderOpenId, chatName, taskMessage } = opts

  if (isSdkSessionRunning(sessionKey) || pendingLaunches.has(sessionKey)) {
    const s = sdkSessions.get(sessionKey)
    if (s) s.lastActivityAt = Date.now()
    return { ok: true }
  }

  const cooldownUntil = failedCooldowns.get(sessionKey)
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return { ok: false, error: `冷却中，${Math.ceil((cooldownUntil - Date.now()) / 1000)}s 后可重试` }
  }
  failedCooldowns.delete(sessionKey)

  pendingLaunches.add(sessionKey)

  const config = getConfig()
  const apiKey = config.cursorApiKey?.trim()
  if (!apiKey) {
    return { ok: false, error: "Cursor API Key 未配置（设置 → Agent 驱动模式）" }
  }

  const prompt = buildPrompt(meta, taskMessage)

  try {
    ensureSdkBinaryPaths()

    const proxyUrl = config.httpProxy?.trim() || config.httpsProxy?.trim()
    if (proxyUrl) {
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      if (config.noProxy?.trim()) process.env.NO_PROXY = config.noProxy.trim()
    }
    const effectiveProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ""
    if (effectiveProxy) installH2Proxy()

    const modelId = config.model?.trim() || "composer-2"
    const modelSelection: { id: string; params?: { id: string; value: string }[] } = { id: modelId }
    if (config.modelParams?.trim()) {
      try {
        modelSelection.params = JSON.parse(config.modelParams)
      } catch { /* ignore bad JSON */ }
    }
    pushUiLog("SDK", "INFO", `[${sessionKey}] 正在创建 SDK Agent (cwd=${workspaceDir}, model=${JSON.stringify(modelSelection)}${proxyUrl ? `, proxy=${proxyUrl}` : ""})`)

    const agent = await Agent.create({
      apiKey,
      model: modelSelection,
      local: {
        cwd: workspaceDir,
        settingSources: ["project", "user"],
        sandboxOptions: { enabled: false },
      },
    })

    const abortController = new AbortController()
    const session: SdkSessionAgent = {
      sessionKey,
      agent,
      run: null,
      agentId: agent.agentId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      chatType,
      workspaceDir,
      senderOpenId,
      chatName,
      abortController,
    }

    sdkSessions.set(sessionKey, session)
    pendingLaunches.delete(sessionKey)
    broadcastLog(`[SDK] 会话 ${sessionKey} 已创建, agentId=${agent.agentId}`)
    broadcastSdkSessionStatus()

    const run = await agent.send(prompt)
    session.run = run

    streamRunEvents(session, run).then(async () => {
      const level = run.status === "error" ? "ERROR" : "INFO"
      const parts: string[] = []
      if (run.result) parts.push(`result=${run.result}`)
      if (run.durationMs != null) parts.push(`duration=${run.durationMs}ms`)
      if (run.model) parts.push(`model=${JSON.stringify(run.model)}`)
      try {
        const wr = await run.wait().catch((e: unknown) => e)
        if (wr instanceof Error) {
          const errObj = wr as any
          parts.push(`waitError=[${wr.constructor.name}] ${wr.message}`)
          for (const k of ["code", "status", "endpoint", "requestId", "operation", "isRetryable"]) {
            if (errObj[k] !== undefined) parts.push(`${k}=${errObj[k]}`)
          }
          if (errObj.cause) parts.push(`cause=${JSON.stringify(errObj.cause)}`)
        } else if (typeof wr === "object" && wr) {
          const r = wr as Record<string, unknown>
          if (r.status) parts.push(`waitStatus=${r.status}`)
          parts.push(`waitRaw=${JSON.stringify(wr)}`)
        }
      } catch (we: unknown) {
        const errObj = we as any
        const wm = we instanceof Error ? `[${we.constructor.name}] ${we.message}` : String(we)
        parts.push(`waitCatchError=${wm}`)
        for (const k of ["code", "status", "endpoint", "requestId", "operation"]) {
          if (errObj?.[k] !== undefined) parts.push(`${k}=${errObj[k]}`)
        }
      }
      if (run.status === "error") {
        try {
          if (run.supports("conversation")) {
            const turns = await run.conversation()
            if (turns.length > 0) {
              const last = turns[turns.length - 1]
              parts.push(`lastTurn=${JSON.stringify(last).slice(0, 500)}`)
            }
          }
        } catch { /* ignore */ }
      }
      pushUiLog("SDK", level, `[${sessionKey}] Agent 运行结束 (status=${run.status}) ${parts.join(", ")}`)
      if (run.status === "error") {
        failedCooldowns.set(sessionKey, Date.now() + FAIL_COOLDOWN_MS)
        pushUiLog("SDK", "WARN", `[${sessionKey}] 错误后冷却 ${FAIL_COOLDOWN_MS / 1000}s，防止立即重试`)
      }
      sdkSessions.delete(sessionKey)
      broadcastSdkSessionStatus()
    })

    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[SDK] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    failedCooldowns.set(sessionKey, Date.now() + FAIL_COOLDOWN_MS)
    pendingLaunches.delete(sessionKey)
    sdkSessions.delete(sessionKey)
    broadcastSdkSessionStatus()
    return { ok: false, error: msg }
  }
}

export function stopSdkSession(sessionKey: string): void {
  const s = sdkSessions.get(sessionKey)
  if (!s) return
  s.abortController.abort()
  if (s.run) {
    s.run.cancel().catch(() => {})
  }
  s.agent.close()
  sdkSessions.delete(sessionKey)
  broadcastSdkSessionStatus()
}

export function stopAllSdkSessions(): void {
  for (const key of [...sdkSessions.keys()]) {
    stopSdkSession(key)
  }
}

export async function checkSdkApiKey(): Promise<{ ok: boolean; email?: string; error?: string }> {
  const config = getConfig()
  const apiKey = config.cursorApiKey?.trim()
  if (!apiKey) return { ok: false, error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const me = await Cursor.me({ apiKey })
    return { ok: true, email: me.userEmail }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export interface SdkModelOption {
  id: string
  label: string
  params: string
  current: boolean
}

export async function listSdkModels(): Promise<{ ok: boolean; models: SdkModelOption[]; error?: string }> {
  const config = getConfig()
  const apiKey = config.cursorApiKey?.trim()
  if (!apiKey) return { ok: false, models: [], error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const sdkModels = await Cursor.models.list({ apiKey })
    const currentModel = config.model?.trim() || ""
    const currentParams = config.modelParams?.trim() || ""

    const models: SdkModelOption[] = []
    for (const m of sdkModels) {
      if (m.variants && m.variants.length > 0) {
        const nameCount = new Map<string, number>()
        for (const v of m.variants) nameCount.set(v.displayName, (nameCount.get(v.displayName) || 0) + 1)

        for (const v of m.variants) {
          const ps = JSON.stringify(v.params)
          const hasDup = (nameCount.get(v.displayName) || 0) > 1
          const suffix = hasDup ? ` (${v.params.map((p) => `${p.id}=${p.value}`).join(", ")})` : ""
          models.push({
            id: m.id,
            label: (v.displayName || m.displayName) + suffix,
            params: ps,
            current: m.id === currentModel && ps === currentParams,
          })
        }
      } else {
        models.push({
          id: m.id,
          label: m.displayName || m.id,
          params: "",
          current: m.id === currentModel && !currentParams,
        })
      }
    }
    return { ok: true, models }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, models: [], error: msg }
  }
}
