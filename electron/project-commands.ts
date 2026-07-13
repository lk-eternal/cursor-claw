import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { getConfig, saveConfig, getRepoProfiles, upsertRepoProfiles, removeRepoProfile } from "./config-store"
import { reportCommandResult, type CommandButton } from "./command-handler"
import { buildSessionCardTitle } from "../src/shared/session-label.js"
import {
  createProject,
  deleteProject,
  getCurrentProject,
  getProject,
  initProjectStore,
  listProjects,
  resolveProjectRef,
  setCurrentProjectId,
  startAction,
  updateAction,
  lastAcceptedAction,
  getProjectNewDraft,
  saveProjectNewDraft,
  clearProjectNewDraft,
  getProjectNodes,
  resolveNodeGroup,
  projectNodeLabel,
  type ProjectNewDraft,
} from "../src/shared/project-store.js"
import { repoShortName,
  projectSessionKey,
  PROJECT_RESERVED_SUBCOMMANDS,
  DEFAULT_NODE_GROUP_ID,
  type Project,
  type ProjectActionType,
} from "../src/shared/project-types.js"
import { addProjectWorktree, ensureArtifactDir, isGitRepoRoot, removeProjectWorktree } from "./project-worktree"
import { buildProjectSessionPrompt, buildActionPrompt } from "./project-prompts"
import { pushAndCreateMergeRequest } from "./project-gitlab"
import { syncArtifactToFeishu } from "./project-feishu-sync"
import { httpPost, syncActiveSession, enqueueToSession } from "./daemon-client"
import { leaveProjectSession } from "./session-dispatcher"

function projectHelpText(): string {
  const nodeIds = getProjectNodes(getCurrentProject()?.groupId).map((n) => n.id).join("|")
  return [
    "💡 /p 项目指令",
    "🔹 /p — 打开项目菜单",
    "🔹 /p status — 查看当前项目详情",
    "🔹 /p new — 新建项目",
    "🔹 /p ls — 列出全部项目",
    "🔹 /p use <序号|id> — 进入指定项目",
    "🔹 /p leave — 退出当前项目",
    `🔹 /p ${nodeIds} — 推进项目节点`,
    "🔹 /p sync — 把最近通过的产出同步到飞书文档",
    "🔹 /p setup — 配置项目工作区与主仓",
    "🔹 /p del <序号|id> — 删除项目（连带移除 worktree）",
  ].join("\n")
}

function ensureStore(): void {
  initProjectStore(app.getPath("userData"))
}

function defaultFeatureBranch(name: string): string {
  const d = new Date()
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `feature/${yy}${mm}${dd}-${slugify(name)}`
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `p${Date.now().toString(36)}`
}

/** 同名项目 worktree 目录去重：被现有项目占用则追加 -2/-3… */
function uniqueProjectSlug(name: string): string {
  const base = slugify(name)
  const used = new Set<string>()
  for (const p of listProjects()) {
    const wts = p.repos?.length ? p.repos.map((r) => r.worktreePath) : [p.worktreePath]
    for (const wt of wts) {
      if (!wt) continue
      // 新规则 root/<slug>/<repo> 取父层；旧规则 root/<slug> 取本层
      used.add(path.basename(path.dirname(wt)).toLowerCase())
      used.add(path.basename(wt).toLowerCase())
    }
  }
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}`
    if (!used.has(cand.toLowerCase())) return cand
  }
  return `${base}-${Date.now().toString(36)}`
}

function formatProjectCard(p: Project, index?: number): string {
  const last = [...p.actions].reverse()[0]
  const accepted = lastAcceptedAction(p)
  const lines = [
    index != null ? `📦 项目 #${index} · ${p.name}` : `📦 项目 · ${p.name}`,
    `🆔 ${p.id}`,
    `📝 ${p.goal}`,
    p.storyUrl ? `🔗 飞书项目 · ${p.storyUrl}` : "",
    p.productDocUrl ? `📘 产品文档 · ${p.productDocUrl}` : "",
    p.techDocUrl ? `📗 技术文档 · ${p.techDocUrl}` : "",
    `🌿 feature: ${p.featureBranch}`,
    ...(p.repos && p.repos.length
      ? p.repos.map((r, i) => {
          const tags = [`base=${r.baseBranch}`, r.testBranch ? `test=${r.testBranch}` : "", r.developBranch ? `dev=${r.developBranch}` : ""].filter(Boolean).join(" ")
          return `📦#${i + 1} ${r.repoPath}\n   ${tags}\n   📁 ${r.worktreePath}`
        })
      : [`base=${p.baseBranch}`, `📁 ${p.worktreePath}`]),
    `💠 ${p.status}`,
    last ? `⏭ 最近 action · ${last.type} (${last.status})` : "⏭ 尚无 action",
    accepted?.artifactPath ? `📄 artifact · ${accepted.artifactPath}` : "",
    accepted?.feishuDocUrl ? `📘 飞书 · ${accepted.feishuDocUrl}` : "",
    last?.mrUrl ? `🔀 MR · ${last.mrUrl}` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

function projectButtons(p?: Project): CommandButton[] {
  const group = resolveNodeGroup(p?.groupId ?? getCurrentProject()?.groupId)
  const nodeBtns: CommandButton[] = group.nodes.map((n) => ({
    label: `${n.label} /p ${n.id}`,
    cmd: `/p ${n.id}`,
    section: group.name,
  }))
  return [
    ...nodeBtns,
    { label: "同步文档 /p sync", cmd: "/p sync" },
    { label: "项目菜单 /p", cmd: "/p" },
    { label: "退出项目 /p leave", cmd: "/p leave" },
  ]
}

/** 项目卡色条用项目名/分支，避免仍显示普通会话目录 */
function projectCardTitle(p: Project) {
  return buildSessionCardTitle({ project: p })
}

function withChatFooter(text: string, footer = "也可直接发消息，在项目会话里继续聊"): string {
  return `${text}\n\n---\n${footer}`
}

/** 进入项目会话（懒加载）：只落元数据与消息路由，Agent 等首条消息/节点任务到队列时由调度器拉起并注入项目上下文 */
async function enterProjectSession(
  port: number,
  chatId: string,
  project: Project,
): Promise<void> {
  const sessionKey = project.sessionKey || projectSessionKey(chatId, project.id)
  project.sessionKey = sessionKey
  project.notifyChatId = chatId
  const { saveProject } = await import("../src/shared/project-store.js")
  saveProject(project)
  await syncActiveSession(port, chatId, sessionKey)
}

interface NewProjectInput {
  chatKey?: string
  name?: string
  goal?: string
  repoPath?: string
  baseBranch?: string
  featureBranch?: string
  storyUrl?: string
  productDocUrl?: string
  techDocUrl?: string
  worktreeRootOverride?: string
  groupId?: string
  repos?: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
}

async function finalizeNewProject(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: NewProjectInput,
): Promise<void> {
  const cfg = getConfig()
  const worktreeRoot = (draft.worktreeRootOverride || cfg.worktreeRoot || "").trim()
  const repos = (draft.repos && draft.repos.length)
    ? draft.repos
    : (draft.repoPath && draft.baseBranch
      ? [{ repoPath: draft.repoPath, baseBranch: draft.baseBranch }]
      : [])
  if (!draft.name || !repos.length) {
    await reportCommandResult(port, messageId, false, "❌ 创建信息不完整（名称/主仓·基线必填）", chatId)
    return
  }
  if (!draft.goal) draft.goal = ""
  if (!worktreeRoot) {
    await reportCommandResult(port, messageId, false, "❌ 未配置工作区目录（/p setup）", chatId)
    return
  }
  for (const r of repos) {
    if (!isGitRepoRoot(r.repoPath)) {
      await reportCommandResult(port, messageId, false, `❌ 主仓无效: ${r.repoPath}`, chatId)
      return
    }
  }
  if (worktreeRoot !== cfg.worktreeRoot) {
    saveConfig({ worktreeRoot })
  }
  upsertRepoProfiles(repos.map((r) => ({
    path: r.repoPath,
    baseBranch: r.baseBranch,
    testBranch: r.testBranch,
    developBranch: r.developBranch,
  })))

  const featureBranch = (draft.featureBranch || defaultFeatureBranch(draft.name)).trim()
  const projectSlug = uniqueProjectSlug(draft.name)
  const created: { repoPath: string; worktreePath: string }[] = []
  const projectRepos: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string; worktreePath: string }[] = []

  for (const r of repos) {
    const short = repoShortName(r.repoPath)
    const worktreePath = path.join(worktreeRoot, projectSlug, short)
    const wt = addProjectWorktree({
      repoPath: r.repoPath,
      worktreePath,
      featureBranch,
      baseBranch: r.baseBranch,
    })
    if (!wt.ok) {
      for (const c of created) removeProjectWorktree(c.repoPath, c.worktreePath)
      await reportCommandResult(port, messageId, false, `❌ ${wt.error}`, chatId)
      return
    }
    created.push({ repoPath: r.repoPath, worktreePath })
    projectRepos.push({
      repoPath: r.repoPath,
      baseBranch: r.baseBranch,
      testBranch: r.testBranch,
      developBranch: r.developBranch,
      worktreePath,
    })
  }

  const primary = projectRepos[0]
  try {
    const project = createProject({
      name: draft.name,
      goal: draft.goal,
      storyUrl: draft.storyUrl,
      productDocUrl: draft.productDocUrl,
      techDocUrl: draft.techDocUrl,
      repoPath: primary.repoPath,
      baseBranch: primary.baseBranch,
      featureBranch,
      worktreePath: primary.worktreePath,
      repos: projectRepos,
      groupId: resolveNodeGroup(draft.groupId).id,
      notifyChatId: chatId,
    })
    if (chatId) {
      project.sessionKey = projectSessionKey(chatId, project.id)
      const { saveProject } = await import("../src/shared/project-store.js")
      saveProject(project)
    }
    for (const r of projectRepos) ensureArtifactDir(r.worktreePath)
    if (draft.chatKey) clearProjectNewDraft(draft.chatKey)
    await reportCommandResult(
      port,
      messageId,
      true,
      withChatFooter(`✅ 项目已创建并进入项目会话\n\n${formatProjectCard(project)}`),
      chatId,
      projectButtons(project),
      { cardTitle: projectCardTitle(project) },
    )
    if (chatId) {
      await enterProjectSession(port, chatId, project)
    }
  } catch (e: any) {
    for (const c of created) removeProjectWorktree(c.repoPath, c.worktreePath)
    await reportCommandResult(port, messageId, false, `❌ 创建失败已回滚: ${e?.message || e}`, chatId)
  }
}

async function handleSetupCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  args: string[],
  patchMessageId?: string,
): Promise<void> {
  ensureStore()
  if (!chatId) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
    return
  }
  const mode = (args[0] || "").toLowerCase()
  if (!mode) {
    clearProjectNewDraft(chatId)
    await replySetupHub(port, messageId, chatId, patchMessageId)
    return
  }
  if (mode === "worktree") {
    // 优先卡内表单（原卡切视图）；被拒/微信降级走分步问答
    try {
      const r = await httpPost(`http://127.0.0.1:${port}/api/project-setup-form`, {
        message_id: messageId,
        session_key: chatId,
        form: "worktree",
        patch_message_id: patchMessageId,
        worktree_root: getConfig().worktreeRoot?.trim() || undefined,
      }) as { ok?: boolean }
      if (r?.ok) return
    } catch { /* fall through to Q&A */ }
    const draft: ProjectNewDraft = {
      chatKey: chatId,
      step: "setup_worktree",
      setupOnly: true,
      returnToSetup: true,
      updatedAt: Date.now(),
    }
    await promptNewStep(port, messageId, chatId, draft, patchMessageId)
    return
  }
  if (mode === "add") {
    const flag = (args[1] || "").toLowerCase()
    const cur = getProjectNewDraft(chatId)
    if (flag === "--skip-test" && cur?.step === "setup_add_test") {
      cur.testBranch = undefined
      cur.step = "setup_add_dev"
      await promptNewStep(port, messageId, chatId, cur, patchMessageId)
      return
    }
    if (flag === "--skip-dev" && cur?.step === "setup_add_dev") {
      cur.developBranch = undefined
      upsertRepoProfiles([{
        path: cur.repoPath!,
        baseBranch: cur.baseBranch || "main",
        testBranch: cur.testBranch,
        developBranch: undefined,
      }])
      clearProjectNewDraft(chatId)
      // 向导收尾：原卡直接更新为 setup 总览（省一条“已添加”插播消息）
      await replySetupHub(port, messageId, chatId, patchMessageId)
      return
    }
    // 优先发飞书表单（四项一次填完，按钮来源原卡切视图）；被拒/微信降级走分步问答
    try {
      const r = await httpPost(`http://127.0.0.1:${port}/api/project-setup-form`, {
        message_id: messageId,
        session_key: chatId,
        patch_message_id: patchMessageId,
      }) as { ok?: boolean }
      if (r?.ok) return
    } catch { /* fall through to Q&A */ }
    const draft: ProjectNewDraft = {
      chatKey: chatId,
      step: "setup_add_path",
      setupOnly: true,
      returnToSetup: true,
      updatedAt: Date.now(),
    }
    await promptNewStep(port, messageId, chatId, draft, patchMessageId)
    return
  }
  if (mode === "del" || mode === "delete" || mode === "rm") {
    const n = Number.parseInt(args[1] || "", 10)
    if (!Number.isInteger(n) || n < 1) {
      await reportCommandResult(port, messageId, false, "用法：/p setup del <序号>", chatId)
      return
    }
    const profiles = getRepoProfiles(getConfig())
    const target = profiles[n - 1]
    if (!target) {
      await reportCommandResult(port, messageId, false, `❌ 序号无效：${n}`, chatId)
      return
    }
    if (!args.includes("--yes")) {
      // 确认视图（原卡切换）：误触可取消返回总览
      await reportCommandResult(
        port, messageId, true,
        `⚠️ 确认删除主仓配置 #${n}？\n${target.path}\n\n仅移除记录，不影响磁盘上的仓库。`,
        chatId,
        [
          { label: `确认删除 #${n}`, cmd: `/p setup del ${n} --yes` },
          { label: "取消", cmd: "/p setup" },
        ],
        patchMessageId ? { patchMessageId } : undefined,
      )
      return
    }
    const removed = removeRepoProfile(n)
    if (!removed) {
      await reportCommandResult(port, messageId, false, `❌ 序号无效：${n}`, chatId)
      return
    }
    // 原卡更新为最新总览，删除结果并入首行提示
    await replySetupHub(port, messageId, chatId, patchMessageId, `✅ 已删除 #${n} ${path.basename(removed.path)}`)
    return
  }
  if (mode === "gitlab") {
    try {
      const cfg = getConfig()
      const r = await httpPost(`http://127.0.0.1:${port}/api/project-setup-form`, {
        message_id: messageId,
        session_key: chatId,
        form: "gitlab",
        patch_message_id: patchMessageId,
        gitlab_host: cfg.gitlabHost?.trim() || undefined,
        token_masked: maskToken(cfg.gitlabToken || ""),
      }) as { ok?: boolean }
      if (r?.ok) return
    } catch { /* fall through to Q&A */ }
    const draft: ProjectNewDraft = {
      chatKey: chatId,
      step: "setup_gitlab_token",
      setupOnly: true,
      returnToSetup: true,
      updatedAt: Date.now(),
    }
    await promptNewStep(port, messageId, chatId, draft, patchMessageId)
    return
  }
  await reportCommandResult(port, messageId, false, "用法：/p setup（总览）· /p setup worktree（目录）· /p setup add（加主仓）· /p setup gitlab · /p setup del <序号>", chatId)
}

function maskToken(token: string): string {
  const t = token.trim()
  if (!t) return "（未设置）"
  return t.length <= 8 ? `${t.slice(0, 2)}***` : `${t.slice(0, 6)}***${t.slice(-3)}`
}

export async function replySetupHub(port: number, messageId: string, chatId: string, patchMessageId?: string, notice?: string): Promise<void> {
  const cfg = getConfig()
  const profiles = getRepoProfiles(cfg)
  const wt = cfg.worktreeRoot?.trim() ? path.normalize(cfg.worktreeRoot.trim()) : ""
  const list = profiles.length
    ? profiles.map((p, i) => {
      const name = path.basename(p.path)
      const branches = [p.baseBranch, p.testBranch, p.developBranch].filter(Boolean).join(" · ")
      return `#${i + 1} ${name} · ${branches}\n   ${p.path}`
    }).join("\n")
    : "（暂无）"
  const btns: CommandButton[] = [
    { label: "设置工作区目录", cmd: "/p setup worktree" },
    { label: "添加主仓", cmd: "/p setup add" },
    { label: "设置 GitLab", cmd: "/p setup gitlab" },
  ]
  for (let i = 0; i < Math.min(profiles.length, 8); i++) {
    btns.push({
      label: `删除 #${i + 1} ${path.basename(profiles[i].path)}`,
      cmd: `/p setup del ${i + 1}`,
    })
  }
  btns.push({ label: "← 项目菜单", cmd: "/p menu --back" })
  await reportCommandResult(
    port,
    messageId,
    true,
    [
      ...(notice ? [notice, ""] : []),
      "⚙️ 项目工作区",
      "",
      `工作区目录：${wt || "（未设置）"}`,
      "",
      "主仓：",
      list,
      "",
      `GitLab Token：${maskToken(cfg.gitlabToken || "")}`,
      `GitLab Host：${cfg.gitlabHost?.trim() || "（默认从 origin 推断）"}`,
    ].join("\n"),
    chatId,
    btns,
    patchMessageId ? { patchMessageId } : undefined,
  )
}

async function promptNewStep(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: ProjectNewDraft,
  patchMessageId?: string,
): Promise<void> {
  const cfg = getConfig()
  saveProjectNewDraft(draft)
  // 向导步骤卡：按钮点击来源时原卡推进，避免每步刷一条新消息
  const send = (text: string, buttons: CommandButton[]) => reportCommandResult(
    port, messageId, true, text, chatId, buttons, patchMessageId ? { patchMessageId } : undefined,
  )

  if (draft.step === "setup_worktree") {
    await send(
      ["⚙️ 设置工作区目录", "", "请直接回复绝对路径", "例：`D:\\claw-projects`"].join("\n"),
      [{ label: "返回 setup", cmd: "/p setup" }, { label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }

  if (draft.step === "setup_add_path") {
    await send(
      "➕ 添加主仓 · 请回复主仓绝对路径（git 根目录）",
      [{ label: "返回 setup", cmd: "/p setup" }, { label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }
  if (draft.step === "setup_add_base") {
    await send(
      `➕ 主仓 ${draft.repoPath}\n请回复 **生产基线分支**（必填）`,
      [{ label: "返回 setup", cmd: "/p setup" }, { label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }
  if (draft.step === "setup_add_test") {
    await send(
      "➕ 请回复 **测试分支**（可空，回 `-` 跳过）",
      [{ label: "跳过", cmd: "/p setup add --skip-test" }, { label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }
  if (draft.step === "setup_add_dev") {
    await send(
      "➕ 请回复 **开发分支**（可空，回 `-` 跳过）",
      [{ label: "跳过并完成", cmd: "/p setup add --skip-dev" }, { label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }
  if (draft.step === "setup_gitlab_token") {
    await send(
      `🔑 请回复 **GitLab Token**（当前 ${maskToken(cfg.gitlabToken || "")}；回 \`-\` 保持不变）`,
      [{ label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }
  if (draft.step === "setup_gitlab_host") {
    await send(
      `🌐 请回复 **GitLab Host**（当前 ${cfg.gitlabHost?.trim() || "默认从 origin 推断"}；回 \`-\` 保持不变，回 \`clear\` 清空）`,
      [{ label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }

}

/** 向导进行中时，把用户下一条非指令文本填入当前步骤 */
export async function fillProjectNewFromText(
  port: number,
  messageId: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  ensureStore()
  const draft = getProjectNewDraft(chatId)
  if (!draft) return false
  const value = text.trim().replace(/^["']|["']$/g, "")
  if (!value) return true

  if (draft.step === "setup_worktree") {
    if (!path.isAbsolute(value)) {
      await reportCommandResult(port, messageId, false, "❌ 请回复绝对路径，例如 D:\\claw-projects", chatId)
      return true
    }
    // 压平 D:\\foo 这类双反斜杠输入，避免脏路径进 config
    const dir = path.normalize(value)
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    } catch (e: any) {
      await reportCommandResult(port, messageId, false, `❌ 无法创建目录: ${e?.message || e}`, chatId)
      return true
    }
    saveConfig({ worktreeRoot: dir })
    clearProjectNewDraft(chatId)
    await reportCommandResult(port, messageId, true, `✅ 工作区目录已设为：${dir}`, chatId)
    await replySetupHub(port, messageId, chatId)
    return true
  }

  if (draft.step === "setup_add_path") {
    if (!path.isAbsolute(value)) {
      await reportCommandResult(port, messageId, false, "❌ 请回复绝对路径", chatId)
      return true
    }
    if (!isGitRepoRoot(value)) {
      await reportCommandResult(port, messageId, false, `❌ 不是有效 git 根目录: ${value}`, chatId)
      return true
    }
    draft.repoPath = path.resolve(value)
    draft.step = "setup_add_base"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_add_base") {
    draft.baseBranch = value
    draft.step = "setup_add_test"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_add_test") {
    draft.testBranch = value === "-" ? undefined : value
    draft.step = "setup_add_dev"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_gitlab_token") {
    if (value !== "-") saveConfig({ gitlabToken: value })
    draft.step = "setup_gitlab_host"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_gitlab_host") {
    if (value === "clear") saveConfig({ gitlabHost: "" })
    else if (value !== "-") saveConfig({ gitlabHost: value })
    clearProjectNewDraft(chatId)
    await reportCommandResult(port, messageId, true, "✅ GitLab 配置已更新", chatId)
    await replySetupHub(port, messageId, chatId)
    return true
  }
  if (draft.step === "setup_add_dev") {
    draft.developBranch = value === "-" ? undefined : value
    upsertRepoProfiles([{
      path: draft.repoPath!,
      baseBranch: draft.baseBranch || "main",
      testBranch: draft.testBranch,
      developBranch: draft.developBranch,
    }])
    clearProjectNewDraft(chatId)
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 已添加主仓 ${path.basename(draft.repoPath!)} · ${draft.baseBranch}`,
      chatId,
    )
    await replySetupHub(port, messageId, chatId)
    return true
  }

  return true
}

async function handleNewCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  parts: string[],
): Promise<void> {
  ensureStore()
  const cfg = getConfig()
  const chatKey = chatId || ""

  // 兼容一行写完：/p new name repoIdx base feature goal...
  if (parts.length >= 6 && !parts[2]?.startsWith("--")) {
    const name = parts[2]
    const repoIdx = Number.parseInt(parts[3], 10)
    const baseBranch = parts[4]
    const featureBranch = parts[5]
    const goal = parts.slice(6).join(" ").trim()
    const roots = cfg.repoRoots || []
    if (!goal || !Number.isInteger(repoIdx) || repoIdx < 1 || repoIdx > roots.length) {
      await reportCommandResult(port, messageId, false, "❌ 一行创建参数无效；也可用 /p new 走交互", chatId)
      return
    }
    await finalizeNewProject(port, messageId, chatId, {
      chatKey,
      name,
      repoPath: roots[repoIdx - 1],
      baseBranch,
      featureBranch,
      goal,
    })
    return
  }

  const flag = parts[2]?.startsWith("--") ? parts[2].toLowerCase() : ""

  if (flag === "--cancel") {
    if (chatKey) clearProjectNewDraft(chatKey)
    await reportCommandResult(port, messageId, true, "已取消向导", chatId)
    return
  }

  // /p new  或  /p new 名字 → 大表单（名字可作表单预填提示，仍发空表单由用户改）
  if (!chatKey) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
    return
  }

  // 若带齐一行参数仍走旧路径；否则发大表单
  try {
    const r = await httpPost(`http://127.0.0.1:${port}/api/project-new-form`, {
      message_id: messageId,
      session_key: chatId,
      repo_profiles: getRepoProfiles(cfg),
      repo_roots: cfg.repoRoots || [],
      worktree_root: cfg.worktreeRoot || "",
    }) as { ok?: boolean; error?: string }
    if (!r?.ok) {
      await reportCommandResult(port, messageId, false, `❌ 创建表单发送失败（飞书卡片被拒）。可先 /p setup 检查主仓与 worktree，或用一行命令：\n/p new <名> <主仓路径> <基线> <feature> <目标…>`, chatId)
    }
  } catch (e: any) {
    await reportCommandResult(port, messageId, false, `❌ 打不开创建表单: ${e?.message || e}`, chatId)
  }
}

/** 表单提交（daemon 卡片回调 → electron） */
export async function handleProjectNewSubmit(
  port: number,
  messageId: string,
  chatId: string,
  fields: {
    name: string
    goal: string
    repoPath: string
    worktreeRoot: string
    baseBranch: string
    featureBranch?: string
    storyUrl?: string
    productDocUrl?: string
    techDocUrl?: string
    groupId?: string
    repos?: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
  },
): Promise<void> {
  ensureStore()
  await finalizeNewProject(port, messageId, chatId, {
    chatKey: chatId,
    name: fields.name,
    goal: fields.goal,
    repoPath: fields.repoPath,
    baseBranch: fields.baseBranch || "main",
    featureBranch: fields.featureBranch,
    storyUrl: fields.storyUrl || undefined,
    productDocUrl: fields.productDocUrl || undefined,
    techDocUrl: fields.techDocUrl || undefined,
    worktreeRootOverride: fields.worktreeRoot,
    groupId: fields.groupId,
    repos: fields.repos,
  })
}


async function handleShipCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  args: string[],
): Promise<void> {
  ensureStore()
  const p = getCurrentProject()
  if (!p) {
    await reportCommandResult(port, messageId, false, "❌ 没有当前项目，先 /p new 或 /p use", chatId)
    return
  }
  const primary = p.repos?.[0]
  const developBranch = primary?.developBranch?.trim()
  const testBranch = primary?.testBranch?.trim()
  const mode = (args[0] || "").toLowerCase()

  if (!mode) {
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        "🚢 交付已拆分为两个节点：",
        "· 部署 /p deploy — 推送到开发分支",
        "· 提测 /p submit-test — 开 MR 到测试分支并通知测试",
        "",
        "分支配置仍可用 /p ship --set develop|test <名>",
      ].join("\n"),
      chatId,
      [
        { label: "部署 /p deploy", cmd: "/p deploy" },
        { label: "提测 /p submit-test", cmd: "/p submit-test" },
      ],
    )
    return
  }

  if (mode === "--set" || mode === "set") {
    const kind = (args[1] || "").toLowerCase()
    const name = (args[2] || "").trim()
    if (!name || (kind !== "develop" && kind !== "dev" && kind !== "test")) {
      await reportCommandResult(port, messageId, false, "用法：/p ship --set develop <分支> 或 /p ship --set test <分支>", chatId)
      return
    }
    const repos = [...(p.repos || [{
      repoPath: p.repoPath,
      baseBranch: p.baseBranch,
      worktreePath: p.worktreePath,
    }])]
    if (kind === "test") repos[0].testBranch = name
    else repos[0].developBranch = name
    p.repos = repos
    const { saveProject } = await import("../src/shared/project-store.js")
    saveProject(p)
    upsertRepoProfiles([{
      path: repos[0].repoPath,
      baseBranch: repos[0].baseBranch,
      testBranch: repos[0].testBranch,
      developBranch: repos[0].developBranch,
    }])
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 已写入 ${kind === "test" ? "testBranch" : "developBranch"}=${name}\n可再 /p ship`,
      chatId,
      [{ label: "继续 ship /p ship", cmd: "/p ship" }],
    )
    return
  }

  // 兼容旧卡片按钮：转发到拆分后的节点流程
  if ((mode === "--to" || mode === "to") && (args[1] || "").toLowerCase() === "develop") {
    await handleDeployCommand(port, messageId, chatId)
    return
  }

  if ((mode === "--mr" || mode === "mr") && (args[1] || "").toLowerCase() === "test") {
    await handleSubmitTestCommand(port, messageId, chatId)
    return
  }

  await reportCommandResult(port, messageId, false, "用法：/p deploy | /p submit-test | /p ship --set develop|test <名>", chatId)
}

/** 部署节点：校验配置后推送开发分支（宿主动作 + Agent 摘要） */
async function handleDeployCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
): Promise<void> {
  ensureStore()
  const p = getCurrentProject()
  if (!p) {
    await reportCommandResult(port, messageId, false, "❌ 没有当前项目，先 /p new 或 /p use", chatId)
    return
  }
  const developBranch = p.repos?.[0]?.developBranch?.trim()
  if (!developBranch) {
    await reportCommandResult(port, messageId, false, "❌ 未配置开发分支，先 /p ship --set develop <名>（或在项目会话让 AI 用 project_update 写入）", chatId)
    return
  }
  await runDeployDevelop(port, messageId, chatId, p, developBranch)
}

/** 提测节点：校验配置后推 MR 到测试分支（宿主动作 + Agent 评论/产物） */
async function handleSubmitTestCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
): Promise<void> {
  ensureStore()
  const p = getCurrentProject()
  if (!p) {
    await reportCommandResult(port, messageId, false, "❌ 没有当前项目，先 /p new 或 /p use", chatId)
    return
  }
  const testBranch = p.repos?.[0]?.testBranch?.trim()
  if (!testBranch) {
    await reportCommandResult(port, messageId, false, "❌ 未配置测试分支，先 /p ship --set test <名>（或在项目会话让 AI 用 project_update 写入）", chatId)
    return
  }
  if (!getConfig().gitlabToken?.trim()) {
    await reportCommandResult(port, messageId, false, "❌ 未配置 GitLab token（设置 → 项目）", chatId)
    return
  }
  await runSubmitTestMr(port, messageId, chatId, p, testBranch)
}

async function runDeployDevelop(
  port: number,
  messageId: string,
  chatId: string | undefined,
  project: Project,
  developBranch: string,
): Promise<void> {
  const started = startAction(project.id, "deploy")
  if (!started.ok) {
    await reportCommandResult(port, messageId, false, `❌ ${started.error}`, chatId)
    return
  }
  const { action } = started
  const { spawnSync } = await import("node:child_process")
  const pushFeat = spawnSync("git", ["push", "-u", "origin", `HEAD:${project.featureBranch}`], {
    cwd: project.worktreePath, encoding: "utf-8", windowsHide: true,
  })
  if ((pushFeat.status ?? 1) !== 0) {
    const err = (pushFeat.stderr || pushFeat.stdout || "push feature 失败").toString()
    updateAction(project.id, action.id, { status: "failed", error: err })
    await reportCommandResult(port, messageId, false, `❌ 推送 feature 失败: ${err}`, chatId)
    return
  }
  const pushDev = spawnSync("git", ["push", "origin", `HEAD:${developBranch}`], {
    cwd: project.worktreePath, encoding: "utf-8", windowsHide: true,
  })
  if ((pushDev.status ?? 1) !== 0) {
    const err = (pushDev.stderr || pushDev.stdout || "push develop 失败").toString()
    updateAction(project.id, action.id, { status: "failed", error: err })
    await reportCommandResult(port, messageId, false, `❌ 部署到开发分支失败: ${err}`, chatId)
    return
  }
  updateAction(project.id, action.id, { status: "accepted", summary: `已推送到开发分支 ${developBranch}` })
  const latest = getProject(project.id)!
  const prompt = buildActionPrompt(latest, action.id, "deploy")
  const notify = chatId || project.notifyChatId || ""
  if (notify) {
    await enqueueToSession(port, projectSessionKey(notify, project.id),
      prompt + `\n\n宿主已将 HEAD 推送到开发分支 ${developBranch}。请写 artifact 摘要登记完成。`)
  }
  await reportCommandResult(port, messageId, true, `✅ 已部署到开发分支 ${developBranch}\n并启动部署节点会话做摘要`, chatId)
}

async function runSubmitTestMr(
  port: number,
  messageId: string,
  chatId: string | undefined,
  project: Project,
  testBranch: string,
): Promise<void> {
  const started = startAction(project.id, "submit-test")
  if (!started.ok) {
    await reportCommandResult(port, messageId, false, `❌ ${started.error}`, chatId)
    return
  }
  const { action } = started
  const cfg = getConfig()
  const mr = await pushAndCreateMergeRequest({
    cwd: project.worktreePath,
    token: cfg.gitlabToken || "",
    host: cfg.gitlabHost || undefined,
    title: `Draft: ${project.name}`,
    sourceBranch: project.featureBranch,
    targetBranch: testBranch,
    description: project.goal,
  })
  if (!mr.ok) {
    updateAction(project.id, action.id, { status: "failed", error: mr.error })
    await reportCommandResult(port, messageId, false, `❌ ship MR→测试失败: ${mr.error}`, chatId)
    return
  }
  updateAction(project.id, action.id, { mrUrl: mr.mrUrl, status: "accepted", summary: `MR → ${testBranch}` })
  const latest = getProject(project.id)!
  const prompt = buildActionPrompt(latest, action.id, "submit-test")
  const notify = chatId || project.notifyChatId || ""
  if (notify) {
    await enqueueToSession(port, projectSessionKey(notify, project.id),
      prompt + [
        "",
        `宿主已创建提测 MR（source: ${latest.featureBranch} → target: ${testBranch}）: ${mr.mrUrl}`,
        "请按节点要求完成飞书项目评论通知与提测说明产物，project_action_done 带 mr_url。",
      ].join("\n"))
  }
  await reportCommandResult(port, messageId, true, `✅ 已开提测 MR → 测试分支 ${testBranch}\n${mr.mrUrl}\n并启动提测节点会话`, chatId)
}

async function runAction(
  port: number,
  messageId: string,
  chatId: string | undefined,
  type: ProjectActionType,
): Promise<void> {
  ensureStore()
  const p = getCurrentProject()
  if (!p) {
    await reportCommandResult(port, messageId, false, "❌ 没有当前项目，先 /p new 或 /p use", chatId)
    return
  }
  if (!chatId) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析 chatId", chatId)
    return
  }
  const started = startAction(p.id, type)
  if (!started.ok) {
    await reportCommandResult(port, messageId, false, `❌ ${started.error}`, chatId)
    return
  }
  const { action, project } = started
  ensureArtifactDir(project.worktreePath)
  const sessionKey = projectSessionKey(chatId, project.id)
  project.sessionKey = sessionKey
  project.notifyChatId = chatId
  const { saveProject } = await import("../src/shared/project-store.js")
  saveProject(project)

  const prompt = buildActionPrompt(project, action.id, type)

  // 任务入队而非直塞启动提示词：Agent 崩溃时消息自动重投，节点不丢
  const enq = await enqueueToSession(port, sessionKey, prompt)
  if (!enq.ok) {
    updateAction(project.id, action.id, { status: "failed", error: enq.error })
    await reportCommandResult(port, messageId, false, `❌ 节点任务入队失败: ${enq.error}`, chatId)
    return
  }
  await syncActiveSession(port, chatId, sessionKey)
  await reportCommandResult(
    port,
    messageId,
    true,
    `🚀 已启动${projectNodeLabel(type, project.groupId)}\n项目：${project.name}`,
    chatId,
  )
}

async function handleDeleteProjectCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  args: string[],
  patchMessageId?: string,
): Promise<void> {
  ensureStore()
  const token = args.filter((a) => a !== "--yes")[0]
  const confirmed = args.includes("--yes")
  // 选择/确认是瞬态卡：按钮点击来源时原卡推进；最终删除结果新发留痕
  const patchExtra = patchMessageId ? { patchMessageId } : undefined

  if (!token) {
    const list = listProjects()
    if (!list.length) {
      await reportCommandResult(port, messageId, true, "📭 暂无项目", chatId, undefined, patchExtra)
      return
    }
    const lines = list.map((p, i) => `#${i + 1} ${p.name} · ${p.featureBranch}`)
    const btns: CommandButton[] = list.slice(0, 10).map((p, i) => ({
      label: `删除 #${i + 1} ${p.name}`,
      cmd: `/p del ${i + 1}`,
    }))
    btns.push({ label: "返回菜单 /p", cmd: "/p" })
    await reportCommandResult(port, messageId, true, `选择要删除的项目：\n${lines.join("\n")}`, chatId, btns, patchExtra)
    return
  }

  const target = resolveProjectRef(token)
  if (!target) {
    await reportCommandResult(port, messageId, false, `❌ 未找到项目：${token}`, chatId, undefined, patchExtra)
    return
  }
  const repos = target.repos?.length
    ? target.repos
    : [{ repoPath: target.repoPath, baseBranch: target.baseBranch, worktreePath: target.worktreePath }]

  if (!confirmed) {
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        `⚠️ 确认删除项目「${target.name}」？`,
        `feature：${target.featureBranch}`,
        ...repos.map((r) => `📁 ${r.worktreePath}`),
        "",
        "将移除以上 worktree 目录（含未提交改动）；主仓与远程分支不受影响。",
      ].join("\n"),
      chatId,
      [
        { label: `确认删除 ${target.name}`, cmd: `/p del ${target.id} --yes` },
        { label: "取消", cmd: "/p" },
      ],
      patchExtra,
    )
    return
  }

  const wasCurrent = getCurrentProject()?.id === target.id
  executeProjectDelete(target.id)
  if (wasCurrent && chatId) await leaveProjectSession(port, chatId)
  // 确认卡原地置为结果态（防再点）；删除结果本身即留痕
  await reportCommandResult(
    port,
    messageId,
    true,
    `🗑 已删除项目「${target.name}」并移除 worktree`,
    chatId,
    [{ label: "项目菜单 /p", cmd: "/p" }],
    patchExtra,
  )
}

/** 删除项目：移除全部 worktree + 删记录（MCP project_delete 与 /p del 共用）。
 * 历史同名项目可能共享同一 worktree 目录：被其他项目引用的目录只删记录不删目录。 */
export function executeProjectDelete(projectId: string): { ok: boolean; name?: string } {
  ensureStore()
  const target = getProject(projectId)
  if (!target) return { ok: false }
  const othersWt = new Set<string>()
  for (const p of listProjects()) {
    if (p.id === target.id) continue
    const wts = p.repos?.length ? p.repos.map((r) => r.worktreePath) : [p.worktreePath]
    for (const wt of wts) { if (wt) othersWt.add(path.resolve(wt).toLowerCase()) }
  }
  const repos = target.repos?.length
    ? target.repos
    : [{ repoPath: target.repoPath, baseBranch: target.baseBranch, worktreePath: target.worktreePath }]
  for (const r of repos) {
    if (!r.worktreePath) continue
    if (othersWt.has(path.resolve(r.worktreePath).toLowerCase())) continue
    try { removeProjectWorktree(r.repoPath, r.worktreePath) } catch { /* 尽力清理 */ }
  }
  deleteProject(target.id)
  return { ok: true, name: target.name }
}

/** 项目二级菜单：列表 + 快速进入，不自动进当前项目；patchMessageId 用于域内「返回菜单」原卡跳转 */
async function replyProjectMenu(port: number, messageId: string, chatId?: string, patchMessageId?: string): Promise<void> {
  const list = listProjects()
  const cur = getCurrentProject()
  if (list.length === 0) {
    await reportCommandResult(port, messageId, true, `${projectHelpText()}\n\n📭 暂无项目`, chatId, [
      { label: "新建项目 /p new", cmd: "/p new" },
      { label: "配置工作区 /p setup", cmd: "/p setup" },
    ], { cardTitle: { title: "项目", subtitle: "菜单" }, patchMessageId })
    return
  }
  const statusLabel: Record<string, string> = { active: "进行中", paused: "已暂停", done: "已完成" }
  const lines = list.map((p, i) => {
    const mark = cur?.id === p.id ? "（当前）" : ""
    const st = statusLabel[p.status] || p.status
    return `#${i + 1} 📦 ${p.name}${mark} · ${st}\n     🌿 ${p.featureBranch}`
  })
  const head = cur
    ? [
      "📦 项目菜单",
      `当前选中：「${cur.name}」——尚未进入协作，点下方「进入」开始`,
      "",
      lines.join("\n"),
    ].join("\n")
    : ["📦 项目菜单", "", lines.join("\n")].join("\n")
  const btns: CommandButton[] = list.slice(0, 10).map((p, i) => ({
    label: `进入 ${p.name}`,
    cmd: `/p use ${i + 1}`,
    section: "进入项目",
  }))
  if (cur) {
    btns.push({ label: "项目详情 /p status", cmd: "/p status", section: "其他" })
    btns.push({ label: "退出项目 /p leave", cmd: "/p leave", section: "其他" })
  }
  btns.push({ label: "新建项目 /p new", cmd: "/p new", section: "其他" })
  btns.push({ label: "删除项目 /p del", cmd: "/p del", section: "其他" })
  btns.push({ label: "配置工作区 /p setup", cmd: "/p setup", section: "其他" })
  btns.push({ label: "帮助 /p help", cmd: "/p help", section: "其他" })
  await reportCommandResult(
    port,
    messageId,
    true,
    `${head}\n\n💡 点「进入」才会切换到该项目；直接发消息不会自动进入`,
    chatId,
    btns,
    { cardTitle: { title: "项目", subtitle: "菜单" }, patchMessageId },
  )
}

export async function handleFeishuProjectCommand(
  port: number,
  messageId: string,
  raw: string,
  chatId?: string,
  patchMessageId?: string,
): Promise<void> {
  ensureStore()
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    await replyProjectMenu(port, messageId, chatId)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, projectHelpText(), chatId)
    return
  }

  if (sub === "menu") {
    // --back：setup/new 等域内「返回菜单」按钮——原卡跳回；普通入口保持新发（导航锚点不吃卡）
    const back = parts.slice(2).some((t) => low(t) === "--back")
    await replyProjectMenu(port, messageId, chatId, back ? patchMessageId : undefined)
    return
  }

  if (sub === "ls" || sub === "list") {
    await replyProjectMenu(port, messageId, chatId)
    return
  }

  if (sub === "use") {
    const target = resolveProjectRef(parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/p use <序号|id>", chatId)
      return
    }
    setCurrentProjectId(target.id)
    await reportCommandResult(
      port,
      messageId,
      true,
      withChatFooter(`✅ 已进入项目会话\n\n${formatProjectCard(target)}`),
      chatId,
      projectButtons(target),
      { cardTitle: projectCardTitle(target) },
    )
    if (chatId) await enterProjectSession(port, chatId, target)
    return
  }

  if (sub === "leave") {
    if (!chatId) {
      await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
      return
    }
    const back = await leaveProjectSession(port, chatId)
    const lines = [
      "✅ 已退出项目，回到普通会话",
      back.workspaceDir ? `📁 ${back.workspaceDir}` : "",
      back.branch ? `🌿 ${back.branch}` : "",
    ].filter(Boolean)
    await reportCommandResult(port, messageId, true, lines.join("\n"), chatId, [
      { label: "会话状态 /s", cmd: "/s" },
      { label: "切换会话 /c", cmd: "/c" },
    ], {
      cardTitle: buildSessionCardTitle({ workspaceDir: back.workspaceDir }),
      sessionKey: back.sessionKey,
    })
    return
  }

  if (sub === "status") {
    const cur = getCurrentProject()
    if (!cur) {
      await reportCommandResult(port, messageId, false, "❌ 没有当前项目", chatId)
      return
    }
    await reportCommandResult(port, messageId, true, formatProjectCard(cur), chatId, projectButtons(cur), {
      cardTitle: projectCardTitle(cur),
    })
    return
  }

  if (sub === "new") {
    await handleNewCommand(port, messageId, chatId, parts)
    return
  }

  if (sub === "del" || sub === "delete" || sub === "rm") {
    await handleDeleteProjectCommand(port, messageId, chatId, parts.slice(2), patchMessageId)
    return
  }

  if (sub === "setup") {
    await handleSetupCommand(port, messageId, chatId, parts.slice(2), patchMessageId)
    return
  }

  if (sub === "ship") {
    await handleShipCommand(port, messageId, chatId, parts.slice(2))
    return
  }

  // 宿主特殊节点（语义 id）：先于普通节点路由拦截
  if (sub === "deploy") {
    await handleDeployCommand(port, messageId, chatId)
    return
  }

  if (sub === "submit-test") {
    await handleSubmitTestCommand(port, messageId, chatId)
    return
  }

  if (!PROJECT_RESERVED_SUBCOMMANDS.includes(sub) && getProjectNodes(getCurrentProject()?.groupId).some((n) => n.id === sub)) {
    await runAction(port, messageId, chatId, sub)
    return
  }

  if (sub === "sync") {
    const cur = getCurrentProject()
    if (!cur) {
      await reportCommandResult(port, messageId, false, "❌ 没有当前项目", chatId)
      return
    }
    const accepted = lastAcceptedAction(cur)
    if (!accepted?.artifactPath) {
      await reportCommandResult(port, messageId, false, "❌ 没有可同步的 accepted artifact", chatId)
      return
    }
    const abs = path.isAbsolute(accepted.artifactPath)
      ? accepted.artifactPath
      : path.join(cur.worktreePath, accepted.artifactPath)
    const sync = syncArtifactToFeishu({ artifactPath: abs, title: `${cur.name} · ${accepted.type}` })
    if (sync.docUrl) {
      updateAction(cur.id, accepted.id, { feishuDocUrl: sync.docUrl })
    }
    if (!sync.ok) {
      await reportCommandResult(port, messageId, false, `⚠️ ${sync.error}`, chatId)
      return
    }
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 已同步飞书${sync.docUrl ? `\n${sync.docUrl}` : ""}`,
      chatId,
    )
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知指令: ${parts[1]}\n\n${projectHelpText()}`, chatId)
}

export async function handleProjectSyncSignal(payload: {
  projectId: string
  actionId: string
  artifactPath?: string
}): Promise<void> {
  ensureStore()
  const p = getProject(payload.projectId)
  if (!p) return
  const action = p.actions.find((a) => a.id === payload.actionId)
  if (!action) return
  const artifactPath = payload.artifactPath || action.artifactPath
  if (!artifactPath) return
  const abs = path.isAbsolute(artifactPath) ? artifactPath : path.join(p.worktreePath, artifactPath)
  if (!fs.existsSync(abs)) return
  const sync = syncArtifactToFeishu({ artifactPath: abs, title: `${p.name} · ${action.type}` })
  if (sync.docUrl) updateAction(p.id, action.id, { feishuDocUrl: sync.docUrl })
}
