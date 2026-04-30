import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

type WeChatClientClass = typeof import("wechat-ilink-client").WeChatClient;
type WeChatClientType = import("wechat-ilink-client").WeChatClient;
type WeixinMessageType = import("wechat-ilink-client").WeixinMessage;

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
  private client: WeChatClientType | null = null;
  private ClientCtor: WeChatClientClass | null = null;
  private status: WeChatStatus = "disconnected";
  private syncBufPath: string;
  private opts: WeChatManagerOptions;
  private selfAccountId = "";
  private recentMsgHashes = new Set<string>();
  private static readonly DEDUP_WINDOW = 60_000;

  constructor(opts: WeChatManagerOptions) {
    super();
    this.opts = opts;
    this.syncBufPath = path.join(opts.dataDir, "wechat-sync.txt");
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

    const mod = await import("wechat-ilink-client");
    const { WeChatClient, normalizeAccountId } = mod;
    this.ClientCtor = WeChatClient;

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

    this.client.on("message", (msg: WeixinMessageType) => this.handleMessage(msg));
    this.client.on("error", (err: Error) => {
      this.opts.log("ERROR", `[WeChat] 错误: ${err.message}`);
      this.setStatus("error");
    });
    this.client.on("sessionExpired", () => {
      this.opts.log("WARN", "[WeChat] 会话已过期，需要重新登录");
      this.setStatus("disconnected");
    });

    const loadSyncBuf = (): string | undefined => {
      try {
        if (fs.existsSync(this.syncBufPath)) return fs.readFileSync(this.syncBufPath, "utf-8");
      } catch { /* ignore */ }
      return undefined;
    };
    const saveSyncBuf = (buf: string): void => {
      try { fs.writeFileSync(this.syncBufPath, buf, "utf-8"); } catch { /* ignore */ }
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

      this.client.start({ loadSyncBuf, saveSyncBuf }).catch((err: Error) => {
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
      await this.client.sendText(toUserName, text);
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
      await this.client.sendMedia(toUserName, filePath);
      return true;
    } catch (err: any) {
      this.opts.log("ERROR", `[WeChat] 发送媒体失败: ${err?.message ?? err}`);
      return false;
    }
  }

  private handleMessage(msg: WeixinMessageType): void {
    const fromUser = msg.from_user_id || "";
    if (fromUser === this.selfAccountId) return;

    const isGroup = (msg.group_id?.length ?? 0) > 0;
    const content = this.ClientCtor ? this.ClientCtor.extractText(msg) : "";
    if (!content.trim()) return;

    const chatId = isGroup ? (msg.group_id || fromUser) : fromUser;
    const messageId = msg.message_id != null
      ? `wx_${msg.message_id}`
      : `wx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const dedupKey = msg.message_id != null
      ? `id:${msg.message_id}`
      : `hash:${chatId}:${content.trim().slice(0, 200)}`;
    if (this.recentMsgHashes.has(dedupKey)) {
      this.opts.log("INFO", `[WeChat] 去重跳过 (key=${dedupKey})`);
      return;
    }
    this.recentMsgHashes.add(dedupKey);
    setTimeout(() => this.recentMsgHashes.delete(dedupKey), WeChatManager.DEDUP_WINDOW);

    const incoming: WeChatIncomingMessage = {
      text: content.trim(),
      messageId,
      chatId,
      chatType: isGroup ? "group" : "p2p",
      senderOpenId: fromUser,
    };

    this.opts.log("INFO", `[WeChat] 收到消息 [${incoming.chatType}] chat=${chatId}: ${content.slice(0, 100)}`);
    this.opts.onMessage(incoming);
  }

  isConnected(): boolean {
    return this.status === "connected";
  }

  getSelfAccountId(): string {
    return this.selfAccountId;
  }
}
