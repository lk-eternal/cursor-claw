import type { ProjectWorkspaceType } from "./project-types.js"

export interface FlowHubSettings {
  flowHubUrl?: string
  flowHubAuthor?: string
}

export interface FlowHubCatalog {
  version: 1
  updatedAt: string
  groups: FlowHubCatalogGroup[]
  nodes: FlowHubCatalogNode[]
}

export interface FlowHubCatalogGroup {
  hubId: string
  name: string
  nodeLabels: string[]
  nodeIds: string[]
  author: string
  updatedAt: string
  contentHash: string
}

export interface FlowHubCatalogNode {
  hubId: string
  label: string
  localId: string
  author: string
  updatedAt: string
  contentHash: string
  sourceGroupName?: string
}

export interface FlowHubNodePayload {
  hubId: string
  id: string
  label: string
  prompt?: string
}

export interface FlowHubGroupBody {
  id: string
  name: string
  workspace?: ProjectWorkspaceType
  nodes: FlowHubNodePayload[]
}

export interface FlowHubGroupEnvelope {
  kind: "cursor-claw-node-group"
  version: 2
  hubId: string
  hubRevision: number
  author: string
  updatedAt: string
  contentHash: string
  group: FlowHubGroupBody
}

export interface FlowHubNodeEnvelope {
  kind: "cursor-claw-flow-node"
  version: 1
  hubId: string
  hubRevision: number
  author: string
  updatedAt: string
  contentHash: string
  node: FlowHubNodePayload
}

export type FlowHubSyncStatus = "missing" | "synced" | "outdated" | "local_modified"

export interface FlowHubHubTrack {
  hubId?: string
  hubRevision?: number
  hubContentHash?: string
  localRevision?: number
}
