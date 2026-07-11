import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  getProject,
  listProjects,
  updateAction,
  getCurrentProject,
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
): void {
  if (!chatId) return
  process.stdout.write(`__PROJECT_NOTIFY__:${JSON.stringify({ chatId, text, buttons, footer })}\n`)
}

function emitProjectSync(payload: { projectId: string; actionId: string; artifactPath?: string }): void {
  process.stdout.write(`__PROJECT_SYNC__:${JSON.stringify(payload)}\n`)
}

export function registerProjectAgentTools(mcpServer: McpServer): void {
  mcpServer.tool(
    "project_action_done",
    "登记项目 action 状态与产物（awaiting_ack / accepted / rejected / failed）",
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
      const r = updateAction(args.project_id, args.action_id, {
        status: args.status,
        artifactPath: args.artifact_path,
        summary: args.summary,
        mrUrl: args.mr_url,
        error: args.error,
        feishuDocUrl: args.feishu_doc_url,
      })
      if (!r.ok) return txt(`❌ ${r.error}`)
      const p = r.project
      const typeLabel: Record<string, string> = {
        plan: "规划", build: "实现", review: "审查", ship: "交付",
      }
      const typeName = typeLabel[r.action.type] || r.action.type
      const advanceBtns = [
        { label: "规划 /p plan", cmd: "/p plan" },
        { label: "实现 /p build", cmd: "/p build" },
        { label: "审查 /p review", cmd: "/p review" },
        { label: "交付 /p ship", cmd: "/p ship" },
        { label: "退出项目 /p leave", cmd: "/p leave" },
      ]
      const footer = "也可直接发消息，在项目会话里继续聊"
      if (args.status === "awaiting_ack") {
        emitProjectNotify(
          p.notifyChatId,
          `⏳ 项目「${p.name}」${typeName} 待确认\n产物: ${args.artifact_path || "(无)"}\n摘要: ${args.summary || "(无)"}`,
          advanceBtns,
          footer,
        )
      } else if (args.status === "accepted") {
        emitProjectNotify(p.notifyChatId, `✅ 项目「${p.name}」${typeName} 已通过`, advanceBtns, footer)
        if (args.artifact_path) {
          emitProjectSync({ projectId: p.id, actionId: r.action.id, artifactPath: args.artifact_path })
        }
      } else if (args.status === "rejected") {
        emitProjectNotify(p.notifyChatId, `⏹ 项目「${p.name}」${typeName} 已驳回`, advanceBtns, footer)
      } else {
        emitProjectNotify(p.notifyChatId, `❌ 项目「${p.name}」${typeName} 失败: ${args.error || ""}`, advanceBtns, footer)
      }
      return txt(`✅ 已更新 action ${args.action_id} → ${args.status}`)
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
}
