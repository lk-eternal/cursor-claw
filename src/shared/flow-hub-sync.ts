import type { FlowHubHubTrack, FlowHubSyncStatus } from "./flow-hub-types.js"

export function resolveSyncStatus(
  local: FlowHubHubTrack | undefined,
  remoteHash: string,
  remoteRevision?: number,
): FlowHubSyncStatus {
  if (!local) return "missing"
  const linked = !!local.hubId?.trim() || local.hubContentHash === remoteHash
  if (!linked) return "missing"
  if ((local.localRevision ?? 0) > 0 && local.hubContentHash !== remoteHash) return "local_modified"
  if (local.hubContentHash === remoteHash) return "synced"
  if (remoteRevision != null && (local.hubRevision ?? 0) < remoteRevision) return "outdated"
  if (local.hubContentHash !== remoteHash) return "outdated"
  return "synced"
}
