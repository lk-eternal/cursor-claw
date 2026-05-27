import { useState, useEffect, useCallback } from "react"
import {
  Plus, Pencil, Trash2, X, Play, ChevronDown, ChevronRight,
  Loader2, CheckCircle2, AlertTriangle, Pause, Clock,
} from "lucide-react"
import type { WorkflowDefinition, WorkflowNode, WorkflowInstance, WorkflowStatus } from "../../shared/workflow-types"

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
  return { id: uid(), name: "", nodes: [emptyNode()], createdAt: Date.now(), updatedAt: Date.now() }
}

interface DefEditorProps {
  initial: WorkflowDefinition
  onSave: (d: WorkflowDefinition) => void
  onCancel: () => void
}

function DefEditor({ initial, onSave, onCancel }: DefEditorProps) {
  const [def, setDef] = useState<WorkflowDefinition>(() => ({
    ...initial,
    nodes: initial.nodes.length ? initial.nodes : [emptyNode()],
  }))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(def.nodes.map((n) => n.id)))

  const updateNode = (idx: number, patch: Partial<WorkflowNode>) => {
    const nodes = [...def.nodes]
    nodes[idx] = { ...nodes[idx], ...patch }
    setDef({ ...def, nodes })
  }

  const removeNode = (idx: number) => {
    if (def.nodes.length <= 1) return
    setDef({ ...def, nodes: def.nodes.filter((_, i) => i !== idx) })
  }

  const addNode = () => {
    const n = emptyNode()
    setDef({ ...def, nodes: [...def.nodes, n] })
    setExpanded((s) => new Set(s).add(n.id))
  }

  const toggleExpand = (id: string) => {
    setExpanded((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  const canSave = def.name.trim() && def.nodes.every((n) => n.name.trim() && n.prompt.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex w-full max-w-2xl flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "85vh" }}>
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h3 className="text-sm font-semibold text-gray-200">{initial.createdAt === def.createdAt && !initial.name ? "新建工作流" : "编辑工作流"}</h3>
          <button onClick={onCancel} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div>
            <label className="mb-1 block text-xs text-gray-500">名称</label>
            <input type="text" value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} className={inputCls} placeholder="例如：代码审查流程" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">描述（可选）</label>
            <input type="text" value={def.description ?? ""} onChange={(e) => setDef({ ...def, description: e.target.value })} className={inputCls} placeholder="简要说明工作流用途" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">工作目录（可选）</label>
            <input type="text" value={def.workingDirectory ?? ""} onChange={(e) => setDef({ ...def, workingDirectory: e.target.value })} className={inputCls} placeholder="留空则使用默认" />
          </div>

          {/* Nodes */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-400">节点列表</label>
              <button onClick={addNode} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-blue-400 hover:bg-gray-800 hover:text-blue-300">
                <Plus size={13} />添加节点
              </button>
            </div>
            <div className="space-y-2">
              {def.nodes.map((node, idx) => (
                <div key={node.id} className="rounded-lg border border-gray-800 bg-gray-800/40">
                  <div className="flex cursor-pointer items-center gap-2 px-3 py-2" onClick={() => toggleExpand(node.id)}>
                    {expanded.has(node.id) ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                    <span className="flex-1 text-xs text-gray-300">{node.name || `节点 ${idx + 1}`}</span>
                    {def.nodes.length > 1 && (
                      <button onClick={(e) => { e.stopPropagation(); removeNode(idx) }} className="text-gray-600 hover:text-red-400"><Trash2 size={13} /></button>
                    )}
                  </div>
                  {expanded.has(node.id) && (
                    <div className="space-y-2 border-t border-gray-800 px-3 py-3">
                      <div><label className="mb-1 block text-[11px] text-gray-600">节点名称</label><input type="text" value={node.name} onChange={(e) => updateNode(idx, { name: e.target.value })} className={inputCls} placeholder="例如：代码审查" /></div>
                      <div><label className="mb-1 block text-[11px] text-gray-600">Prompt</label><textarea value={node.prompt} onChange={(e) => updateNode(idx, { prompt: e.target.value })} rows={3} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder="该节点的 Agent 指令..." /></div>
                      <div className="flex gap-3">
                        <div className="flex-1"><label className="mb-1 block text-[11px] text-gray-600">最大重试</label><input type="number" min={0} value={node.maxRetries} onChange={(e) => updateNode(idx, { maxRetries: parseInt(e.target.value) || 0 })} className={inputCls} /></div>
                        <div className="flex-1"><label className="mb-1 block text-[11px] text-gray-600">Model（可选）</label><input type="text" value={node.model ?? ""} onChange={(e) => updateNode(idx, { model: e.target.value || undefined })} className={inputCls} placeholder="留空默认" /></div>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-gray-400">
                        <input type="checkbox" checked={node.isolated ?? false} onChange={(e) => updateNode(idx, { isolated: e.target.checked })} className="rounded border-gray-600" />
                        隔离运行（独立 Agent 会话）
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
          <button onClick={onCancel} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
          <button onClick={() => onSave({ ...def, updatedAt: Date.now() })} disabled={!canSave} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
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

// ── Main Panel ──────────────────────────────────────────────

type SubTab = "definitions" | "instances"

export default function WorkflowPanel() {
  const [subTab, setSubTab] = useState<SubTab>("definitions")
  const [defs, setDefs] = useState<WorkflowDefinition[]>([])
  const [instances, setInstances] = useState<WorkflowInstance[]>([])
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null)
  const [viewInst, setViewInst] = useState<WorkflowInstance | null>(null)

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
            {defs.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无工作流定义</p>}
            {defs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-800/30 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-200">{d.name}</p>
                  <p className="truncate text-[11px] text-gray-600">{d.description || `${d.nodes.length} 个节点`}</p>
                </div>
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
      {viewInst && <InstanceDetail inst={viewInst} defName={defNameMap[viewInst.workflowId] ?? ""} onClose={() => setViewInst(null)} onDelete={() => void deleteInst(viewInst.id)} />}
    </>
  )
}
