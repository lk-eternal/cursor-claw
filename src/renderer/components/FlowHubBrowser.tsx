import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus, RefreshCw, X } from "lucide-react"
import type { FlowHubCatalog, FlowHubCatalogGroup, FlowHubCatalogNode, FlowHubSyncStatus } from "../../shared/flow-hub-types"

type BrowserKind = "group" | "node"

interface FlowHubBrowserProps {
  kind: BrowserKind
  targetGroupId?: string
  onClose: () => void
  onImported: () => void
  showAlert: (title: string, msg: string) => void | Promise<void>
  showConfirm: (title: string, msg: string, ok?: string, cancel?: string) => Promise<boolean>
}

const PAGE = 20

export function FlowHubBrowser({ kind, targetGroupId, onClose, onImported, showAlert, showConfirm }: FlowHubBrowserProps) {
  const [catalog, setCatalog] = useState<FlowHubCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [visible, setVisible] = useState(PAGE)
  const [statusMap, setStatusMap] = useState<Record<string, FlowHubSyncStatus>>({})
  const [busyId, setBusyId] = useState("")
  const [hoverPrompt, setHoverPrompt] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    const r = await window.electronAPI.flowHub.getCatalog(true)
    if (!r.ok) {
      setError(r.error ?? "加载失败")
      setCatalog(null)
    } else {
      setCatalog(r.catalog)
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    if (!catalog) return { groups: [], nodes: [] }
    const q = query.trim().toLowerCase()
    const match = (s: string) => !q || s.toLowerCase().includes(q)
    return {
      groups: catalog.groups.filter((g) => match(g.name) || match(g.author) || g.nodeLabels.some(match)),
      nodes: catalog.nodes.filter((n) => match(n.label) || match(n.localId) || match(n.author)),
    }
  }, [catalog, query])

  const groupSlice = useMemo(
    () => (kind === "group" ? filtered.groups.slice(0, visible) : []),
    [filtered.groups, kind, visible],
  )
  const nodeSlice = useMemo(
    () => (kind === "node" ? filtered.nodes.slice(0, visible) : []),
    [filtered.nodes, kind, visible],
  )
  const totalItems = kind === "group" ? filtered.groups.length : filtered.nodes.length

  useEffect(() => {
    if (!catalog) return
    void (async () => {
      const map: Record<string, FlowHubSyncStatus> = {}
      for (const g of catalog.groups) {
        map[g.hubId] = await window.electronAPI.flowHub.getSyncStatus("group", g.hubId, g.contentHash)
      }
      for (const n of catalog.nodes) {
        map[n.hubId] = await window.electronAPI.flowHub.getSyncStatus("node", n.hubId, n.contentHash)
      }
      setStatusMap(map)
    })()
  }, [catalog])

  const handleImport = async (hubId: string) => {
    setBusyId(hubId)
    const r = kind === "group"
      ? await window.electronAPI.flowHub.importGroup(hubId)
      : await window.electronAPI.flowHub.importNode(hubId, targetGroupId ?? "")
    setBusyId("")
    if (!r.ok) void showAlert("导入失败", r.error ?? "未知错误")
    else { onImported(); void load() }
  }

  const handleSync = async (hubId: string) => {
    const st = statusMap[hubId]
    if (st === "local_modified") {
      if (!(await showConfirm("同步确认", "本地已修改，用 Hub 覆盖本地内容？"))) return
    }
    setBusyId(hubId)
    const r = kind === "group"
      ? await window.electronAPI.flowHub.syncGroup(hubId, "overwrite")
      : await window.electronAPI.flowHub.syncNode(hubId, targetGroupId ?? "", "overwrite")
    setBusyId("")
    if (!r.ok) void showAlert("同步失败", r.error ?? "未知错误")
    else { onImported(); void load() }
  }

  const previewNode = async (hubId: string, nodeLocalId?: string) => {
    const r = await window.electronAPI.flowHub.preview(kind, hubId, nodeLocalId)
    setHoverPrompt(r.ok ? (r.prompt?.slice(0, 400) ?? "（无自定义提示词）") : "")
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-gray-700 bg-gray-950 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-100">
            {kind === "group" ? "从共享空间获取流程组" : "从共享空间获取节点"}
          </h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="border-b border-gray-800 px-4 py-2">
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setVisible(PAGE) }}
            placeholder="搜索名称 / 作者 / 节点…"
            className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3" onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40 && visible < totalItems) {
            setVisible((v) => v + PAGE)
          }
        }}>
          {loading && <p className="text-xs text-gray-500">加载中…</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          {!loading && !error && groupSlice.length === 0 && nodeSlice.length === 0 && <p className="text-xs text-gray-500">无匹配项</p>}
          {kind === "group" && groupSlice.map((g: FlowHubCatalogGroup) => {
            const st = statusMap[g.hubId] ?? "missing"
            return (
              <div key={g.hubId} className="rounded-lg border border-gray-800 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-gray-100">{g.name}</div>
                    <div className="text-[10px] text-gray-500">by {g.author || "未知"} · {g.updatedAt.slice(0, 10)}</div>
                  </div>
                  <ActionBtn st={st} busy={busyId === g.hubId} onAdd={() => void handleImport(g.hubId)} onSync={() => void handleSync(g.hubId)} />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {g.nodeLabels.map((label, i) => (
                    <span
                      key={`${g.hubId}-${g.nodeIds[i] ?? i}`}
                      className="cursor-default rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400"
                      onMouseEnter={() => void previewNode(g.hubId, g.nodeIds[i])}
                      onMouseLeave={() => setHoverPrompt("")}
                    >{label}</span>
                  ))}
                </div>
              </div>
            )
          })}
          {kind === "node" && nodeSlice.map((n: FlowHubCatalogNode) => {
            const st = statusMap[n.hubId] ?? "missing"
            return (
              <div
                key={n.hubId}
                className="flex items-center justify-between rounded-lg border border-gray-800 p-3"
                onMouseEnter={() => void previewNode(n.hubId)}
                onMouseLeave={() => setHoverPrompt("")}
              >
                <div>
                  <div className="text-sm text-gray-100">{n.label} <span className="font-mono text-xs text-gray-500">/p {n.localId}</span></div>
                  <div className="text-[10px] text-gray-500">by {n.author}{n.sourceGroupName ? ` · 来自 ${n.sourceGroupName}` : ""}</div>
                </div>
                <ActionBtn st={st} busy={busyId === n.hubId} onAdd={() => void handleImport(n.hubId)} onSync={() => void handleSync(n.hubId)} />
              </div>
            )
          })}
        </div>
        {hoverPrompt && (
          <div className="border-t border-gray-800 px-4 py-2 text-[10px] text-gray-400 whitespace-pre-wrap max-h-24 overflow-y-auto">{hoverPrompt}</div>
        )}
      </div>
    </div>
  )
}

function ActionBtn({ st, busy, onAdd, onSync }: {
  st: FlowHubSyncStatus
  busy: boolean
  onAdd: () => void
  onSync: () => void
}) {
  if (busy) return <span className="text-xs text-gray-500">…</span>
  if (st === "synced") return <span className="text-xs text-emerald-500">✓ 已添加</span>
  if (st === "outdated" || st === "local_modified") {
    return (
      <button type="button" onClick={onSync} className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300">
        <RefreshCw className="h-3 w-3" />同步
      </button>
    )
  }
  return (
    <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300">
      <Plus className="h-3 w-3" />添加
    </button>
  )
}
