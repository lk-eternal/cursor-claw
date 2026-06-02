import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getInstance,
  listInstances,
  listDefinitions,
  getDefinition,
  saveDefinition,
  deleteDefinition,
} from "./workflow-store.js";
import {
  handleNext,
  handleReject,
  createInstance,
  startWorkflow,
  type EngineResult,
} from "./workflow-engine.js";
import type { WorkflowDefinition, WorkflowInstance } from "./shared/workflow-types.js";
import { normalizeWorkflowDefinition } from "./shared/workflow-types.js";
import { parseWorkflowDefinitionText } from "./shared/workflow-parse.js";
import { randomUUID } from "node:crypto";

function txt(text: string) { return { content: [{ type: "text" as const, text }] }; }

// ── Daemon → Electron 信号发射 ──────────────────────────

function emitLaunch(inst: WorkflowInstance, result: EngineResult): void {
  if (!result.node || !result.prompt) return;
  const payload = {
    instanceId: inst.id,
    nodeId: result.node.id,
    nodeName: result.node.name,
    prompt: result.prompt,
    workingDirectory: inst.workingDirectory,
    notifyChatId: inst.notifyChatId,
    model: result.node.model,
  };
  process.stdout.write(`__WF_LAUNCH__:${JSON.stringify(payload)}\n`);
}

function emitNotify(chatId: string | undefined, text: string): void {
  if (!chatId) return;
  process.stdout.write(`__WF_NOTIFY__:${JSON.stringify({ chatId, text })}\n`);
}

function emitInstanceUpdate(inst: WorkflowInstance): void {
  process.stdout.write(`__WF_INSTANCE__:${JSON.stringify(inst)}\n`);
}

function validateRunning(instanceId: string): string | null {
  const inst = getInstance(instanceId);
  if (!inst) return `❌ 工作流实例 "${instanceId}" 不存在`;
  if (inst.status !== "running") return `❌ 工作流实例 "${instanceId}" 非运行状态（当前: ${inst.status}）`;
  return null;
}

function respondEngineResult(
  instanceId: string,
  result: EngineResult
): string {
  const inst = getInstance(instanceId);

  if (inst) emitInstanceUpdate(inst);

  if (result.failed) {
    emitNotify(inst?.notifyChatId, `❌ 工作流失败: ${result.message}`);
    return `❌ ${result.message}`;
  }
  if (result.done) {
    emitNotify(inst?.notifyChatId, "✅ 工作流已完成。所有节点执行成功。");
    return "✅ 工作流已完成。所有节点执行成功。";
  }
  if (result.isolated && inst) {
    emitLaunch(inst, result);
    return `✅ 下一节点「${result.node?.name}」将由独立 Agent 处理。`;
  }
  return result.prompt ?? "✅ 已提交";
}

// ── Agent 侧工具：workflow_next / workflow_reject ────────

export function registerWorkflowAgentTools(mcpServer: McpServer): void {
  mcpServer.tool(
    "workflow_next",
    "完成当前工作流节点，提交产物并流转到下一个节点",
    {
      instance_id: z.string().describe("工作流实例 ID（见 Prompt 中的「实例 ID」）"),
      output: z.string().describe("当前节点的产出（结构化文本）"),
    },
    async ({ instance_id, output }) => {
      const err = validateRunning(instance_id);
      if (err) return txt(err);

      const inst = getInstance(instance_id);
      emitNotify(inst?.notifyChatId, `✅ 节点产物已提交: ${output}`);

      const result = handleNext(instance_id, { output });
      return txt(respondEngineResult(instance_id, result, ));
    },
  );

  mcpServer.tool(
    "workflow_reject",
    "驳回工作流节点产物，回退到指定节点重新执行（默认上一个节点）",
    {
      instance_id: z.string().describe("工作流实例 ID（见 Prompt 中的「实例 ID」）"),
      reason: z.string().describe("驳回原因"),
      target_node_id: z.string().optional().describe("回退目标节点 ID（可选，默认上一个节点）"),
    },
    async ({ instance_id, reason, target_node_id }) => {
      const err = validateRunning(instance_id);
      if (err) return txt(err);

      const inst = getInstance(instance_id);
      emitNotify(inst?.notifyChatId, `⚠️ 驳回已提交。理由: ${reason}`);

      const result = handleReject(instance_id, { reason, targetNodeId: target_node_id });
      return txt(respondEngineResult(instance_id, result));
    },
  );
}

// ── Admin 侧工具：manage_workflows ──────────────────────

export function registerWorkflowAdminTools(mcpServer: McpServer): void {
  mcpServer.tool(
    "manage_workflows",
    "管理工作流定义与实例。支持：list / get / create / update / delete / run / status",
    {
      action: z.enum(["list", "get", "create", "update", "delete", "run", "status"]).describe("操作"),
      id: z.string().optional().describe("工作流定义 ID 或实例 ID"),
      data: z.string().optional().describe("工作流定义 YAML 或 JSON（create/update 时使用，YAML 推荐）"),
      input: z.string().optional().describe("run 时的初始输入"),
      workingDirectory: z.string().optional().describe("run 时的工作目录（覆盖定义默认值）"),
    },
    async ({ action, id, data, input, workingDirectory }) => {
      try {
        if (action === "list") {
          const defs = listDefinitions();
          if (defs.length === 0) return txt("当前没有工作流定义。");
          const lines = defs.map((d) => `- **${d.name}** (${d.nodes.length} 节点) ID: \`${d.id}\``);
          return txt(lines.join("\n"));
        }

        if (action === "get") {
          if (!id) return txt("❌ 需要提供 id 参数");
          const def = getDefinition(id);
          if (!def) return txt(`❌ 工作流 "${id}" 不存在`);
          return txt(JSON.stringify(def, null, 2));
        }

        if (action === "create") {
          if (!data) return txt("❌ 需要提供 data 参数（JSON 格式的工作流定义）");
          const parsed = parseWorkflowDefinitionText(data);
          const now = Date.now();
          const def = normalizeWorkflowDefinition({
            ...parsed,
            id: parsed.id || randomUUID(),
            name: parsed.name || "未命名工作流",
            createdAt: now,
            updatedAt: now,
          });
          saveDefinition(def);
          return txt(`✅ 工作流「${def.name}」已创建。ID: \`${def.id}\`\n节点: ${def.nodes.map((n) => n.name).join(" → ")}`);
        }

        if (action === "update") {
          if (!id) return txt("❌ 需要提供 id 参数");
          if (!data) return txt("❌ 需要提供 data 参数");
          const existing = getDefinition(id);
          if (!existing) return txt(`❌ 工作流 "${id}" 不存在`);
          const patch = parseWorkflowDefinitionText(data);
          const updated = normalizeWorkflowDefinition({
            ...existing,
            ...patch,
            id: existing.id,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
            nodes: patch.nodes?.length ? patch.nodes : existing.nodes,
          });
          saveDefinition(updated);
          return txt(`✅ 工作流「${updated.name}」已更新。`);
        }

        if (action === "delete") {
          if (!id) return txt("❌ 需要提供 id 参数");
          if (deleteDefinition(id)) return txt("✅ 工作流已删除。");
          return txt(`❌ 工作流 "${id}" 不存在`);
        }

        if (action === "run") {
          if (!id) return txt("❌ 需要提供 id 参数（工作流定义 ID）");
          const def = getDefinition(id);
          if (!def) return txt(`❌ 工作流 "${id}" 不存在`);

          const inst = createInstance(def, {
            input,
            workingDirectory: workingDirectory || def.workingDirectory,
          });

          const result = startWorkflow(inst.id);
          if (result.failed) return txt(`❌ ${result.message}`);

          const fresh = getInstance(inst.id)!;
          emitInstanceUpdate(fresh);
          emitLaunch(fresh, result);
          emitNotify(fresh.notifyChatId, `🚀 工作流「${def.name}」已启动，第一个节点: ${result.node?.name}`);

          return txt([
            `🚀 工作流「${def.name}」已启动`,
            `实例 ID: \`${inst.id}\``,
            `第一个节点: ${result.node?.name}`,
            "Agent 已发起启动信号",
          ].join("\n"));
        }

        if (action === "status") {
          const instances = id ? [getInstance(id)].filter(Boolean) : listInstances();
          if (instances.length === 0) return txt("没有工作流实例。");
          const lines = instances.map((inst) => {
            if (!inst) return "";
            const def = getDefinition(inst.workflowId);
            return [
              `**${def?.name || inst.workflowId}** — ${inst.status}`,
              `  ID: \`${inst.id}\``,
              `  当前节点: ${inst.currentNodeId || "(无)"}`,
              `  步数: ${inst.stepCount}/${inst.maxSteps}`,
              `  节点历史: ${inst.nodeHistory.length} 条`,
            ].join("\n");
          });
          return txt(lines.join("\n\n"));
        }

        return txt(`❌ 未知操作: ${action}`);
      } catch (e: any) {
        return txt(`❌ 操作失败: ${e?.message ?? e}`);
      }
    },
  );
}
