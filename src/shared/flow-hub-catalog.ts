import type { FlowHubCatalog, FlowHubCatalogGroup, FlowHubCatalogNode } from "./flow-hub-types.js"

export function emptyCatalog(): FlowHubCatalog {
  return { version: 1, updatedAt: new Date().toISOString(), groups: [], nodes: [] }
}

export function parseCatalog(raw: unknown): FlowHubCatalog | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as FlowHubCatalog
  if (obj.version !== 1 || !Array.isArray(obj.groups) || !Array.isArray(obj.nodes)) return null
  return {
    version: 1,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
    groups: obj.groups.filter((g) => g?.hubId?.trim() && g?.name?.trim()),
    nodes: obj.nodes.filter((n) => n?.hubId?.trim() && n?.label?.trim()),
  }
}

export function mergeGroupIntoCatalog(catalog: FlowHubCatalog, entry: FlowHubCatalogGroup): FlowHubCatalog {
  const groups = [...catalog.groups]
  const i = groups.findIndex((g) => g.hubId === entry.hubId)
  if (i >= 0) groups[i] = entry
  else groups.push(entry)
  return { ...catalog, updatedAt: new Date().toISOString(), groups }
}

export function mergeNodeIntoCatalog(catalog: FlowHubCatalog, entry: FlowHubCatalogNode): FlowHubCatalog {
  const nodes = [...catalog.nodes]
  const i = nodes.findIndex((n) => n.hubId === entry.hubId)
  if (i >= 0) nodes[i] = entry
  else nodes.push(entry)
  return { ...catalog, updatedAt: new Date().toISOString(), nodes }
}

export function filterCatalog(catalog: FlowHubCatalog, query: string): FlowHubCatalog {
  const q = query.trim().toLowerCase()
  if (!q) return catalog
  const match = (s: string) => s.toLowerCase().includes(q)
  return {
    ...catalog,
    groups: catalog.groups.filter((g) =>
      match(g.name) || match(g.author) || g.nodeLabels.some(match) || g.nodeIds.some(match),
    ),
    nodes: catalog.nodes.filter((n) =>
      match(n.label) || match(n.localId) || match(n.author) || (n.sourceGroupName && match(n.sourceGroupName)),
    ),
  }
}

export function sortCatalog(catalog: FlowHubCatalog): FlowHubCatalog {
  const byTime = (a: string, b: string) => (b > a ? 1 : b < a ? -1 : 0)
  return {
    ...catalog,
    groups: [...catalog.groups].sort((a, b) => byTime(a.updatedAt, b.updatedAt)),
    nodes: [...catalog.nodes].sort((a, b) => byTime(a.updatedAt, b.updatedAt)),
  }
}
