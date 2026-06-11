import * as fs from "node:fs";
import * as path from "node:path";

const POLL_INTERVAL_MS = 400;
const STALE_MESSAGE_MS = 5 * 60 * 1000;
const BATCH_WAIT_MS = 800;  // 800ms 窗口期间内的文件变动视为同一批次，减少重复处理
const MAX_TOTAL_WAIT = 5000; // 最多允许拼接等待 5 秒，防止被无限拉长的图片流卡死

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

export function pushToFileQueue(text: string, messageId?: string, source?: string, sessionKey?: string, chatType?: string, senderOpenId?: string, skipDedup?: boolean): boolean {
  if (!queueDir || !text?.trim()) return false;

  const ts = Date.now();
  const fileToken = messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = fileToken.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}_${safeId}.qmsg`;

  if (messageId && !skipDedup) {
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
      text, messageId: messageId || "", timestamp: ts,
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
