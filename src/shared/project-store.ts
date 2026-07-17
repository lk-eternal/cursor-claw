import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { DEFAULT_NODE_GROUPS, DEFAULT_NODE_GROUP_ID, type Project, type ProjectAction, type ProjectActionStatus, type ProjectActionType, type ProjectNodeDef, type ProjectNodeGroupDef } from "./project-types.js"

let baseDir = ""

export function initProjectStore(userDataDir: string): void {
  baseDir = path.join(userDataDir, "projects")
  ensureDir(baseDir)
}

export function getProjectStoreDir(): string {
  return baseDir
}

// ── 流程组表（electron 设置页写，daemon MCP 读，共用一份文件） ──

function groupsPath(): string {
  return path.join(baseDir, "project-node-groups.json")
}

/** 旧版扁平节点表：仅迁移用 */
function legacyNodesPath(): string {
  return path.join(baseDir, "project-nodes.json")
}

const NODE_GROUP_ID_RE = /^[a-z][a-z0-9-]*$/

function sanitizeGroups(groups: ProjectNodeGroupDef[] | null | undefined): ProjectNodeGroupDef[] {
  return (groups ?? [])
    .filter((g) => g?.id?.trim() && g?.name?.trim())
    .map((g) => ({
      id: g.id.trim(),
      name: g.name.trim(),
      ...(g.workspace === "plain" || g.workspace === "worktree" ? { workspace: g.workspace } : {}),
      nodes: (g.nodes ?? []).filter((n) => n?.id?.trim() && n?.label?.trim())
        .map((n) => ({ id: n.id.trim(), label: n.label.trim(), ...(n.prompt?.trim() ? { prompt: n.prompt } : {}) })),
    }))
}

function slugFromGroupName(name: string): string {
  let slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug || !/^[a-z]/.test(slug)) {
    slug = slug ? `g-${slug.replace(/^[^a-z0-9]*/i, "")}` : ""
  }
  slug = slug.replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "")
  return NODE_GROUP_ID_RE.test(slug) ? slug.slice(0, 40) : ""
}

/** 解析单组导出 JSON；兼容 envelope 与裸 group 对象 */
export function parseNodeGroupExport(raw: unknown): ProjectNodeGroupDef | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  let candidate: unknown
  if (obj.kind === "cursor-claw-node-group" && obj.group && typeof obj.group === "object") {
    candidate = obj.group
  } else if (typeof obj.id === "string" && typeof obj.name === "string" && Array.isArray(obj.nodes)) {
    candidate = obj
  } else {
    return null
  }
  const c = candidate as ProjectNodeGroupDef
  if (!c.name?.trim() || !Array.isArray(c.nodes)) return null
  const [group] = sanitizeGroups([{
    id: (c.id ?? "").trim() || "import",
    name: c.name,
    workspace: c.workspace === "plain" || c.workspace === "worktree" ? c.workspace : "worktree",
    nodes: c.nodes,
  }])
  if (!group) return null
  return {
    ...group,
    workspace: group.workspace === "plain" ? "plain" : "worktree",
  }
}

/** 生成不与已有组冲突的新 id（优先文件 id，冲突加 -2/-3…） */
export function resolveUniqueNodeGroupId(
  preferredId: string | undefined,
  name: string,
  existingIds: Iterable<string>,
): string {
  const used = new Set(existingIds)
  const pick = (base: string): string | null => {
    if (!NODE_GROUP_ID_RE.test(base)) return null
    if (!used.has(base)) return base
    for (let i = 2; i < 1000; i++) {
      const cand = `${base}-${i}`
      if (NODE_GROUP_ID_RE.test(cand) && !used.has(cand)) return cand
    }
    return null
  }
  const pref = preferredId?.trim()
  if (pref) {
    const hit = pick(pref)
    if (hit) return hit
  }
  const fromName = slugFromGroupName(name)
  if (fromName) {
    const hit = pick(fromName)
    if (hit) return hit
  }
  for (let i = 0; i < 100; i++) {
    const cand = `import-${randomBytes(4).toString("hex")}`
    if (!used.has(cand)) return cand
  }
  return `import-${randomUUID().replace(/-/g, "").slice(0, 8)}`
}

/** 旧扁平表 → 默认组结构：plan/build/review 的自定义覆盖到开发组，ship 丢弃，其余节点并入开发组 */
function migrateLegacyNodes(legacy: ProjectNodeDef[]): ProjectNodeGroupDef[] {
  const groups = DEFAULT_NODE_GROUPS.map((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n })) }))
  const develop = groups.find((g) => g.id === DEFAULT_NODE_GROUP_ID) ?? groups[0]
  for (const n of legacy) {
    if (n.id === "ship") continue
    const exist = develop.nodes.find((d) => d.id === n.id)
    if (exist) {
      exist.label = n.label || exist.label
      if (n.prompt?.trim()) exist.prompt = n.prompt
    } else {
      develop.nodes.push({ id: n.id, label: n.label, ...(n.prompt?.trim() ? { prompt: n.prompt } : {}) })
    }
  }
  return groups
}

interface NodeGroupsFile {
  version: 2
  groups: ProjectNodeGroupDef[]
  /** 已播种过的默认节点/组 id（`group:<id>` 表示组）：新版本新增默认节点只补种一次，用户删除后不复活 */
  seeded: string[]
}

function cloneDefaultGroups(): ProjectNodeGroupDef[] {
  return DEFAULT_NODE_GROUPS.map((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n })) }))
}

/** 兼容 v1 裸数组格式：视文件中已有的组/节点为「已播种」 */
function normalizeGroupsFile(raw: unknown): NodeGroupsFile | null {
  if (Array.isArray(raw)) {
    const groups = sanitizeGroups(raw as ProjectNodeGroupDef[])
    if (!groups.length) return null
    const seeded = groups.flatMap((g) => [`group:${g.id}`, ...g.nodes.map((n) => n.id)])
    return { version: 2, groups, seeded }
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as NodeGroupsFile).groups)) {
    const f = raw as NodeGroupsFile
    const groups = sanitizeGroups(f.groups)
    if (!groups.length) return null
    return { version: 2, groups, seeded: Array.isArray(f.seeded) ? f.seeded : [] }
  }
  return null
}

/** 把默认表中「从未播种过」的组/节点补进存量配置（默认节点随版本演进，老用户升级可见） */
function seedMissingDefaults(file: NodeGroupsFile): boolean {
  let changed = false
  const seeded = new Set(file.seeded)
  const mark = (id: string) => { if (!seeded.has(id)) { seeded.add(id); changed = true } }
  for (const dg of DEFAULT_NODE_GROUPS) {
    let group = file.groups.find((g) => g.id === dg.id)
    if (!group && !seeded.has(`group:${dg.id}`)) {
      group = { ...dg, nodes: dg.nodes.map((n) => ({ ...n })) }
      file.groups.push(group)
      changed = true
    }
    mark(`group:${dg.id}`)
    if (!group) { for (const n of dg.nodes) mark(n.id); continue }
    // 旧版本无 workspace 字段：按默认组补上（用户在新版设置页保存后字段固化，不再覆盖）
    if (group.workspace === undefined && dg.workspace) {
      group.workspace = dg.workspace
      changed = true
    }
    for (const n of dg.nodes) {
      if (!group.nodes.some((x) => x.id === n.id) && !seeded.has(n.id)) {
        group.nodes.push({ ...n })
        changed = true
      }
      mark(n.id)
    }
  }
  if (changed) file.seeded = [...seeded]
  return changed
}

export function getNodeGroups(): ProjectNodeGroupDef[] {
  if (!baseDir) return cloneDefaultGroups()
  const file = normalizeGroupsFile(readJsonSafe<unknown>(groupsPath(), null))
  if (file) {
    if (seedMissingDefaults(file)) writeJson(groupsPath(), file)
    return file.groups
  }
  const legacy = readJsonSafe<ProjectNodeDef[] | null>(legacyNodesPath(), null)
  const migrated = legacy?.length
    ? migrateLegacyNodes(legacy.filter((n) => n?.id?.trim() && n?.label?.trim()))
    : cloneDefaultGroups()
  const fresh: NodeGroupsFile = {
    version: 2,
    groups: migrated,
    seeded: migrated.flatMap((g) => [`group:${g.id}`, ...g.nodes.map((n) => n.id)]),
  }
  seedMissingDefaults(fresh)
  writeJson(groupsPath(), fresh)
  return fresh.groups
}

export function saveNodeGroups(groups: ProjectNodeGroupDef[]): void {
  if (!baseDir) throw new Error("project store not initialized")
  const prev = normalizeGroupsFile(readJsonSafe<unknown>(groupsPath(), null))
  // 显式保存 = 用户对完整默认表做过取舍：默认组/节点全部视为已播种，删掉的不再复活
  const defaultsSeeded = DEFAULT_NODE_GROUPS.flatMap((g) => [`group:${g.id}`, ...g.nodes.map((n) => n.id)])
  writeJson(groupsPath(), {
    version: 2,
    groups: sanitizeGroups(groups),
    seeded: [...new Set([...(prev?.seeded ?? []), ...defaultsSeeded])],
  } satisfies NodeGroupsFile)
}

/** 按组 id 解析流程组；缺省/失配回落默认组（再回落第一组） */
export function resolveNodeGroup(groupId?: string): ProjectNodeGroupDef {
  const groups = getNodeGroups()
  return groups.find((g) => g.id === groupId)
    ?? groups.find((g) => g.id === DEFAULT_NODE_GROUP_ID)
    ?? groups[0]
}

export function getProjectNodes(groupId?: string): ProjectNodeDef[] {
  return resolveNodeGroup(groupId).nodes
}

/** 组内优先，其次全组检索（历史 action 的节点可能已换组/删除） */
export function getProjectNode(id: string, groupId?: string): ProjectNodeDef | undefined {
  const inGroup = resolveNodeGroup(groupId).nodes.find((n) => n.id === id)
  if (inGroup) return inGroup
  for (const g of getNodeGroups()) {
    const hit = g.nodes.find((n) => n.id === id)
    if (hit) return hit
  }
  return undefined
}

export function projectNodeLabel(id: string, groupId?: string): string {
  return getProjectNode(id, groupId)?.label || id
}

/** 项目绑定的流程组 id（去重、过滤无效 id，至少回落默认组） */
export function projectGroupIds(p: Pick<Project, "groupIds" | "groupId">): string[] {
  const raw = p.groupIds?.length
    ? [...new Set(p.groupIds.map((id) => id?.trim()).filter(Boolean) as string[])]
    : (p.groupId?.trim() ? [p.groupId.trim()] : [])
  const valid = raw.filter((id) => getNodeGroups().some((g) => g.id === id))
  return valid.length ? valid : [DEFAULT_NODE_GROUP_ID]
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
  // 软删除：移入 trash，避免误删后无法恢复元数据
  const trashDir = path.join(baseDir, "trash")
  ensureDir(trashDir)
  const trashFp = path.join(trashDir, `${id}.${Date.now()}.json`)
  try {
    fs.renameSync(fp, trashFp)
  } catch {
    fs.copyFileSync(fp, trashFp)
    fs.unlinkSync(fp)
  }
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
  const groupIds = projectGroupIds(input)
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
    groupIds,
    groupId: groupIds[0],
    workspaceType: input.workspaceType,
    status: input.status ?? "active",
    actions: input.actions ?? [],
    sessionKey: input.sessionKey,
    notifyChatId: input.notifyChatId,
    groupChatId: input.groupChatId,
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
  // 节点任务入会话队列顺序执行，允许多个 running 并存（不再因已有 running 拦截）
  // 顺带清理崩溃遗留的超期 running，避免列表长期脏数据
  for (const a of project.actions) {
    if (a.status === "running" && Date.now() - (a.startedAt ?? 0) > STALE_RUNNING_MS) {
      a.status = "failed"
      a.error = "长时间未完成，已自动失效"
      a.completedAt = Date.now()
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
  // 仅纯数字才当序号；hex id（如 3d2abd629656）绝不能 parseInt——否则会变成 3 误删第 3 项
  if (/^\d+$/.test(token)) {
    const idx = Number.parseInt(token, 10)
    if (idx >= 1 && idx <= list.length) return list[idx - 1]
  }
  const byId = list.find((p) => p.id === token)
  if (byId) return byId
  const byName = list.filter((p) => p.name === token)
  return byName.length === 1 ? byName[0] : undefined
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
