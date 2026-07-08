import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as Lark from "@larksuiteoapi/node-sdk";

// ── 媒体缓存目录（飞书/微信下载的图片、文件、语音共用）─────

export const MEDIA_CACHE_DIR = path.join(os.tmpdir(), "cursor-claw-images");

/** 清理媒体缓存中 mtime 超过 maxAgeMs 的旧文件，返回删除数量（避免临时文件无限堆积） */
export function cleanupMediaCache(maxAgeMs: number): number {
  let removed = 0;
  try {
    if (!fs.existsSync(MEDIA_CACHE_DIR)) return 0;
    const now = Date.now();
    for (const name of fs.readdirSync(MEDIA_CACHE_DIR)) {
      const full = path.join(MEDIA_CACHE_DIR, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) { fs.unlinkSync(full); removed++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}

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

const SILENT_LOGGER = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

export function createLarkClient(appId: string, appSecret: string): Lark.Client {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
    logger: SILENT_LOGGER,
  });
}

// ── 飞书发送 ─────────────────────────────────────────────

export interface CardButton {
  label: string;
  /** 回传交互数据，card.action.trigger 回调中原样返回 */
  value: unknown;
  type?: "primary" | "default" | "danger";
}

export interface LarkSenderOptions {
  client: Lark.Client;
  chatId: string;
  messagePrefix: string;
  log: (level: string, ...args: unknown[]) => void;
}

export class LarkSender {
  private client: Lark.Client;
  private messagePrefix: string;
  private log: (level: string, ...args: unknown[]) => void;

  chatId: string | null = null;

  constructor(opts: LarkSenderOptions) {
    this.client = opts.client;
    this.messagePrefix = opts.messagePrefix;
    this.log = opts.log;
    if (opts.chatId) this.chatId = opts.chatId;
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
      // 引用消息无 mentions 上下文，清理残留的 @ 占位符
      return result ? result.replace(/@_user_\d+\s?/g, "").trim() || null : null;
    } catch (e: any) {
      this.log("DEBUG", `拉取消息内容失败 (${messageId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /** 文本中含 `<at user_id="ou_xxx">` 标签时需用 text 消息发送才能产生真实 mention（触发被 @ 机器人的事件推送） */
  static containsAtTag(text: string): boolean {
    return /<at\s+user_id=/.test(text);
  }

  private formatForSend(text: string, title?: string): { content: string; msgType: string } {
    const fullText = `${this.messagePrefix}${text}`;
    if (LarkSender.containsAtTag(fullText)) {
      return { content: JSON.stringify({ text: fullText }), msgType: "text" };
    }
    return { content: JSON.stringify(LarkSender.buildCard(fullText, title)), msgType: "interactive" };
  }

  /** 构造 schema 2.0 markdown 卡片；buttons 为回传交互按钮（点击触发 card.action.trigger） */
  static buildCard(text: string, title?: string, buttons?: CardButton[]): any {
    const elements: any[] = [{ tag: "markdown", content: text.replace(/\\/g, "\\\\") }];
    for (const b of buttons ?? []) {
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: b.label.slice(0, 100) },
        type: b.type ?? "primary",
        width: "fill",
        behaviors: [{ type: "callback", value: b.value }],
      });
    }
    const card: any = {
      schema: "2.0",
      config: { wide_screen_mode: true },
      body: { elements },
    };
    if (title) {
      card.header = { title: { tag: "plain_text", content: title }, template: "turquoise" };
    }
    return card;
  }

  /** 发送带回传按钮的交互卡片（优先回复，退避 chat 直发），返回 message_id */
  async sendCardWithButtons(text: string, buttons: CardButton[], replyMessageId?: string, chatId?: string, title?: string): Promise<string | undefined> {
    const card = LarkSender.buildCard(`${this.messagePrefix}${text}`, title, buttons);
    const content = JSON.stringify(card);
    if (replyMessageId && !replyMessageId.startsWith("internal_")) {
      try {
        const res = await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: { content, msg_type: "interactive" },
        });
        const mid = (res as any)?.data?.message_id;
        if (mid) { this.log("INFO", `飞书按钮卡片已回复(${buttons.length}个按钮)`); return mid; }
      } catch (e: any) { this.log("WARN", `按钮卡片回复退避 (${replyMessageId}): ${e?.message ?? e}`); }
    }
    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) { this.log("WARN", "无发送目标"); return undefined; }
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" as any },
        data: { receive_id: targetChatId, content, msg_type: "interactive" },
      });
      this.log("INFO", `飞书按钮卡片已发送(${buttons.length}个按钮)`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("ERROR", `按钮卡片发送异常: ${e?.message ?? e}`); return undefined; }
  }

  async replyMessage(messageId: string, text: string, title?: string): Promise<string | undefined> {
    try {
      const { content, msgType } = this.formatForSend(text, title);
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: { content, msg_type: msgType },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书回复已发送(${text.length}字)`);
      else this.log("ERROR", `飞书回复失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("WARN", `飞书回复异常: ${e?.message ?? e}`); return undefined; }
  }

  async sendMessage(text: string, replyMessageId?: string, chatId?: string, title?: string): Promise<string | undefined> {
    if (replyMessageId && !replyMessageId.startsWith("internal_")) { return this.replyMessage(replyMessageId, text, title); }
    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) { this.log("WARN", "无发送目标"); return undefined; }
    try {
      const { content, msgType } = this.formatForSend(text, title);
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" as any },
        data: { receive_id: targetChatId, content, msg_type: msgType },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书消息已发送(${text.length}字)`);
      else this.log("ERROR", `飞书发送失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("ERROR", `飞书发送异常: ${e?.message ?? e}`); return undefined; }
  }

  async addReaction(messageId: string, emojiType: string = "Get"): Promise<boolean> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) return true;
      this.log("WARN", `添加表情失败: code=${(res as any).code}`);
      return false;
    } catch (e: any) {
      this.log("WARN", `添加表情异常: ${e?.message ?? e}`);
      return false;
    }
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
      if (replyMessageId && !replyMessageId.startsWith("internal_")) {
        try {
          await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "image" } });
          sent = true;
        } catch (e: any) { this.log("WARN", `图片回复退避 (${replyMessageId}): ${e?.message}`); }
      }
      if (!sent) {
        const targetChatId = chatId ?? this.chatId;
        if (!targetChatId) { this.log("WARN", "无发送目标"); return; }
        await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: targetChatId, content, msg_type: "image" } });
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
      if (replyMessageId && !replyMessageId.startsWith("internal_")) {
        try {
          await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "file" } });
          sent = true;
        } catch (e: any) { this.log("WARN", `文件回复退避 (${replyMessageId}): ${e?.message}`); }
      }
      if (!sent) {
        const targetChatId = chatId ?? this.chatId;
        if (!targetChatId) { this.log("WARN", "无发送目标"); return; }
        await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: targetChatId, content, msg_type: "file" } });
      }
      this.log("INFO", `文件已发送: ${fileName}`);
    } catch (e: any) { this.log("ERROR", `发送文件异常: ${e?.message ?? e}`); }
  }

  // ── 图片下载 ───────────────────────────────────────────

  private static readonly IMAGE_DIR = MEDIA_CACHE_DIR;

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
              switch (el.tag) {
                case "text": if (el.text) segs.push(el.text); break;
                case "a": if (el.text) segs.push(el.href ? `${el.text}(${el.href})` : el.text); break;
                case "at": if (el.user_name) segs.push(`@${el.user_name}`); break;
                case "img":
                  if (el.image_key) { result.imageKeys.push({ messageId, imageKey: el.image_key }); segs.push("[图片]"); }
                  break;
                case "media": segs.push("[视频]"); break;
                case "emotion": if (el.emoji_type) segs.push(`[${el.emoji_type}]`); break;
                case "code_block": if (el.text) segs.push(`\`\`\`${el.language ?? ""}\n${el.text}\n\`\`\``); break;
                case "hr": segs.push("---"); break;
              }
            }
            if (segs.length) lineTexts.push(segs.join(""));
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
        case "folder": result.text = `[文件夹: ${parsed.folder_name ?? "未知"}]`; break;
        case "audio": result.text = parsed.duration ? `[语音消息 ${Math.ceil(parsed.duration / 1000)}s]` : "[语音消息]"; break;
        case "video": result.text = parsed.file_name ? `[视频: ${parsed.file_name}]` : "[视频]"; break;
        case "media": {
          const mediaParts = [parsed.file_name ?? "视频"];
          if (parsed.duration) mediaParts.push(`${Math.ceil(parsed.duration / 1000)}s`);
          result.text = `[媒体: ${mediaParts.join(" ")}]`;
          if (parsed.image_key) result.imageKeys.push({ messageId, imageKey: parsed.image_key });
          break;
        }
        case "sticker": result.text = "[表情包]"; break;
        case "share_chat": result.text = parsed.chat_name ? `[分享群聊: ${parsed.chat_name}]` : "[分享群聊]"; break;
        case "share_user": result.text = parsed.user_id ? `[分享名片: ${parsed.user_id}]` : "[分享名片]"; break;
        case "merge_forward": result.text = "[合并转发消息]"; break;
        case "system": {
          const tpl = parsed.template ?? "";
          if (parsed.content) {
            try {
              const sysContent = JSON.parse(parsed.content);
              result.text = `[系统消息: ${sysContent.text ?? tpl}]`;
            } catch { result.text = `[系统消息: ${tpl || parsed.content}]`; }
          } else {
            result.text = tpl ? `[系统消息: ${tpl}]` : "[系统消息]";
          }
          break;
        }
        case "hongbao": result.text = "[红包]"; break;
        case "share_calendar_event": result.text = parsed.summary ? `[日程: ${parsed.summary}]` : "[日程邀请]"; break;
        case "calendar": result.text = parsed.summary ? `[日历: ${parsed.summary}]` : "[日历消息]"; break;
        case "general_calendar": result.text = parsed.summary ? `[日程: ${parsed.summary}]` : "[通用日历]"; break;
        case "location": result.text = parsed.name ? `[位置: ${parsed.name}]` : "[位置]"; break;
        case "video_chat": {
          const topic = parsed.topic ?? "";
          const vcType = parsed.call_type === "1" ? "视频通话" : "语音通话";
          result.text = topic ? `[${vcType}: ${topic}]` : `[${vcType}]`;
          break;
        }
        case "todo": result.text = parsed.task_content?.summary ?? "[待办任务]"; break;
        case "vote": result.text = parsed.topic ? `[投票: ${parsed.topic}]` : "[投票]"; break;
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

  /** 建立 WebSocket 长连接；返回的 Promise 反映连接建立结果（调用方可据此维护连接状态） */
  startConnection(
    appId: string,
    appSecret: string,
    encryptKey: string,
    onMessage: (event: LarkMessageEvent) => void,
    onCardAction?: (event: LarkCardActionEvent) => Promise<unknown> | unknown,
  ): Promise<void> {
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
          const senderType: string = senderObj?.sender_type ?? "user";
          this.log("DEBUG", `sender raw: ${JSON.stringify(senderObj)}`);
          const parentId: string = msg?.parent_id ?? "";
          const mentions: LarkMention[] = (msg?.mentions ?? []).map((m: any) => ({ key: m.key ?? "", id: m.id?.open_id ?? "", name: m.name ?? "" }));
          onMessage({ text, messageId, chatId, chatType, messageType, rawContent, senderOpenId, senderType, parentId: parentId || undefined, mentions });
        } catch (e: any) {
          this.log("ERROR", `事件处理异常: ${e?.message ?? e}`);
        }
      },
      "card.action.trigger": async (data: any) => {
        try {
          const evt: LarkCardActionEvent = {
            messageId: data?.context?.open_message_id ?? data?.open_message_id ?? "",
            chatId: data?.context?.open_chat_id ?? data?.open_chat_id ?? "",
            operatorOpenId: data?.operator?.open_id,
            value: data?.action?.value,
          };
          this.log("INFO", `卡片按钮点击: msg=${evt.messageId} value=${JSON.stringify(evt.value)?.slice(0, 200)}`);
          if (!onCardAction) return {};
          return (await onCardAction(evt)) ?? {};
        } catch (e: any) {
          this.log("ERROR", `卡片回调处理异常: ${e?.message ?? e}`);
          return {};
        }
      },
    });
    const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error });
    return wsClient.start({ eventDispatcher })
      .then(() => this.log("INFO", "飞书 WebSocket 连接建立成功"))
      .catch((e: any) => {
        this.log("ERROR", `飞书 WebSocket 连接失败: ${e?.message ?? e}`);
        throw e;
      });
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

export interface LarkCardActionEvent {
  /** 卡片所在消息 ID */
  messageId: string;
  chatId: string;
  operatorOpenId?: string;
  /** 按钮 behaviors callback 配置的自定义回传数据 */
  value: unknown;
}

export interface LarkMessageEvent {
  text: string;
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  rawContent: string;
  senderOpenId?: string;
  /** "user" | "app"（app = 其他机器人发送） */
  senderType?: string;
  parentId?: string;
  mentions: LarkMention[];
}
