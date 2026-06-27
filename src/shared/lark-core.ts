import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";

const STREAM_ELEMENT_ID = "stream_content";
const MERGE_BATCH_ELEMENT_ID = "merge_body";
const TOOL_PROGRESS_ELEMENT_ID = "tool_progress";
const THINKING_ELEMENT_ID = "thinking_summary";

export interface PresentationCardState {
  cardEntityId: string;
  cardMessageId: string;
  cardSequence: number;
}

function formatToolStatusLabel(status: "started" | "completed" | "failed"): string {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "执行中…";
}

export interface MergeBatchCardView {
  title: string;
  bodyMarkdown: string;
  footerText: string;
}

export interface MergeBatchCardState {
  cardEntityId: string;
  cardMessageId: string;
  cardSequence: number;
}

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

export function createLarkClient(appId: string, appSecret: string): Lark.Client {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
  });
}

// ── 飞书发送 ─────────────────────────────────────────────

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
      this.log("WARN", `拉取消息内容失败 (${messageId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /** 文本中含 `<at user_id="ou_xxx">` 标签时需用 text 消息发送才能产生真实 mention（触发被 @ 机器人的事件推送） */
  static containsAtTag(text: string): boolean {
    return /<at\s+user_id=/.test(text);
  }

  private formatForSend(text: string, title?: string): { content: string; msgType: string } {
    return this.formatStreamForSend(text, title, false);
  }

  /** 流式 outbound：interactive 卡片含 update_multi 以支持 PATCH；text 类型走 update 接口 */
  private formatStreamForSend(text: string, title?: string, stream = true): { content: string; msgType: string } {
    const fullText = `${this.messagePrefix}${text}`;
    if (LarkSender.containsAtTag(fullText)) {
      return { content: JSON.stringify({ text: fullText }), msgType: "text" };
    }
    const escaped = fullText.replace(/\\/g, "\\\\");
    const card: any = {
      schema: "2.0",
      config: { wide_screen_mode: true, ...(stream ? { update_multi: true } : {}) },
      body: { elements: [{ tag: "markdown", content: escaped }] },
    };
    if (title) {
      card.header = { title: { tag: "plain_text", content: title }, template: "turquoise" };
    }
    return { content: JSON.stringify(card), msgType: "interactive" };
  }

  /** 流式首包：发送可 PATCH 的 interactive 卡片（PATCH 不可行时由 daemon 分段 sendMessage 降级） */
  async sendStreamMessage(text: string, chatId?: string, title?: string): Promise<string | undefined> {
    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) { this.log("WARN", "无发送目标"); return undefined; }
    try {
      const { content, msgType } = this.formatStreamForSend(text, title, true);
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" as any },
        data: { receive_id: targetChatId, content, msg_type: msgType },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书流式首包已发送(${text.length}字)`);
      else this.log("ERROR", `飞书流式首包失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("ERROR", `飞书流式首包异常: ${e?.message ?? e}`); return undefined; }
  }

  /**
   * PATCH 更新已发送消息 content；interactive 走 im.message.patch，text 走 im.message.update。
   * 返回 false 时 daemon 应降级为段落分段 sendMessage（F4.3）。
   */
  async updateMessageContent(messageId: string, text: string, title?: string): Promise<boolean> {
    try {
      const fullText = `${this.messagePrefix}${text}`;
      if (LarkSender.containsAtTag(fullText)) {
        const res = await (this.client.im.message as any).update({
          path: { message_id: messageId },
          data: { msg_type: "text", content: JSON.stringify({ text: fullText }) },
        });
        if ((res as any).code === 0 || (res as any).code === undefined) return true;
        this.log("WARN", `飞书 text update 失败: code=${(res as any).code}, msg=${(res as any).msg}`);
        return false;
      }
      const { content, msgType } = this.formatStreamForSend(text, title, true);
      if (msgType !== "interactive") return false;
      const res = await (this.client.im.message as any).patch({
        path: { message_id: messageId },
        data: { content },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) return true;
      this.log("WARN", `飞书 PATCH 失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return false;
    } catch (e: any) {
      this.log("WARN", `飞书消息更新失败 (${messageId}): ${e?.message ?? e}`);
      return false;
    }
  }

  /** CardKit 流式：创建 streaming_mode 卡片实体，返回 card_id 与固定 element_id */
  async createStreamingCardEntity(title?: string): Promise<{ cardId: string; elementId: string } | null> {
    try {
      const card: Record<string, unknown> = {
        schema: "2.0",
        config: {
          streaming_mode: true,
          update_multi: true,
          wide_screen_mode: true,
          summary: { content: "" },
        },
        body: {
          elements: [{ tag: "markdown", element_id: STREAM_ELEMENT_ID, content: "" }],
        },
      };
      if (title) {
        card.header = { title: { tag: "plain_text", content: title }, template: "turquoise" };
      }
      const res = await this.client.request({
        method: "POST",
        url: "/open-apis/cardkit/v1/cards",
        data: { type: "card_json", data: JSON.stringify(card) },
      }) as { code?: number; msg?: string; data?: { card_id?: string } };
      if (res?.code !== 0) {
        this.log("WARN", `CardKit 创建卡片失败: code=${res?.code}, msg=${res?.msg}`);
        return null;
      }
      const cardId = res?.data?.card_id;
      if (!cardId) {
        this.log("WARN", "CardKit 创建卡片失败: 无 card_id");
        return null;
      }
      return { cardId, elementId: STREAM_ELEMENT_ID };
    } catch (e: unknown) {
      this.log("WARN", `CardKit 创建卡片异常: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** CardKit 流式：发送引用 card_id 的 interactive 消息（可选 reply 到 inbound，NF2） */
  async sendStreamingCardMessage(chatId: string, cardId: string, replyMessageId?: string): Promise<string | null> {
    try {
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      if (replyMessageId && !replyMessageId.startsWith("internal_")) {
        const res = await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: { content, msg_type: "interactive" },
        }) as { code?: number; msg?: string; data?: { message_id?: string } };
        if (res?.code !== 0) {
          this.log("WARN", `CardKit reply 发送失败: code=${res?.code}, msg=${res?.msg}`);
          return null;
        }
        return res?.data?.message_id ?? null;
      }
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" as any },
        data: { receive_id: chatId, content, msg_type: "interactive" },
      }) as { code?: number; msg?: string; data?: { message_id?: string } };
      if (res?.code !== 0) {
        this.log("WARN", `CardKit 发送卡片消息失败: code=${res?.code}, msg=${res?.msg}`);
        return null;
      }
      return res?.data?.message_id ?? null;
    } catch (e: unknown) {
      this.log("WARN", `CardKit 发送卡片消息异常: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** CardKit 流式：更新元素全文（sequence 递增）；含 @ 标签时不支持，返回 false 供降级 */
  async updateStreamingCardText(cardId: string, elementId: string, text: string, sequence: number): Promise<boolean> {
    try {
      const fullText = `${this.messagePrefix}${text}`;
      if (LarkSender.containsAtTag(fullText)) return false;
      const content = fullText.replace(/\\/g, "\\\\");
      const res = await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
        data: { content, sequence, uuid: randomUUID() },
      }) as { code?: number; msg?: string };
      if (res?.code !== 0) {
        this.log("WARN", `CardKit 流式更新失败: code=${res?.code}, msg=${res?.msg}`);
        return false;
      }
      return true;
    } catch (e: unknown) {
      this.log("WARN", `CardKit 流式更新异常: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** 合并批次 CardKit：创建非流式可 PATCH 卡片实体（含按钮占位） */
  async createMergeBatchCardEntity(view: MergeBatchCardView): Promise<{ cardId: string; elementId: string } | null> {
    try {
      const escapedBody = view.bodyMarkdown.replace(/\\/g, "\\\\");
      const escapedFooter = view.footerText.replace(/\\/g, "\\\\");
      const card: Record<string, unknown> = {
        schema: "2.0",
        config: { wide_screen_mode: true, update_multi: true },
        header: { title: { tag: "plain_text", content: view.title }, template: "blue" },
        body: {
          elements: [
            {
              tag: "markdown",
              element_id: MERGE_BATCH_ELEMENT_ID,
              content: `${escapedBody}\n\n---\n*${escapedFooter}*`,
            },
            {
              tag: "action",
              actions: [
                { tag: "button", text: { tag: "plain_text", content: "立即发送" }, type: "primary", value: { action: "merge_send_now" } },
                { tag: "button", text: { tag: "plain_text", content: "编辑" }, type: "default", value: { action: "merge_edit" } },
                { tag: "button", text: { tag: "plain_text", content: "拆开逐条" }, type: "default", value: { action: "merge_split" } },
              ],
            },
          ],
        },
      };
      const res = await this.client.request({
        method: "POST",
        url: "/open-apis/cardkit/v1/cards",
        data: { type: "card_json", data: JSON.stringify(card) },
      }) as { code?: number; msg?: string; data?: { card_id?: string } };
      if (res?.code !== 0) {
        this.log("WARN", `合并 CardKit 创建失败: code=${res?.code}, msg=${res?.msg}`);
        return null;
      }
      const cardId = res?.data?.card_id;
      if (!cardId) {
        this.log("WARN", "合并 CardKit 创建失败: 无 card_id");
        return null;
      }
      return { cardId, elementId: MERGE_BATCH_ELEMENT_ID };
    } catch (e: unknown) {
      this.log("WARN", `合并 CardKit 创建异常: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** 合并批次 CardKit：发送卡片消息（可选 reply 到 inbound） */
  async sendMergeBatchCardMessage(chatId: string, cardId: string, replyMessageId?: string): Promise<string | null> {
    try {
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      if (replyMessageId && !replyMessageId.startsWith("internal_")) {
        const res = await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: { content, msg_type: "interactive" },
        }) as { code?: number; msg?: string; data?: { message_id?: string } };
        if (res?.code !== 0) {
          this.log("WARN", `合并 CardKit reply 失败: code=${res?.code}, msg=${res?.msg}`);
          return null;
        }
        return res?.data?.message_id ?? null;
      }
      return this.sendStreamingCardMessage(chatId, cardId);
    } catch (e: unknown) {
      this.log("WARN", `合并 CardKit 发送异常: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** 合并批次 CardKit：PATCH 更新正文元素（单 outbound_message_id 全程更新） */
  async updateMergeBatchCardBody(
    cardId: string,
    elementId: string,
    view: MergeBatchCardView,
    sequence: number,
  ): Promise<boolean> {
    try {
      const escapedBody = view.bodyMarkdown.replace(/\\/g, "\\\\");
      const escapedFooter = view.footerText.replace(/\\/g, "\\\\");
      const content = `${escapedBody}\n\n---\n*${escapedFooter}*`;
      const res = await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
        data: { content, sequence, uuid: randomUUID() },
      }) as { code?: number; msg?: string };
      if (res?.code !== 0) {
        this.log("WARN", `合并 CardKit PATCH 失败: code=${res?.code}, msg=${res?.msg}`);
        return false;
      }
      return true;
    } catch (e: unknown) {
      this.log("WARN", `合并 CardKit PATCH 异常: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /**
   * 合并批次 CardKit：创建或 PATCH 更新单卡。
   * ponytail: 按钮占位，回调由 T8 接线；超 MERGE_CARD_MAX_ITEMS 时正文截断由调用方处理。
   */
  async renderMergeBatchCard(
    chatId: string,
    view: MergeBatchCardView,
    existing?: MergeBatchCardState,
    replyMessageId?: string,
  ): Promise<MergeBatchCardState | null> {
    if (existing?.cardEntityId && existing.cardMessageId) {
      const seq = (existing.cardSequence ?? 0) + 1;
      const ok = await this.updateMergeBatchCardBody(existing.cardEntityId, MERGE_BATCH_ELEMENT_ID, view, seq);
      if (ok) return { ...existing, cardSequence: seq };
      this.log("WARN", "合并 CardKit PATCH 失败，保留旧卡状态");
      return existing;
    }
    const entity = await this.createMergeBatchCardEntity(view);
    if (!entity) return null;
    const msgId = await this.sendMergeBatchCardMessage(chatId, entity.cardId, replyMessageId);
    if (!msgId) return null;
    return { cardEntityId: entity.cardId, cardMessageId: msgId, cardSequence: 1 };
  }

  /** 工具进度 CardKit：创建可 PATCH 卡片实体 */
  async createToolProgressCardEntity(
    toolName: string,
    status: "started" | "completed" | "failed",
  ): Promise<{ cardId: string; elementId: string } | null> {
    try {
      const escapedName = toolName.replace(/\\/g, "\\\\");
      const statusLabel = formatToolStatusLabel(status);
      const card: Record<string, unknown> = {
        schema: "2.0",
        config: { wide_screen_mode: true, update_multi: true },
        header: { title: { tag: "plain_text", content: "工具执行" }, template: "wathet" },
        body: {
          elements: [{
            tag: "markdown",
            element_id: TOOL_PROGRESS_ELEMENT_ID,
            content: `🔧 **${escapedName}**\n状态：${statusLabel}`,
          }],
        },
      };
      const res = await this.client.request({
        method: "POST",
        url: "/open-apis/cardkit/v1/cards",
        data: { type: "card_json", data: JSON.stringify(card) },
      }) as { code?: number; msg?: string; data?: { card_id?: string } };
      if (res?.code !== 0) {
        this.log("WARN", `工具 CardKit 创建失败: code=${res?.code}, msg=${res?.msg}`);
        return null;
      }
      const cardId = res?.data?.card_id;
      if (!cardId) {
        this.log("WARN", "工具 CardKit 创建失败: 无 card_id");
        return null;
      }
      return { cardId, elementId: TOOL_PROGRESS_ELEMENT_ID };
    } catch (e: unknown) {
      this.log("WARN", `工具 CardKit 创建异常: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** 工具进度 CardKit：PATCH 更新 tool_name + status */
  async updateToolProgressCardBody(
    cardId: string,
    elementId: string,
    toolName: string,
    status: "started" | "completed" | "failed",
    sequence: number,
  ): Promise<boolean> {
    try {
      const escapedName = toolName.replace(/\\/g, "\\\\");
      const statusLabel = formatToolStatusLabel(status);
      const content = `🔧 **${escapedName}**\n状态：${statusLabel}`;
      const res = await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
        data: { content, sequence, uuid: randomUUID() },
      }) as { code?: number; msg?: string };
      if (res?.code !== 0) {
        this.log("WARN", `工具 CardKit PATCH 失败: code=${res?.code}, msg=${res?.msg}`);
        return false;
      }
      return true;
    } catch (e: unknown) {
      this.log("WARN", `工具 CardKit PATCH 异常: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /**
   * 工具进度 CardKit：创建或 PATCH 单卡。
   * started 且无 existing 时发新消息；后续 PATCH 同 entity。
   */
  async renderToolProgressCard(
    chatId: string,
    toolName: string,
    status: "started" | "completed" | "failed",
    existing?: PresentationCardState,
    replyMessageId?: string,
  ): Promise<PresentationCardState | null> {
    if (existing?.cardEntityId && existing.cardMessageId) {
      const seq = (existing.cardSequence ?? 0) + 1;
      const ok = await this.updateToolProgressCardBody(
        existing.cardEntityId, TOOL_PROGRESS_ELEMENT_ID, toolName, status, seq,
      );
      if (ok) return { ...existing, cardSequence: seq };
      this.log("WARN", "工具 CardKit PATCH 失败，保留旧卡状态");
      return existing;
    }
    const entity = await this.createToolProgressCardEntity(toolName, status);
    if (!entity) return null;
    const msgId = await this.sendStreamingCardMessage(chatId, entity.cardId, replyMessageId);
    if (!msgId) return null;
    return { cardEntityId: entity.cardId, cardMessageId: msgId, cardSequence: 1 };
  }

  /** 思考摘要 CardKit：创建可 PATCH 卡片实体 */
  async createThinkingCardEntity(summary: string): Promise<{ cardId: string; elementId: string } | null> {
    try {
      const escaped = summary.replace(/\\/g, "\\\\");
      const card: Record<string, unknown> = {
        schema: "2.0",
        config: { wide_screen_mode: true, update_multi: true },
        header: { title: { tag: "plain_text", content: "思考中" }, template: "grey" },
        body: {
          elements: [{
            tag: "markdown",
            element_id: THINKING_ELEMENT_ID,
            content: escaped || "…",
          }],
        },
      };
      const res = await this.client.request({
        method: "POST",
        url: "/open-apis/cardkit/v1/cards",
        data: { type: "card_json", data: JSON.stringify(card) },
      }) as { code?: number; msg?: string; data?: { card_id?: string } };
      if (res?.code !== 0) {
        this.log("WARN", `思考 CardKit 创建失败: code=${res?.code}, msg=${res?.msg}`);
        return null;
      }
      const cardId = res?.data?.card_id;
      if (!cardId) {
        this.log("WARN", "思考 CardKit 创建失败: 无 card_id");
        return null;
      }
      return { cardId, elementId: THINKING_ELEMENT_ID };
    } catch (e: unknown) {
      this.log("WARN", `思考 CardKit 创建异常: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** 思考摘要 CardKit：PATCH 更新正文 */
  async updateThinkingCardBody(
    cardId: string,
    elementId: string,
    summary: string,
    sequence: number,
  ): Promise<boolean> {
    try {
      const content = summary.replace(/\\/g, "\\\\") || "…";
      const res = await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
        data: { content, sequence, uuid: randomUUID() },
      }) as { code?: number; msg?: string };
      if (res?.code !== 0) {
        this.log("WARN", `思考 CardKit PATCH 失败: code=${res?.code}, msg=${res?.msg}`);
        return false;
      }
      return true;
    } catch (e: unknown) {
      this.log("WARN", `思考 CardKit PATCH 异常: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** 思考摘要 CardKit：创建或 PATCH 单卡 */
  async renderThinkingCard(
    chatId: string,
    summary: string,
    existing?: PresentationCardState,
    replyMessageId?: string,
  ): Promise<PresentationCardState | null> {
    if (existing?.cardEntityId && existing.cardMessageId) {
      const seq = (existing.cardSequence ?? 0) + 1;
      const ok = await this.updateThinkingCardBody(existing.cardEntityId, THINKING_ELEMENT_ID, summary, seq);
      if (ok) return { ...existing, cardSequence: seq };
      this.log("WARN", "思考 CardKit PATCH 失败，保留旧卡状态");
      return existing;
    }
    const entity = await this.createThinkingCardEntity(summary);
    if (!entity) return null;
    const msgId = await this.sendStreamingCardMessage(chatId, entity.cardId, replyMessageId);
    if (!msgId) return null;
    return { cardEntityId: entity.cardId, cardMessageId: msgId, cardSequence: 1 };
  }

  /** CardKit 流式：关闭 streaming_mode（final 时调用） */
  async closeStreamingCardMode(cardId: string, sequence: number): Promise<boolean> {
    try {
      const res = await this.client.request({
        method: "PATCH",
        url: `/open-apis/cardkit/v1/cards/${cardId}/settings`,
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence,
          uuid: randomUUID(),
        },
      }) as { code?: number; msg?: string };
      if (res?.code !== 0) {
        this.log("WARN", `CardKit 关闭流式模式失败: code=${res?.code}, msg=${res?.msg}`);
        return false;
      }
      return true;
    } catch (e: unknown) {
      this.log("WARN", `CardKit 关闭流式模式异常: ${e instanceof Error ? e.message : e}`);
      return false;
    }
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
    } catch (e: any) { this.log("ERROR", `飞书回复异常: ${e?.message ?? e}`); return undefined; }
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
          const senderType: string = senderObj?.sender_type ?? "user";
          this.log("DEBUG", `sender raw: ${JSON.stringify(senderObj)}`);
          const parentId: string = msg?.parent_id ?? "";
          const mentions: LarkMention[] = (msg?.mentions ?? []).map((m: any) => ({ key: m.key ?? "", id: m.id?.open_id ?? "", name: m.name ?? "" }));
          onMessage({ text, messageId, chatId, chatType, messageType, rawContent, senderOpenId, senderType, parentId: parentId || undefined, mentions });
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
  /** "user" | "app"（app = 其他机器人发送） */
  senderType?: string;
  parentId?: string;
  mentions: LarkMention[];
}
