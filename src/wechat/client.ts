import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ILinkApi } from "./api.js";
import { uploadMedia, downloadMediaFromItem, getMimeFromFilename } from "./cdn.js";
import {
  MessageType, MessageState, MessageItemKind, TypingStatus, UploadMediaType,
  type WeixinMessage, type MessageItem, type GetUpdatesResp,
  type LoginResult, type DownloadResult,
} from "./types.js";

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

function generateClientId(): string {
  return `claw:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemKind.TEXT && item.text_item?.text != null) return String(item.text_item.text);
    if (item.type === MessageItemKind.VOICE && item.voice_item?.text) return item.voice_item.text;
  }
  return "";
}

export function normalizeAccountId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}

export class WeChatClient extends EventEmitter {
  readonly api: ILinkApi;
  accountId: string | undefined;
  private abortController: AbortController | undefined;
  private contextTokens = new Map<string, string>();

  constructor(opts: { token?: string; accountId?: string; baseUrl?: string; cdnBaseUrl?: string } = {}) {
    super();
    this.api = new ILinkApi({ token: opts.token, baseUrl: opts.baseUrl, cdnBaseUrl: opts.cdnBaseUrl });
    this.accountId = opts.accountId;
  }

  getAccountId(): string | undefined { return this.accountId; }
  getContextToken(userId: string): string | undefined { return this.contextTokens.get(userId); }

  // ─── Login ───

  async login(opts: {
    onQRCode?: (dataUrl: string) => void | Promise<void>;
    onStatus?: (s: string) => void;
    timeoutMs?: number;
    maxRefreshes?: number;
    botType?: string;
    signal?: AbortSignal;
  } = {}): Promise<LoginResult> {
    const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1_000);
    const maxRefreshes = opts.maxRefreshes ?? 3;
    const deadline = Date.now() + timeoutMs;
    let refreshCount = 1;
    const qr = await this.api.getQRCode(opts.botType);
    let qrcode = qr.qrcode;
    if (opts.onQRCode) await opts.onQRCode(qr.qrcode_img_content);
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) return { connected: false, message: "Login cancelled." };
      const status = await this.api.pollQRCodeStatus(qrcode);
      opts.onStatus?.(status.status);
      switch (status.status) {
        case "wait": case "scaned": break;
        case "expired": {
          refreshCount++;
          if (refreshCount > maxRefreshes) return { connected: false, message: `QR expired ${maxRefreshes} times.` };
          const r = await this.api.getQRCode(opts.botType);
          qrcode = r.qrcode;
          if (opts.onQRCode) await opts.onQRCode(r.qrcode_img_content);
          break;
        }
        case "confirmed":
          if (!status.ilink_bot_id) return { connected: false, message: "No ilink_bot_id from server." };
          this.accountId = normalizeAccountId(status.ilink_bot_id);
          if (status.bot_token) this.api.setToken(status.bot_token);
          return {
            connected: true,
            botToken: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl,
            userId: status.ilink_user_id,
            message: "Login successful!",
          };
      }
      await new Promise(r => setTimeout(r, 1_000));
    }
    return { connected: false, message: "Login timed out." };
  }

  // ─── Monitor ───

  async start(opts: {
    loadSyncBuf?: () => Promise<string | undefined>;
    saveSyncBuf?: (buf: string) => Promise<void>;
    longPollTimeoutMs?: number;
  } = {}): Promise<void> {
    if (!this.accountId) throw new Error("No accountId. Call login() first or pass it in constructor.");
    if (!this.api.getToken()) throw new Error("No token. Call login() first or pass it in constructor.");
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    let buf = (await opts.loadSyncBuf?.()) ?? "";
    let nextTimeout = opts.longPollTimeoutMs ?? 35_000;
    let fails = 0;

    while (!signal.aborted) {
      try {
        const resp = await this.api.getUpdates(buf, nextTimeout);
        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) nextTimeout = resp.longpolling_timeout_ms;
        if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
          if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
            this.emit("sessionExpired");
            await sleep(3600_000, signal);
            fails = 0;
            continue;
          }
          fails++;
          this.emit("error", new Error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`));
          await sleep(fails >= MAX_CONSECUTIVE_FAILURES ? (fails = 0, BACKOFF_DELAY_MS) : RETRY_DELAY_MS, signal);
          continue;
        }
        fails = 0;
        this.emit("poll", resp);
        if (resp.get_updates_buf) {
          buf = resp.get_updates_buf;
          await opts.saveSyncBuf?.(buf);
        }
        for (const msg of resp.msgs ?? []) {
          if (msg.context_token && msg.from_user_id) this.contextTokens.set(msg.from_user_id, msg.context_token);
          this.emit("message", msg);
        }
      } catch (err) {
        if (signal.aborted) return;
        fails++;
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        await sleep(fails >= MAX_CONSECUTIVE_FAILURES ? (fails = 0, BACKOFF_DELAY_MS) : RETRY_DELAY_MS, signal);
      }
    }
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = undefined;
  }

  // ─── Sending ───

  async sendText(to: string, text: string, contextToken?: string): Promise<string> {
    const ct = contextToken ?? this.contextTokens.get(to);
    if (!ct) throw new Error(`No context_token for user ${to}`);
    const clientId = generateClientId();
    await this.api.sendMessage({
      msg: {
        from_user_id: "", to_user_id: to, client_id: clientId,
        message_type: MessageType.BOT, message_state: MessageState.FINISH,
        item_list: text ? [{ type: MessageItemKind.TEXT, text_item: { text } }] : undefined,
        context_token: ct,
      },
    });
    return clientId;
  }

  async sendMedia(to: string, filePath: string, caption?: string, contextToken?: string): Promise<string> {
    const ct = contextToken ?? this.contextTokens.get(to);
    if (!ct) throw new Error(`No context_token for user ${to}`);
    const mime = getMimeFromFilename(filePath);
    let mediaType: typeof UploadMediaType[keyof typeof UploadMediaType];
    if (mime.startsWith("video/")) mediaType = UploadMediaType.VIDEO;
    else if (mime.startsWith("image/")) mediaType = UploadMediaType.IMAGE;
    else mediaType = UploadMediaType.FILE;

    const uploaded = await uploadMedia(this.api, filePath, to, mediaType);

    const items: MessageItem[] = [];
    if (caption) items.push({ type: MessageItemKind.TEXT, text_item: { text: caption } });

    if (mediaType === UploadMediaType.IMAGE) {
      items.push({
        type: MessageItemKind.IMAGE,
        image_item: {
          media: { encrypt_query_param: uploaded.downloadEncryptedQueryParam, aes_key: Buffer.from(uploaded.aeskey).toString("base64"), encrypt_type: 1 },
          mid_size: uploaded.fileSizeCiphertext,
        },
      });
    } else if (mediaType === UploadMediaType.VIDEO) {
      items.push({
        type: MessageItemKind.VIDEO,
        video_item: {
          media: { encrypt_query_param: uploaded.downloadEncryptedQueryParam, aes_key: Buffer.from(uploaded.aeskey).toString("base64"), encrypt_type: 1 },
          video_size: uploaded.fileSizeCiphertext,
        },
      });
    } else {
      items.push({
        type: MessageItemKind.FILE,
        file_item: {
          media: { encrypt_query_param: uploaded.downloadEncryptedQueryParam, aes_key: Buffer.from(uploaded.aeskey).toString("base64"), encrypt_type: 1 },
          file_name: path.basename(filePath),
          len: String(uploaded.fileSize),
        },
      });
    }

    let lastClientId = "";
    for (const item of items) {
      const cid = generateClientId();
      await this.api.sendMessage({
        msg: {
          from_user_id: "", to_user_id: to, client_id: cid,
          message_type: MessageType.BOT, message_state: MessageState.FINISH,
          item_list: [item], context_token: ct,
        },
      });
      lastClientId = cid;
    }
    return lastClientId;
  }

  // ─── Typing ───

  async getTypingTicket(userId: string, contextToken?: string): Promise<string> {
    const ct = contextToken ?? this.contextTokens.get(userId);
    if (!ct) return "";
    const resp = await this.api.getConfig(userId, ct);
    return resp.typing_ticket ?? "";
  }

  async sendTyping(userId: string, typingTicket: string, status: "typing" | "cancel" = "typing"): Promise<void> {
    await this.api.sendTyping({
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status: status === "typing" ? TypingStatus.TYPING : TypingStatus.CANCEL,
    });
  }

  // ─── Download ───

  async downloadMedia(item: MessageItem): Promise<DownloadResult | null> {
    return downloadMediaFromItem(item, this.api.cdnBaseUrl);
  }

  // ─── Static helpers ───

  static extractText(msg: WeixinMessage): string { return extractTextBody(msg.item_list); }
  static isMediaItem(item: MessageItem): boolean {
    return item.type === MessageItemKind.IMAGE || item.type === MessageItemKind.VIDEO
      || item.type === MessageItemKind.FILE || item.type === MessageItemKind.VOICE;
  }
}
