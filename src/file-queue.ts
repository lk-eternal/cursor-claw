import * as fs from "node:fs";
import * as path from "node:path";

const POLL_INTERVAL_MS = 400;
const STALE_MESSAGE_MS = 5 * 60 * 1000;
const BATCH_WAIT_MS = 800;

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

export function pushToFileQueue(text: string, messageId?: string, source?: string, sessionKey?: string, chatType?: string, senderOpenId?: string): boolean {
  if (!queueDir || !text?.trim()) return false;

  const ts = Date.now();
  const id = messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}_${safeId}.qmsg`;

  if (messageId) {
    try {
      const existing = fs.readdirSync(queueDir);
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
      text, messageId: id, timestamp: ts,
      source: source || `pid-${process.pid}`,
      sessionKey: sessionKey || "", chatType: chatType || "",
      senderOpenId: senderOpenId || "",
    });
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
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

export function claimNextMessage(filterSessionKey?: string): QueueMessage | null {
  if (!queueDir) return null;

  let files: string[];
  try {
    files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).sort();
  } catch {
    return null;
  }

  for (const file of files) {
    const srcPath = path.join(queueDir, file);

    if (filterSessionKey) {
      try {
        const raw = fs.readFileSync(srcPath, "utf-8");
        const parsed = JSON.parse(raw);
        if ((parsed.sessionKey || parsed.chatId || "") !== filterSessionKey) continue;
      } catch { continue; }
    }

    const claimedPath = srcPath.replace(/\.qmsg$/, ".claimed");
    try {
      fs.renameSync(srcPath, claimedPath);
    } catch {
      continue;
    }
    try {
      const raw = fs.readFileSync(claimedPath, "utf-8");
      const donePath = claimedPath.replace(/\.claimed$/, ".done");
      try { fs.renameSync(claimedPath, donePath); } catch { try { fs.unlinkSync(claimedPath); } catch { /* ignore */ } }
      const parsed = JSON.parse(raw);
      return {
        text: typeof parsed.text === "string" ? parsed.text : raw,
        messageId: parsed.messageId || "",
        sessionKey: parsed.sessionKey || parsed.chatId || "",
        chatType: parsed.chatType || "",
        senderOpenId: parsed.senderOpenId || "",
      };
    } catch {
      try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
      continue;
    }
  }
  return null;
}

function pollFileQueue(timeoutMs: number, intervalMs = POLL_INTERVAL_MS, filterSessionKey?: string): Promise<QueueMessage | null> {
  return new Promise((resolve) => {
    const immediate = claimNextMessage(filterSessionKey);
    if (immediate !== null) { resolve(immediate); return; }

    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const msg = claimNextMessage(filterSessionKey);
      if (msg !== null) { clearInterval(timer); resolve(msg); return; }
      if (Date.now() >= deadline) { clearInterval(timer); resolve(null); }
    }, intervalMs);
    timer.unref();
  });
}

export async function pollFileQueueBatch(timeoutMs: number, intervalMs = POLL_INTERVAL_MS, filterSessionKey?: string): Promise<QueueMessage | null> {
  const first = await pollFileQueue(timeoutMs, intervalMs, filterSessionKey);
  if (first === null) return null;

  const parts = [first.text];
  let extra = claimNextMessage(filterSessionKey);

  while (extra !== null){
    while (extra !== null) {
      parts.push(extra.text);
      extra = claimNextMessage(filterSessionKey);
    }

    await new Promise((r) => setTimeout(r, BATCH_WAIT_MS));

    extra = claimNextMessage(filterSessionKey);
  }

  return { text: parts.join("\n"), messageId: first.messageId, sessionKey: first.sessionKey, chatType: first.chatType, senderOpenId: first.senderOpenId };
}

export function getEarliestMessageTime(filterSessionKey?: string): number | null {
  if (!queueDir) return null;
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).sort();
    for (const file of files) {
      const filePath = path.join(queueDir, file);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (filterSessionKey && (parsed.sessionKey || parsed.chatId || "") !== filterSessionKey) continue;
        return parsed.timestamp || parseInt(file.split("_")[0], 10) || null;
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return null;
}

export function getQueueLength(): number {
  if (!queueDir) return 0;
  try {
    return fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).length;
  } catch {
    return 0;
  }
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

export function getQueueMessages(): QueueMessageView[] {
  if (!queueDir) return [];
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).sort();
    return files.map((f, i) => {
      try {
        const filePath = path.join(queueDir, f);
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        const ts = parsed.timestamp || fs.statSync(filePath).mtimeMs;
        return {
          index: i, fileId: f,
          preview: (parsed.text ?? "").slice(0, 200),
          sessionKey: parsed.sessionKey || parsed.chatId || undefined,
          chatType: parsed.chatType || undefined,
          timestamp: Math.round(ts),
          senderOpenId: parsed.senderOpenId || undefined,
        };
      } catch {
        return { index: i, fileId: f, preview: "(unreadable)" };
      }
    });
  } catch {
    return [];
  }
}

export function deleteQueueMessage(fileId: string): boolean {
  if (!queueDir || !fileId) return false;
  const basename = path.basename(fileId);
  if (basename !== fileId || !fileId.endsWith(".qmsg")) return false;
  try {
    const filePath = path.join(queueDir, basename);
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
    return false;
  } catch {
    return false;
  }
}

export interface QueueSessionInfo {
  sessionKey: string;
  chatType: string;
  senderOpenId?: string;
}

export function getDistinctSessions(): QueueSessionInfo[] {
  if (!queueDir) return [];
  const map = new Map<string, { chatType: string; senderOpenId?: string }>();
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        const key = parsed.sessionKey || parsed.chatId || "";
        if (key && !map.has(key)) {
          map.set(key, { chatType: parsed.chatType || "p2p", senderOpenId: parsed.senderOpenId || undefined });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return [...map.entries()].map(([key, v]) => ({
    sessionKey: key,
    chatType: v.chatType,
    senderOpenId: v.senderOpenId,
  }));
}

export function cleanupStaleMessages(): void {
  if (!queueDir) return;
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(queueDir)) {
      if (!f.endsWith(".claimed") && !f.endsWith(".tmp") && !f.endsWith(".done")) continue;
      const filePath = path.join(queueDir, f);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > STALE_MESSAGE_MS) fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
