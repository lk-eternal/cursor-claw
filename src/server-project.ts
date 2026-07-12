import path from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  getProject,
  listProjects,
  updateAction,
  getCurrentProject,
  getProjectNodes,
  projectNodeLabel,
} from "./shared/project-store.js"
import { projectIdFromSessionKey } from "./shared/project-types.js"

function txt(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

function emitProjectNotify(
  chatId: string | undefined,
  text: string,
  buttons?: { label: string; cmd: string }[],
  footer?: string,
  filePath?: string,
  sessionKey?: string,
): void {
  if (!chatId) return
  process.stdout.write(`__PROJECT_NOTIFY__:${JSON.stringify({ chatId, text, buttons, footer, filePath, sessionKey })}\n`)
}

function emitProjectSync(payload: { projectId: string; actionId: string; artifactPath?: string }): void {
  process.stdout.write(`__PROJECT_SYNC__:${JSON.stringify(payload)}\n`)
}

export function registerProjectAgentTools(mcpServer: McpServer): void {
  mcpServer.tool(
    "project_action_done",
    "登记项目 action 产物。产出即完成：宿主会把产物文件直接发给用户并给出推进按钮，无需用户确认（status 传 accepted；失败传 failed）",
    {
      project_id: z.string().describe("项目 ID"),
      action_id: z.string().describe("action ID"),
      status: z.enum(["awaiting_ack", "accepted", "rejected", "failed"]),
      artifact_path: z.string().optional().describe("artifact 相对或绝对路径"),
      summary: z.string().optional(),
      mr_url: z.string().optional(),
      error: z.string().optional(),
      feishu_doc_url: z.string().optional(),
    },
    async (args) => {
      // 产出即完成：历史上的 awaiting_ack 归一为 accepted，不再要求用户点通过
      const status = args.status === "awaiting_ack" ? "accepted" : args.status
      const r = updateAction(args.project_id, args.action_id, {
        status,
        artifactPath: args.artifact_path,
        summary: args.summary,
        mrUrl: args.mr_url,
        error: args.error,
        feishuDocUrl: args.feishu_doc_url,
      })
      if (!r.ok) return txt(`❌ ${r.error}`)
      const p = r.project
      const typeName = projectNodeLabel(r.action.type)
      const advanceBtns = getProjectNodes().map((n) => ({
        label: `${n.label} /p ${n.id}`,
        cmd: `/p ${n.id}`,
      }))
      const footer = "点按钮推进下一步；要改产物直接发消息说"
      if (status === "accepted") {
        const artifactAbs = args.artifact_path
          ? (path.isAbsolute(args.artifact_path) ? args.artifact_path : path.join(p.worktreePath, args.artifact_path))
          : undefined
        emitProjectNotify(
          p.notifyChatId,
          [
            `✅ 项目「${p.name}」${typeName}完成`,
            args.summary ? `摘要：${args.summary}` : "",
            args.mr_url ? `MR：${args.mr_url}` : "",
          ].filter(Boolean).join("\n"),
          advanceBtns,
          footer,
          artifactAbs,
          p.sessionKey,
        )
        if (args.artifact_path) {
          emitProjectSync({ projectId: p.id, actionId: r.action.id, artifactPath: args.artifact_path })
        }
      } else if (status === "rejected") {
        emitProjectNotify(p.notifyChatId, `⏹ 项目「${p.name}」${typeName}已中止`, advanceBtns, footer)
      } else {
        emitProjectNotify(p.notifyChatId, `❌ 项目「${p.name}」${typeName}失败: ${args.error || ""}`, advanceBtns, footer)
      }
      return txt(`✅ 已登记 ${typeName}完成，产物已发送给用户，无需再向用户确认`)
    },
  )

  
  mcpServer.tool(
    "project_update",
    "更新项目元数据。字段红线：baseBranch=生产基线，只作切 feature 起点，禁止默认作为 ship 推送/MR 目标；testBranch=测试环境；developBranch=开发环境。可补齐 repos[].testBranch/developBranch、goal、文档链接等。",
    {
      project_id: z.string().optional().describe("项目 ID；缺省当前项目"),
      session_key: z.string().optional(),
      goal: z.string().optional(),
      story_url: z.string().optional(),
      product_doc_url: z.string().optional(),
      tech_doc_url: z.string().optional(),
      feature_branch: z.string().optional(),
      base_branch: z.string().optional().describe("生产基线（谨慎修改）"),
      test_branch: z.string().optional().describe("主仓测试分支"),
      develop_branch: z.string().optional().describe("主仓开发分支"),
      repo_index: z.number().int().min(0).optional().describe("改第几个仓的分支，默认 0"),
    },
    async (args) => {
      let id = args.project_id
      if (!id && args.session_key) id = projectIdFromSessionKey(args.session_key)
      const p = id ? getProject(id) : getCurrentProject()
      if (!p) return txt("❌ 未找到项目")
      if (args.goal !== undefined) p.goal = args.goal
      if (args.story_url !== undefined) p.storyUrl = args.story_url || undefined
      if (args.product_doc_url !== undefined) p.productDocUrl = args.product_doc_url || undefined
      if (args.tech_doc_url !== undefined) p.techDocUrl = args.tech_doc_url || undefined
      if (args.feature_branch !== undefined) p.featureBranch = args.feature_branch
      if (args.base_branch !== undefined) {
        p.baseBranch = args.base_branch
      }
      const repos = [...(p.repos || [{
        repoPath: p.repoPath,
        baseBranch: p.baseBranch,
        worktreePath: p.worktreePath,
      }])]
      const idx = args.repo_index ?? 0
      if (!repos[idx]) return txt(`❌ repos[${idx}] 不存在`)
      if (args.base_branch !== undefined) repos[idx].baseBranch = args.base_branch
      if (args.test_branch !== undefined) repos[idx].testBranch = args.test_branch || undefined
      if (args.develop_branch !== undefined) repos[idx].developBranch = args.develop_branch || undefined
      p.repos = repos
      if (idx === 0) {
        p.repoPath = repos[0].repoPath
        p.baseBranch = repos[0].baseBranch
        p.worktreePath = repos[0].worktreePath
      }
      const { saveProject } = await import("./shared/project-store.js")
      saveProject(p)
      process.stdout.write(`__PROJECT_PROFILE_UPSERT__:${JSON.stringify({
        path: repos[idx].repoPath,
        baseBranch: repos[idx].baseBranch,
        testBranch: repos[idx].testBranch,
        developBranch: repos[idx].developBranch,
      })}\n`)
      return txt(`✅ 已更新项目 ${p.id}\n${JSON.stringify({
        goal: p.goal,
        featureBranch: p.featureBranch,
        baseBranch: p.baseBranch,
        repos: p.repos,
      }, null, 2)}`)
    },
  )

mcpServer.tool(
    "project_get",
    "查询项目详情（含 actions）",
    {
      project_id: z.string().optional().describe("项目 ID；缺省当前项目；也可从 session 推断"),
      session_key: z.string().optional(),
    },
    async ({ project_id, session_key }) => {
      let id = project_id
      if (!id && session_key) id = projectIdFromSessionKey(session_key)
      const p = id ? getProject(id) : getCurrentProject()
      if (!p) return txt("❌ 未找到项目")
      return txt(JSON.stringify(p, null, 2))
    },
  )

  mcpServer.tool(
    "project_list",
    "列出所有项目",
    {},
    async () => {
      const list = listProjects()
      if (list.length === 0) return txt("📭 暂无项目")
      const lines = list.map((p, i) => `#${i + 1} ${p.name} (${p.status}) id=${p.id} branch=${p.featureBranch}`)
      return txt(lines.join("\n"))
    },
  )

  mcpServer.tool(
    "project_delete",
    "删除项目（宿主连带移除全部 worktree；不动主仓与远程分支）。删除前必须先向用户确认",
    {
      project_id: z.string().describe("项目 ID"),
    },
    async ({ project_id }) => {
      const p = getProject(project_id)
      if (!p) return txt("❌ 未找到项目")
      process.stdout.write(`__PROJECT_DELETE__:${JSON.stringify({ projectId: project_id })}\n`)
      return txt(`✅ 已提交删除「${p.name}」，宿主正在清理 worktree`)
    },
  )
}
