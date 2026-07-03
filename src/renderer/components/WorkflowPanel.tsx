import { useState, useEffect, useCallback } from "react"
import {
  Plus, Pencil, Trash2, X, Play, ChevronDown, ChevronRight,
  Loader2, CheckCircle2, AlertTriangle, Pause, Clock, FolderOpen, RefreshCw, GripVertical,
} from "lucide-react"
import type { WorkflowDefinition, WorkflowNode, WorkflowInstance, WorkflowStatus } from "../../shared/workflow-types"
import SearchableSelect from "./SearchableSelect"

const inputCls = "w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"

function uid(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }

const STATUS_STYLE: Record<WorkflowStatus, { color: string; Icon: typeof CheckCircle2 }> = {
  pending: { color: "text-gray-400", Icon: Clock },
  running: { color: "text-blue-400", Icon: Loader2 },
  paused: { color: "text-yellow-400", Icon: Pause },
  completed: { color: "text-green-400", Icon: CheckCircle2 },
  failed: { color: "text-red-400", Icon: AlertTriangle },
}

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  pending: "等待中", running: "运行中", paused: "已暂停", completed: "已完成", failed: "已失败",
}

// ── Definition Editor ───────────────────────────────────────

function emptyNode(): WorkflowNode {
  return { id: uid(), name: "", prompt: "", maxRetries: 1 }
}

function emptyDef(): WorkflowDefinition {
  return { id: uid(), name: "", nodes: [emptyNode()], createdAt: Date.now(), updatedAt: Date.now(), config: {} }
}

interface DefEditorProps {
  initial: WorkflowDefinition
  onSave: (d: WorkflowDefinition) => void
  onCancel: () => void
}

function DefEditor({ initial, onSave, onCancel }: DefEditorProps) {
  const [def, setDef] = useState<WorkflowDefinition>(() => ({
    ...initial,
    config: initial.config ?? {},
    nodes: initial.nodes.length ? initial.nodes : [emptyNode()],
  }))
  const [activeNodeIdx, setActiveNodeIdx] = useState(0)
  const [defaultDir, setDefaultDir] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([])

  const modelLabel = useCallback((id: string) => modelOptions.find((o) => o.id === id)?.label || id, [modelOptions])

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setDefaultDir(cfg.workspaceDir || "未配置")
      setDefaultModel(cfg.model || "auto")
      const fetcher = cfg.agentMode === "sdk" ? window.electronAPI.listSdkModels : window.electronAPI.listModels
      fetcher().then((res) => {
        if (!res.ok) return
        // 工作流节点模型只存 id（不带 variant 参数），按 id 去重并直接以 id 展示
        const seen = new Set<string>()
        setModelOptions(res.models.filter((m) => !seen.has(m.id) && (seen.add(m.id), true)).map((m) => ({ id: m.id, label: m.id })))
      })
    })
  }, [])

  const pickDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setDef({ ...def, workingDirectory: dir })
  }

  const [cfgEntries, setCfgEntries] = useState(() =>
    Object.entries(initial.config ?? {}).map(([key, value]) => ({ key, value }))
  )
  const updateCfgEntry = (idx: number, field: "key" | "value", val: string) =>
    setCfgEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, [field]: val } : e)))
  const removeCfgEntry = (idx: number) =>
    setCfgEntries((prev) => prev.filter((_, i) => i !== idx))
  const addCfgEntry = () => setCfgEntries((prev) => [...prev, { key: "", value: "" }])
  const cfgToRecord = () => {
    const r: Record<string, string> = {}
    for (const { key, value } of cfgEntries) if (key.trim()) r[key.trim()] = value
    return r
  }

  const updateNode = (idx: number, patch: Partial<WorkflowNode>) => {
    const nodes = [...def.nodes]
    nodes[idx] = { ...nodes[idx], ...patch }
    setDef({ ...def, nodes })
  }

  const removeNode = (idx: number) => {
    if (def.nodes.length <= 1) return
    const nodes = def.nodes.filter((_, i) => i !== idx)
    setDef({ ...def, nodes })
    if (activeNodeIdx >= nodes.length) setActiveNodeIdx(nodes.length - 1)
    else if (activeNodeIdx === idx) setActiveNodeIdx(Math.max(0, idx - 1))
  }

  const addNode = () => {
    const n = emptyNode()
    setDef({ ...def, nodes: [...def.nodes, n] })
    setActiveNodeIdx(def.nodes.length)
  }

  const moveNode = (from: number, to: number) => {
    if (to < 0 || to >= def.nodes.length) return
    const nodes = [...def.nodes]
    const [moved] = nodes.splice(from, 1)
    nodes.splice(to, 0, moved)
    setDef({ ...def, nodes })
    setActiveNodeIdx(to)
  }

  const canSave = def.name.trim() && def.nodes.every((n) => n.name.trim() && n.prompt.trim())
  const activeNode = def.nodes[activeNodeIdx]

  const getInheritedModel = (nodeIdx: number): string => {
    for (let i = nodeIdx - 1; i >= 0; i--) {
      if (def.nodes[i].model) return modelLabel(def.nodes[i].model!)
    }
    return modelLabel(defaultModel)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex w-full max-w-4xl flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "90vh" }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
          <h3 className="text-sm font-semibold text-gray-200">{initial.createdAt === def.createdAt && !initial.name ? "新建工作流" : "编辑工作流"}</h3>
          <button onClick={onCancel} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>

        {/* Body: left sidebar + right editor */}
        <div className="flex flex-1 overflow-hidden">
          {/* ── Left: General Settings ── */}
          <div className="w-72 shrink-0 space-y-3 overflow-y-auto border-r border-gray-800 p-4">
            <div>
              <label className="mb-1 block text-xs text-gray-500">名称 *</label>
              <input type="text" value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} className={inputCls} placeholder="例如：代码审查流程" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">描述</label>
              <input type="text" value={def.description ?? ""} onChange={(e) => setDef({ ...def, description: e.target.value })} className={inputCls} placeholder="简要说明工作流用途" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">工作目录 <span className="text-gray-600">（默认：{defaultDir}）</span></label>
              <div className="flex gap-1.5">
                <input type="text" value={def.workingDirectory ?? ""} onChange={(e) => setDef({ ...def, workingDirectory: e.target.value })} className={inputCls + " flex-1"} placeholder={defaultDir} />
                <button type="button" onClick={pickDir} className="shrink-0 rounded-md border border-gray-700 bg-gray-800 px-2 text-gray-400 hover:border-blue-500 hover:text-blue-400"><FolderOpen size={14} /></button>
              </div>
            </div>

            {/* Config */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs text-gray-500">环境变量</label>
                <button onClick={addCfgEntry} className="text-xs text-blue-400 hover:text-blue-300"><Plus size={12} /></button>
              </div>
              {cfgEntries.length > 0 && (
                <div className="space-y-1">
                  {cfgEntries.map((entry, idx) => (
                    <div key={idx} className="flex items-center gap-1">
                      <input type="text" value={entry.key} onChange={(e) => updateCfgEntry(idx, "key", e.target.value)} className="w-20 shrink-0 rounded border border-gray-700 bg-gray-800 px-1.5 py-1 font-mono text-[11px] text-gray-200 outline-none focus:border-blue-500" placeholder="KEY" />
                      <span className="text-[10px] text-gray-600">=</span>
                      <input type="text" value={entry.value} onChange={(e) => updateCfgEntry(idx, "value", e.target.value)} className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-800 px-1.5 py-1 font-mono text-[11px] text-gray-200 outline-none focus:border-blue-500" placeholder="value" />
                      <button onClick={() => removeCfgEntry(idx)} className="shrink-0 text-gray-600 hover:text-red-400"><Trash2 size={11} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Node list */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs text-gray-500">节点列表</label>
                <button onClick={addNode} className="text-xs text-blue-400 hover:text-blue-300"><Plus size={12} /></button>
              </div>
              <div className="space-y-0.5">
                {def.nodes.map((node, idx) => (
                  <div
                    key={node.id}
                    onClick={() => setActiveNodeIdx(idx)}
                    className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition ${idx === activeNodeIdx ? "bg-blue-600/20 text-blue-300" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${idx === activeNodeIdx ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-400"}`}>{idx + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{node.name || "未命名节点"}</span>
                    {def.nodes.length > 1 && (
                      <button onClick={(e) => { e.stopPropagation(); removeNode(idx) }} className="invisible shrink-0 text-gray-600 hover:text-red-400 group-hover:visible"><Trash2 size={11} /></button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Right: Active Node Editor ── */}
          {activeNode && (
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600 text-xs font-bold text-white">{activeNodeIdx + 1}</span>
                <h4 className="text-sm font-medium text-gray-200">节点配置</h4>
                <span className="text-[11px] font-mono text-gray-600">#{activeNode.id}</span>
                <div className="ml-auto flex gap-1">
                  <button onClick={() => moveNode(activeNodeIdx, activeNodeIdx - 1)} disabled={activeNodeIdx === 0} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white disabled:opacity-30" title="上移"><ChevronDown size={14} className="rotate-180" /></button>
                  <button onClick={() => moveNode(activeNodeIdx, activeNodeIdx + 1)} disabled={activeNodeIdx === def.nodes.length - 1} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white disabled:opacity-30" title="下移"><ChevronDown size={14} /></button>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">节点名称 *</label>
                  <input type="text" value={activeNode.name} onChange={(e) => updateNode(activeNodeIdx, { name: e.target.value })} className={inputCls} placeholder="例如：代码审查" />
                </div>

                <div>
                  <label className="mb-1 block text-xs text-gray-500">Prompt *</label>
                  <textarea
                    value={activeNode.prompt}
                    onChange={(e) => updateNode(activeNodeIdx, { prompt: e.target.value })}
                    rows={10}
                    className={inputCls + " font-mono text-xs leading-relaxed"}
                    placeholder="该节点的 Agent 指令..."
                  />
                </div>

                <div className="flex items-end gap-4">
                  <div className="w-28 shrink-0">
                    <label className="mb-1 block text-xs text-gray-500">最大重试</label>
                    <input type="number" min={0} value={activeNode.maxRetries} onChange={(e) => updateNode(activeNodeIdx, { maxRetries: parseInt(e.target.value) || 0 })} className={inputCls} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs text-gray-500">模型</label>
                    {activeNodeIdx === 0 || activeNode.isolated ? (
                      <SearchableSelect
                        value={activeNode.model ?? ""}
                        onChange={(v) => updateNode(activeNodeIdx, { model: v || undefined })}
                        options={modelOptions}
                        placeholder={activeNodeIdx === 0 ? `默认: ${modelLabel(defaultModel)}` : `继承: ${getInheritedModel(activeNodeIdx)}`}
                        fallbackLabel={activeNode.model}
                      />
                    ) : (
                      <div className="flex h-[34px] items-center rounded-md border border-gray-700/50 bg-gray-800/50 px-3 text-xs text-gray-400">
                        继承：{getInheritedModel(activeNodeIdx)}
                      </div>
                    )}
                  </div>
                </div>

                {activeNodeIdx > 0 && (
                  <label className="flex items-center gap-2 text-xs text-gray-400 select-none">
                    <input type="checkbox" checked={activeNode.isolated ?? false} onChange={(e) => {
                      const isolated = e.target.checked
                      updateNode(activeNodeIdx, isolated ? { isolated } : { isolated: false, model: undefined })
                    }} className="rounded border-gray-600" />
                    隔离运行（独立 Agent 会话，可单独设置模型）
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-3">
          <button onClick={onCancel} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
          <button onClick={() => onSave({ ...def, config: cfgToRecord(), updatedAt: Date.now() })} disabled={!canSave} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
        </div>
      </div>
    </div>
  )
}

// ── Instance Detail ─────────────────────────────────────────

function InstanceDetail({ inst, defName, onClose, onDelete }: {
  inst: WorkflowInstance
  defName: string
  onClose: () => void
  onDelete: () => void
}) {
  const s = STATUS_STYLE[inst.status]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <s.Icon size={15} className={`${s.color} ${inst.status === "running" ? "animate-spin" : ""}`} />
            <h3 className="text-sm font-semibold text-gray-200">{defName || inst.workflowId}</h3>
            <span className={`text-xs ${s.color}`}>{STATUS_LABEL[inst.status]}</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div><span className="text-gray-600">实例ID</span><p className="font-mono text-gray-400">{inst.id}</p></div>
            <div><span className="text-gray-600">步骤</span><p className="text-gray-300">{inst.stepCount} / {inst.maxSteps}</p></div>
            <div><span className="text-gray-600">当前节点</span><p className="text-gray-300">{inst.currentNodeId ?? "-"}</p></div>
            <div><span className="text-gray-600">创建时间</span><p className="text-gray-400">{new Date(inst.createdAt).toLocaleString()}</p></div>
          </div>
          {inst.input && (
            <div><span className="text-gray-600">输入</span><pre className="mt-1 max-h-24 overflow-auto rounded-md bg-gray-800 p-2 text-gray-400">{inst.input}</pre></div>
          )}
          {inst.nodeHistory.length > 0 && (
            <div>
              <span className="text-gray-600">执行历史</span>
              <div className="mt-1 space-y-1">
                {inst.nodeHistory.map((h, i) => (
                  <div key={`${h.nodeId}-${h.attempt}-${i}`} className="flex items-center gap-2 rounded-md bg-gray-800/60 px-2 py-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${h.status === "completed" ? "bg-green-400" : h.status === "running" ? "bg-blue-400" : h.status === "rejected" ? "bg-yellow-400" : "bg-red-400"}`} />
                    <span className="flex-1 text-gray-300">{h.nodeId}</span>
                    <span className="text-gray-600">#{h.attempt}</span>
                    <span className="text-gray-500">{h.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
          <button onClick={onDelete} className="rounded-md px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-900/30">删除实例</button>
          <button onClick={onClose} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">关闭</button>
        </div>
      </div>
    </div>
  )
}

// ── Run Launch Dialog ───────────────────────────────────────

function RunLaunchDialog({ def, busy, onConfirm, onCancel }: {
  def: WorkflowDefinition
  busy?: boolean
  onConfirm: (input: string) => void
  onCancel: () => void
}) {
  const [input, setInput] = useState("")

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-gray-200">启动工作流</h3>
          <button onClick={onCancel} disabled={busy} className="text-gray-500 hover:text-white disabled:opacity-40"><X size={16} /></button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <p className="text-sm text-gray-300">{def.name}</p>
          <div>
            <label className="mb-1 block text-xs text-gray-500">初始输入（选填）</label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={4}
              disabled={busy}
              className={inputCls + " text-xs"}
              placeholder="将作为工作流实例的初始输入..."
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-800 px-5 py-3">
          <button onClick={onCancel} disabled={busy} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white disabled:opacity-40">取消</button>
          <button onClick={() => onConfirm(input.trim())} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            确定启动
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Panel ──────────────────────────────────────────────

type SubTab = "definitions" | "instances"

export default function WorkflowPanel() {
  const [subTab, setSubTab] = useState<SubTab>("definitions")
  const [defs, setDefs] = useState<WorkflowDefinition[]>([])
  const [instances, setInstances] = useState<WorkflowInstance[]>([])
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null)
  const [viewInst, setViewInst] = useState<WorkflowInstance | null>(null)
  const [runningDef, setRunningDef] = useState<WorkflowDefinition | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [runError, setRunError] = useState("")

  const refreshDefs = useCallback(async () => {
    setDefs(await window.electronAPI.getWorkflowDefinitions())
  }, [])

  const refreshInstances = useCallback(async () => {
    setInstances(await window.electronAPI.getWorkflowInstances())
  }, [])

  useEffect(() => {
    if (subTab === "definitions") void refreshDefs()
    else void refreshInstances()
  }, [subTab, refreshDefs, refreshInstances])

  useEffect(() => {
    return window.electronAPI.onWorkflowInstanceUpdate((updated) => {
      setInstances((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
      setViewInst((prev) => (prev && prev.id === updated.id ? updated : prev))
    })
  }, [])

  const saveDef = async (d: WorkflowDefinition) => {
    await window.electronAPI.saveWorkflowDefinition(d)
    setEditing(null)
    void refreshDefs()
  }

  const deleteDef = async (id: string) => {
    await window.electronAPI.deleteWorkflowDefinition(id)
    void refreshDefs()
  }

  const deleteInst = async (id: string) => {
    await window.electronAPI.deleteWorkflowInstance(id)
    setViewInst(null)
    void refreshInstances()
  }

  const handleRunConfirm = async (input: string) => {
    if (!runningDef || runBusy) return
    setRunBusy(true)
    setRunError("")
    try {
      const result = await window.electronAPI.runWorkflow(runningDef.id, input || undefined)
      if (!result.ok) {
        setRunError(result.error || "启动失败")
        return
      }
      setRunningDef(null)
      setSubTab("instances")
      void refreshInstances()
    } finally {
      setRunBusy(false)
    }
  }

  const defNameMap = Object.fromEntries(defs.map((d) => [d.id, d.name]))

  return (
    <>
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-gray-300">工作流</h3>
          <div className="flex rounded-md border border-gray-700 text-xs">
            <button onClick={() => setSubTab("definitions")} className={`px-3 py-1 rounded-l-md transition ${subTab === "definitions" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}>定义</button>
            <button onClick={() => setSubTab("instances")} className={`px-3 py-1 rounded-r-md transition ${subTab === "instances" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}>实例</button>
          </div>
          {subTab === "definitions" && (
            <button onClick={() => setEditing(emptyDef())} className="ml-auto flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500">
              <Plus size={13} />新建
            </button>
          )}
          {subTab === "instances" && (
            <button onClick={() => void refreshInstances()} className="ml-auto flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">
              刷新
            </button>
          )}
        </div>

        {subTab === "definitions" && (
          <div className="space-y-1.5">
            {runError && <p className="rounded-md border border-red-800/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">{runError}</p>}
            {defs.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无工作流定义</p>}
            {defs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-800/30 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-200">{d.name}</p>
                  <p className="truncate text-[11px] text-gray-600">{d.description || `${d.nodes.length} 个节点`}</p>
                </div>
                <button onClick={() => { setRunError(""); setRunningDef(d) }} title="启动工作流" className="shrink-0 text-gray-500 hover:text-blue-400"><Play size={14} /></button>
                <button onClick={() => setEditing({ ...d })} className="shrink-0 text-gray-500 hover:text-blue-400"><Pencil size={14} /></button>
                <button onClick={() => void deleteDef(d.id)} className="shrink-0 text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}

        {subTab === "instances" && (
          <div className="space-y-1.5">
            {instances.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无运行实例</p>}
            {instances.map((inst) => {
              const s = STATUS_STYLE[inst.status]
              return (
                <div key={inst.id} onClick={() => { void refreshDefs().then(() => setViewInst(inst)) }} className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-800 bg-gray-800/30 px-4 py-2.5 hover:border-gray-700">
                  <s.Icon size={15} className={`shrink-0 ${s.color} ${inst.status === "running" ? "animate-spin" : ""}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-200">{defNameMap[inst.workflowId] || inst.workflowId}</p>
                    <p className="truncate text-[11px] text-gray-600">{STATUS_LABEL[inst.status]} · 步骤 {inst.stepCount}/{inst.maxSteps}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-gray-600">{new Date(inst.updatedAt).toLocaleString()}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {editing && <DefEditor initial={editing} onSave={(d) => void saveDef(d)} onCancel={() => setEditing(null)} />}
      {runningDef && <RunLaunchDialog def={runningDef} busy={runBusy} onConfirm={(input) => void handleRunConfirm(input)} onCancel={() => !runBusy && setRunningDef(null)} />}
      {viewInst && <InstanceDetail inst={viewInst} defName={defNameMap[viewInst.workflowId] ?? ""} onClose={() => setViewInst(null)} onDelete={() => void deleteInst(viewInst.id)} />}
    </>
  )
}
