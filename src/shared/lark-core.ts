import { DEFAULT_NODE_GROUP_ID, encodeRepoPair } from "./project-types.js";
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
  /** 分组标题：与上一按钮不同时，在该按钮前插入 markdown 分段 */
  section?: string;
}

/** 卡片标题：字符串，或主标题 + 副标题（分支等小字） */
export type CardTitle = string | { title: string; subtitle?: string };

export interface CardInput {
  placeholder: string;
  /** 回传交互数据，用户提交输入时随 input_value 一起返回 */
  value: unknown;
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

  /** 文本中含 `<at user_id="ou_xxx">` 标签时需用 text 消息发送才能产生真实 mention（触发被 @ 机器人的事件推送）。
   * 代码块/行内代码里的 at 语法只是引用示例，先剥离再判断，否则技术讨论消息会被误降级为纯文本。 */
  static containsAtTag(text: string): boolean {
    const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    return /<at\s+user_id=/.test(stripped);
  }

  private formatForSend(text: string, title?: CardTitle, template?: string): { content: string; msgType: string } {
    const fullText = `${this.messagePrefix}${text}`;
    if (LarkSender.containsAtTag(fullText)) {
      return { content: JSON.stringify({ text: fullText }), msgType: "text" };
    }
    return { content: JSON.stringify(LarkSender.buildCard(fullText, title, undefined, undefined, template)), msgType: "interactive" };
  }

  /** 按显示宽度计数（CJK/emoji 算 2，半角算 1）；.length 会低估中文导致窄屏按钮文字被截为 "..." */
  private static displayWidth(s: string): number {
    let w = 0;
    for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    return w;
  }

  private static normalizeCardTitle(title?: CardTitle): { title?: string; subtitle?: string } {
    if (!title) return {};
    if (typeof title === "string") return { title };
    return { title: title.title, subtitle: title.subtitle };
  }

  /** 正文色条底色（RGB）；与会话色板枚举一一对应。飞书 header 渲染有客户端 bug（同一卡片时有时无背景色），改为正文自绘规避 */
  private static readonly BANNER_RGB: Record<string, string> = {
    turquoise: "16,166,166",
    blue: "51,109,244",
    wathet: "58,142,230",
    indigo: "97,81,244",
    violet: "180,74,224",
    purple: "124,88,246",
    carmine: "235,54,146",
    orange: "255,136,0",
    red: "245,74,82",
    yellow: "255,197,26",
    green: "52,199,36",
    grey: "142,142,147",
    default: "142,142,147",
  };

  /** 正文分段：每段 markdown 后紧跟该段按钮（用于 /s 等「标题+信息+按钮」同区） */
  static appendButtonRows(elements: any[], buttons: CardButton[], opts?: { showSection?: boolean; singleCol?: boolean }): void {
    if (!buttons.length) return;
    const groups: { section?: string; items: CardButton[] }[] = [];
    for (const b of buttons) {
      const last = groups[groups.length - 1];
      if (!last || last.section !== b.section) groups.push({ section: b.section, items: [b] });
      else last.items.push(b);
    }
    const toButton = (b: CardButton) => ({
      tag: "button",
      text: { tag: "plain_text", content: b.label.slice(0, 100) },
      type: b.type ?? "primary",
      width: "default",
      behaviors: [{ type: "callback", value: b.value }],
    });
    const leftRow = (row: CardButton[]) => ({
      tag: "column_set",
      horizontal_align: "left",
      horizontal_spacing: "8px",
      columns: row.map((b) => ({
        tag: "column", width: "auto", elements: [toButton(b)],
      })),
    });
    for (const g of groups) {
      if (opts?.showSection !== false && g.section) {
        elements.push({ tag: "markdown", content: `**${g.section}**` });
      }
      if (opts?.singleCol) {
        for (const b of g.items) elements.push(leftRow([b]));
        continue;
      }
      const maxPerRow = (w: number) => (w <= 6 ? 3 : w <= 12 ? 2 : 1);
      let row: CardButton[] = [];
      const flush = () => {
        if (row.length) { elements.push(leftRow(row)); row = []; }
      };
      for (const b of g.items) {
        const tryRow = [...row, b];
        const limit = Math.min(...tryRow.map((x) => maxPerRow(LarkSender.displayWidth(x.label))));
        if (row.length > 0 && tryRow.length > limit) flush();
        row.push(b);
      }
      flush();
    }
  }

  /**
   * 构造 schema 2.0 markdown 卡片。
   * sections 优先：每段正文后紧跟该段按钮（不再把所有按钮堆到卡片底部）。
   */
  static buildCard(
    text: string,
    title?: CardTitle,
    buttons?: CardButton[],
    input?: CardInput,
    template?: string,
    footer?: string,
    sections?: { text: string; buttons?: CardButton[] }[],
  ): any {
    const elements: any[] = [];
    if (sections && sections.length > 0) {
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const md = sec.text.replace(/\s+$/u, "");
        if (md) elements.push({ tag: "markdown", content: md });
        if (sec.buttons?.length) LarkSender.appendButtonRows(elements, sec.buttons, { showSection: false });
        if (i < sections.length - 1) elements.push({ tag: "hr" });
      }
    } else {
      const body = text.replace(/\s+$/u, "");
      elements.push({ tag: "markdown", content: body });
    }
    const btns = sections?.length ? [] : (buttons ?? []);
    const foot = footer?.replace(/^\s+|\s+$/gu, "");
    if (foot || (input && (btns.length > 0 || sections?.some((s) => s.buttons?.length)))) elements.push({ tag: "hr" });
    if (foot) elements.push({ tag: "markdown", content: foot });
    if (btns.length > 0) LarkSender.appendButtonRows(elements, btns, { singleCol: !!input });
    if (input) {
      elements.push({
        tag: "input",
        name: "custom_input",
        input_type: "multiline_text",
        width: "fill",
        rows: 1,
        auto_resize: true,
        max_rows: 8,
        placeholder: { tag: "plain_text", content: input.placeholder.slice(0, 100) },
        label_position: "top",
        behaviors: [{ type: "callback", value: input.value }],
      });
    }
    const card: any = {
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      body: { horizontal_align: "left", elements },
    };
    const { title: titleText, subtitle } = LarkSender.normalizeCardTitle(title);
    if (titleText) {
      const esc = (s: string) => s.slice(0, 100);
      const t = esc(titleText);
      const sub = subtitle ? esc(subtitle) : undefined;
      const oneLine = sub && LarkSender.displayWidth(t) + LarkSender.displayWidth(sub) + 3 <= 36;
      const content = sub ? (oneLine ? `**${t}** · ${sub}` : `**${t}**\n${sub}`) : `**${t}**`;
      const rgb = LarkSender.BANNER_RGB[template || ""] ?? LarkSender.BANNER_RGB.turquoise;
      card.config.style = {
        color: { "cus-hdr": { light_mode: `rgba(${rgb},0.14)`, dark_mode: `rgba(${rgb},0.26)` } },
      };
      elements.unshift({
        tag: "column_set",
        margin: "0px 0px 8px 0px",
        columns: [{
          tag: "column",
          width: "weighted",
          weight: 1,
          background_style: "cus-hdr",
          padding: "6px 10px 6px 10px",
          vertical_align: "center",
          elements: [{ tag: "markdown", content, text_size: "notation" }],
        }],
      });
    }
    return card;
  }

  /** 项目创建大表单（一次提交；主仓/流程组可空） */
  static buildProjectNewFormCard(opts: {
    title?: string
    repoProfiles?: { path: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
    /** @deprecated 兼容旧调用 */
    repoRoots?: string[]
    worktreeRoot?: string
    nodeGroups?: { id: string; name: string }[]
  }): any {
    type Profile = { path: string; baseBranch: string; testBranch?: string; developBranch?: string }
    const profiles: Profile[] = (opts.repoProfiles && opts.repoProfiles.length)
      ? opts.repoProfiles
      : (opts.repoRoots || []).map((p) => ({ path: p, baseBranch: "main" }))
    const defaultGroupName = opts.nodeGroups?.find((g) => g.id === DEFAULT_NODE_GROUP_ID)?.name
      || opts.nodeGroups?.[0]?.name
      || "开发"
    const elements: any[] = []

    const field = (name: string, label: string | null, placeholder: string, required?: boolean, defaultValue?: string) => {
      const el: any = {
        tag: "input",
        name,
        required: !!required,
        placeholder: { tag: "plain_text", content: placeholder.replace(/\\/g, "/").slice(0, 100) },
        label_position: "top",
        width: "fill",
      }
      if (label) {
        el.label = { tag: "plain_text", content: label }
      }
      if (defaultValue) el.default_value = defaultValue.replace(/\\/g, "/")
      return el
    }

    const formElements: any[] = [
      field("name", "项目名称", "例如 login", true),
    ]

    const groups = opts.nodeGroups || []
    if (groups.length > 0) {
      formElements.push({ tag: "markdown", content: "流程组（可多选）" })
      formElements.push({
        tag: "multi_select_static",
        name: "group_ids",
        required: false,
        width: "fill",
        placeholder: { tag: "plain_text", content: `不选则默认「${defaultGroupName.slice(0, 20)}」` },
        options: groups.slice(0, 20).map((g) => ({
          text: { tag: "plain_text", content: g.name.slice(0, 30) },
          value: g.id,
        })),
      })
    }

    // 独立群模式：建项后自动建项目专属群，协作在群里进行（不选默认独立群）
    const chatModeSelect = [
      { tag: "markdown", content: "会话模式" },
      {
        tag: "select_static",
        name: "chatMode",
        required: false,
        width: "fill",
        placeholder: { tag: "plain_text", content: "默认「独立群」：自动建群并在群里协作" },
        options: [
          { text: { tag: "plain_text", content: "独立群（推荐）：自动建项目群" }, value: "group" },
          { text: { tag: "plain_text", content: "当前会话：沿用现有单聊模式" }, value: "inline" },
        ],
      },
    ]

    const encode = encodeRepoPair
    const labelOf = (rp: string, b: string, t?: string, d?: string) => {
      const remote = /^(https?:\/\/|ssh:\/\/|git@)/i.test(rp.trim())
      const norm = rp.replace(/\\/g, "/").replace(/\/+$/, "")
      const name = (norm.split("/").pop() || norm).replace(/\.git$/i, "")
      return [`${remote ? "☁ " : ""}${name}`, b || "main", t || "", d || ""].filter((x) => !!x).join(" · ").slice(0, 50)
    }

    if (profiles.length > 0) {
      formElements.push({ tag: "markdown", content: "主仓·分支（可多选历史项；也可下方追加）" })
      formElements.push({
        tag: "multi_select_static",
        name: "repoPairs",
        required: false,
        placeholder: { tag: "plain_text", content: "点此选择主仓·分支（可多选，可空）" },
        options: profiles.slice(0, 50).map((pr) => ({
          text: { tag: "plain_text", content: labelOf(pr.path, pr.baseBranch, pr.testBranch, pr.developBranch) },
          value: encode(pr.path, pr.baseBranch, pr.testBranch, pr.developBranch),
        })),
      })
    }

    formElements.push({ tag: "markdown", content: profiles.length ? "追加主仓·分支（可空）" : "主仓·分支（可空）" })
    formElements.push(
      field("repoPathCustom", null, "主仓本地路径或远程地址（https/git@）", false),
      field("baseBranchCustom", null, "生产基线分支，例如 main", false),
      field("testBranchCustom", null, "测试分支，可空，例如 test"),
      field("developBranchCustom", null, "开发分支，可空，例如 develop"),
      field("worktreeRoot", "AI 工作目录", "各主仓将独立 checkout 到此目录下；无仓时仅建项目目录", false, opts.worktreeRoot || undefined),
      field("featureBranch", "feature 分支", "可空，默认 feature/yyMMdd-名；已存在则复用"),
      field("storyUrl", "飞书项目链接", "可空"),
      field("productDocUrl", "产品文档", "可空"),
      field("techDocUrl", "技术文档", "可空"),
      field("goal", "目标描述", "可空，可后续再定"),
      ...chatModeSelect,
      {
        tag: "button",
        name: "submit",
        text: { tag: "plain_text", content: "创建项目" },
        type: "primary",
        form_action_type: "submit",
        behaviors: [{
          type: "callback",
          value: {
            kind: "project_new_form",
            worktreeRoot: opts.worktreeRoot || "",
            groupId: "",
            groupIds: [],
            workspaceType: "worktree",
          },
        }],
      },
    )

    elements.push({ tag: "form", name: "project_new", elements: formElements })
    LarkSender.appendButtonRows(elements, [{ label: "← 返回菜单", value: { kind: "cmd", cmd: "/p menu --back" }, type: "default" }])

    return {
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      header: {
        title: { tag: "plain_text", content: opts.title || "创建项目" },
        template: "orange",
      },
      body: { horizontal_align: "left", elements },
    }
  }

  /** /p setup 添加主仓表单：路径+基线+测试+开发一次填完提交 */
  static buildRepoSetupFormCard(opts?: { title?: string; prefix?: string }): any {
    const field = (name: string, placeholder: string, required?: boolean) => ({
      tag: "input",
      name,
      required: !!required,
      placeholder: { tag: "plain_text", content: placeholder.slice(0, 100) },
      label_position: "top",
      width: "fill",
    })
    const elements: any[] = [
      { tag: "markdown", content: `${opts?.prefix || ""}一次填完提交；红 * 为必填。生产基线只作切分支起点，不会成为交付目标。` },
      {
        tag: "form",
        name: "repo_setup",
        elements: [
          field("repoPath", "主仓本地路径或远程地址（https/git@）", true),
          field("baseBranch", "生产基线分支，例如 main", true),
          field("testBranch", "测试分支，可空"),
          field("developBranch", "开发分支，可空"),
          {
            tag: "button",
            name: "submit",
            text: { tag: "plain_text", content: "保存主仓" },
            type: "primary",
            form_action_type: "submit",
            behaviors: [{ type: "callback", value: { kind: "repo_setup_form" } }],
          },
        ],
      },
    ]
    LarkSender.appendButtonRows(elements, [{ label: "← 返回 setup", value: { kind: "cmd", cmd: "/p setup" }, type: "default" }])
    return {
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      header: {
        title: { tag: "plain_text", content: opts?.title || "添加主仓" },
        template: "orange",
      },
      body: { horizontal_align: "left", elements },
    }
  }

  /** patch 任意卡片 JSON（单卡多视图导航用：原卡在 总览↔表单 间跳转） */
  async patchRawCard(messageId: string, card: any): Promise<boolean> {
    if (!messageId || messageId.startsWith("internal_")) return false
    try {
      const res = await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      const code = (res as any)?.code
      if (code !== undefined && code !== 0) {
        this.log("WARN", `卡片视图切换失败 code=${code} (${messageId})`)
        return false
      }
      return true
    } catch (e: any) {
      this.log("WARN", `卡片视图切换异常 (${messageId}): ${e?.message ?? e}`)
      return false
    }
  }

  /** /p setup 单字段表单：worktree 目录 / GitLab 配置（卡内输入框，提交回调保存，原卡回总览） */
  static buildSetupFieldFormCard(opts: {
    form: "worktree" | "gitlab"
    worktreeRoot?: string
    gitlabHost?: string
    tokenMasked?: string
  }): any {
    const field = (name: string, label: string, placeholder: string, required?: boolean, defaultValue?: string) => {
      const el: any = {
        tag: "input",
        name,
        required: !!required,
        label: { tag: "plain_text", content: label },
        placeholder: { tag: "plain_text", content: placeholder.slice(0, 100) },
        label_position: "top",
        width: "fill",
      }
      if (defaultValue) el.default_value = defaultValue.replace(/\\/g, "/")
      return el
    }
    const isWorktree = opts.form === "worktree"
    const formElements: any[] = isWorktree
      ? [
        field("worktreeRoot", "AI 工作目录", "绝对路径，例如 D:/claw-projects", true, opts.worktreeRoot),
        {
          tag: "button", name: "submit", text: { tag: "plain_text", content: "保存" }, type: "primary",
          form_action_type: "submit",
          behaviors: [{ type: "callback", value: { kind: "setup_worktree_form" } }],
        },
      ]
      : [
        Object.assign(field("gitlabToken", "GitLab Token", `当前 ${opts.tokenMasked || "（未设置）"}；留空保持不变`), { input_type: "password" }),
        field("gitlabHost", "GitLab Host", `当前 ${opts.gitlabHost || "默认从 origin 推断"}；留空保持不变，填 clear 清空`),
        {
          tag: "button", name: "submit", text: { tag: "plain_text", content: "保存" }, type: "primary",
          form_action_type: "submit",
          behaviors: [{ type: "callback", value: { kind: "setup_gitlab_form" } }],
        },
      ]
    const elements: any[] = [
      { tag: "markdown", content: isWorktree ? "项目 worktree 将在此目录下创建；不存在会自动创建。" : "保存后立即生效；Token 仅用于开提测 MR。" },
      { tag: "form", name: `setup_${opts.form}`, elements: formElements },
    ]
    LarkSender.appendButtonRows(elements, [{ label: "← 返回 setup", value: { kind: "cmd", cmd: "/p setup" }, type: "default" }])
    return {
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      header: {
        title: { tag: "plain_text", content: isWorktree ? "设置工作区目录" : "设置 GitLab" },
        template: "orange",
      },
      body: { horizontal_align: "left", elements },
    }
  }
  async sendInteractiveCard(card: any, replyMessageId?: string, chatId?: string): Promise<string | null | undefined> {
    const content = JSON.stringify(card)
    if (replyMessageId && !replyMessageId.startsWith("internal_")) {
      try {
        const res = await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: { content, msg_type: "interactive" },
        })
        const code = (res as any)?.code
        const mid = ((res as any)?.data?.message_id ?? (res as any)?.message_id) as string | undefined
        if (code !== undefined && code !== 0) {
          this.log("WARN", `交互卡片回复失败 code=${code}`)
          return undefined
        }
        return mid ?? null
      } catch (e: any) {
        this.log("WARN", `交互卡片回复失败: ${e?.message ?? e}${e?.response?.data ? " " + JSON.stringify(e.response.data).slice(0, 500) : ""}`)
        return undefined
      }
    }
    const target = chatId || this.chatId
    if (!target) return undefined
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: target, content, msg_type: "interactive" },
      })
      return ((res as any)?.data?.message_id ?? (res as any)?.message_id) as string | undefined
    } catch (e: any) {
      this.log("WARN", `交互卡片发送失败: ${e?.message ?? e}${e?.response?.data ? " " + JSON.stringify(e.response.data).slice(0, 500) : ""}`)
      return undefined
    }
  }

  /** Hermes 流式卡：思考折叠面板（≤20 字符） */
  static readonly STREAM_THINK_ID = "think_panel";
  /** Hermes 流式卡：工具折叠面板（≤20 字符） */
  static readonly STREAM_TOOL_ID = "tool_panel";
  /** Hermes 流式卡：回复 markdown（仅此组件走 stream content 打字机） */
  static readonly STREAM_REPLY_ID = "reply_md";
  /** @deprecated 使用 STREAM_REPLY_ID */
  static readonly STREAM_ELEMENT_ID = "reply_md";

  /** 构建 Thought 折叠面板（对齐 hermes builder.py：plain_text + notation 灰字） */
  static buildThinkPanelElement(
    content: string,
    opts?: { title?: string; expanded?: boolean },
  ): Record<string, unknown> {
    return {
      tag: "collapsible_panel",
      element_id: LarkSender.STREAM_THINK_ID,
      expanded: opts?.expanded ?? false,
      header: {
        title: {
          tag: "plain_text",
          content: opts?.title || "💭 思考中…",
          text_color: "grey",
          text_size: "notation",
        },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px", color: "grey" },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [{
        tag: "markdown",
        content: content || "_（暂无）_",
        text_size: "notation",
      }],
    };
  }

  /** 单步工具行：div + standard_icon + lark_md（对齐 hermes _build_tool_step_*） */
  static buildToolStepElements(step: {
    title: string;
    status: string;
    detail?: string;
    icon?: string;
  }): Record<string, unknown>[] {
    const info =
      step.status === "running" ? { label: "Running", color: "turquoise" }
      : step.status === "error" ? { label: "Failed", color: "red" }
      : { label: "Succeeded", color: "green" };
    const title = (step.title || "tool").replace(/[*_`]/g, "");
    const elements: Record<string, unknown>[] = [{
      tag: "div",
      icon: {
        tag: "standard_icon",
        token: step.icon || "setting-inter_outlined",
        color: "grey",
      },
      text: {
        tag: "lark_md",
        content: `**${title}** · <font color='${info.color}'>${info.label}</font>`,
        text_size: "notation",
      },
    }];
    const detail = step.detail?.trim();
    if (detail) {
      elements.push({
        tag: "div",
        margin: "0px 0px 0px 22px",
        text: {
          tag: "plain_text",
          content: detail.length > 200 ? `${detail.slice(0, 200)}…` : detail,
          text_color: "grey",
          text_size: "notation",
        },
      });
    }
    return elements;
  }

  /**
   * 构建工具折叠面板。
   * steps 传结构化步骤（推荐）；传 string 时降级为整段 markdown（兼容旧调用）。
   */
  static buildToolPanelElement(
    steps: Array<{ title: string; status: string; detail?: string; icon?: string }> | string,
    opts?: { title?: string; expanded?: boolean },
  ): Record<string, unknown> {
    let elements: Record<string, unknown>[];
    if (typeof steps === "string") {
      elements = [{ tag: "markdown", content: steps || "_（暂无）_", text_size: "notation" }];
    } else if (!steps.length) {
      elements = [{ tag: "markdown", content: "_（暂无）_", text_size: "notation" }];
    } else {
      elements = steps.flatMap((s) => LarkSender.buildToolStepElements(s));
    }
    return {
      tag: "collapsible_panel",
      element_id: LarkSender.STREAM_TOOL_ID,
      expanded: opts?.expanded ?? true,
      header: {
        title: {
          tag: "plain_text",
          content: opts?.title || "🛠️ 工具执行 · 0 步",
          text_color: "grey",
          text_size: "notation",
        },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px", color: "grey" },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      vertical_spacing: "4px",
      padding: "8px 8px 8px 8px",
      elements,
    };
  }

  /** 流式卡时间线段（按执行顺序交错） */
  /** 流式卡：会话色条（目录/项目 + 分支），与 send 消息同款 */
  static buildSessionBannerElement(title: CardTitle, elementId = "session_bar"): Record<string, unknown> {
    const { title: titleText, subtitle } = LarkSender.normalizeCardTitle(title);
    const t = (titleText || "会话").slice(0, 100);
    const sub = subtitle ? subtitle.slice(0, 100) : undefined;
    const oneLine = sub && LarkSender.displayWidth(t) + LarkSender.displayWidth(sub) + 3 <= 36;
    const content = sub ? (oneLine ? `**${t}** · ${sub}` : `**${t}**\n${sub}`) : `**${t}**`;
    return {
      tag: "column_set",
      element_id: elementId,
      margin: "0px 0px 4px 0px",
      columns: [{
        tag: "column",
        width: "weighted",
        weight: 1,
        background_style: "cus-hdr",
        padding: "6px 10px 6px 10px",
        vertical_align: "center",
        elements: [{ tag: "markdown", content, text_size: "notation" }],
      }],
    };
  }


  /** 飞书 CardKit JSON 2.0：单卡组件/元素合计 ≤200（含嵌套 tag） */
  static readonly STREAM_ELEMENT_BUDGET = 180;

  /** 递归统计带 tag 的节点数（对齐飞书 300305 限额口径） */
  static countCardElements(node: unknown): number {
    if (node == null || typeof node !== "object") return 0;
    if (Array.isArray(node)) {
      return node.reduce<number>((n, x) => n + LarkSender.countCardElements(x), 0);
    }
    const rec = node as Record<string, unknown>;
    let n = typeof rec.tag === "string" ? 1 : 0;
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") n += LarkSender.countCardElements(v);
    }
    return n;
  }

  /**
   * 收敛时间线，避免工具步/思考块把元素顶破 200。
   * 优先保留：会话条、最近工具步、正文 reply、交互按钮。
   */
  static compactStreamingSegments<T extends {
    type: string;
    text?: string;
    title?: string;
    expanded?: boolean;
    steps?: Array<{ title: string; status: string; detail?: string; icon?: string }>;
  }>(segments: T[], opts?: { maxToolSteps?: number; maxThinkChars?: number; stripDetails?: boolean }): T[] {
    const maxToolSteps = opts?.maxToolSteps ?? 28;
    const maxThinkChars = opts?.maxThinkChars ?? 1200;
    const stripDetails = opts?.stripDetails ?? false;
    const out: T[] = [];
    for (const seg of segments) {
      if (seg.type === "tools") {
        let steps = [...(seg.steps || [])];
        const realCount = steps.length;
        if (stripDetails) {
          steps = steps.map((s) => ({ ...s, detail: undefined }));
        }
        if (steps.length > maxToolSteps) {
          const omitted = steps.length - maxToolSteps;
          steps = [
            { title: `… 更早 ${omitted} 步已折叠`, status: "success" },
            ...steps.slice(-maxToolSteps),
          ];
        }
        out.push({ ...seg, steps, title: `🛠️ 工具执行 · ${realCount} 步` } as T);
      } else if (seg.type === "thinking") {
        let text = seg.text || "";
        if (text.length > maxThinkChars) {
          text = "…" + text.slice(-(maxThinkChars - 1));
        }
        out.push({ ...seg, text } as T);
      } else {
        out.push(seg);
      }
    }
    // 过多折叠块时：合并靠前的 thinking，只留最后 2 个 thinking + 全部 tools/reply
    const thinkIdxs = out.map((s, i) => (s.type === "thinking" ? i : -1)).filter((i) => i >= 0);
    if (thinkIdxs.length > 2) {
      const keep = new Set(thinkIdxs.slice(-2));
      const merged: string[] = [];
      const next: T[] = [];
      for (let i = 0; i < out.length; i++) {
        const s = out[i];
        if (s.type === "thinking" && !keep.has(i)) {
          if (s.text?.trim()) merged.push(s.text.trim());
          continue;
        }
        if (s.type === "thinking" && merged.length && keep.has(i) && i === Math.min(...keep)) {
          const prefix = merged.join("\n\n");
          const text = s.text?.trim() ? `${prefix}\n\n${s.text}` : prefix;
          const clipped = text.length > maxThinkChars * 2 ? "…" + text.slice(-(maxThinkChars * 2 - 1)) : text;
          next.push({ ...s, text: clipped } as T);
          merged.length = 0;
          continue;
        }
        next.push(s);
      }
      return next;
    }
    return out;
  }

  /** 构建流式卡 JSON；会话色条 + 时间线 segments */
  static buildStreamingCardJson(opts?: {
    status?: "streaming" | "completed" | "error";
    showThinking?: boolean;
    sessionTitle?: CardTitle;
    sessionTemplate?: string;
    segments?: Array<
      | { type: "thinking"; text: string; title?: string; expanded?: boolean }
      | { type: "tools"; title?: string; expanded?: boolean; steps: Array<{ title: string; status: string; detail?: string; icon?: string }> }
      | { type: "reply"; text: string }
    >;
    thinking?: string;
    thinkingTitle?: string;
    thinkingExpanded?: boolean;
    toolsSteps?: Array<{ title: string; status: string; detail?: string; icon?: string }>;
    toolsContent?: string;
    toolsTitle?: string;
    toolsExpanded?: boolean;
    reply?: string;
    buttons?: CardButton[];
    input?: CardInput;
    footer?: string;
  }): Record<string, unknown> {
    const status = opts?.status || "streaming";
    const showThinking = opts?.showThinking !== false;
    const sessionTpl = opts?.sessionTemplate || "turquoise";
    const sessionRgb = LarkSender.BANNER_RGB[sessionTpl] ?? LarkSender.BANNER_RGB.turquoise;

    let segments = opts?.segments;
    if (!segments) {
      segments = [];
      if (showThinking) {
        segments.push({
          type: "thinking",
          text: opts?.thinking || (status === "streaming" ? "_（生成中…）_" : "_（暂无）_"),
          title: opts?.thinkingTitle,
          expanded: opts?.thinkingExpanded,
        });
      }
      segments.push({
        type: "tools",
        title: opts?.toolsTitle,
        expanded: opts?.toolsExpanded,
        steps: opts?.toolsSteps || [],
      });
      if (opts?.reply?.trim()) segments.push({ type: "reply", text: opts.reply });
    }


    const buildBodyElements = (segs: NonNullable<typeof segments>): Record<string, unknown>[] => {
      const els: Record<string, unknown>[] = [];
      if (opts?.sessionTitle) {
        els.push(LarkSender.buildSessionBannerElement(opts.sessionTitle));
      }
      let thinkIdx = 0;
      let toolIdx = 0;
      let replyIdx = 0;
      const replyCount = segs.filter((s) => s.type === "reply" && s.text.trim()).length;
      for (const seg of segs) {
        if (seg.type === "thinking") {
          if (!showThinking) continue;
          const el = LarkSender.buildThinkPanelElement(seg.text || "_（暂无）_", {
            title: seg.title || (status === "streaming" ? "💭 思考中…" : "💭 思考完成"),
            expanded: seg.expanded ?? (status === "streaming"),
          });
          el.element_id = `think_${thinkIdx++}`;
          els.push(el);
        } else if (seg.type === "tools") {
          const el = LarkSender.buildToolPanelElement(seg.steps || [], {
            title: seg.title || `🛠️ 工具执行 · ${(seg.steps || []).length} 步`,
            expanded: seg.expanded ?? true,
          });
          el.element_id = `tool_${toolIdx++}`;
          els.push(el);
        } else if (seg.text.trim()) {
          const isLastReply = replyIdx === replyCount - 1;
          els.push({
            tag: "markdown",
            content: seg.text,
            element_id: isLastReply ? LarkSender.STREAM_REPLY_ID : `reply_${replyIdx}`,
          });
          replyIdx++;
        }
      }
      const buttons = opts?.buttons ?? [];
      const input = opts?.input;
      const foot = opts?.footer?.replace(/^\s+|\s+$/gu, "");
      if (foot || (input && buttons.length > 0)) els.push({ tag: "hr" });
      if (foot) els.push({ tag: "markdown", content: foot });
      if (buttons.length > 0) LarkSender.appendButtonRows(els, buttons, { singleCol: !!input });
      if (input) {
        els.push({
          tag: "input",
          name: "custom_input",
          input_type: "multiline_text",
          width: "fill",
          rows: 1,
          auto_resize: true,
          max_rows: 8,
          placeholder: { tag: "plain_text", content: input.placeholder.slice(0, 100) },
          label_position: "top",
          behaviors: [{ type: "callback", value: input.value }],
        });
      }
      return els;
    };

    // 飞书 300305：单卡组件/元素合计 ≤200；按真实元素计数逐级收敛，不超不降级（保住工具详情）
    let elements = buildBodyElements(segments);
    for (const level of [
      { maxToolSteps: 28, maxThinkChars: 1200, stripDetails: false },
      { maxToolSteps: 16, maxThinkChars: 800, stripDetails: true },
      { maxToolSteps: 8, maxThinkChars: 500, stripDetails: true },
      { maxToolSteps: 4, maxThinkChars: 300, stripDetails: true },
    ] as const) {
      if (LarkSender.countCardElements(elements) <= LarkSender.STREAM_ELEMENT_BUDGET) break;
      elements = buildBodyElements(LarkSender.compactStreamingSegments(segments, level));
    }

    const interactive = (opts?.buttons?.length ?? 0) > 0 || !!opts?.input;
    return {
      schema: "2.0",
      config: {
        streaming_mode: status === "streaming" && !interactive,
        update_multi: true,
        width_mode: "fill",
        summary: { content: status === "streaming" ? "思考中…" : status === "completed" ? "已完成" : "出错" },
        style: {
          color: {
            "cus-hdr": {
              light_mode: `rgba(${sessionRgb},0.14)`,
              dark_mode: `rgba(${sessionRgb},0.26)`,
            },
          },
        },
      },
      body: { horizontal_align: "left", elements },
    };
  }

  /**
   * 创建 Hermes 风格 CardKit 流式卡片（schema 2.0 + streaming_mode）。
   * 按 segments 时间线渲染；仅最后一段 reply 使用 reply_md 以便打字机。
   */
  async createStreamingCardEntity(opts?: {
    title?: string;
    template?: string;
    showThinking?: boolean;
    sessionTitle?: CardTitle;
    sessionTemplate?: string;
    segments?: Array<
      | { type: "thinking"; text: string; title?: string; expanded?: boolean }
      | { type: "tools"; title?: string; expanded?: boolean; steps: Array<{ title: string; status: string; detail?: string; icon?: string }> }
      | { type: "reply"; text: string }
    >;
    thinking?: string;
    thinkingTitle?: string;
    thinkingExpanded?: boolean;
    toolsSteps?: Array<{ title: string; status: string; detail?: string; icon?: string }>;
    toolsContent?: string;
    toolsTitle?: string;
    toolsExpanded?: boolean;
    reply?: string;
  }): Promise<string | undefined> {
    const cardJson = LarkSender.buildStreamingCardJson({
      status: "streaming",
      showThinking: opts?.showThinking,
      sessionTitle: opts?.sessionTitle,
      sessionTemplate: opts?.sessionTemplate,
      segments: opts?.segments,
      thinking: opts?.thinking,
      thinkingTitle: opts?.thinkingTitle,
      thinkingExpanded: opts?.thinkingExpanded,
      toolsSteps: opts?.toolsSteps,
      toolsContent: opts?.toolsContent,
      toolsTitle: opts?.toolsTitle,
      toolsExpanded: opts?.toolsExpanded,
      reply: opts?.reply,
    });
    try {
      const res = await this.client.request({
        method: "POST",
        url: "/open-apis/cardkit/v1/cards",
        data: { type: "card_json", data: JSON.stringify(cardJson) },
      }) as any;
      const code = res?.code;
      const cardId = res?.data?.card_id as string | undefined;
      if (code !== undefined && code !== 0) {
        this.log("WARN", `创建流式卡片失败 code=${code} msg=${res?.msg ?? ""}`);
        return undefined;
      }
      if (!cardId) {
        this.log("WARN", "创建流式卡片成功但未返回 card_id");
        return undefined;
      }
      return cardId;
    } catch (e: any) {
      this.log("WARN", `创建流式卡片异常: ${e?.message ?? e}${e?.response?.data ? " " + JSON.stringify(e.response.data).slice(0, 500) : ""}`);
      return undefined;
    }
  }

  /** 全量更新 CardKit 卡片（时间线刷新 / 收口绿头） */
  async updateStreamingCard(
    cardId: string,
    cardJson: Record<string, unknown>,
    sequence: number,
  ): Promise<boolean> {
    try {
      const res = await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`,
        data: {
          card: { type: "card_json", data: JSON.stringify(cardJson) },
          sequence,
        },
      }) as any;
      const code = res?.code;
      if (code !== undefined && code !== 0) {
        this.log("WARN", `全量更新流式卡片失败 code=${code} msg=${res?.msg ?? ""} seq=${sequence}`);
        return false;
      }
      return true;
    } catch (e: any) {
      this.log("WARN", `全量更新流式卡片异常: ${e?.message ?? e} seq=${sequence}`);
      return false;
    }
  }

  /** 全量替换卡片内某个组件（PUT element；sequence 须严格递增） */
  async replaceCardElement(
    cardId: string,
    elementId: string,
    elementObj: Record<string, unknown>,
    sequence: number,
  ): Promise<boolean> {
    try {
      const res = await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}`,
        data: { element: JSON.stringify(elementObj), sequence },
      }) as any;
      const code = res?.code;
      if (code !== undefined && code !== 0) {
        this.log("WARN", `替换卡片组件失败 code=${code} msg=${res?.msg ?? ""} id=${elementId} seq=${sequence}`);
        return false;
      }
      return true;
    } catch (e: any) {
      this.log("WARN", `替换卡片组件异常: ${e?.message ?? e} id=${elementId} seq=${sequence}`);
      return false;
    }
  }

  /** 通过 card_id 发送已创建的 CardKit 卡片实体 */
  async sendCardEntity(cardId: string, replyMessageId?: string, chatId?: string): Promise<string | null | undefined> {
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    if (replyMessageId && !replyMessageId.startsWith("internal_")) {
      try {
        const res = await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: { content, msg_type: "interactive" },
        });
        const code = (res as any)?.code;
        const mid = ((res as any)?.data?.message_id ?? (res as any)?.message_id) as string | undefined;
        if (code !== undefined && code !== 0) {
          this.log("WARN", `流式卡片回复失败 code=${code}`);
          return undefined;
        }
        return mid ?? null;
      } catch (e: any) {
        this.log("WARN", `流式卡片回复失败: ${e?.message ?? e}`);
        return undefined;
      }
    }
    const target = chatId || this.chatId;
    if (!target) { this.log("WARN", "流式卡片无发送目标"); return undefined; }
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" as any },
        data: { receive_id: target, content, msg_type: "interactive" },
      });
      const code = (res as any)?.code;
      const mid = ((res as any)?.data?.message_id ?? (res as any)?.message_id) as string | undefined;
      if (code !== undefined && code !== 0) {
        this.log("WARN", `流式卡片发送失败 code=${code} msg=${(res as any)?.msg ?? ""}`);
        return undefined;
      }
      return mid ?? null;
    } catch (e: any) {
      this.log("WARN", `流式卡片发送异常: ${e?.message ?? e}`);
      return undefined;
    }
  }

  /** 流式更新 markdown 全量内容（默认 reply_md；sequence 须严格递增） */
  async streamCardElementContent(
    cardId: string,
    content: string,
    sequence: number,
    elementId = LarkSender.STREAM_REPLY_ID,
  ): Promise<boolean> {
    try {
      const res = await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
        data: { content: content || "…", sequence },
      }) as any;
      const code = res?.code;
      if (code !== undefined && code !== 0) {
        this.log("WARN", `流式更新内容失败 code=${code} msg=${res?.msg ?? ""} seq=${sequence}`);
        return false;
      }
      return true;
    } catch (e: any) {
      this.log("WARN", `流式更新内容异常: ${e?.message ?? e} seq=${sequence}`);
      return false;
    }
  }

  /** 关闭流式模式（PATCH settings streaming_mode:false） */
  async closeStreamingCard(cardId: string, sequence: number): Promise<boolean> {
    try {
      const res = await this.client.request({
        method: "PATCH",
        url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence,
        },
      }) as any;
      const code = res?.code;
      if (code !== undefined && code !== 0) {
        this.log("WARN", `关闭流式模式失败 code=${code} msg=${res?.msg ?? ""} seq=${sequence}`);
        return false;
      }
      return true;
    } catch (e: any) {
      this.log("WARN", `关闭流式模式异常: ${e?.message ?? e} seq=${sequence}`);
      return false;
    }
  }

  /**
   * 发送带回传按钮的交互卡片。
   * @returns message_id；回复成功但飞书未回 message_id 时返回 null（调用方不得再 create）；失败返回 undefined
   */
  async sendCardWithButtons(
    text: string,
    buttons: CardButton[],
    replyMessageId?: string,
    chatId?: string,
    title?: CardTitle,
    input?: CardInput,
    template?: string,
    footer?: string,
    sections?: { text: string; buttons?: CardButton[] }[],
  ): Promise<string | null | undefined> {
    const card = LarkSender.buildCard(`${this.messagePrefix}${text}`, title, buttons, input, template, footer, sections);
    const content = JSON.stringify(card);
    // 有 replyMessageId 时只走回复，成功即返回——禁止再 create 到 chatId（否则群消息 reply + 主用户 chat 直发 = 窜台）
    if (replyMessageId && !replyMessageId.startsWith("internal_")) {
      try {
        const res = await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: { content, msg_type: "interactive" },
        });
        const code = (res as any)?.code;
        const mid = ((res as any)?.data?.message_id ?? (res as any)?.message_id) as string | undefined;
        if (code !== undefined && code !== 0) {
          this.log("WARN", `按钮卡片回复失败 code=${code} (${replyMessageId})`);
          return undefined;
        }
        // 未抛错且 code 正常：视为回复成功，绝不再二次直发（防群聊+主用户窜台）
        this.log("INFO", `飞书按钮卡片已回复(${buttons.length}个按钮)${mid ? "" : "（响应未带 message_id）"}`);
        return mid ?? null; // null = 已回复成功但无 id，调用方禁止再 create
      } catch (e: any) {
        this.log("WARN", `按钮卡片回复失败 (${replyMessageId}): ${e?.message ?? e}`);
        return undefined;
      }
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

  /** 主动更新已发送的交互卡片（需 config.update_multi=true）；带 buttons/sections 时保留交互能力 */
  async patchCard(
    messageId: string,
    text: string,
    title?: CardTitle,
    template?: string,
    footer?: string,
    buttons?: CardButton[],
    sections?: { text: string; buttons?: CardButton[] }[],
  ): Promise<boolean> {
    if (!messageId || messageId.startsWith("internal_")) return false;
    try {
      const card = LarkSender.buildCard(`${this.messagePrefix}${text}`, title, buttons, undefined, template, footer, sections);
      const res = await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      const code = (res as any)?.code;
      if (code !== undefined && code !== 0) {
        this.log("WARN", `卡片更新失败 code=${code} (${messageId})`);
        return false;
      }
      this.log("INFO", `飞书卡片已更新 (${messageId})`);
      return true;
    } catch (e: any) {
      this.log("WARN", `卡片更新异常 (${messageId}): ${e?.message ?? e}`);
      return false;
    }
  }

  async replyMessage(messageId: string, text: string, title?: CardTitle, template?: string): Promise<string | undefined> {
    try {
      const { content, msgType } = this.formatForSend(text, title, template);
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: { content, msg_type: msgType },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书回复已发送(${text.length}字)`);
      else this.log("ERROR", `飞书回复失败: code=${(res as any).code}, msg=${(res as any).msg}`);
      return (res as any)?.data?.message_id;
    } catch (e: any) { this.log("WARN", `飞书回复异常: ${e?.message ?? e}`); return undefined; }
  }

  async sendMessage(text: string, replyMessageId?: string, chatId?: string, title?: CardTitle, template?: string): Promise<string | undefined> {
    if (replyMessageId && !replyMessageId.startsWith("internal_")) { return this.replyMessage(replyMessageId, text, title, template); }
    // internal_ 不可 reply：必须显式 chatId，禁止回落到 this.chatId（主用户）造成窜台
    if (replyMessageId?.startsWith("internal_") && !chatId) {
      this.log("WARN", `internal 消息回复缺少 chatId，已拒绝默认私聊兜底 (${replyMessageId})`);
      return undefined;
    }
    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) { this.log("WARN", "无发送目标"); return undefined; }
    try {
      const { content, msgType } = this.formatForSend(text, title, template);
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
    if (!messageId || messageId.startsWith("internal_")) return false;
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) return true;
      this.log("WARN", `添加表情失败: code=${(res as any).code} msg=${messageId}`);
      return false;
    } catch (e: any) {
      this.log("WARN", `添加表情异常: ${e?.message ?? e} msg=${messageId}`);
      return false;
    }
  }

  async sendImage(imagePath: string, replyMessageId?: string, chatId?: string): Promise<string | undefined> {
    const absPath = path.resolve(imagePath);
    if (!fs.existsSync(absPath)) { this.log("ERROR", `图片不存在: ${absPath}`); return undefined; }
    try {
      const uploadRes: any = await this.client.im.image.create({ data: { image_type: "message", image: fs.createReadStream(absPath) } });
      const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
      if (!imageKey) { this.log("ERROR", `图片上传失败`); return undefined; }
      const content = JSON.stringify({ image_key: imageKey });
      let sentId: string | undefined;
      if (replyMessageId && !replyMessageId.startsWith("internal_")) {
        try {
          const r: any = await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "image" } });
          sentId = r?.data?.message_id ?? r?.message_id;
        } catch (e: any) { this.log("WARN", `图片回复退避 (${replyMessageId}): ${e?.message}`); }
      }
      if (!sentId) {
        if (replyMessageId?.startsWith("internal_") && !chatId) {
          this.log("WARN", `internal 图片回复缺少 chatId，已拒绝默认私聊兜底 (${replyMessageId})`);
          return undefined;
        }
        const targetChatId = chatId ?? this.chatId;
        if (!targetChatId) { this.log("WARN", "无发送目标"); return undefined; }
        const r: any = await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: targetChatId, content, msg_type: "image" } });
        sentId = r?.data?.message_id ?? r?.message_id;
      }
      this.log("INFO", "图片已发送");
      return sentId;
    } catch (e: any) { this.log("ERROR", `发送图片异常: ${e?.message ?? e}`); return undefined; }
  }

  async sendFile(filePath: string, replyMessageId?: string, chatId?: string): Promise<string | undefined> {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) { this.log("ERROR", `文件不存在: ${absPath}`); return undefined; }
    try {
      const fileName = path.basename(absPath);
      const uploadRes: any = await this.client.im.file.create({ data: { file_type: "stream", file_name: fileName, file: fs.createReadStream(absPath) } });
      const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
      if (!fileKey) { this.log("ERROR", `文件上传失败`); return undefined; }
      const content = JSON.stringify({ file_key: fileKey, file_name: fileName });
      let sentId: string | undefined;
      if (replyMessageId && !replyMessageId.startsWith("internal_")) {
        try {
          const r: any = await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "file" } });
          sentId = r?.data?.message_id ?? r?.message_id;
        } catch (e: any) { this.log("WARN", `文件回复退避 (${replyMessageId}): ${e?.message}`); }
      }
      if (!sentId) {
        if (replyMessageId?.startsWith("internal_") && !chatId) {
          this.log("WARN", `internal 文件回复缺少 chatId，已拒绝默认私聊兜底 (${replyMessageId})`);
          return undefined;
        }
        const targetChatId = chatId ?? this.chatId;
        if (!targetChatId) { this.log("WARN", "无发送目标"); return undefined; }
        const r: any = await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: targetChatId, content, msg_type: "file" } });
        sentId = r?.data?.message_id ?? r?.message_id;
      }
      this.log("INFO", `文件已发送: ${fileName}`);
      return sentId;
    } catch (e: any) { this.log("ERROR", `发送文件异常: ${e?.message ?? e}`); return undefined; }
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

  private wsClient: Lark.WSClient | null = null;

  /** 当前 WebSocket 连接状态快照（无连接时返回 null） */
  getWsConnectionStatus(): Lark.WSConnectionStatus | null {
    return this.wsClient?.getConnectionStatus() ?? null;
  }

  closeConnection(force = false): void {
    try { this.wsClient?.close({ force }); } catch { /* best-effort */ }
    this.wsClient = null;
  }

  /** 建立 WebSocket 长连接；返回的 Promise 反映连接建立结果（调用方可据此维护连接状态） */
  startConnection(
    appId: string,
    appSecret: string,
    encryptKey: string,
    onMessage: (event: LarkMessageEvent) => void,
    onCardAction?: (event: LarkCardActionEvent) => Promise<unknown> | unknown,
    lifecycle?: LarkWsLifecycle,
  ): Promise<void> {
    const eventDispatcher = new Lark.EventDispatcher({ encryptKey: encryptKey || undefined, logger: SILENT_LOGGER, loggerLevel: Lark.LoggerLevel.error }).register({
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
          const rawForm = data?.action?.form_value;
          const formValue = rawForm && typeof rawForm === "object" && !Array.isArray(rawForm)
            ? Object.fromEntries(Object.entries(rawForm).map(([k, v]) => [k, String(v ?? "").trim()]))
            : undefined;
          const evt: LarkCardActionEvent = {
            messageId: data?.context?.open_message_id ?? data?.open_message_id ?? "",
            chatId: data?.context?.open_chat_id ?? data?.open_chat_id ?? "",
            operatorOpenId: data?.operator?.open_id,
            value: data?.action?.value,
            inputValue: typeof data?.action?.input_value === "string" ? data.action.input_value : undefined,
            formValue,
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
    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      logger: SILENT_LOGGER,
      loggerLevel: Lark.LoggerLevel.error,
      autoReconnect: true,
      wsConfig: { pingTimeout: 10 },
      onReady: () => {
        this.log("INFO", "飞书 WebSocket 就绪");
        lifecycle?.onReady?.();
      },
      onReconnecting: () => {
        this.log("WARN", "飞书 WebSocket 断线，正在重连...");
        lifecycle?.onDisconnected?.();
        lifecycle?.onReconnecting?.();
      },
      onReconnected: () => {
        this.log("INFO", "飞书 WebSocket 重连成功");
        lifecycle?.onReconnected?.();
        lifecycle?.onReady?.();
      },
      onError: (err: Error) => {
        this.log("ERROR", `飞书 WebSocket 致命错误: ${err.message}`);
        lifecycle?.onError?.(err);
        lifecycle?.onDisconnected?.();
      },
    });
    return this.wsClient.start({ eventDispatcher })
      .then(() => this.log("INFO", "飞书 WebSocket 连接建立成功"))
      .catch((e: any) => {
        this.log("ERROR", `飞书 WebSocket 连接失败: ${e?.message ?? e}`);
        this.wsClient = null;
        throw e;
      });
  }
}

export interface LarkWsLifecycle {
  onReady?: () => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onError?: (err: Error) => void;
  /** 连接不可用（重连中/失败） */
  onDisconnected?: () => void;
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
  /** 输入框组件提交的文本（tag=input 时返回） */
  inputValue?: string;
  /** 表单提交时各字段 name → value */
  formValue?: Record<string, string>;
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
