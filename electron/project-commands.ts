import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { getConfig } from "./config-store"
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
import { launchProjectAgent } from "./session-dispatcher"

const PROJECT_HELP = [
  "💡 /p 子命令（全称 /project）",
  "🔹 /p — 当前项目状态卡",
  "🔹 /p new [名字] — 交互创建（逐步选主仓/分支/目标）",
  "🔹 /p new --cancel — 取消创建向导",
  "🔹 /p ls — 列表",
  "🔹 /p use <序号|id> — 切换当前项目",
  "🔹 /p plan|build|review|ship — 触发 action",
  "🔹 /p sync — 同步最近 accepted artifact 到飞书",
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
    p.storyUrl ? `🔗 story · ${p.storyUrl}` : "",
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

function projectButtons(p: Project): CommandButton[] {
  return [
    { label: "plan /p plan", cmd: "/p plan" },
    { label: "build /p build", cmd: "/p build" },
    { label: "review /p review", cmd: "/p review" },
    { label: "ship /p ship", cmd: "/p ship" },
    { label: "sync /p sync", cmd: "/p sync" },
    { label: "列表 /p ls", cmd: "/p ls" },
  ]
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

async function finalizeNewProject(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: ProjectNewDraft,
): Promise<void> {
  const cfg = getConfig()
  if (!draft.name || !draft.repoPath || !draft.baseBranch || !draft.featureBranch || !draft.goal) {
    await reportCommandResult(port, messageId, false, "❌ 创建信息不完整", chatId)
    return
  }
  if (!cfg.worktreeRoot?.trim()) {
    await reportCommandResult(port, messageId, false, "❌ 未配置 worktree 根目录（设置 → 项目工作区）", chatId)
    return
  }
  if (!isGitRepoRoot(draft.repoPath)) {
    await reportCommandResult(port, messageId, false, `❌ 主仓无效: ${draft.repoPath}`, chatId)
    return
  }
  const worktreePath = path.join(cfg.worktreeRoot.trim(), slugify(draft.name))
  const wt = addProjectWorktree({
    repoPath: draft.repoPath,
    worktreePath,
    featureBranch: draft.featureBranch,
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
      repoPath: draft.repoPath,
      baseBranch: draft.baseBranch,
      featureBranch: draft.featureBranch,
      worktreePath,
      notifyChatId: chatId,
    })
    if (chatId) {
      project.sessionKey = projectSessionKey(chatId, project.id)
      const { saveProject } = await import("../src/shared/project-store.js")
      saveProject(project)
    }
    ensureArtifactDir(worktreePath)
    clearProjectNewDraft(draft.chatKey)
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 项目已创建（worktree）\n\n${formatProjectCard(project)}`,
      chatId,
      projectButtons(project),
    )
  } catch (e: any) {
    removeProjectWorktree(draft.repoPath, worktreePath)
    await reportCommandResult(port, messageId, false, `❌ 创建失败已回滚: ${e?.message || e}`, chatId)
  }
}

async function promptNewStep(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: ProjectNewDraft,
): Promise<void> {
  const cfg = getConfig()
  saveProjectNewDraft(draft)

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
      clearProjectNewDraft(draft.chatKey)
      await reportCommandResult(port, messageId, false, "❌ 请先在 设置 → 项目工作区 登记主仓路径", chatId)
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
  const value = text.trim()
  if (!value) return true

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
    await reportCommandResult(port, messageId, true, "已取消创建项目", chatId)
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

  // /p new  或  /p new 名字
  if (!chatKey) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
    return
  }
  if (!cfg.worktreeRoot?.trim() || !(cfg.repoRoots || []).length) {
    await reportCommandResult(
      port,
      messageId,
      false,
      "❌ 请先在 设置 → 项目工作区 配置：主仓列表 + worktree 根目录",
      chatId,
    )
    return
  }

  const nameArg = parts[2] && !parts[2].startsWith("--") ? parts.slice(2).join(" ").trim() : ""
  const draft: ProjectNewDraft = {
    chatKey,
    step: nameArg ? "repo" : "name",
    name: nameArg || undefined,
    updatedAt: Date.now(),
  }
  await promptNewStep(port, messageId, chatId, draft)
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
      await reportCommandResult(port, messageId, true, "📭 暂无项目。用法见 /p help", chatId)
      return
    }
    const curId = getCurrentProject()?.id
    const lines = list.map((p, i) => `#${i + 1}\t${p.name}${p.id === curId ? " ★" : ""} · ${p.status} · ${p.featureBranch}`)
    await reportCommandResult(port, messageId, true, `📦 项目一览\n\n${lines.join("\n")}\n\n✨ /p use <序号>`, chatId)
    return
  }

  if (sub === "use") {
    const target = resolveProjectRef(parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/p use <序号|id>", chatId)
      return
    }
    setCurrentProjectId(target.id)
    await reportCommandResult(port, messageId, true, `✅ 已切换当前项目\n\n${formatProjectCard(target)}`, chatId, projectButtons(target))
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
