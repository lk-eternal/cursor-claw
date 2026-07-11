export type ProjectStatus = "active" | "paused" | "done"
export type ProjectActionType = "plan" | "build" | "review" | "ship"
export type ProjectActionStatus =
  | "running"
  | "awaiting_ack"
  | "accepted"
  | "rejected"
  | "failed"

export interface ProjectAction {
  id: string
  type: ProjectActionType
  status: ProjectActionStatus
  artifactPath?: string
  feishuDocUrl?: string
  summary?: string
  mrUrl?: string
  error?: string
  startedAt: number
  completedAt?: number
}

export interface Project {
  id: string
  name: string
  goal: string
  storyUrl?: string
  productDocUrl?: string
  techDocUrl?: string
  repoPath: string
  baseBranch: string
  featureBranch: string
  worktreePath: string
  status: ProjectStatus
  actions: ProjectAction[]
  sessionKey?: string
  notifyChatId?: string
  createdAt: number
  updatedAt: number
}

export interface ProjectSettingsSlice {
  gitlabToken: string
  gitlabHost: string
  repoRoots: string[]
  worktreeRoot: string
}

export const PROJECT_ACTION_TYPES: ProjectActionType[] = ["plan", "build", "review", "ship"]

export function isProjectActionType(s: string): s is ProjectActionType {
  return (PROJECT_ACTION_TYPES as string[]).includes(s)
}

export function projectSessionKey(chatKey: string, projectId: string): string {
  return `${chatKey}::project_${projectId}`
}

export function projectIdFromSessionKey(sessionKey: string): string | undefined {
  const idx = sessionKey.indexOf("::")
  if (idx < 0) return undefined
  const suffix = sessionKey.slice(idx + 2)
  if (!suffix.startsWith("project_")) return undefined
  return suffix.slice("project_".length) || undefined
}

export function artifactRelPath(actionId: string, type: ProjectActionType): string {
  return pathJoin(".cursor-claw", "artifacts", `${actionId}-${type}.md`)
}

function pathJoin(...parts: string[]): string {
  return parts.join("/")
}
