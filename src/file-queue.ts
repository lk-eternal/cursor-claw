import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const POLL_INTERVAL_MS = 400;
const STALE_TMP_MS = 5 * 60 * 1000;

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

export function pushToFileQueue(text: string, messageId?: string, source?: string, sessionKey?: string, skipDedup?: boolean, meta?: QueueMessageMeta): boolean {
  if (!queueDir || !text?.trim()) return false;

  const dir = getSessionDir(sessionKey);
  const ts = Date.now();
  const fileToken = messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = fileToken.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}_${safeId}.qmsg`;

  if (messageId && !skipDedup) {
    try {
      const existing = fs.readdirSync(dir);
      if (existing.some((f) => (f.endsWith(".qmsg") || f.endsWith(".claimed")) && matchesSafeId(f, safeId))) {
        return false;
      }
    } catch { /* ignore */ }
  }

  try {
    const data = JSON.stringify({
      text, messageId: messageId || "", timestamp: ts,
      source: source || `pid-${process.pid}`,
      sessionKey: sessionKey || "",
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
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

export interface QueueMessageMeta {
  chatType?: string;
  senderOpenId?: string;
  senderType?: string;
  botOpenId?: string;
  botName?: string;
  botRoster?: string;
  quotedContent?: string;
}

export interface QueueMessage {
  text: string;
  messageId: string;
  sessionKey: string;
  /** 入队时间戳（毫秒），按此升序投递；Agent 合并回复时取最大者确认整批 */
  timestamp: number;
  /** 消息上下文：会话类型、发送者、机器人身份/名册、引用原文 */
  meta?: QueueMessageMeta;
}

function fileTimestamp(file: string): number {
  const ts = parseInt(path.basename(file).split("_")[0], 10);
  return Number.isNaN(ts) ? 0 : ts;
}

/** 文件名 `${ts}_${safeId}.ext` 是否精确对应该 safeId（避免 endsWith 的后缀歧义） */
function matchesSafeId(filename: string, safeId: string): boolean {
  const base = filename.replace(/\.\w+$/, "");
  const idx = base.indexOf("_");
  return idx >= 0 && base.slice(idx + 1) === safeId;
}

function parseMessageFile(filePath: string): QueueMessage | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const meta: QueueMessageMeta = { ...(parsed.meta || {}) };
    // 兼容旧格式：顶层 chatType/senderOpenId 收进 meta
    if (parsed.chatType && !meta.chatType) meta.chatType = parsed.chatType;
    if (parsed.senderOpenId && !meta.senderOpenId) meta.senderOpenId = parsed.senderOpenId;
    return {
      text: typeof parsed.text === "string" ? parsed.text : raw,
      messageId: parsed.messageId || "",
      sessionKey: parsed.sessionKey || parsed.chatId || "",
      timestamp: parsed.timestamp || fileTimestamp(filePath),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 领取并消费下一条消息：rename 原子占用 → 读取 → 立即删除。
 * 领取即消费，不可恢复。仅用于 drain/dequeue-all（electron 本地 CLI 调度）场景；
 * poll-message 路径请用 claimSessionMessages（领取不删，靠回复确认）。
 */
export function claimNextMessage(filterSessionKey?: string): QueueMessage | null {
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
    // rename 是原子操作：并发领取时只有一个进程/请求能成功占用
    try {
      fs.renameSync(srcPath, claimedPath);
    } catch {
      continue;
    }
    const parsed = parseMessageFile(claimedPath);
    try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
    if (parsed) return parsed;
  }
  return null;
}

/** 会话目录下是否存在未确认消息（.qmsg 待投递 或 .claimed 已投递待回复确认） */
function hasPendingMessages(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".qmsg") || f.endsWith(".claimed"));
  } catch {
    return false;
  }
}

/** 指定会话待处理（待领取 + 已领取待 ack）消息条数；目录不存在或未初始化时返回 0 */
export function getSessionPendingCount(sessionKey: string): number {
  if (!queueDir || !sessionKey) return 0;
  const dir = path.join(queueDir, sanitizeSessionDir(sessionKey));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg") || f.endsWith(".claimed")).length;
  } catch {
    return 0;
  }
}

/** 指定会话待领取（仅 .qmsg）消息条数；目录不存在或未初始化时返回 0 */
export function getSessionUnclaimedCount(sessionKey: string): number {
  if (!queueDir || !sessionKey) return 0;
  const dir = path.join(queueDir, sanitizeSessionDir(sessionKey));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).length;
  } catch {
    return 0;
  }
}

/** 按 timestamp 升序返回指定会话全部待领取（.qmsg）消息 */
export function listUnclaimedMessages(sessionKey: string): QueueMessage[] {
  if (!queueDir || !sessionKey) return [];
  const dir = path.join(queueDir, sanitizeSessionDir(sessionKey));
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).sort();
  } catch {
    return [];
  }
  const items: QueueMessage[] = [];
  for (const f of files) {
    const parsed = parseMessageFile(path.join(dir, f));
    if (parsed) items.push(parsed);
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

/** 删除会话全部 .qmsg 并写入单条新消息；.claimed 不动 */
export function replaceSessionUnclaimedMessages(
  sessionKey: string,
  newText: string,
  meta?: QueueMessageMeta,
): { ok: boolean; messageId?: string; error?: string } {
  if (!queueDir || !sessionKey || !newText?.trim()) return { ok: false, error: "invalid input" };
  const dir = path.join(queueDir, sanitizeSessionDir(sessionKey));
  if (!fs.existsSync(dir)) return { ok: false, error: "session not found" };

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { ok: false, error: "read failed" };
  }

  for (const f of files) {
    if (!f.endsWith(".qmsg")) continue;
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }

  const ts = Date.now();
  const messageId = `merge_override_${ts}`;
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}_${safeId}.qmsg`;
  try {
    const data = JSON.stringify({
      text: newText.trim(),
      messageId,
      timestamp: ts,
      source: `daemon-${process.pid}`,
      sessionKey,
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    });
    const tmpPath = path.join(dir, filename + ".tmp");
    const finalPath = path.join(dir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    return { ok: true, messageId };
  } catch {
    return { ok: false, error: "write failed" };
  }
}

/**
 * 领取该会话所有未确认消息（不删除）：
 * 1. 把所有 .qmsg 改名为 .claimed（标记"已投递、待回复确认"）；
 * 2. 返回该会话全部 .claimed（含本次新投递的 + 历史未确认的），按 timestamp 升序。
 *
 * 消息只有在 Agent 通过 send-xxx 回复（ackMessages）后才删除；未确认则下次 poll 重新投递，
 * 因此幽灵连接领走也不会丢——这是"至少一次"投递的核心。
 */
export function claimSessionMessages(filterSessionKey?: string): QueueMessage[] {
  if (!queueDir) return [];
  const dir = getSessionDir(filterSessionKey);

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  for (const f of files) {
    if (!f.endsWith(".qmsg")) continue;
    const src = path.join(dir, f);
    try {
      fs.renameSync(src, src.replace(/\.qmsg$/, ".claimed"));
    } catch { /* 并发已被领取，忽略 */ }
  }

  let claimed: string[];
  try {
    claimed = fs.readdirSync(dir).filter((f) => f.endsWith(".claimed")).sort();
  } catch {
    return [];
  }

  const items: QueueMessage[] = [];
  for (const f of claimed) {
    const parsed = parseMessageFile(path.join(dir, f));
    if (parsed) items.push(parsed);
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

/**
 * 阻塞领取：有未确认消息（.qmsg 或 .claimed）立即返回；全空则挂起等待新消息。
 * timeoutMs: 0=不等待立即返回；<0=无限阻塞；>0=超时毫秒。
 */
export function waitForSessionMessages(
  timeoutMs: number,
  intervalMs = POLL_INTERVAL_MS,
  filterSessionKey?: string,
  isCancelled?: () => boolean,
): Promise<QueueMessage[]> {
  return new Promise((resolve) => {
    const dir = getSessionDir(filterSessionKey);
    if (hasPendingMessages(dir)) { resolve(claimSessionMessages(filterSessionKey)); return; }
    if (timeoutMs === 0) { resolve([]); return; }

    const infinite = timeoutMs < 0;
    const deadline = infinite ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (isCancelled?.()) { clearInterval(timer); resolve([]); return; }
      if (hasPendingMessages(dir)) { clearInterval(timer); resolve(claimSessionMessages(filterSessionKey)); return; }
      if (!infinite && Date.now() >= deadline) { clearInterval(timer); resolve([]); }
    }, intervalMs);
    timer.unref();
  });
}

/**
 * 回复确认（ack）：Agent 回复某条 message_id 即视为该消息及更早的全部已处理。
 * 删除该会话中「时间戳 ≤ 目标消息」的所有 .claimed（仅已投递的；未投递的 .qmsg 不动，
 * 防止时钟乱序误删新消息），返回被确认消息的 messageId（用于打表情）。
 * 找不到目标消息（已被确认过）返回空数组。session_key 缺省时遍历所有会话兜底。
 */
export function ackMessages(messageId: string, filterSessionKey?: string): string[] {
  if (!queueDir || !messageId) return [];
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dirs = filterSessionKey ? [getSessionDir(filterSessionKey)] : [queueDir, ...listSessionDirs()];

  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".claimed"));
    } catch {
      continue;
    }

    const target = files.find((f) => matchesSafeId(f, safeId));
    if (!target) continue;
    const cutoff = fileTimestamp(target);

    const acked: string[] = [];
    for (const f of files) {
      if (fileTimestamp(f) > cutoff) continue;
      const filePath = path.join(dir, f);
      let mid = "";
      try {
        mid = JSON.parse(fs.readFileSync(filePath, "utf-8")).messageId || "";
      } catch { /* ignore */ }
      try {
        fs.unlinkSync(filePath);
        if (mid) acked.push(mid);
      } catch { /* ignore */ }
    }
    return acked;
  }
  return [];
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
            chatType: parsed.meta?.chatType || parsed.chatType || undefined,
            timestamp: Math.round(ts),
            senderOpenId: parsed.meta?.senderOpenId || parsed.senderOpenId || undefined,
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
            map.set(key, { chatType: parsed.meta?.chatType || parsed.chatType || "p2p", senderOpenId: parsed.meta?.senderOpenId || parsed.senderOpenId || undefined });
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

/** 仅清理写入中断遗留的 .tmp 孤儿文件；.claimed 不超时删除（靠 Agent 回复确认） */
export function cleanupStaleMessages(): void {
  if (!queueDir) return;
  const now = Date.now();
  const dirs = [queueDir, ...listSessionDirs()];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".tmp")) continue;
        const filePath = path.join(dir, f);
        try {
          if (now - fs.statSync(filePath).mtimeMs > STALE_TMP_MS) {
            fs.unlinkSync(filePath);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

/**
 * 冷启动回收遗留 .claimed：全应用重启后无 live Agent，磁盘 claimed 为孤儿状态。
 * 还原为 .qmsg 以保留「至少一次」投递语义，供 orchestrator 重新领取。
 * @returns 回收条数
 */
export function cleanupOrphanClaimedOnColdStart(): number {
  if (!queueDir) return 0;
  let count = 0;
  const dirs = listSessionDirs();
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".claimed"));
      for (const f of files) {
        const src = path.join(dir, f);
        const dest = src.replace(/\.claimed$/, ".qmsg");
        try {
          if (fs.existsSync(dest)) {
            // 异常双份：删孤儿 claimed，保留已有 .qmsg
            fs.unlinkSync(src);
          } else {
            fs.renameSync(src, dest);
          }
          count++;
        } catch { /* 并发或 IO 失败，跳过 */ }
      }
    } catch { /* ignore */ }
  }
  return count;
}
