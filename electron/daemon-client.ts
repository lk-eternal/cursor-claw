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

export async function httpGet(url: string, timeoutMs = 3000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function httpPost(url: string, body: object, timeoutMs = 3000): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json().catch(() => null)
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
