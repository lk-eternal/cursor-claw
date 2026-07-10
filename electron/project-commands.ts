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
  "🔹 /p new <名> <主仓序号> <基线分支> <feature分支> <目标…>",
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
  const cfg = getConfig()

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
    // /p new <name> <repoIndex> <baseBranch> <featureBranch> <goal...>
    if (parts.length < 6) {
      const roots = cfg.repoRoots || []
      const rootLines = roots.length
        ? roots.map((r, i) => `#${i + 1}\t${r}`).join("\n")
        : "（设置 → 项目工作区 中登记主仓路径）"
      await reportCommandResult(
        port,
        messageId,
        false,
        `💡 用法：/p new <名> <主仓序号> <基线分支> <feature分支> <目标…>\n\n主仓列表：\n${rootLines}\n\nworktree 根目录：${cfg.worktreeRoot || "（未配置）"}`,
        chatId,
      )
      return
    }
    const name = parts[2]
    const repoIdx = Number.parseInt(parts[3], 10)
    const baseBranch = parts[4]
    const featureBranch = parts[5]
    const goal = parts.slice(6).join(" ").trim()
    if (!goal) {
      await reportCommandResult(port, messageId, false, "❌ 请填写目标描述", chatId)
      return
    }
    const roots = cfg.repoRoots || []
    if (!Number.isInteger(repoIdx) || repoIdx < 1 || repoIdx > roots.length) {
      await reportCommandResult(port, messageId, false, `❌ 主仓序号无效（1～${roots.length || 0}）`, chatId)
      return
    }
    if (!cfg.worktreeRoot?.trim()) {
      await reportCommandResult(port, messageId, false, "❌ 未配置 worktree 根目录（设置 → 项目工作区）", chatId)
      return
    }
    const repoPath = roots[repoIdx - 1]
    if (!isGitRepoRoot(repoPath)) {
      await reportCommandResult(port, messageId, false, `❌ 主仓无效: ${repoPath}`, chatId)
      return
    }
    const worktreePath = path.join(cfg.worktreeRoot.trim(), slugify(name))
    const wt = addProjectWorktree({ repoPath, worktreePath, featureBranch, baseBranch })
    if (!wt.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${wt.error}`, chatId)
      return
    }
    try {
      const project = createProject({
        name,
        goal,
        repoPath,
        baseBranch,
        featureBranch,
        worktreePath,
        notifyChatId: chatId,
        sessionKey: chatId ? projectSessionKey(chatId, "pending") : undefined,
      })
      if (chatId) {
        project.sessionKey = projectSessionKey(chatId, project.id)
        const { saveProject } = await import("../src/shared/project-store.js")
        saveProject(project)
      }
      ensureArtifactDir(worktreePath)
      await reportCommandResult(
        port,
        messageId,
        true,
        `✅ 项目已创建（worktree）\n\n${formatProjectCard(project)}`,
        chatId,
        projectButtons(project),
      )
    } catch (e: any) {
      removeProjectWorktree(repoPath, worktreePath)
      await reportCommandResult(port, messageId, false, `❌ 创建失败已回滚: ${e?.message || e}`, chatId)
    }
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
