import type {
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowNode,
  WorkflowNextPayload,
  WorkflowRejectPayload,
  NodeExecution,
} from "./shared/workflow-types.js";
import {
  getDefinition,
  getInstance,
  saveInstance,
  listInstances,
} from "./workflow-store.js";
import { randomUUID } from "node:crypto";

// ── Prompt 组装 ──────────────────────────────────────────

function buildNodesBrief(nodes: WorkflowNode[]): string {
  return nodes.map((n, i) => `${i + 1}. [${n.id}] ${n.name}`).join("\n");
}

function assembleContext(instance: WorkflowInstance): string {
  const entries = Object.entries(instance.context);
  if (entries.length === 0) return "(无前序产物)";
  return entries
    .map(([k, v]) => `**${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n\n");
}

export function buildStartPrompt(
  def: WorkflowDefinition,
  node: WorkflowNode,
  instance: WorkflowInstance,
): string {
  const lines = [
    `你正在执行工作流「${def.name}」。`,
    ``,
    `## 当前节点: ${node.name}`,
    ``,
    `### 任务`,
    node.prompt,
    ``,
    `### 输入`,
    instance.input ? instance.input : assembleContext(instance),
    ``,
  ];
  if (def.config && Object.keys(def.config).length > 0) {
    lines.push(
      `### 配置变量`,
      ...Object.entries(def.config).map(([k, v]) => `- **${k}**: ${v}`),
      ``,
    );
  }
  lines.push(
    `### 输出要求`,
    `完成任务后，你 **必须** 调用 \`workflow_next\` 工具提交产物。`,
    `如果你认为输入不合格，调用 \`workflow_reject\` 驳回。`,
    ``,
    `### 工作流节点一览`,
    buildNodesBrief(def.nodes),
    ``,
    `### 可用的工作流工具`,
    `- workflow_next(output): 完成当前节点，提交产物`,
    `- workflow_reject(reason, target_node_id?): 驳回到指定节点（默认上一个节点）`,
  );
  return lines.join("\n");
}

export function buildRetryPrompt(
  def: WorkflowDefinition,
  node: WorkflowNode,
  instance: WorkflowInstance,
  attempt: number,
  rejectFromNodeName: string,
  reason: string,
  previousOutput: unknown,
): string {
  const lines = [
    `你正在执行工作流「${def.name}」。`,
    ``,
    `## 当前节点: ${node.name}（第 ${attempt} 次执行）`,
    ``,
    `⚠️ 你被后续节点「${rejectFromNodeName}」驳回了。`,
    `驳回原因：${reason}`,
    ``,
    `请根据上述原因修正你的产出，并重新调用 \`workflow_next\` 提交。`,
    ``,
    `### 任务`,
    node.prompt,
    ``,
    `### 上一次的产出（供参考）`,
    typeof previousOutput === "string" ? previousOutput : JSON.stringify(previousOutput ?? "(无)"),
    ``,
    `### 输入`,
    assembleContext(instance),
    ``,
  ];
  if (def.config && Object.keys(def.config).length > 0) {
    lines.push(
      `### 配置变量`,
      ...Object.entries(def.config).map(([k, v]) => `- **${k}**: ${v}`),
      ``,
    );
  }
  lines.push(
    `### 工作流节点一览`,
    buildNodesBrief(def.nodes),
    ``,
    `### 可用的工作流工具`,
    `- workflow_next(output): 完成当前节点，提交产物`,
    `- workflow_reject(reason, target_node_id?): 驳回到指定节点（默认上一个节点）`,
  );
  return lines.join("\n");
}

function buildNextNodePrompt(
  def: WorkflowDefinition,
  node: WorkflowNode,
  instance: WorkflowInstance,
): string {
  return buildStartPrompt(def, node, instance);
}

// ── 实例创建 ─────────────────────────────────────────────

export function createInstance(
  def: WorkflowDefinition,
  opts: {
    input?: string
    workingDirectory?: string
    notifyChatId?: string
    sessionKey?: string
    maxSteps?: number
  },
): WorkflowInstance {
  const now = Date.now();
  const inst: WorkflowInstance = {
    id: randomUUID(),
    workflowId: def.id,
    status: "pending",
    currentNodeId: null,
    context: {},
    nodeHistory: [],
    sessionKey: opts.sessionKey,
    notifyChatId: opts.notifyChatId,
    workingDirectory: opts.workingDirectory || def.workingDirectory || process.cwd(),
    input: opts.input,
    maxSteps: opts.maxSteps ?? 50,
    stepCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  saveInstance(inst);
  return inst;
}

// ── 核心引擎逻辑 ─────────────────────────────────────────

export interface EngineResult {
  prompt?: string
  done?: boolean
  failed?: boolean
  isolated?: boolean
  node?: WorkflowNode
  message?: string
}

function getNodeIndex(def: WorkflowDefinition, nodeId: string): number {
  return def.nodes.findIndex((n) => n.id === nodeId);
}

function getNodeRetryCount(instance: WorkflowInstance, nodeId: string): number {
  return instance.nodeHistory.filter(
    (h) => h.nodeId === nodeId && h.rejectFromNodeId,
  ).length;
}

/** 启动工作流，返回第一个节点的 prompt */
export function startWorkflow(instanceId: string): EngineResult {
  const inst = getInstance(instanceId);
  if (!inst) return { failed: true, message: "实例不存在" };

  const def = getDefinition(inst.workflowId);
  if (!def || def.nodes.length === 0) return { failed: true, message: "工作流定义无效或无节点" };

  const firstNode = def.nodes[0];
  inst.status = "running";
  inst.currentNodeId = firstNode.id;
  inst.updatedAt = Date.now();

  const exec: NodeExecution = {
    nodeId: firstNode.id,
    attempt: 1,
    status: "running",
    input: inst.input ? { raw: inst.input } : {},
    startedAt: Date.now(),
  };
  inst.nodeHistory.push(exec);
  saveInstance(inst);

  const prompt = buildStartPrompt(def, firstNode, inst);
  return {
    prompt,
    node: firstNode,
    isolated: firstNode.isolated ?? false,
  };
}

/** 处理 workflow_next 信号 */
export function handleNext(instanceId: string, payload: WorkflowNextPayload): EngineResult {
  const inst = getInstance(instanceId);
  if (!inst || inst.status !== "running") return { failed: true, message: "工作流非运行状态" };

  const def = getDefinition(inst.workflowId);
  if (!def) return { failed: true, message: "工作流定义不存在" };

  const currentIdx = getNodeIndex(def, inst.currentNodeId!);
  if (currentIdx < 0) return { failed: true, message: "当前节点无效" };

  const currentNode = def.nodes[currentIdx];

  // 写入产物
  inst.context[currentNode.id] = payload.output;

  // 更新 nodeHistory 中最新的 running 记录
  const lastExec = [...inst.nodeHistory].reverse().find(
    (h) => h.nodeId === currentNode.id && h.status === "running",
  );
  if (lastExec) {
    lastExec.status = "completed";
    lastExec.output = payload.output;
    lastExec.completedAt = Date.now();
  }

  inst.stepCount++;
  inst.updatedAt = Date.now();

  // 步数熔断
  if (inst.stepCount >= inst.maxSteps) {
    inst.status = "failed";
    saveInstance(inst);
    return { failed: true, message: `全局步数达到上限 (${inst.maxSteps})，工作流已终止` };
  }

  // 判断是否是最后一个节点
  const nextIdx = currentIdx + 1;
  if (nextIdx >= def.nodes.length) {
    inst.status = "completed";
    inst.currentNodeId = null;
    inst.completedAt = Date.now();
    saveInstance(inst);
    return { done: true, message: "工作流已完成" };
  }

  // 推进到下一节点
  const nextNode = def.nodes[nextIdx];
  inst.currentNodeId = nextNode.id;

  const exec: NodeExecution = {
    nodeId: nextNode.id,
    attempt: 1,
    status: "running",
    input: { ...inst.context },
    startedAt: Date.now(),
  };
  inst.nodeHistory.push(exec);
  saveInstance(inst);

  if (nextNode.isolated) {
    return {
      isolated: true,
      node: nextNode,
      prompt: buildNextNodePrompt(def, nextNode, inst),
      message: "产物已提交，下一节点将由独立 Agent 处理",
    };
  }

  return {
    prompt: buildNextNodePrompt(def, nextNode, inst),
    node: nextNode,
  };
}

/** 处理 workflow_reject 信号 */
export function handleReject(instanceId: string, payload: WorkflowRejectPayload): EngineResult {
  const inst = getInstance(instanceId);
  if (!inst || inst.status !== "running") return { failed: true, message: "工作流非运行状态" };

  const def = getDefinition(inst.workflowId);
  if (!def) return { failed: true, message: "工作流定义不存在" };

  const currentIdx = getNodeIndex(def, inst.currentNodeId!);
  if (currentIdx < 0) return { failed: true, message: "当前节点无效" };

  const currentNode = def.nodes[currentIdx];

  // 确定回退目标
  let targetIdx: number;
  if (payload.targetNodeId) {
    targetIdx = getNodeIndex(def, payload.targetNodeId);
    if (targetIdx < 0 || targetIdx >= currentIdx) {
      return { failed: true, message: `回退目标节点 "${payload.targetNodeId}" 无效（必须在当前节点之前）` };
    }
  } else {
    targetIdx = currentIdx - 1;
    if (targetIdx < 0) return { failed: true, message: "已是第一个节点，无法回退" };
  }

  const targetNode = def.nodes[targetIdx];

  // 标记当前节点为 rejected
  const lastExec = [...inst.nodeHistory].reverse().find(
    (h) => h.nodeId === currentNode.id && h.status === "running",
  );
  if (lastExec) {
    lastExec.status = "rejected";
    lastExec.rejectReason = payload.reason;
    lastExec.completedAt = Date.now();
  }

  // 检查重试次数
  const retryCount = getNodeRetryCount(inst, targetNode.id);
  if (retryCount >= targetNode.maxRetries) {
    inst.status = "failed";
    inst.updatedAt = Date.now();
    saveInstance(inst);
    return {
      failed: true,
      message: `节点「${targetNode.name}」已达最大重试次数 (${targetNode.maxRetries})，工作流终止`,
    };
  }

  inst.stepCount++;
  inst.updatedAt = Date.now();

  // 步数熔断
  if (inst.stepCount >= inst.maxSteps) {
    inst.status = "failed";
    saveInstance(inst);
    return { failed: true, message: `全局步数达到上限 (${inst.maxSteps})，工作流已终止` };
  }

  // 回退到目标节点
  inst.currentNodeId = targetNode.id;
  const previousOutput = inst.context[targetNode.id];

  const exec: NodeExecution = {
    nodeId: targetNode.id,
    attempt: retryCount + 2,
    status: "running",
    input: { ...inst.context },
    rejectReason: payload.reason,
    rejectFromNodeId: currentNode.id,
    startedAt: Date.now(),
  };
  inst.nodeHistory.push(exec);
  saveInstance(inst);

  const prompt = buildRetryPrompt(
    def,
    targetNode,
    inst,
    retryCount + 2,
    currentNode.name,
    payload.reason,
    previousOutput,
  );

  if (targetNode.isolated) {
    return {
      isolated: true,
      node: targetNode,
      prompt,
      message: `节点「${targetNode.name}」驳回重跑（独立 Agent）`,
    };
  }

  return { prompt, node: targetNode };
}

/** 崩溃恢复：将 running 状态的实例标记为 paused */
export function recoverStaleInstances(): WorkflowInstance[] {
  const recovered: WorkflowInstance[] = [];
  for (const inst of listInstances()) {
    if (inst.status === "running") {
      inst.status = "paused";
      inst.updatedAt = Date.now();
      saveInstance(inst);
      recovered.push(inst);
    }
  }
  return recovered;
}

/** 恢复暂停的工作流 */
export function resumeWorkflow(instanceId: string): EngineResult {
  const inst = getInstance(instanceId);
  if (!inst) return { failed: true, message: "实例不存在" };
  if (inst.status !== "paused") return { failed: true, message: "工作流非暂停状态" };

  const def = getDefinition(inst.workflowId);
  if (!def) return { failed: true, message: "工作流定义不存在" };

  if (!inst.currentNodeId) return { failed: true, message: "无当前节点" };

  const node = def.nodes.find((n) => n.id === inst.currentNodeId);
  if (!node) return { failed: true, message: "当前节点定义不存在" };

  inst.status = "running";
  inst.updatedAt = Date.now();
  saveInstance(inst);

  return {
    prompt: buildStartPrompt(def, node, inst),
    node,
    isolated: node.isolated ?? false,
  };
}
