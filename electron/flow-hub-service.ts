import type { AppConfig } from "./config-store.js"
import { getConfig } from "./config-store.js"
import {
  emptyCatalog,
  mergeGroupIntoCatalog,
  mergeNodeIntoCatalog,
  parseCatalog,
  sortCatalog,
} from "../src/shared/flow-hub-catalog.js"
import {
  buildGroupEnvelope,
  buildNodeEnvelope,
  envelopeToGroupDef,
  ensureHubId,
  groupDefToBody,
  nodeDefToPayload,
  parseGroupEnvelope,
  parseNodeEnvelope,
} from "../src/shared/flow-hub-envelope.js"
import { GitLabFlowHubClient, parseHubRepoUrl } from "../src/shared/flow-hub-gitlab.js"
import { computeNodeContentHash } from "../src/shared/flow-hub-hash.js"
import { resolveSyncStatus } from "../src/shared/flow-hub-sync.js"
import type { FlowHubCatalog, FlowHubSyncStatus } from "../src/shared/flow-hub-types.js"
import {
  getNodeGroups,
  resolveUniqueNodeGroupId,
  saveNodeGroups,
} from "../src/shared/project-store.js"
import type { ProjectNodeDef, ProjectNodeGroupDef } from "../src/shared/project-types.js"

export interface FlowHubContext {
  hubUrl: string
  author: string
  gitlabHost: string
  gitlabToken: string
  client: GitLabFlowHubClient
  projectId: number
}

let catalogCache: { at: number; catalog: FlowHubCatalog } | null = null
const CATALOG_TTL_MS = 60_000

export function clearCatalogCache(): void {
  catalogCache = null
}

async function commitHubFiles(
  ctx: FlowHubContext,
  message: string,
  files: { path: string; content: string }[],
): Promise<void> {
  const withExists = await Promise.all(files.map(async (f) => ({
    ...f,
    exists: await ctx.client.fileExists(ctx.projectId, f.path),
  })))
  await ctx.client.commitFiles(ctx.projectId, message, withExists)
}

export function loadFlowHubContext(cfg?: AppConfig): FlowHubContext | { error: string } {
  const config = cfg ?? getConfig()
  const hubUrl = config.flowHubUrl?.trim() ?? ""
  const author = config.flowHubAuthor?.trim() ?? ""
  const token = config.gitlabToken?.trim() ?? ""
  const parsed = parseHubRepoUrl(hubUrl)
  if (!parsed) return { error: "Hub 地址无效" }
  if (!token) return { error: "请先配置 GitLab Token" }
  const cfgHost = (config.gitlabHost?.trim() || parsed.host).replace(/\/+$/, "")
  if (cfgHost !== parsed.host.replace(/\/+$/, "")) {
    return { error: "Hub 地址与 GitLab Host 不一致" }
  }
  return {
    hubUrl,
    author,
    gitlabHost: parsed.host,
    gitlabToken: token,
    client: new GitLabFlowHubClient(parsed.host, token),
    projectId: 0,
  }
}

async function resolveCtx(cfg?: AppConfig): Promise<FlowHubContext | { error: string }> {
  const base = loadFlowHubContext(cfg)
  if ("error" in base) return base
  try {
    const parsed = parseHubRepoUrl(base.hubUrl)!
    const projectId = await base.client.resolveProjectId(parsed.projectPath)
    return { ...base, projectId }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchCatalog(force = false, cfg?: AppConfig): Promise<{ ok: true; catalog: FlowHubCatalog } | { ok: false; error: string }> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return { ok: true, catalog: catalogCache.catalog }
  }
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  try {
    const raw = await ctx.client.readRawFile(ctx.projectId, "catalog.json")
    const catalog = sortCatalog(raw ? (parseCatalog(JSON.parse(raw)) ?? emptyCatalog()) : emptyCatalog())
    catalogCache = { at: Date.now(), catalog }
    return { ok: true, catalog }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function getSyncStatusForCatalogEntry(
  kind: "group" | "node",
  hubId: string,
  contentHash: string,
  hubRevision?: number,
): FlowHubSyncStatus {
  if (kind === "group") {
    const g = getNodeGroups().find((x) => x.hubId === hubId)
    return resolveSyncStatus(g, contentHash, hubRevision)
  }
  for (const g of getNodeGroups()) {
    const n = g.nodes.find((x) => x.hubId === hubId)
    if (n) return resolveSyncStatus(n, contentHash, hubRevision)
  }
  return "missing"
}

async function persistCatalog(ctx: FlowHubContext, catalog: FlowHubCatalog, batch?: { path: string; content: string }[]): Promise<void> {
  const catalogFile = {
    path: "catalog.json",
    content: JSON.stringify(catalog, null, 2),
  }
  if (batch) {
    await commitHubFiles(ctx, `flow-hub: upload by ${ctx.author}`, [...batch, catalogFile])
  } else {
    await commitHubFiles(ctx, `flow-hub: update catalog by ${ctx.author}`, [catalogFile])
  }
  catalogCache = { at: Date.now(), catalog }
}

function resolveNodeId(existing: ProjectNodeDef[], id: string): string {
  if (!existing.some((n) => n.id === id)) return id
  for (let i = 2; i < 1000; i++) {
    const cand = `${id}-${i}`
    if (!existing.some((n) => n.id === cand)) return cand
  }
  return `${id}-x`
}

export async function importGroupFromHub(hubId: string, cfg?: AppConfig): Promise<{ ok: true; group: ProjectNodeGroupDef } | { ok: false; error: string }> {
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  try {
    const raw = await ctx.client.readRawFile(ctx.projectId, `groups/${hubId}.json`)
    if (!raw) return { ok: false, error: "Hub 上找不到该流程组" }
    const env = parseGroupEnvelope(JSON.parse(raw))
    if (!env) return { ok: false, error: "无效的流程组文件" }
    const existing = getNodeGroups().find((g) => g.hubId === hubId)
    if (existing) return { ok: false, error: "已添加，请使用同步" }
    let def = envelopeToGroupDef(env)
    const groups = getNodeGroups()
    const newId = resolveUniqueNodeGroupId(def.id, def.name, groups.map((g) => g.id))
    def = { ...def, id: newId }
    saveNodeGroups([...groups, def])
    return { ok: true, group: def }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function importNodeFromHub(
  hubId: string,
  targetGroupId: string,
  cfg?: AppConfig,
): Promise<{ ok: true; node: ProjectNodeDef } | { ok: false; error: string }> {
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  try {
    const raw = await ctx.client.readRawFile(ctx.projectId, `nodes/${hubId}.json`)
    if (!raw) return { ok: false, error: "Hub 上找不到该节点" }
    const env = parseNodeEnvelope(JSON.parse(raw))
    if (!env) return { ok: false, error: "无效的节点文件" }
    const groups = getNodeGroups()
    const group = groups.find((g) => g.id === targetGroupId)
    if (!group) return { ok: false, error: "目标流程组不存在" }
    if (group.nodes.some((n) => n.hubId === hubId)) return { ok: false, error: "已添加，请使用同步" }
    const node: ProjectNodeDef = {
      id: resolveNodeId(group.nodes, env.node.id),
      label: env.node.label,
      ...(env.node.prompt ? { prompt: env.node.prompt } : {}),
      hubId: env.hubId,
      hubRevision: env.hubRevision,
      hubContentHash: env.contentHash,
      localRevision: 0,
    }
    saveNodeGroups(groups.map((g) => g.id === targetGroupId ? { ...g, nodes: [...g.nodes, node] } : g))
    return { ok: true, node }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function uploadGroup(groupId: string, cfg?: AppConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = loadFlowHubContext(cfg)
  if ("error" in base) return { ok: false, error: base.error }
  if (!base.author) return { ok: false, error: "请先填写 Hub 作者昵称" }
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  const groups = getNodeGroups()
  const group = groups.find((g) => g.id === groupId)
  if (!group) return { ok: false, error: "流程组不存在" }
  try {
    const withHub = {
      ...group,
      hubId: ensureHubId(group).hubId,
      nodes: group.nodes.map((n) => ensureHubId(n)),
    }
    const hubRevision = (withHub.hubRevision ?? 0) + 1
    const env = buildGroupEnvelope({
      group: groupDefToBody(withHub),
      hubId: withHub.hubId!,
      hubRevision,
      author: ctx.author,
    })
    const path = `groups/${withHub.hubId}.json`
    const entityFile = { path, content: JSON.stringify(env, null, 2) }
    let catalog = (await fetchCatalog(true, cfg)).ok ? catalogCache!.catalog : emptyCatalog()
    catalog = mergeGroupIntoCatalog(catalog, {
      hubId: withHub.hubId!,
      name: group.name,
      nodeLabels: group.nodes.map((n) => n.label),
      nodeIds: group.nodes.map((n) => n.id),
      author: ctx.author,
      updatedAt: env.updatedAt,
      contentHash: env.contentHash,
    })
    await persistCatalog(ctx, catalog, [entityFile])
    saveNodeGroups(groups.map((g) => g.id === groupId ? {
      ...withHub,
      hubRevision,
      hubContentHash: env.contentHash,
      localRevision: 0,
    } : g))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function uploadNode(
  groupId: string,
  nodeId: string,
  cfg?: AppConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = loadFlowHubContext(cfg)
  if ("error" in base) return { ok: false, error: base.error }
  if (!base.author) return { ok: false, error: "请先填写 Hub 作者昵称" }
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  const groups = getNodeGroups()
  const group = groups.find((g) => g.id === groupId)
  const node = group?.nodes.find((n) => n.id === nodeId)
  if (!group || !node) return { ok: false, error: "节点不存在" }
  try {
    const withHub = ensureHubId(node)
    const hubRevision = (withHub.hubRevision ?? 0) + 1
    const payload = nodeDefToPayload(withHub)
    const env = buildNodeEnvelope({
      node: payload,
      hubId: withHub.hubId,
      hubRevision,
      author: ctx.author,
    })
    const path = `nodes/${withHub.hubId}.json`
    const entityFile = { path, content: JSON.stringify(env, null, 2) }
    let catalog = (await fetchCatalog(true, cfg)).ok ? catalogCache!.catalog : emptyCatalog()
    catalog = mergeNodeIntoCatalog(catalog, {
      hubId: withHub.hubId,
      label: node.label,
      localId: node.id,
      author: ctx.author,
      updatedAt: env.updatedAt,
      contentHash: env.contentHash,
      sourceGroupName: group.name,
    })
    await persistCatalog(ctx, catalog, [entityFile])
    saveNodeGroups(groups.map((g) => g.id === groupId ? {
      ...g,
      nodes: g.nodes.map((n) => n.id === nodeId ? {
        ...withHub,
        hubRevision,
        hubContentHash: env.contentHash,
        localRevision: 0,
      } : n),
    } : g))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function previewHubItem(
  kind: "group" | "node",
  hubId: string,
  nodeLocalId?: string,
  cfg?: AppConfig,
): Promise<{ ok: true; prompt?: string; name: string } | { ok: false; error: string }> {
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  try {
    const path = kind === "group" ? `groups/${hubId}.json` : `nodes/${hubId}.json`
    const raw = await ctx.client.readRawFile(ctx.projectId, path)
    if (!raw) return { ok: false, error: "不存在" }
    if (kind === "node") {
      const env = parseNodeEnvelope(JSON.parse(raw))
      if (!env) return { ok: false, error: "无效" }
      return { ok: true, name: env.node.label, prompt: env.node.prompt }
    }
    const env = parseGroupEnvelope(JSON.parse(raw))
    if (!env) return { ok: false, error: "无效" }
    if (nodeLocalId) {
      const node = env.group.nodes.find((n) => n.id === nodeLocalId)
      return { ok: true, name: node?.label ?? nodeLocalId, prompt: node?.prompt }
    }
    return { ok: true, name: env.group.name }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function syncGroupFromHub(
  hubId: string,
  mode: "overwrite" | "keep",
  cfg?: AppConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (mode === "keep") return { ok: true }
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  try {
    const raw = await ctx.client.readRawFile(ctx.projectId, `groups/${hubId}.json`)
    if (!raw) return { ok: false, error: "Hub 上找不到该流程组" }
    const env = parseGroupEnvelope(JSON.parse(raw))
    if (!env) return { ok: false, error: "无效文件" }
    const groups = getNodeGroups()
    const i = groups.findIndex((g) => g.hubId === hubId)
    if (i < 0) return { ok: false, error: "本地未添加该组" }
    const def = envelopeToGroupDef(env)
    def.id = groups[i].id
    saveNodeGroups(groups.map((g, idx) => idx === i ? def : g))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function syncNodeFromHub(
  hubId: string,
  targetGroupId: string,
  mode: "overwrite" | "keep",
  cfg?: AppConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (mode === "keep") return { ok: true }
  const ctx = await resolveCtx(cfg)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  try {
    const raw = await ctx.client.readRawFile(ctx.projectId, `nodes/${hubId}.json`)
    if (!raw) return { ok: false, error: "Hub 上找不到该节点" }
    const env = parseNodeEnvelope(JSON.parse(raw))
    if (!env) return { ok: false, error: "无效文件" }
    const groups = getNodeGroups()
    const group = groups.find((g) => g.id === targetGroupId)
    if (!group) return { ok: false, error: "流程组不存在" }
    const ni = group.nodes.findIndex((n) => n.hubId === hubId)
    if (ni < 0) return { ok: false, error: "本地未添加该节点" }
    const node: ProjectNodeDef = {
      id: group.nodes[ni].id,
      label: env.node.label,
      ...(env.node.prompt ? { prompt: env.node.prompt } : {}),
      hubId: env.hubId,
      hubRevision: env.hubRevision,
      hubContentHash: computeNodeContentHash(env.node),
      localRevision: 0,
    }
    saveNodeGroups(groups.map((g) => g.id === targetGroupId ? {
      ...g,
      nodes: g.nodes.map((n, idx) => idx === ni ? node : n),
    } : g))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
