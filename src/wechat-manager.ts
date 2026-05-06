import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WeChatClient, normalizeAccountId } from "./wechat/index.js";
import type { WeixinMessage, MessageItem } from "./wechat/index.js";

export interface WeChatIncomingMessage {
  text: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  senderName?: string;
}

export interface WeChatManagerOptions {
  dataDir: string;
  log: (level: string, ...args: unknown[]) => void;
  onMessage: (msg: WeChatIncomingMessage) => void;
  onQrCode?: (dataUrl: string) => void;
  onStatusChange?: (status: WeChatStatus) => void;
}

export type WeChatStatus = "disconnected" | "qr_pending" | "logging_in" | "connected" | "error";

export class WeChatManager extends EventEmitter {
  private client: WeChatClient | null = null;
  private status: WeChatStatus = "disconnected";
  private syncBufPath: string;
  private ctxTokensPath: string;
  private opts: WeChatManagerOptions;
  private selfAccountId = "";
  private recentMsgHashes = new Set<string>();
  private typingTickets = new Map<string, string>();
  private static readonly DEDUP_WINDOW = 60_000;

  constructor(opts: WeChatManagerOptions) {
    super();
    this.opts = opts;
    this.syncBufPath = path.join(opts.dataDir, "wechat-sync.txt");
    this.ctxTokensPath = path.join(opts.dataDir, "wechat-ctx-tokens.json");
    if (!fs.existsSync(opts.dataDir)) fs.mkdirSync(opts.dataDir, { recursive: true });
  }

  getStatus(): WeChatStatus {
    return this.status;
  }

  private setStatus(s: WeChatStatus): void {
    this.opts.log("INFO", `[WeChat] status: ${this.status} -> ${s}`);
    this.status = s;
    this.opts.onStatusChange?.(s);
  }

  async start(token?: string, accountId?: string): Promise<void> {
    if (this.client) await this.stop();

    if (!token) {
      this.opts.log("ERROR", "[WeChat] token 未提供，无法启动");
      this.setStatus("error");
      return;
    }

    const resolvedAccountId = accountId ? normalizeAccountId(accountId) : undefined;

    this.client = new WeChatClient({
      token,
      accountId: resolvedAccountId,
    });

    this.client.on("message", (msg: WeixinMessage) => this.handleMessage(msg));
    this.client.on("error", (err: Error) => {
      this.opts.log("ERROR", `[WeChat] 错误: ${err.message}`);
      this.setStatus("error");
    });
    this.client.on("sessionExpired", () => {
      this.opts.log("WARN", "[WeChat] 会话已过期，需要重新登录");
      this.setStatus("disconnected");
    });

    const loadSyncBuf = async (): Promise<string | undefined> => {
      try {
        if (fs.existsSync(this.syncBufPath)) return fs.readFileSync(this.syncBufPath, "utf-8");
      } catch { /* ignore */ }
      return undefined;
    };
    const saveSyncBuf = async (buf: string): Promise<void> => {
      try { fs.writeFileSync(this.syncBufPath, buf, "utf-8"); } catch { /* ignore */ }
    };
    const loadContextTokens = async (): Promise<Record<string, string> | undefined> => {
      try {
        if (fs.existsSync(this.ctxTokensPath)) return JSON.parse(fs.readFileSync(this.ctxTokensPath, "utf-8"));
      } catch { /* ignore */ }
      return undefined;
    };
    const saveContextTokens = async (tokens: Record<string, string>): Promise<void> => {
      try { fs.writeFileSync(this.ctxTokensPath, JSON.stringify(tokens), "utf-8"); } catch { /* ignore */ }
    };

    const needQrLogin = !resolvedAccountId;

    try {
      if (needQrLogin) {
        this.setStatus("qr_pending");
        this.opts.log("INFO", "[WeChat] Token 模式需要扫码补全 accountId...");
        const loginResult = await this.client.login({
          onQRCode: (qrcodeUrl: string) => {
            this.opts.log("INFO", "[WeChat] 二维码已生成，等待扫码...");
            this.opts.onQrCode?.(qrcodeUrl);
            this.setStatus("qr_pending");
          },
        });
        this.selfAccountId = loginResult.accountId || "";
        this.opts.log("INFO", `[WeChat] 登录成功, accountId=${this.selfAccountId}`);
      } else {
        this.selfAccountId = resolvedAccountId;
        this.opts.log("INFO", `[WeChat] Token 直连模式, accountId=${this.selfAccountId}`);
      }

      this.setStatus("logging_in");

      const onFirstPoll = new Promise<void>((resolve) => {
        this.client!.once("poll", () => resolve());
      });

      this.client.start({ loadSyncBuf, saveSyncBuf, loadContextTokens, saveContextTokens }).catch((err: Error) => {
        this.opts.log("ERROR", `[WeChat] 轮询异常退出: ${err?.message ?? err}`);
        if (this.status !== "disconnected") this.setStatus("error");
      });

      await onFirstPoll;
      this.setStatus("connected");
      this.opts.log("INFO", "[WeChat] 消息轮询已启动");
    } catch (err: any) {
      this.opts.log("ERROR", `[WeChat] 启动失败: ${err?.message ?? err}`);
      this.setStatus("error");
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      try { this.client.stop(); } catch { /* ignore */ }
      this.client = null;
    }
    this.setStatus("disconnected");
    this.opts.log("INFO", "[WeChat] 已停止");
  }

  async sendText(toUserName: string, text: string): Promise<boolean> {
    if (!this.client || this.status !== "connected") {
      this.opts.log("WARN", "[WeChat] 发送失败: 未连接");
      return false;
    }
    try {
      await this.ensureTyping(toUserName);
      await this.client.sendText(toUserName, text);
      await this.cancelTyping(toUserName);
      return true;
    } catch (err: any) {
      this.opts.log("ERROR", `[WeChat] 发送文本失败: ${err?.message ?? err}`);
      return false;
    }
  }

  async sendMedia(toUserName: string, filePath: string): Promise<boolean> {
    if (!this.client || this.status !== "connected") {
      this.opts.log("WARN", "[WeChat] 发送媒体失败: 未连接");
      return false;
    }
    try {
      await this.ensureTyping(toUserName);
      await this.client.sendMedia(toUserName, filePath);
      await this.cancelTyping(toUserName);
      return true;
    } catch (err: any) {
      this.opts.log("ERROR", `[WeChat] 发送媒体失败: ${err?.message ?? err}`);
      return false;
    }
  }

  /** 确保发送前有 typing 状态：有缓存 ticket 直接用，没有则重新获取并 typing */
  private async ensureTyping(userId: string): Promise<void> {
    if (!this.client) return;
    const cached = this.typingTickets.get(userId);
    if (cached) return; // 收到消息时已经 typing 过了
    try {
      const ticket = await this.client.getTypingTicket(userId);
      if (ticket) {
        this.typingTickets.set(userId, ticket);
        await this.client.sendTyping(userId, ticket, "typing");
      }
    } catch (err: any) {
      this.opts.log("WARN", `[WeChat] ensureTyping 失败: ${err?.message ?? err}`);
    }
  }

  /** 取消 typing 状态并清除缓存 */
  private async cancelTyping(userId: string): Promise<void> {
    if (!this.client) return;
    const ticket = this.typingTickets.get(userId);
    if (!ticket) return;
    this.typingTickets.delete(userId);
    try {
      await this.client.sendTyping(userId, ticket, "cancel");
    } catch (err: any) {
      this.opts.log("WARN", `[WeChat] cancelTyping 失败: ${err?.message ?? err}`);
    }
  }

  /** 收到消息时立即获取 ticket 并开始 typing */
  private async startTypingForUser(userId: string): Promise<void> {
    if (!this.client) return;
    try {
      const ticket = await this.client.getTypingTicket(userId);
      if (ticket) {
        this.typingTickets.set(userId, ticket);
        await this.client.sendTyping(userId, ticket, "typing");
      }
    } catch (err: any) {
      this.opts.log("WARN", `[WeChat] startTyping 失败: ${err?.message ?? err}`);
    }
  }

  private static readonly MEDIA_DIR = path.join(os.tmpdir(), "cursor-claw-images");

  private handleMessage(msg: WeixinMessage): void {
    this.opts.log("DEBUG", `[WeChat] RAW msg: mid=${msg.message_id} type=${msg.message_type} state=${msg.message_state} from=${msg.from_user_id} to=${msg.to_user_id} client_id=${msg.client_id}`);

    if (msg.message_type === 2) return;
    if (msg.message_state !== undefined && msg.message_state !== 2) return;

    const fromUser = msg.from_user_id || "";
    if (fromUser === this.selfAccountId) return;

    const isGroup = (msg.group_id?.length ?? 0) > 0;

    if (msg.message_id != null && this.recentMsgHashes.has(String(msg.message_id))) {
      this.opts.log("INFO", `[WeChat] 去重跳过 (mid=${msg.message_id})`);
      return;
    }
    if (msg.message_id != null) {
      const mid = String(msg.message_id);
      this.recentMsgHashes.add(mid);
      setTimeout(() => this.recentMsgHashes.delete(mid), WeChatManager.DEDUP_WINDOW);
    }

    const chatId = isGroup ? (msg.group_id || fromUser) : fromUser;
    const messageId = msg.message_id != null
      ? `wx_${msg.message_id}`
      : `wx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    this.processMessageContent(msg).then((content) => {
      if (!content.trim()) return;

      const incoming: WeChatIncomingMessage = {
        text: content.trim(),
        messageId,
        chatId,
        chatType: isGroup ? "group" : "p2p",
        senderOpenId: fromUser,
      };

      this.opts.log("INFO", `[WeChat] 收到消息 [${incoming.chatType}] chat=${chatId}: ${content.slice(0, 100)}`);
      this.startTypingForUser(chatId).catch(() => {});
      this.opts.onMessage(incoming);
    }).catch((err) => {
      this.opts.log("ERROR", `[WeChat] 处理消息内容失败: ${err?.message ?? err}`);
    });
  }

  private async processMessageContent(msg: WeixinMessage): Promise<string> {
    const textContent = WeChatClient.extractText(msg);
    const parts: string[] = [];
    if (textContent.trim()) parts.push(textContent.trim());

    const items = msg.item_list ?? [];
    for (const item of items) {
      if (!WeChatClient.isMediaItem(item)) continue;
      const result = await this.downloadMediaItem(item);
      if (result) {
        const label = { image: "图片", voice: "语音", file: "文件", video: "视频" }[result.kind] ?? "文件";
        parts.push(`[${label}已保存: ${result.path}]`);
      } else {
        parts.push("[媒体下载失败]");
      }
    }

    return parts.join("\n");
  }

  private async downloadMediaItem(item: MessageItem): Promise<{ path: string; kind: string } | null> {
    if (!this.client) return null;
    try {
      const media = await this.client.downloadMedia(item);
      if (!media) return null;

      if (!fs.existsSync(WeChatManager.MEDIA_DIR)) {
        fs.mkdirSync(WeChatManager.MEDIA_DIR, { recursive: true });
      }
      const extMap: Record<string, string> = { image: ".png", voice: ".mp3", video: ".mp4", file: "" };
      const ext = media.fileName
        ? path.extname(media.fileName)
        : (extMap[media.kind] ?? "");
      const fileName = `wx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = path.join(WeChatManager.MEDIA_DIR, fileName);
      fs.writeFileSync(filePath, media.data);
      return { path: filePath, kind: media.kind };
    } catch (err: any) {
      this.opts.log("WARN", `[WeChat] 下载媒体失败: ${err?.message ?? err}`);
      return null;
    }
  }

  isConnected(): boolean {
    return this.status === "connected";
  }

  getSelfAccountId(): string {
    return this.selfAccountId;
  }
}
