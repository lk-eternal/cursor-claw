// ── 工作流数据模型 ─────────────────────────────────────────

export interface WorkflowNode {
  id: string
  name: string
  prompt: string
  model?: string
  maxRetries: number
  isolated?: boolean
}

export interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  workingDirectory?: string
  config?: Record<string, string>
  nodes: WorkflowNode[]
  createdAt: number
  updatedAt: number
}

export interface NodeExecution {
  nodeId: string
  attempt: number
  status: "running" | "completed" | "rejected" | "failed"
  input: Record<string, unknown>
  output?: unknown
  rejectReason?: string
  rejectFromNodeId?: string
  startedAt: number
  completedAt?: number
}

export type WorkflowStatus = "pending" | "running" | "paused" | "completed" | "failed"

export interface WorkflowInstance {
  id: string
  workflowId: string
  status: WorkflowStatus
  currentNodeId: string | null
  context: Record<string, unknown>
  nodeHistory: NodeExecution[]
  sessionKey?: string
  notifyChatId?: string
  workingDirectory: string
  input?: string
  maxSteps: number
  stepCount: number
  createdAt: number
  updatedAt: number
  completedAt?: number
}

// ── 引擎信号 ───────────────────────────────────────────────

export interface WorkflowNextPayload {
  output: string
}

export interface WorkflowRejectPayload {
  reason: string
  targetNodeId?: string
}

/** 模板/YAML/JSON 中 prompt 可为 string 或 string[]（数组加载时 join） */
export type WorkflowPromptInput = string | string[]

export function normalizePrompt(prompt: WorkflowPromptInput | undefined): string {
  if (prompt == null) {
    return ""
  }
  if (Array.isArray(prompt)) {
    return prompt.join("\n")
  }
  return prompt
}

export function normalizeWorkflowDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return {
    ...def,
    nodes: def.nodes.map((n) => ({
      ...n,
      prompt: normalizePrompt(n.prompt as WorkflowPromptInput),
      maxRetries: n.maxRetries ?? 2,
    })),
  }
}
