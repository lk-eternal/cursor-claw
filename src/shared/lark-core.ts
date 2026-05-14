import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as Lark from "@larksuiteoapi/node-sdk";

// ── 代理环境变量清理 ─────────────────────────────────────

const PROXY_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NODE_USE_ENV_PROXY",
];

export function stripProxyEnv(): string[] {
  const removed: string[] = [];
  for (const key of PROXY_KEYS) {
    if (process.env[key]) {
      removed.push(key);
      delete process.env[key];
    }
  }
  return removed;
}

// ── 时间戳 ───────────────────────────────────────────────

export function localTimestamp(): string {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

// ── Lark Client 工厂 ────────────────────────────────────

export function createLarkClient(appId: string, appSecret: string): Lark.Client {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
  });
}

// ── 发送目标解析 ─────────────────────────────────────────

export interface SendTarget {
  receiveIdType: string;
  receiveId: string;
}

export interface LarkSenderOptions {
  client: Lark.Client;
  receiveId: string;
  receiveIdType: string;
  messagePrefix: string;
  log: (level: string, ...args: unknown[]) => void;
}

export class LarkSender {
  private client: Lark.Client;
  private messagePrefix: string;
  private log: (level: string, ...args: unknown[]) => void;

  resolvedTarget: SendTarget | null = null;
  autoOpenId = "";

  constructor(opts: LarkSenderOptions) {
    this.client = opts.client;
    this.messagePrefix = opts.messagePrefix;
    this.log = opts.log;
    this.initTarget(opts.receiveId, opts.receiveIdType);
  }

  private initTarget(receiveId: string, receiveIdType: string): void {
    if (!receiveId) return;
    const idType = receiveIdType || "auto";
    if (["open_id", "user_id", "union_id", "chat_id"].includes(idType)) {
      this.resolvedTarget = { receiveIdType: idType, receiveId };
    }
  }

  async resolveTarget(receiveId: string, receiveIdType: string): Promise<void> {
    if (!receiveId) {
      this.log("INFO", "未配置 LARK_RECEIVE_ID，将从首条消息自动获取");
      return;
    }
    const idType = receiveIdType || "auto";
    if (this.resolvedTarget) return;

    if (idType === "email" || (idType === "auto" && receiveId.includes("@"))) {
      const openId = await this.resolveEmailToOpenId(receiveId);
      if (openId) { this.resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
    }
    if (idType === "mobile" || (idType === "auto" && /^\+?\d{7,}$/.test(receiveId))) {
      const openId = await this.resolveMobileToOpenId(receiveId);
      if (openId) { this.resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
    }
    this.resolvedTarget = { receiveIdType: "open_id", receiveId };
  }

  getTarget(): SendTarget | null {
    if (this.resolvedTarget) return this.resolvedTarget;
    if (this.autoOpenId) return { receiveIdType: "open_id", receiveId: this.autoOpenId };
    return null;
  }

  async resolveEmailToOpenId(email: string): Promise<string | null> {
    try {
      const res = await this.client.contact.user.batchGetId({
        params: { user_id_type: "open_id" }, data: { emails: [email] },
      });
      const users = res.data?.user_list;
      if (users && users.length > 0 && users[0].user_id) {
        this.log("INFO", `邮箱 ${email} → open_id: ${users[0].user_id}`);
        return users[0].user_id;
      }
      return null;
    } catch (e) { this.log("ERROR", "邮箱解析失败:", e); return null; }
  }

  async resolveMobileToOpenId(mobile: string): Promise<string | null> {
    try {
      const res = await this.client.contact.user.batchGetId({
        params: { user_id_type: "open_id" }, data: { mobiles: [mobile] },
      });
      const users = res.data?.user_list;
      if (users && users.length > 0 && users[0].user_id) {
        this.log("INFO", `手机号 ${mobile} → open_id: ${users[0].user_id}`);
        return users[0].user_id;
      }
      return null;
    } catch (e) { this.log("ERROR", "手机号解析失败:", e); return null; }
  }

  async fetchMessageContent(messageId: string): Promise<string | null> {
    try {
      const res = await this.client.im.message.get({
        path: { message_id: messageId },
        params: { card_msg_content_type: "user_card_content" } as any,
      });
      const item = (res as any)?.data?.items?.[0];
      const content = item?.body?.content;
      if (!content) return null;
      const msgType: string = item?.msg_type ?? "text";
      this.log("DEBUG", `fetchMessageContent(${messageId}) type=${msgType} content=${content.substring(0, 200)}`);
      const result = await this.processIncomingMessage(messageId, msgType, content);
      return result || null;
    } catch (e: any) {
      this.log("WARN", `拉取消息内容失败 (${messageId}): ${e?.message ?? e}`);
      return null;
    }
  }

  private formatForSend(text: string): { content: string; msgType: string } {
    const fullText = `${this.messagePrefix}${text}`;
    const escaped = fullText.replace(/\\/g, "\\\\");
    return {
      content: JSON.stringify({
        schema: "2.0",
        config: { wide_screen_mode: true },
        body: { elements: [{ tag: "markdown", content: escaped }] },
      }),
      msgType: "interactive",
    };
  }

  async replyMessage(messageId: string, text: string): Promise<string | undefined> {
    try {
      const { content, msgType } = this.formatForSend(text);
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: { content, msg_type: msgType },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书回复已发送(${text.length}字)`);
      else this.log("ERROR", `飞书回复失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("ERROR", `飞书回复异常: ${e?.message ?? e}`); return undefined; }
  }

  async sendMessage(text: string, replyMessageId?: string): Promise<string | undefined> {
    if (replyMessageId) { return this.replyMessage(replyMessageId, text); }
    const target = this.getTarget();
    if (!target) { this.log("WARN", "无发送目标"); return undefined; }
    try {
      const { content, msgType } = this.formatForSend(text);
      const res = await this.client.im.message.create({
        params: { receive_id_type: target.receiveIdType as any },
        data: { receive_id: target.receiveId, content, msg_type: msgType },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书消息已发送(${text.length}字)`);
      else this.log("ERROR", `飞书发送失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("ERROR", `飞书发送异常: ${e?.message ?? e}`); return undefined; }
  }

  async sendMessageToChat(chatId: string, text: string): Promise<string | undefined> {
    try {
      const { content, msgType } = this.formatForSend(text);
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" as any },
        data: { receive_id: chatId, content, msg_type: msgType },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书消息已发送到会话 ${chatId}(${text.length}字)`);
      else this.log("ERROR", `飞书发送失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("ERROR", `飞书发送异常: ${e?.message ?? e}`); return undefined; }
  }

  async sendImage(imagePath: string, replyMessageId?: string, chatId?: string): Promise<void> {
    const absPath = path.resolve(imagePath);
    if (!fs.existsSync(absPath)) { this.log("ERROR", `图片不存在: ${absPath}`); return; }
    try {
      const uploadRes: any = await this.client.im.image.create({ data: { image_type: "message", image: fs.createReadStream(absPath) } });
      const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
      if (!imageKey) { this.log("ERROR", `图片上传失败`); return; }
      const content = JSON.stringify({ image_key: imageKey });
      let sent = false;
      if (replyMessageId) {
        try {
          await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "image" } });
          sent = true;
        } catch (e: any) { this.log("WARN", `图片回复退避 (${replyMessageId}): ${e?.message}`); }
      }
      if (!sent) {
        if (chatId) {
          await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: chatId, content, msg_type: "image" } });
        } else {
          const target = this.getTarget();
          if (!target) { this.log("WARN", "无发送目标"); return; }
          await this.client.im.message.create({ params: { receive_id_type: target.receiveIdType as any }, data: { receive_id: target.receiveId, content, msg_type: "image" } });
        }
      }
      this.log("INFO", "图片已发送");
    } catch (e: any) { this.log("ERROR", `发送图片异常: ${e?.message ?? e}`); }
  }

  async sendFile(filePath: string, replyMessageId?: string, chatId?: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) { this.log("ERROR", `文件不存在: ${absPath}`); return; }
    try {
      const fileName = path.basename(absPath);
      const uploadRes: any = await this.client.im.file.create({ data: { file_type: "stream", file_name: fileName, file: fs.createReadStream(absPath) } });
      const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
      if (!fileKey) { this.log("ERROR", `文件上传失败`); return; }
      const content = JSON.stringify({ file_key: fileKey, file_name: fileName });
      let sent = false;
      if (replyMessageId) {
        try {
          await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "file" } });
          sent = true;
        } catch (e: any) { this.log("WARN", `文件回复退避 (${replyMessageId}): ${e?.message}`); }
      }
      if (!sent) {
        if (chatId) {
          await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: chatId, content, msg_type: "file" } });
        } else {
          const target = this.getTarget();
          if (!target) { this.log("WARN", "无发送目标"); return; }
          await this.client.im.message.create({ params: { receive_id_type: target.receiveIdType as any }, data: { receive_id: target.receiveId, content, msg_type: "file" } });
        }
      }
      this.log("INFO", `文件已发送: ${fileName}`);
    } catch (e: any) { this.log("ERROR", `发送文件异常: ${e?.message ?? e}`); }
  }

  // ── 图片下载 ───────────────────────────────────────────

  private static readonly IMAGE_DIR = path.join(os.tmpdir(), "cursor-claw-images");

  async downloadImage(messageId: string, imageKey: string): Promise<string | null> {
    try {
      if (!fs.existsSync(LarkSender.IMAGE_DIR)) fs.mkdirSync(LarkSender.IMAGE_DIR, { recursive: true });
      const resp: any = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey }, params: { type: "image" },
      });
      const filePath = path.join(LarkSender.IMAGE_DIR, `${imageKey}.png`);
      if (resp && typeof resp.pipe === "function") {
        const ws = fs.createWriteStream(filePath);
        await new Promise<void>((resolve, reject) => { resp.pipe(ws); ws.on("finish", resolve); ws.on("error", reject); });
        return filePath;
      }
      if (resp?.writeFile) { await resp.writeFile(filePath); return filePath; }
      return null;
    } catch (e: any) { this.log("ERROR", `下载图片异常: ${e?.message ?? e}`); return null; }
  }

  // ── 消息解析 & 处理 ───────────────────────────────────

  private static extractCardText(elements: any[], parts: string[]): void {
    for (const el of elements) {
      if (!el) continue;
      if (Array.isArray(el)) { this.extractCardText(el, parts); continue; }
      if (typeof el !== "object") continue;

      const tag: string = el.tag ?? "";
      switch (tag) {
        case "markdown":
        case "plain_text":
          if (el.content) parts.push(el.content);
          break;
        case "text":
          if (el.text) parts.push(el.text);
          break;
        case "div":
          if (el.text?.content) parts.push(el.text.content);
          if (Array.isArray(el.extra)) this.extractCardText(el.extra, parts);
          break;
        case "column_set":
          if (Array.isArray(el.columns)) {
            for (const col of el.columns) {
              if (Array.isArray(col.elements)) this.extractCardText(col.elements, parts);
            }
          }
          break;
        case "form":
        case "interactive_container":
        case "collapsible_panel":
          if (Array.isArray(el.elements)) this.extractCardText(el.elements, parts);
          break;
        case "action":
          if (Array.isArray(el.actions)) {
            for (const act of el.actions) {
              const txt = act.text?.content ?? act.text?.text;
              if (txt) parts.push(`[按钮: ${txt}]`);
            }
          }
          break;
        case "button":
          if (el.text?.content) parts.push(`[按钮: ${el.text.content}]`);
          break;
        case "note":
          if (Array.isArray(el.elements)) {
            const noteTexts = el.elements.filter((n: any) => n.content).map((n: any) => n.content);
            if (noteTexts.length) parts.push(noteTexts.join(" "));
          }
          break;
        case "table":
          if (el.header?.titles) parts.push(el.header.titles.map((t: any) => t.content ?? t).join(" | "));
          if (Array.isArray(el.rows)) {
            for (const row of el.rows) {
              if (Array.isArray(row)) parts.push(row.map((c: any) => c?.content ?? c?.text ?? String(c ?? "")).join(" | "));
            }
          }
          break;
        case "img":
        case "img_combination":
          parts.push("[图片]");
          break;
        case "chart":
          parts.push("[图表]");
          break;
        case "person":
          if (el.user_id) parts.push(`[@用户]`);
          break;
        case "hr":
          break;
        default:
          if (el.text?.content) parts.push(el.text.content);
          if (el.content && typeof el.content === "string") parts.push(el.content);
          if (Array.isArray(el.elements)) this.extractCardText(el.elements, parts);
          break;
      }
    }
  }

  static parseMessageContent(messageId: string, messageType: string, content: string): ParsedMessage {
    const result: ParsedMessage = { text: "", imageKeys: [] };
    try {
      const parsed = JSON.parse(content);
      switch (messageType) {
        case "text": result.text = parsed.text ?? content; break;
        case "image":
          if (parsed.image_key) { result.imageKeys.push({ messageId, imageKey: parsed.image_key }); result.text = "[图片]"; }
          break;
        case "post": {
          const localized = parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp ?? parsed;
          const lineTexts: string[] = [];
          if (localized.title) lineTexts.push(localized.title);
          const lines = localized.content ?? localized.elements ?? [];
          if (!Array.isArray(lines)) { result.text = content; break; }
          for (const line of lines) {
            if (!Array.isArray(line)) continue;
            const segs: string[] = [];
            for (const el of line) {
              if (el.tag === "text" && el.text) segs.push(el.text);
              else if (el.tag === "img" && el.image_key) { result.imageKeys.push({ messageId, imageKey: el.image_key }); segs.push("[图片]"); }
              else if (el.tag === "a" && el.text) segs.push(el.text);
              else if (el.tag === "at" && el.user_name) segs.push(`@${el.user_name}`);
              else if (el.tag === "emotion" && el.emoji_type) segs.push(`[${el.emoji_type}]`);
            }
            lineTexts.push(segs.join(""));
          }
          result.text = lineTexts.join("\n"); break;
        }
        case "interactive": {
          const parts: string[] = [];
          const header = parsed.header ?? parsed.i18n_header?.zh_cn ?? parsed.i18n_header?.en_us;
          if (header?.title?.content) parts.push(header.title.content);
          const isV2 = parsed.schema === "2.0";
          const elements = isV2
            ? (parsed.body?.elements ?? [])
            : (parsed.elements ?? parsed.i18n_elements?.zh_cn ?? parsed.i18n_elements?.en_us ?? parsed.i18n_body?.zh_cn?.elements ?? []);
          if (Array.isArray(elements)) this.extractCardText(elements, parts);
          result.text = parts.join("\n") || "[卡片消息]"; break;
        }
        case "file": result.text = `[文件: ${parsed.file_name ?? "未知"}]`; break;
        case "audio": result.text = parsed.duration ? `[语音消息 ${Math.ceil(parsed.duration / 1000)}s]` : "[语音消息]"; break;
        case "video": result.text = parsed.file_name ? `[视频: ${parsed.file_name}]` : "[视频]"; break;
        case "media": result.text = parsed.file_name ? `[媒体: ${parsed.file_name}]` : "[媒体]"; break;
        case "sticker": result.text = "[表情包]"; break;
        case "share_chat": result.text = parsed.chat_name ? `[分享群聊: ${parsed.chat_name}]` : "[分享群聊]"; break;
        case "share_user": result.text = "[分享名片]"; break;
        case "merge_forward": {
          const fwdParts: string[] = ["[合并转发消息]"];
          if (Array.isArray(parsed.message_list)) {
            for (const msg of parsed.message_list.slice(0, 5)) {
              const sub = this.parseMessageContent(msg.message_id ?? "", msg.msg_type ?? "text", msg.content ?? "{}");
              if (sub.text) fwdParts.push(`  > ${sub.text.split("\n")[0]}`);
            }
            if (parsed.message_list.length > 5) fwdParts.push(`  > ...共${parsed.message_list.length}条`);
          }
          result.text = fwdParts.join("\n"); break;
        }
        case "system": result.text = "[系统消息]"; break;
        default: result.text = parsed.text ?? "[不支持的消息类型]";
      }
    } catch { result.text = content; }
    return result;
  }

  async processIncomingMessage(messageId: string, messageType: string, content: string): Promise<string> {
    const parsed = LarkSender.parseMessageContent(messageId, messageType, content);
    const total = parsed.imageKeys.length;
    let text = parsed.text;
    if (total > 1) {
      let idx = 0;
      text = text.replace(/\[图片\]/g, () => `[图片${++idx}]`);
    }
    const parts: string[] = [];
    if (text) parts.push(text);
    for (let i = 0; i < total; i++) {
      const img = parsed.imageKeys[i];
      const localPath = await this.downloadImage(img.messageId, img.imageKey);
      const label = total > 1 ? `图片${i + 1}` : "图片";
      parts.push(localPath ? `[${label}已保存: ${localPath}]` : `[${label}下载失败: ${img.imageKey}]`);
    }
    return parts.join("\n");
  }

  // ── WebSocket 连接 ────────────────────────────────────

  startConnection(
    appId: string,
    appSecret: string,
    encryptKey: string,
    onMessage: (event: LarkMessageEvent) => void,
  ): void {
    const eventDispatcher = new Lark.EventDispatcher(encryptKey ? { encryptKey } : {}).register({
      "im.message.receive_v1": (data) => {
        try {
          const msg = (data as any)?.message;
          const senderObj = (data as any)?.sender;
          const messageId: string = msg?.message_id ?? "";
          const chatId: string = msg?.chat_id ?? "";
          const chatType: string = msg?.chat_type ?? "p2p";
          const rawContent: string = msg?.content ?? "";
          const messageType: string = msg?.message_type ?? "text";
          let text = rawContent;
          try { text = LarkSender.parseMessageContent(messageId, messageType, rawContent).text || rawContent; } catch { /* use raw */ }
          const senderOpenId = senderObj?.sender_id?.open_id;
          const parentId: string = msg?.parent_id ?? "";
          const mentions: LarkMention[] = (msg?.mentions ?? []).map((m: any) => ({ key: m.key ?? "", id: m.id?.open_id ?? "", name: m.name ?? "" }));
          onMessage({ text, messageId, chatId, chatType, messageType, rawContent, senderOpenId, parentId: parentId || undefined, mentions });
        } catch (e: any) {
          this.log("ERROR", `事件处理异常: ${e?.message ?? e}`);
        }
      },
    });
    const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error });
    wsClient.start({ eventDispatcher })
      .then(() => this.log("INFO", "飞书 WebSocket 连接建立成功"))
      .catch((e: any) => this.log("ERROR", `飞书 WebSocket 连接失败: ${e?.message ?? e}`));
  }
}

// ── 类型导出 ──────────────────────────────────────────────

export interface ParsedMessage {
  text: string;
  imageKeys: { messageId: string; imageKey: string }[];
}

export interface LarkMention {
  key: string;
  id: string;
  name: string;
}

export interface LarkMessageEvent {
  text: string;
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  rawContent: string;
  senderOpenId?: string;
  parentId?: string;
  mentions: LarkMention[];
}
