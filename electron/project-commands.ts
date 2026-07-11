import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { getConfig, saveConfig } from "./config-store"
import { reportCommandResult, type CommandButton } from "./command-handler"
import {
  createProject,
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
  type ProjectNewDraft,
} from "../src/shared/project-store.js"
import {
  artifactRelPath,
  isProjectActionType,
  projectSessionKey,
  type Project,
  type ProjectActionType,
} from "../src/shared/project-types.js"
import { addProjectWorktree, ensureArtifactDir, isGitRepoRoot, removeProjectWorktree } from "./project-worktree"
import { pushAndCreateMergeRequest } from "./project-gitlab"
import { syncArtifactToFeishu } from "./project-feishu-sync"
import { httpPost, syncActiveSession, getCurrentActiveSession } from "./daemon-client"
import { launchProjectAgent } from "./session-dispatcher"

const PROJECT_HELP = [
  "💡 /p 子命令（全称 /project）",
  "🔹 /p — 当前项目状态卡",
  "🔹 /p new — 飞书大表单创建（下拉+手填，一次提交）",
  "🔹 /p ls — 项目列表并切换",
  "🔹 /p use <序号|id> — 进入该项目会话",
  "🔹 /p leave — 退出项目，回到普通会话",
  "🔹 /p plan|build|review|ship — 推进阶段（注入项目会话队列）",
  "🔹 /p sync — 同步最近 accepted artifact 到飞书",
  "🔹 /p setup — 仅配置 worktree/主仓",
].join("\n")

function ensureStore(): void {
  initProjectStore(app.getPath("userData"))
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `p${Date.now().toString(36)}`
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
    `🌿 ${p.featureBranch} ← ${p.baseBranch}`,
    `📁 ${p.worktreePath}`,
    `💠 ${p.status}`,
    last ? `⏭ 最近 action · ${last.type} (${last.status})` : "⏭ 尚无 action",
    accepted?.artifactPath ? `📄 artifact · ${accepted.artifactPath}` : "",
    accepted?.feishuDocUrl ? `📘 飞书 · ${accepted.feishuDocUrl}` : "",
    last?.mrUrl ? `🔀 MR · ${last.mrUrl}` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

function projectButtons(_p?: Project): CommandButton[] {
  return [
    { label: "规划 /p plan", cmd: "/p plan" },
    { label: "实现 /p build", cmd: "/p build" },
    { label: "审查 /p review", cmd: "/p review" },
    { label: "交付 /p ship", cmd: "/p ship" },
    { label: "同步文档 /p sync", cmd: "/p sync" },
    { label: "项目列表 /p ls", cmd: "/p ls" },
    { label: "退出项目 /p leave", cmd: "/p leave" },
  ]
}

function withChatFooter(text: string, footer = "也可直接发消息，在项目会话里继续聊"): string {
  return `${text}\n\n---\n${footer}`
}

function buildActionPrompt(p: Project, actionId: string, type: ProjectActionType): string {
  const rel = artifactRelPath(actionId, type)
  const abs = path.join(p.worktreePath, rel.replace(/\//g, path.sep))
  const prev = lastAcceptedAction(p)
  const lines = [
    `[PROJECT_ACTION]`,
    `你正在执行项目工作区 action，不是普通闲聊。`,
    `项目 ID: ${p.id}`,
    `Action ID: ${actionId}`,
    `Action 类型: ${type}`,
    `目标: ${p.goal}`,
    p.storyUrl ? `Story: ${p.storyUrl}` : "",
    `工作目录(cwd): ${p.worktreePath}`,
    `Feature 分支: ${p.featureBranch}`,
    `基线分支: ${p.baseBranch}`,
    `Artifact 必须写入: ${abs}`,
    prev?.artifactPath ? `上一份已通过产物: ${prev.artifactPath}` : "",
    "",
    `要求:`,
    `1. 在 worktree 内完成 ${type} 工作，把完整产出写成上述 md 文件`,
    `2. 调用 MCP project_action_done(project_id, action_id, status=awaiting_ack, artifact_path, summary)`,
    `3. 再用 send_question 让用户选择：通过 / 再聊聊 / 驳回（session_key 用当前专属会话）`,
    `4. 用户选择后再次 project_action_done → accepted 或 rejected`,
    `5. 禁止调用 workflow_next；本任务走 project_* 工具`,
  ]
  if (type === "ship") {
    lines.push(
      "",
      `ship 额外要求:`,
      `- 确保改动已提交到 ${p.featureBranch}`,
      `- 推送并开向 ${p.baseBranch} 的 GitLab MR（可用 git + 设置中的 token；若环境已由宿主执行也可在 summary 写 MR 链接）`,
      `- project_action_done 时带上 mr_url`,
    )
  }
  return lines.filter(Boolean).join("\n")
}

async function enterProjectSession(
  port: number,
  chatId: string,
  project: Project,
  welcome?: string,
): Promise<void> {
  const sessionKey = project.sessionKey || projectSessionKey(chatId, project.id)
  project.sessionKey = sessionKey
  project.notifyChatId = chatId
  const { saveProject } = await import("../src/shared/project-store.js")
  saveProject(project)
  const prev = await getCurrentActiveSession(port, chatId)
  if (prev && prev !== sessionKey) {
    // remember previous in draft file? skip — leave goes to bare chatKey
  }
  await syncActiveSession(port, chatId, sessionKey)
  await launchProjectAgent({
    projectId: project.id,
    projectName: project.name,
    workingDirectory: project.worktreePath,
    notifyChatId: chatId,
    prompt: welcome || [
      `[PROJECT_SESSION] 你已进入项目「${project.name}」专属会话。`,
      `目标: ${project.goal}`,
      project.storyUrl ? `飞书项目: ${project.storyUrl}` : "",
      project.productDocUrl ? `产品文档: ${project.productDocUrl}` : "",
      project.techDocUrl ? `技术文档: ${project.techDocUrl}` : "",
      `工作目录: ${project.worktreePath}`,
      `用户可直接发消息自由聊；推进阶段请等用户点击 规划/实现/审查/交付 或发送 /p plan|build|review|ship。`,
      `不要调用 workflow_next。`,
    ].filter(Boolean).join("\n"),
  })
}

async function finalizeNewProject(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: ProjectNewDraft & { productDocUrl?: string; techDocUrl?: string; worktreeRootOverride?: string },
): Promise<void> {
  const cfg = getConfig()
  const worktreeRoot = (draft.worktreeRootOverride || cfg.worktreeRoot || "").trim()
  if (!draft.name || !draft.repoPath || !draft.baseBranch || !draft.goal) {
    await reportCommandResult(port, messageId, false, "❌ 创建信息不完整（名称/主仓/基线分支/目标必填）", chatId)
    return
  }
  if (!worktreeRoot) {
    await reportCommandResult(port, messageId, false, "❌ 未配置 worktree 根目录", chatId)
    return
  }
  if (!isGitRepoRoot(draft.repoPath)) {
    await reportCommandResult(port, messageId, false, `❌ 主仓无效: ${draft.repoPath}`, chatId)
    return
  }
  if (worktreeRoot !== cfg.worktreeRoot) {
    saveConfig({ worktreeRoot })
  }
  const roots = cfg.repoRoots || []
  if (!roots.some((r) => path.resolve(r) === path.resolve(draft.repoPath!))) {
    saveConfig({ repoRoots: [...roots, path.resolve(draft.repoPath)] })
  }

  const featureBranch = (draft.featureBranch || `feature/${slugify(draft.name)}`).trim()
  const worktreePath = path.join(worktreeRoot, slugify(draft.name))
  const wt = addProjectWorktree({
    repoPath: draft.repoPath,
    worktreePath,
    featureBranch,
    baseBranch: draft.baseBranch,
  })
  if (!wt.ok) {
    await reportCommandResult(port, messageId, false, `❌ ${wt.error}`, chatId)
    return
  }
  try {
    const project = createProject({
      name: draft.name,
      goal: draft.goal,
      storyUrl: draft.storyUrl,
      productDocUrl: draft.productDocUrl,
      techDocUrl: draft.techDocUrl,
      repoPath: draft.repoPath,
      baseBranch: draft.baseBranch,
      featureBranch,
      worktreePath,
      notifyChatId: chatId,
    })
    if (chatId) {
      project.sessionKey = projectSessionKey(chatId, project.id)
      const { saveProject } = await import("../src/shared/project-store.js")
      saveProject(project)
    }
    ensureArtifactDir(worktreePath)
    if (draft.chatKey) clearProjectNewDraft(draft.chatKey)
    await reportCommandResult(
      port,
      messageId,
      true,
      withChatFooter(`✅ 项目已创建并进入项目会话\n\n${formatProjectCard(project)}`),
      chatId,
      projectButtons(project),
    )
    if (chatId) {
      await enterProjectSession(port, chatId, project)
    }
  } catch (e: any) {
    removeProjectWorktree(draft.repoPath, worktreePath)
    await reportCommandResult(port, messageId, false, `❌ 创建失败已回滚: ${e?.message || e}`, chatId)
  }
}

function continueAfterSetup(draft: ProjectNewDraft): ProjectNewDraft {
  if (draft.pendingName) {
    draft.name = draft.pendingName
    draft.pendingName = undefined
    draft.step = "repo"
  } else {
    draft.step = "name"
  }
  return draft
}

async function promptNewStep(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: ProjectNewDraft,
): Promise<void> {
  const cfg = getConfig()
  saveProjectNewDraft(draft)

  if (draft.step === "setup_worktree") {
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        "⚙️ 项目工作区尚未配置，先走飞书交互设置",
        "",
        "① 请直接回复 **worktree 根目录** 的绝对路径",
        "例：`D:\\claw-projects`",
        "",
        "取消：/p new --cancel",
      ].join("\n"),
      chatId,
      [{ label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }

  if (draft.step === "setup_repo") {
    const roots = cfg.repoRoots || []
    const list = roots.length ? roots.map((r, i) => `#${i + 1}\t${r}`).join("\n") : "（暂无）"
    const btns: CommandButton[] = []
    if (roots.length > 0) {
      btns.push({ label: "完成，继续", cmd: "/p new --setup-done" })
    }
    btns.push({ label: "取消", cmd: "/p new --cancel" })
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        "⚙️ ② 请直接回复 **主仓本地路径**（须为 git 根目录）",
        "例：`D:\\repos\\foo`",
        "",
        `已登记主仓：\n${list}`,
        roots.length ? "\n可继续回复路径追加；或点「完成，继续」" : "",
      ].filter(Boolean).join("\n"),
      chatId,
      btns,
    )
    return
  }

  if (draft.step === "name") {
    await reportCommandResult(
      port,
      messageId,
      true,
      "📦 创建项目 · 请直接回复**项目名称**（下一条消息）\n取消：/p new --cancel",
      chatId,
      [{ label: "取消 /p new --cancel", cmd: "/p new --cancel" }],
    )
    return
  }

  if (draft.step === "repo") {
    const roots = cfg.repoRoots || []
    if (roots.length === 0) {
      draft.step = "setup_repo"
      await promptNewStep(port, messageId, chatId, draft)
      return
    }
    const lines = roots.map((r, i) => `#${i + 1}\t${r}`).join("\n")
    const btns: CommandButton[] = roots.slice(0, 10).map((r, i) => ({
      label: `#${i + 1} ${path.basename(r)}`,
      cmd: `/p new --repo ${i + 1}`,
    }))
    btns.push({ label: "取消", cmd: "/p new --cancel" })
    await reportCommandResult(
      port,
      messageId,
      true,
      `📦 项目「${draft.name}」· 选择主仓\n\n${lines}`,
      chatId,
      btns,
    )
    return
  }

  if (draft.step === "base") {
    const btns: CommandButton[] = ["main", "master", "develop", "release"].map((b) => ({
      label: b,
      cmd: `/p new --base ${b}`,
    }))
    btns.push({ label: "取消", cmd: "/p new --cancel" })
    await reportCommandResult(
      port,
      messageId,
      true,
      `📦 项目「${draft.name}」· 选择基线分支\n也可直接回复分支名（下一条消息）`,
      chatId,
      btns,
    )
    return
  }

  if (draft.step === "branch") {
    const suggested = `feature/${slugify(draft.name || "task")}`
    await reportCommandResult(
      port,
      messageId,
      true,
      `📦 项目「${draft.name}」· feature 分支\n建议：\`${suggested}\`\n点按钮或直接回复自定义分支名`,
      chatId,
      [
        { label: suggested, cmd: `/p new --branch ${suggested}` },
        { label: "取消", cmd: "/p new --cancel" },
      ],
    )
    return
  }

  if (draft.step === "goal") {
    await reportCommandResult(
      port,
      messageId,
      true,
      `📦 项目「${draft.name}」· 请直接回复**目标描述**（下一条消息）\n取消：/p new --cancel`,
      chatId,
      [{ label: "取消", cmd: "/p new --cancel" }],
    )
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
    try {
      if (!fs.existsSync(value)) fs.mkdirSync(value, { recursive: true })
    } catch (e: any) {
      await reportCommandResult(port, messageId, false, `❌ 无法创建目录: ${e?.message || e}`, chatId)
      return true
    }
    saveConfig({ worktreeRoot: value })
    draft.step = "setup_repo"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }

  if (draft.step === "setup_repo") {
    if (!path.isAbsolute(value)) {
      await reportCommandResult(port, messageId, false, "❌ 请回复主仓绝对路径", chatId)
      return true
    }
    if (!isGitRepoRoot(value)) {
      await reportCommandResult(port, messageId, false, `❌ 不是有效 git 根目录: ${value}`, chatId)
      return true
    }
    const cfg = getConfig()
    const roots = [...(cfg.repoRoots || [])]
    const resolved = path.resolve(value)
    if (!roots.some((r) => path.resolve(r) === resolved)) {
      roots.push(resolved)
      saveConfig({ repoRoots: roots })
    }
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 已登记主仓：${resolved}\n可继续回复路径追加，或点「完成，继续」`,
      chatId,
      [
        { label: "完成，继续", cmd: "/p new --setup-done" },
        { label: "取消", cmd: "/p new --cancel" },
      ],
    )
    saveProjectNewDraft(draft)
    return true
  }

  if (draft.step === "name") {
    draft.name = value
    draft.step = "repo"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "base") {
    draft.baseBranch = value
    draft.step = "branch"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "branch") {
    draft.featureBranch = value
    draft.step = "goal"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "goal") {
    draft.goal = value
    await finalizeNewProject(port, messageId, chatId, draft)
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
    const draft: ProjectNewDraft = {
      chatKey,
      step: "goal",
      name,
      repoPath: roots[repoIdx - 1],
      baseBranch,
      featureBranch,
      goal,
      updatedAt: Date.now(),
    }
    await finalizeNewProject(port, messageId, chatId, draft)
    return
  }

  const flag = parts[2]?.startsWith("--") ? parts[2].toLowerCase() : ""

  if (flag === "--cancel") {
    if (chatKey) clearProjectNewDraft(chatKey)
    await reportCommandResult(port, messageId, true, "已取消向导", chatId)
    return
  }

  if (flag === "--setup-done") {
    const draft = chatKey ? getProjectNewDraft(chatKey) : undefined
    if (!draft) {
      await reportCommandResult(port, messageId, false, "❌ 没有进行中的向导", chatId)
      return
    }
    const roots = getConfig().repoRoots || []
    if (!roots.length) {
      await reportCommandResult(port, messageId, false, "❌ 至少登记一个主仓", chatId)
      return
    }
    if (!getConfig().worktreeRoot?.trim()) {
      draft.step = "setup_worktree"
      await promptNewStep(port, messageId, chatId, draft)
      return
    }
    if (draft.setupOnly) {
      clearProjectNewDraft(chatKey)
      const cfg = getConfig()
      await reportCommandResult(
        port,
        messageId,
        true,
        `✅ 项目工作区已配置\nworktree：${cfg.worktreeRoot}\n主仓：\n${(cfg.repoRoots || []).map((r, i) => `#${i + 1}\t${r}`).join("\n")}\n\n可以 /p new 了`,
        chatId,
        [{ label: "创建项目 /p new", cmd: "/p new" }],
      )
      return
    }
    await promptNewStep(port, messageId, chatId, continueAfterSetup(draft))
    return
  }

  if (flag === "--repo") {
    const draft = chatKey ? getProjectNewDraft(chatKey) : undefined
    if (!draft?.name) {
      await reportCommandResult(port, messageId, false, "❌ 没有进行中的创建，先 /p new", chatId)
      return
    }
    const repoIdx = Number.parseInt(parts[3], 10)
    const roots = cfg.repoRoots || []
    if (!Number.isInteger(repoIdx) || repoIdx < 1 || repoIdx > roots.length) {
      await reportCommandResult(port, messageId, false, "❌ 主仓序号无效", chatId)
      return
    }
    draft.repoPath = roots[repoIdx - 1]
    draft.step = "base"
    await promptNewStep(port, messageId, chatId, draft)
    return
  }

  if (flag === "--base") {
    const draft = chatKey ? getProjectNewDraft(chatKey) : undefined
    if (!draft?.name || !draft.repoPath) {
      await reportCommandResult(port, messageId, false, "❌ 没有进行中的创建，先 /p new", chatId)
      return
    }
    const base = parts[3]
    if (!base) {
      await reportCommandResult(port, messageId, false, "❌ 缺少基线分支", chatId)
      return
    }
    draft.baseBranch = base
    draft.step = "branch"
    await promptNewStep(port, messageId, chatId, draft)
    return
  }

  if (flag === "--branch") {
    const draft = chatKey ? getProjectNewDraft(chatKey) : undefined
    if (!draft?.name || !draft.repoPath || !draft.baseBranch) {
      await reportCommandResult(port, messageId, false, "❌ 没有进行中的创建，先 /p new", chatId)
      return
    }
    const branch = parts.slice(3).join(" ").trim()
    if (!branch) {
      await reportCommandResult(port, messageId, false, "❌ 缺少 feature 分支名", chatId)
      return
    }
    draft.featureBranch = branch
    draft.step = "goal"
    await promptNewStep(port, messageId, chatId, draft)
    return
  }

  // /p new  或  /p new 名字 → 大表单（名字可作表单预填提示，仍发空表单由用户改）
  if (!chatKey) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
    return
  }

  // 若带齐一行参数仍走旧路径；否则发大表单
  try {
    await httpPost(`http://127.0.0.1:${port}/api/project-new-form`, {
      message_id: messageId,
      session_key: chatId,
      repo_roots: cfg.repoRoots || [],
      worktree_root: cfg.worktreeRoot || "",
    })
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
  },
): Promise<void> {
  ensureStore()
  await finalizeNewProject(port, messageId, chatId, {
    chatKey: chatId,
    step: "goal",
    name: fields.name,
    goal: fields.goal,
    repoPath: fields.repoPath,
    baseBranch: fields.baseBranch || "main",
    featureBranch: fields.featureBranch,
    storyUrl: fields.storyUrl || undefined,
    productDocUrl: fields.productDocUrl || undefined,
    techDocUrl: fields.techDocUrl || undefined,
    worktreeRootOverride: fields.worktreeRoot,
    updatedAt: Date.now(),
  })
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

  if (type === "ship") {
    // Host-assisted ship: push+MR first, then still launch agent for summary/HITL if needed.
    const cfg = getConfig()
    const mr = await pushAndCreateMergeRequest({
      cwd: project.worktreePath,
      token: cfg.gitlabToken || "",
      host: cfg.gitlabHost || undefined,
      title: `Draft: ${project.name}`,
      sourceBranch: project.featureBranch,
      targetBranch: project.baseBranch,
      description: project.goal,
    })
    if (!mr.ok) {
      updateAction(project.id, action.id, { status: "failed", error: mr.error })
      await reportCommandResult(port, messageId, false, `❌ ship 失败: ${mr.error}`, chatId)
      return
    }
    updateAction(project.id, action.id, { mrUrl: mr.mrUrl })
  }

  const launch = await launchProjectAgent({
    projectId: project.id,
    projectName: project.name,
    prompt,
    workingDirectory: project.worktreePath,
    notifyChatId: chatId,
  })
  if (!launch.ok) {
    updateAction(project.id, action.id, { status: "failed", error: launch.error })
    await reportCommandResult(port, messageId, false, `❌ 拉起项目会话失败: ${launch.error}`, chatId)
    return
  }
  await reportCommandResult(
    port,
    messageId,
    true,
    `🚀 已启动 ${type}\n项目: ${project.name}\nAction: ${action.id}\n会话: ${sessionKey}${type === "ship" && getProject(project.id)?.actions.find((a) => a.id === action.id)?.mrUrl ? `\nMR: ${getProject(project.id)!.actions.find((a) => a.id === action.id)!.mrUrl}` : ""}`,
    chatId,
  )
}

export async function handleFeishuProjectCommand(
  port: number,
  messageId: string,
  raw: string,
  chatId?: string,
): Promise<void> {
  ensureStore()
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    const cur = getCurrentProject()
    if (!cur) {
      await reportCommandResult(port, messageId, true, `${PROJECT_HELP}\n\n📭 尚无当前项目`, chatId, [
        { label: "列表 /p ls", cmd: "/p ls" },
      ])
      return
    }
    const list = listProjects()
    const idx = list.findIndex((p) => p.id === cur.id) + 1
    await reportCommandResult(port, messageId, true, formatProjectCard(cur, idx), chatId, projectButtons(cur))
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, PROJECT_HELP, chatId)
    return
  }

  if (sub === "ls" || sub === "list") {
    const list = listProjects()
    if (list.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 暂无项目。发 /p new 创建", chatId, [
        { label: "创建项目 /p new", cmd: "/p new" },
      ])
      return
    }
    const curId = getCurrentProject()?.id
    const lines = list.map((p, i) => `#${i + 1}\t${p.name}${p.id === curId ? " ★" : ""} · ${p.status} · ${p.featureBranch}`)
    const btns: CommandButton[] = list.slice(0, 10).map((p, i) => ({
      label: `进入 ${p.name}`,
      cmd: `/p use ${i + 1}`,
    }))
    btns.push({ label: "创建 /p new", cmd: "/p new" })
    await reportCommandResult(port, messageId, true, `📦 项目一览\n\n${lines.join("\n")}`, chatId, btns)
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
    )
    if (chatId) await enterProjectSession(port, chatId, target)
    return
  }

  if (sub === "leave") {
    if (!chatId) {
      await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
      return
    }
    await syncActiveSession(port, chatId, chatId)
    await reportCommandResult(port, messageId, true, "✅ 已退出项目流程，回到普通会话", chatId, [
      { label: "项目列表 /p ls", cmd: "/p ls" },
      { label: "创建 /p new", cmd: "/p new" },
    ])
    return
  }

  if (sub === "status") {
    const cur = getCurrentProject()
    if (!cur) {
      await reportCommandResult(port, messageId, false, "❌ 没有当前项目", chatId)
      return
    }
    await reportCommandResult(port, messageId, true, formatProjectCard(cur), chatId, projectButtons(cur))
    return
  }

  if (sub === "new") {
    await handleNewCommand(port, messageId, chatId, parts)
    return
  }

  if (sub === "setup") {
    if (!chatId) {
      await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
      return
    }
    const cfgNow = getConfig()
    const draft: ProjectNewDraft = {
      chatKey: chatId,
      step: !cfgNow.worktreeRoot?.trim() ? "setup_worktree" : "setup_repo",
      setupOnly: true,
      updatedAt: Date.now(),
    }
    await promptNewStep(port, messageId, chatId, draft)
    return
  }

  if (isProjectActionType(sub)) {
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

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${PROJECT_HELP}`, chatId)
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
