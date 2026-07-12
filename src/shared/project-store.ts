import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { DEFAULT_PROJECT_NODES, type Project, type ProjectAction, type ProjectActionStatus, type ProjectActionType, type ProjectNodeDef } from "./project-types.js"

let baseDir = ""

export function initProjectStore(userDataDir: string): void {
  baseDir = path.join(userDataDir, "projects")
  ensureDir(baseDir)
}

export function getProjectStoreDir(): string {
  return baseDir
}

// ── 流程节点表（electron 设置页写，daemon MCP 读，共用一份文件） ──

function nodesPath(): string {
  return path.join(baseDir, "project-nodes.json")
}

export function getProjectNodes(): ProjectNodeDef[] {
  const saved = baseDir ? readJsonSafe<ProjectNodeDef[] | null>(nodesPath(), null) : null
  const list = (saved ?? []).filter((n) => n?.id?.trim() && n?.label?.trim())
  if (!list.length) return DEFAULT_PROJECT_NODES.map((n) => ({ ...n }))
  // 内置节点始终存在（用户可改 label/prompt，不可删）
  for (const b of DEFAULT_PROJECT_NODES) {
    if (!list.some((n) => n.id === b.id)) list.push({ ...b })
  }
  return list
}

export function saveProjectNodes(nodes: ProjectNodeDef[]): void {
  if (!baseDir) throw new Error("project store not initialized")
  writeJson(nodesPath(), nodes)
}

export function getProjectNode(id: string): ProjectNodeDef | undefined {
  return getProjectNodes().find((n) => n.id === id)
}

export function projectNodeLabel(id: string): string {
  return getProjectNode(id)?.label || id
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function projectPath(id: string): string {
  return path.join(baseDir, `${id}.json`)
}

function currentPath(): string {
  return path.join(baseDir, "current.json")
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
    }
  } catch { /* ignore */ }
  return fallback
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")
}

export function listProjects(): Project[] {
  if (!baseDir || !fs.existsSync(baseDir)) return []
  return fs.readdirSync(baseDir)
    .filter((f) => f.endsWith(".json") && f !== "current.json")
    .map((f) => readJsonSafe<Project | null>(path.join(baseDir, f), null))
    .filter((p): p is Project => !!p && typeof p.id === "string")
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getProject(id: string): Project | undefined {
  if (!baseDir || !id) return undefined
  return readJsonSafe<Project | undefined>(projectPath(id), undefined)
}

export function saveProject(project: Project): void {
  if (!baseDir) throw new Error("project store not initialized")
  project.updatedAt = Date.now()
  writeJson(projectPath(project.id), project)
}

export function deleteProject(id: string): boolean {
  const fp = projectPath(id)
  if (!fs.existsSync(fp)) return false
  fs.unlinkSync(fp)
  const cur = getCurrentProjectId()
  if (cur === id) setCurrentProjectId(null)
  return true
}

export function getCurrentProjectId(): string | null {
  const data = readJsonSafe<{ id?: string }>(currentPath(), {})
  return data.id ?? null
}

export function setCurrentProjectId(id: string | null): void {
  if (!baseDir) throw new Error("project store not initialized")
  if (!id) {
    if (fs.existsSync(currentPath())) fs.unlinkSync(currentPath())
    return
  }
  writeJson(currentPath(), { id })
}

export function getCurrentProject(): Project | undefined {
  const id = getCurrentProjectId()
  return id ? getProject(id) : undefined
}

export function createProject(input: Omit<Project, "id" | "actions" | "status" | "createdAt" | "updatedAt"> & {
  id?: string
  status?: Project["status"]
  actions?: ProjectAction[]
}): Project {
  const now = Date.now()
  const project: Project = {
    id: input.id ?? randomUUID().replace(/-/g, "").slice(0, 12),
    name: input.name,
    goal: input.goal,
    storyUrl: input.storyUrl,
    productDocUrl: input.productDocUrl,
    techDocUrl: input.techDocUrl,
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    featureBranch: input.featureBranch,
    worktreePath: input.worktreePath,
    repos: input.repos,
    status: input.status ?? "active",
    actions: input.actions ?? [],
    sessionKey: input.sessionKey,
    notifyChatId: input.notifyChatId,
    createdAt: now,
    updatedAt: now,
  }
  saveProject(project)
  setCurrentProjectId(project.id)
  return project
}

export function findBusyAction(project: Project): ProjectAction | undefined {
  // 只有正在跑的 agent 才算忙；产出后（含旧数据的 awaiting_ack）即可推进下一节点
  return project.actions.find((a) => a.status === "running")
}

const STALE_RUNNING_MS = 12 * 60 * 60 * 1000

export function startAction(projectId: string, type: ProjectActionType): { ok: true; project: Project; action: ProjectAction } | { ok: false; error: string } {
  const project = getProject(projectId)
  if (!project) return { ok: false, error: "项目不存在" }
  if (project.status === "done") return { ok: false, error: "项目已结束" }
  const busy = findBusyAction(project)
  if (busy) {
    // agent 崩溃等原因遗留的陈旧 running：超时自动失效放行，避免项目被永久卡死
    if (Date.now() - (busy.startedAt ?? 0) > STALE_RUNNING_MS) {
      busy.status = "failed"
      busy.error = "长时间未完成，已自动失效"
      busy.completedAt = Date.now()
      saveProject(project)
    } else {
      return { ok: false, error: `已有进行中的 action: ${busy.type} (${busy.status})` }
    }
  }
  const action: ProjectAction = {
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    type,
    status: "running",
    startedAt: Date.now(),
  }
  project.actions.push(action)
  saveProject(project)
  return { ok: true, project, action }
}

export function updateAction(
  projectId: string,
  actionId: string,
  patch: Partial<Pick<ProjectAction, "status" | "artifactPath" | "feishuDocUrl" | "summary" | "mrUrl" | "error" | "completedAt">>,
): { ok: true; project: Project; action: ProjectAction } | { ok: false; error: string } {
  const project = getProject(projectId)
  if (!project) return { ok: false, error: "项目不存在" }
  const action = project.actions.find((a) => a.id === actionId)
  if (!action) return { ok: false, error: "action 不存在" }
  Object.assign(action, patch)
  if (patch.status && ["accepted", "rejected", "failed"].includes(patch.status) && !action.completedAt) {
    action.completedAt = patch.completedAt ?? Date.now()
  }
  saveProject(project)
  return { ok: true, project, action }
}

export function lastAcceptedAction(project: Project): ProjectAction | undefined {
  return [...project.actions].reverse().find((a) => a.status === "accepted")
}

export function resolveProjectRef(token: string | undefined, projects?: Project[]): Project | undefined {
  const list = projects ?? listProjects()
  if (!token) return getCurrentProject()
  const idx = Number.parseInt(token, 10)
  if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]
  return list.find((p) => p.id === token || p.name === token)
}

/** /p new 交互向导草稿（按 chatKey） */
export type ProjectNewStep =
  | "setup_worktree"
  | "setup_add_path"
  | "setup_add_base"
  | "setup_add_test"
  | "setup_add_dev"
  | "setup_gitlab_token"
  | "setup_gitlab_host"

export interface ProjectNewDraft {
  chatKey: string
  step: ProjectNewStep
  name?: string
  repoPath?: string
  baseBranch?: string
  testBranch?: string
  developBranch?: string
  featureBranch?: string
  goal?: string
  storyUrl?: string
  /** 仅 /p setup，完成后不进入创建 */
  setupOnly?: boolean
  /** setup 子流程结束后回到 setup 总览 */
  returnToSetup?: boolean
  updatedAt: number
}

function pendingNewPath(): string {
  return path.join(baseDir, "pending-new.json")
}

export function getProjectNewDraft(chatKey: string): ProjectNewDraft | undefined {
  if (!baseDir || !chatKey) return undefined
  const all = readJsonSafe<Record<string, ProjectNewDraft>>(pendingNewPath(), {})
  return all[chatKey]
}

export function saveProjectNewDraft(draft: ProjectNewDraft): void {
  if (!baseDir) throw new Error("project store not initialized")
  const all = readJsonSafe<Record<string, ProjectNewDraft>>(pendingNewPath(), {})
  draft.updatedAt = Date.now()
  all[draft.chatKey] = draft
  writeJson(pendingNewPath(), all)
}

export function clearProjectNewDraft(chatKey: string): void {
  if (!baseDir || !chatKey) return
  const all = readJsonSafe<Record<string, ProjectNewDraft>>(pendingNewPath(), {})
  if (!all[chatKey]) return
  delete all[chatKey]
  writeJson(pendingNewPath(), all)
}

export function hasProjectNewDraft(chatKey: string): boolean {
  return !!getProjectNewDraft(chatKey)
}

export type { ProjectActionStatus }
