import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { getEnabledChannels } from "./config-store"
import { makeChatKey } from "../src/shared/channel-types"

export interface LockInfo { pid: number; port: number; version: string }

export function getLockFilePath(): string {
  return path.join(app.getPath("userData"), LOCK_FILE_NAME)
}

export function readLockFile(): LockInfo | null {
  try {
    const lockPath = getLockFilePath()
    if (!fs.existsSync(lockPath)) return null
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"))
  } catch {
    return null
  }
}

export function httpGet(url: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: string[] = []
      res.on("data", (c: Buffer) => chunks.push(c.toString()))
      res.on("end", () => {
        try { resolve(JSON.parse(chunks.join(""))) } catch { reject(new Error("Invalid JSON")) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
  })
}

export function httpPost(url: string, body: object, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: string[] = []
      res.on("data", (c: Buffer) => chunks.push(c.toString()))
      res.on("end", () => { try { resolve(JSON.parse(chunks.join(""))) } catch { resolve(null) } })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.end(data)
  })
}

export async function syncActiveSession(port: number, chatId: string, sessionKey: string): Promise<void> {
  try {
    await httpPost(`http://127.0.0.1:${port}/api/active-session`, { chatId, sessionKey })
  } catch {}
}

export async function getCurrentActiveSession(port: number, chatId: string): Promise<string | undefined> {
  try {
    const res = (await httpGet(`http://127.0.0.1:${port}/api/active-sessions`)) as { sessions?: Record<string, string> }
    return res?.sessions?.[chatId]
  } catch { return undefined }
}

export async function drainSessionMessages(port: number, sessionKey: string): Promise<number> {
  try {
    const res = (await httpPost(`http://127.0.0.1:${port}/dequeue-all`, { sessionKey })) as { messages?: unknown[] }
    return res?.messages?.length ?? 0
  } catch { return 0 }
}

export async function resolveMainChatId(port: number, preferredChatId?: string, channelId?: string): Promise<string | undefined> {
  const preferred = preferredChatId?.trim()
  if (preferred) {
    return preferred
  }
  const candidates = getEnabledChannels().filter((c) => !channelId || c.id === channelId)
  for (const c of candidates) {
    if (c.mainUserEnabled && c.mainUserChatId?.trim()) {
      return makeChatKey(c.id, c.mainUserChatId.trim())
    }
  }
  try {
    const res = (await httpGet(`http://127.0.0.1:${port}/api/active-sessions`)) as { sessions?: Record<string, string> }
    const keys = Object.keys(res?.sessions ?? {})
    return keys[0] || undefined
  } catch {
    return undefined
  }
}

export async function enqueueToMainSession(
  port: number, content: string, preferredChatId?: string, channelId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const chatId = await resolveMainChatId(port, preferredChatId, channelId)
  if (!chatId) {
    return { ok: false, error: "未绑定主用户且无活跃会话，无法入队" }
  }
  try {
    await httpPost(`http://127.0.0.1:${port}/enqueue`, { content, chatId, chatType: "p2p" })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function reportSessionAgentPhase(
  sessionKey: string,
  phase: "starting" | "processing" | "idle",
): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port || !sessionKey) return
  try {
    await httpPost(`http://127.0.0.1:${lock.port}/api/session-agent-phase`, {
      session_key: sessionKey,
      phase,
    }, 5000)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[Phase] 上报失败 (${sessionKey}/${phase}): ${msg}`)
  }
}
