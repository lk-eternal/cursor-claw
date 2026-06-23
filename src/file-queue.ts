import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const POLL_INTERVAL_MS = 400;
const STALE_MESSAGE_MS = 5 * 60 * 1000;
const BATCH_WAIT_MS = 800;
const MAX_TOTAL_WAIT = 5000;

let queueDir = "";

export function initFileQueue(): string {
  const appDataDir = process.env.APP_DATA_DIR;
  if (!appDataDir) throw new Error("APP_DATA_DIR 环境变量未设置");
  queueDir = path.join(appDataDir, "file-queue");
  if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
  return queueDir;
}

export function getQueueDir(): string {
  return queueDir;
}

function sanitizeSessionDir(sessionKey: string): string {
  return crypto.createHash("md5").update(sessionKey).digest("hex").slice(0, 16);
}

function getSessionDir(sessionKey?: string): string {
  if (!sessionKey) return queueDir;
  const sub = path.join(queueDir, sanitizeSessionDir(sessionKey));
  if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
  return sub;
}

function listSessionDirs(): string[] {
  if (!queueDir) return [];
  try {
    return fs.readdirSync(queueDir)
      .filter((d) => {
        const full = path.join(queueDir, d);
        return fs.statSync(full).isDirectory();
      })
      .map((d) => path.join(queueDir, d));
  } catch { return []; }
}

export function pushToFileQueue(text: string, messageId?: string, source?: string, sessionKey?: string, chatType?: string, senderOpenId?: string, skipDedup?: boolean): boolean {
  if (!queueDir || !text?.trim()) return false;

  const dir = getSessionDir(sessionKey);
  const ts = Date.now();
  const fileToken = messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = fileToken.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}_${safeId}.qmsg`;

  if (messageId && !skipDedup) {
    try {
      const existing = fs.readdirSync(dir);
      if (existing.some((f) => {
        const base = f.replace(/\.\w+$/, "");
        return base.endsWith(`_${safeId}`);
      })) {
        return false;
      }
    } catch { /* ignore */ }
  }

  try {
    const data = JSON.stringify({
      text, messageId: messageId || "", timestamp: ts,
      source: source || `pid-${process.pid}`,
      sessionKey: sessionKey || "", chatType: chatType || "",
      senderOpenId: senderOpenId || "",
    });
    const tmpPath = path.join(dir, filename + ".tmp");
    const finalPath = path.join(dir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

export interface QueueMessage {
  text: string;
  messageId: string;
  sessionKey: string;
  chatType: string;
  senderOpenId: string;
}

export interface HeldQueueMessage extends QueueMessage {
  holdFiles: string[];
}

export function toPublicQueueMessage(held: HeldQueueMessage): QueueMessage {
  const { holdFiles: _h, ...msg } = held;
  return msg;
}

function parseHeldMessage(claimedPath: string): QueueMessage | null {
  try {
    const raw = fs.readFileSync(claimedPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      text: typeof parsed.text === "string" ? parsed.text : raw,
      messageId: parsed.messageId || "",
      sessionKey: parsed.sessionKey || parsed.chatId || "",
      chatType: parsed.chatType || "",
      senderOpenId: parsed.senderOpenId || "",
    };
  } catch {
    return null;
  }
}

function holdNextMessage(filterSessionKey?: string): HeldQueueMessage | null {
  if (!queueDir) return null;

  const dir = getSessionDir(filterSessionKey);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).sort();
  } catch {
    return null;
  }

  for (const file of files) {
    const srcPath = path.join(dir, file);
    const claimedPath = srcPath.replace(/\.qmsg$/, ".claimed");
    try {
      fs.renameSync(srcPath, claimedPath);
    } catch {
      continue;
    }

    const parsed = parseHeldMessage(claimedPath);
    if (!parsed) {
      try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
      continue;
    }

    return { ...parsed, holdFiles: [claimedPath] };
  }
  return null;
}

export function finalizeHeldMessages(holdFiles: string[]): void {
  for (const claimedPath of holdFiles) {
    const donePath = claimedPath.replace(/\.claimed$/, ".done");
    try {
      fs.renameSync(claimedPath, donePath);
    } catch {
      // 响应已发出，不可回滚为 .qmsg（会导致重复投递）；交给 cleanupStaleMessages 清理残留
      try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
    }
  }
}

export function releaseHeldMessages(holdFiles: string[]): void {
  for (const claimedPath of holdFiles) {
    const qmsgPath = claimedPath.replace(/\.claimed$/, ".qmsg");
    try {
      fs.renameSync(claimedPath, qmsgPath);
    } catch { /* ignore */ }
  }
}

/** 立即消费（dequeue-all 等场景）：hold 后马上 finalize */
export function claimNextMessage(filterSessionKey?: string): QueueMessage | null {
  const held = holdNextMessage(filterSessionKey);
  if (!held) return null;
  finalizeHeldMessages(held.holdFiles);
  return toPublicQueueMessage(held);
}

function pollFileQueueHold(
  timeoutMs: number,
  intervalMs = POLL_INTERVAL_MS,
  filterSessionKey?: string,
  isCancelled?: () => boolean,
): Promise<HeldQueueMessage | null> {
  return new Promise((resolve) => {
    const immediate = holdNextMessage(filterSessionKey);
    if (immediate !== null) { resolve(immediate); return; }

    // 0=不等待；<0=无限阻塞；>0=超时毫秒
    if (timeoutMs === 0) { resolve(null); return; }

    const infinite = timeoutMs < 0;
    const deadline = infinite ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (isCancelled?.()) { clearInterval(timer); resolve(null); return; }
      const msg = holdNextMessage(filterSessionKey);
      if (msg !== null) { clearInterval(timer); resolve(msg); return; }
      if (!infinite && Date.now() >= deadline) { clearInterval(timer); resolve(null); }
    }, intervalMs);
    timer.unref();
  });
}

export async function pollFileQueueHoldBatch(
  timeoutMs: number,
  intervalMs = POLL_INTERVAL_MS,
  filterSessionKey?: string,
  isCancelled?: () => boolean,
): Promise<HeldQueueMessage[]> {
  const first = await pollFileQueueHold(timeoutMs, intervalMs, filterSessionKey, isCancelled);
  if (first === null) return [];

  const items: HeldQueueMessage[] = [first];

  if (timeoutMs === 0) {
    let extra = holdNextMessage(filterSessionKey);
    while (extra !== null) {
      items.push(extra);
      extra = holdNextMessage(filterSessionKey);
    }
    return items;
  }

  const startTime = Date.now();
  while (Date.now() - startTime < MAX_TOTAL_WAIT) {
    if (isCancelled?.()) break;

    const maxWait = Math.min(BATCH_WAIT_MS, MAX_TOTAL_WAIT - (Date.now() - startTime));
    const nextMsg = await pollFileQueueHold(maxWait, intervalMs, filterSessionKey, isCancelled);

    if (nextMsg !== null) {
      items.push(nextMsg);
    } else {
      break;
    }
  }

  return items;
}

export function getEarliestMessageTime(filterSessionKey?: string): number | null {
  if (!queueDir) return null;
  const dir = getSessionDir(filterSessionKey);
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).sort();
    if (files.length === 0) return null;
    const file = files[0];
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw);
      return parsed.timestamp || parseInt(file.split("_")[0], 10) || null;
    } catch { return null; }
  } catch { /* ignore */ }
  return null;
}

export function getQueueLength(filterSessionKey?: string): number {
  if (!queueDir) return 0;
  if (filterSessionKey) {
    const dir = getSessionDir(filterSessionKey);
    try { return fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).length; } catch { return 0; }
  }
  try {
    let total = 0;
    for (const sub of listSessionDirs()) {
      try { total += fs.readdirSync(sub).filter((f) => f.endsWith(".qmsg")).length; } catch { /* ignore */ }
    }
    total += fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).length;
    return total;
  } catch { return 0; }
}

export interface QueueMessageView {
  index: number;
  fileId: string;
  preview: string;
  sessionKey?: string;
  chatType?: string;
  timestamp?: number;
  senderOpenId?: string;
}

export function getQueueMessages(filterSessionKey?: string): QueueMessageView[] {
  if (!queueDir) return [];
  const dirs = filterSessionKey ? [getSessionDir(filterSessionKey)] : [queueDir, ...listSessionDirs()];
  const result: QueueMessageView[] = [];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).sort();
      for (const f of files) {
        try {
          const filePath = path.join(dir, f);
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(raw);
          const ts = parsed.timestamp || fs.statSync(filePath).mtimeMs;
          result.push({
            index: result.length, fileId: f,
            preview: (parsed.text ?? "").slice(0, 200),
            sessionKey: parsed.sessionKey || parsed.chatId || undefined,
            chatType: parsed.chatType || undefined,
            timestamp: Math.round(ts),
            senderOpenId: parsed.senderOpenId || undefined,
          });
        } catch {
          result.push({ index: result.length, fileId: f, preview: "(unreadable)" });
        }
      }
    } catch { /* ignore */ }
  }
  return result;
}

export function deleteQueueMessage(fileId: string, filterSessionKey?: string): boolean {
  if (!queueDir || !fileId) return false;
  const basename = path.basename(fileId);
  if (basename !== fileId || !fileId.endsWith(".qmsg")) return false;
  const dirs = filterSessionKey ? [getSessionDir(filterSessionKey)] : [queueDir, ...listSessionDirs()];
  for (const dir of dirs) {
    try {
      const filePath = path.join(dir, basename);
      if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
    } catch { /* ignore */ }
  }
  return false;
}

export interface QueueSessionInfo {
  sessionKey: string;
  chatType: string;
  senderOpenId?: string;
}

export function getDistinctSessions(): QueueSessionInfo[] {
  if (!queueDir) return [];
  const map = new Map<string, { chatType: string; senderOpenId?: string }>();
  const dirs = [queueDir, ...listSessionDirs()];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg"));
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, f), "utf-8");
          const parsed = JSON.parse(raw);
          const key = parsed.sessionKey || parsed.chatId || "";
          if (key && !map.has(key)) {
            map.set(key, { chatType: parsed.chatType || "p2p", senderOpenId: parsed.senderOpenId || undefined });
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return [...map.entries()].map(([key, v]) => ({
    sessionKey: key,
    chatType: v.chatType,
    senderOpenId: v.senderOpenId,
  }));
}

export function cleanupStaleMessages(): void {
  if (!queueDir) return;
  const now = Date.now();
  const dirs = [queueDir, ...listSessionDirs()];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".claimed") && !f.endsWith(".tmp") && !f.endsWith(".done")) continue;
        const filePath = path.join(dir, f);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > STALE_MESSAGE_MS) {
            if (f.endsWith(".claimed")) {
              const qmsgPath = filePath.replace(/\.claimed$/, ".qmsg");
              try { fs.renameSync(filePath, qmsgPath); } catch { fs.unlinkSync(filePath); }
            } else {
              fs.unlinkSync(filePath);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}
