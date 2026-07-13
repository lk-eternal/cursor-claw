export type ProjectStatus = "active" | "paused" | "done"
/** 节点 id：内置 plan/build/review/ship，或用户自定义 slug */
export type ProjectActionType = string
export type ProjectActionStatus =
  | "running"
  | "awaiting_ack"
  | "accepted"
  | "rejected"
  | "failed"

/** 项目流程节点定义（推进按钮/命令/提示词的唯一来源；无内置/自定义之分，均可增删改） */
export interface ProjectNodeDef {
  id: string
  label: string
  /** 节点工作要求；留空且 id 命中默认模板时用代码里的模板 */
  prompt?: string
}

/** 流程组：项目创建时选定一组，推进按钮/命令只展示该组节点 */
export interface ProjectNodeGroupDef {
  id: string
  name: string
  nodes: ProjectNodeDef[]
}

/** 默认流程组种子：仅在无任何持久化数据时初始化用 */
export const DEFAULT_NODE_GROUPS: ProjectNodeGroupDef[] = [
  {
    id: "develop",
    name: "开发",
    nodes: [
      { id: "plan", label: "规划" },
      { id: "build", label: "实现" },
      { id: "review", label: "审查" },
      { id: "deploy", label: "部署" },
      { id: "submit-test", label: "提测" },
    ],
  },
  {
    id: "test",
    name: "测试",
    nodes: [
      { id: "test-review", label: "测试评审" },
      { id: "test-cases", label: "用例编写" },
      { id: "test-deploy", label: "部署" },
      { id: "test-exec", label: "测试" },
      { id: "file-bug", label: "提缺陷" },
      { id: "retest", label: "复测" },
      { id: "release-doc", label: "上线文档" },
    ],
  },
]

export const DEFAULT_NODE_GROUP_ID = DEFAULT_NODE_GROUPS[0].id

export interface RepoProfile {
  path: string
  /** 生产基线：只作切 feature 起点，禁止默认 ship 目标 */
  baseBranch: string
  testBranch?: string
  developBranch?: string
}

export interface ProjectRepo {
  repoPath: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
  worktreePath: string
}

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
  /** multi-repo worktrees */
  repos?: ProjectRepo[]
  /** 流程组 id；旧项目缺省视为默认组 */
  groupId?: string
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
  repoProfiles: RepoProfile[]
  worktreeRoot: string
}

/** /p 保留子命令：自定义节点 id 不得与之冲突 */
export const PROJECT_RESERVED_SUBCOMMANDS = [
  "help", "menu", "ls", "list", "use", "leave", "status", "new", "del", "delete", "rm", "setup", "sync", "ship",
]

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

export const REPO_PAIR_SEP = "||"

/** path||base||test||develop（后两段可空） */
export function encodeRepoPair(
  repoPath: string,
  baseBranch: string,
  testBranch?: string,
  developBranch?: string,
): string {
  return [
    repoPath.replace(/\\/g, "/"),
    baseBranch || "main",
    testBranch || "",
    developBranch || "",
  ].join(REPO_PAIR_SEP)
}

export function decodeRepoPair(value: string): {
  path: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
} {
  const parts = (value || "").trim().split(REPO_PAIR_SEP)
  const pathPart = (parts[0] || "").replace(/\//g, "\\")
  if (parts.length < 2) return { path: pathPart, baseBranch: "main" }
  const baseBranch = (parts[1] || "").trim() || "main"
  const testBranch = (parts[2] || "").trim() || undefined
  const developBranch = (parts[3] || "").trim() || undefined
  return { path: pathPart, baseBranch, testBranch, developBranch }
}

export function repoShortName(repoPath: string): string {
  const norm = repoPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = norm.split("/").pop() || "repo"
  return base.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, "-").slice(0, 40) || "repo"
}
