import { useState, useEffect, useCallback, useRef } from "react"
import {
  Plus, Pencil, Trash2, X, Loader2, CheckCircle2, ShieldAlert, Eye, EyeOff,
  LogIn, MessageSquare, Bird, FolderOpen, RefreshCw, ChevronDown, ChevronRight, ExternalLink,
  GripVertical,
} from "lucide-react"
import SearchableSelect from "./SearchableSelect"
import useInlineModal from "./useInlineModal"
import { modelSlug } from "../model-utils"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

function newLocalChannelId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("")
  return `ch_${hex}`
}

function emptyChannel(type: "feishu" | "wechat", defaultName: string): ChannelConfig {
  return {
    id: newLocalChannelId(),
    name: defaultName,
    enabled: true,
    type,
    agentResourceId: "cli",
    model: "auto",
    modelParams: "",
    othersModel: "",
    othersModelParams: "",
    mainUserEnabled: false,
    mainUserChatId: "",
    allowOthers: false,
    digitalIdentity: "",
    workspaceDir: "",
    keepSession: true,
    persistentPoll: true,
    showThinking: true,
  }
}

interface ModelOption { id: string; label: string; params: string }

export default function ChannelPanel() {
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [resources, setResources] = useState<AgentResource[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, ChannelStatusInfo>>({})
  const [editing, setEditing] = useState<ChannelConfig | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  /** 仅按住把手时才允许拖拽，避免整行拖拽干扰行内按钮与文本选择 */
  const [dragArmed, setDragArmed] = useState(false)
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()

  const reload = useCallback(async () => {
    const cfg = await window.electronAPI.getConfig()
    // 旧迁移通道可能缺少通道级字段，展示时兜底
    setChannels((cfg.channels ?? []).map((c) => ({
      ...c,
      allowOthers: c.allowOthers ?? cfg.allowOthers ?? false,
      digitalIdentity: c.digitalIdentity ?? cfg.digitalIdentity ?? "",
    })))
    const list = cfg.agentResources ?? []
    setResources(list.some((r) => r.id === "cli") ? list : [{ id: "cli", type: "cli", name: "Cursor CLI" }, ...list])
  }, [])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    const sync = (s: DaemonStatus) => {
      if (!s.channels) return
      const m: Record<string, ChannelStatusInfo> = {}
      for (const c of s.channels) m[c.id] = c
      setStatusMap(m)
    }
    window.electronAPI.getDaemonStatus().then(sync)
    const unsub = window.electronAPI.onDaemonStatus(sync)
    return () => unsub()
  }, [])

  const persistChannels = async (next: ChannelConfig[]) => {
    setChannels(next)
    await window.electronAPI.saveConfig({ channels: next })
  }

  const handleToggle = async (id: string) => {
    await persistChannels(channels.map((c) => c.id === id ? { ...c, enabled: !c.enabled } : c))
  }

  const handleDelete = async (c: ChannelConfig) => {
    if (!await showConfirm("删除确认", `确定删除通道「${c.name}」吗？该通道的消息将不再接收。`)) return
    await persistChannels(channels.filter((x) => x.id !== c.id))
  }

  const openAdd = (type: "feishu" | "wechat") => {
    setShowAddMenu(false)
    const count = channels.filter((c) => c.type === type).length
    const base = type === "feishu" ? "飞书" : "微信"
    setEditing(emptyChannel(type, count > 0 ? `${base} ${count + 1}` : base))
    setIsNew(true)
  }

  const openEdit = (c: ChannelConfig) => { setEditing({ ...c }); setIsNew(false) }

  const handleSave = async (next: ChannelConfig) => {
    const exists = channels.some((c) => c.id === next.id)
    await persistChannels(exists ? channels.map((c) => c.id === next.id ? next : c) : [...channels, next])
  }

  // 数组顺序即首页通道树顺序；仅重排不触发 Daemon 重启
  const sortable = channels.length > 1
  const resetDrag = () => { setDragId(null); setOverId(null); setDragArmed(false) }

  const handleDrop = async (targetId: string) => {
    const from = channels.findIndex((c) => c.id === dragId)
    const to = channels.findIndex((c) => c.id === targetId)
    resetDrag()
    if (from < 0 || to < 0 || from === to) return
    const next = [...channels]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await persistChannels(next)
  }

  return (
    <>
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-300">消息通道</h3>
          <button onClick={() => void reload()} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
          <div className="flex-1" />
          <div className="relative">
            <button onClick={() => setShowAddMenu(!showAddMenu)} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />添加通道</button>
            {showAddMenu && (
              <div className="absolute right-0 z-20 mt-1 w-36 rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl">
                <button onClick={() => openAdd("feishu")} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-300 hover:bg-gray-800"><Bird size={13} className="text-blue-400" />飞书通道</button>
                <button onClick={() => openAdd("wechat")} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-300 hover:bg-gray-800"><MessageSquare size={13} className="text-green-400" />微信通道</button>
              </div>
            )}
          </div>
        </div>
        <p className="text-xs text-gray-600">
          每个通道绑定一个 Agent 资源与独立模型；通道配置保存后 Daemon 将自动重启生效。
          {channels.length > 1 && "拖动左侧把手可调整顺序，首页通道树同步生效（仅排序不重启）。"}
        </p>

        <div className="space-y-2">
          {channels.map((c) => {
            const st = statusMap[c.id]
            const resource = resources.find((r) => r.id === c.agentResourceId)
            const credMissing = c.type === "feishu" ? !(c.larkAppId && c.larkAppSecret) : !c.wechatToken
            return (
              <div
                key={c.id}
                draggable={sortable && dragArmed}
                onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = "move" }}
                onDragOver={(e) => {
                  if (!dragId || dragId === c.id) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "move"
                  if (overId !== c.id) setOverId(c.id)
                }}
                onDragLeave={() => setOverId((v) => v === c.id ? null : v)}
                onDrop={(e) => { e.preventDefault(); void handleDrop(c.id) }}
                onDragEnd={resetDrag}
                className={`rounded-lg border px-4 py-3 transition ${
                  dragId === c.id
                    ? "border-gray-700 opacity-40"
                    : overId === c.id
                      ? "border-blue-500 bg-blue-950/20"
                      : "border-gray-700"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    {sortable && (
                      <GripVertical
                        size={14}
                        onMouseDown={() => setDragArmed(true)}
                        onMouseUp={() => setDragArmed(false)}
                        className="shrink-0 cursor-grab text-gray-600 transition hover:text-gray-300 active:cursor-grabbing"
                      />
                    )}
                    {c.type === "feishu" ? <Bird size={16} className="shrink-0 text-blue-400" /> : <MessageSquare size={16} className="shrink-0 text-green-400" />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        {!c.enabled
                          ? <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">已停用</span>
                          : credMissing
                            ? <span className="shrink-0 rounded bg-yellow-900/40 px-1.5 py-0.5 text-[10px] text-yellow-400">凭据未配置</span>
                            : st
                              ? <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${st.connected ? "bg-green-900/40 text-green-400" : "bg-yellow-900/40 text-yellow-400"}`}>{st.connected ? "已连接" : st.status}</span>
                              : <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">未运行</span>}
                        {c.mainUserEnabled && c.mainUserChatId && <span className="shrink-0 rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">主用户已绑定</span>}
                        {c.allowOthers && <span className="shrink-0 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] text-emerald-400">其他人可用</span>}
                      </div>
                      <p className="flex items-center gap-1 truncate text-xs text-gray-500">
                        {c.type === "feishu" && c.larkAppId && (
                          <>
                            <a
                              href={`https://open.feishu.cn/app/${c.larkAppId}`}
                              target="_blank"
                              rel="noreferrer"
                              draggable={false}
                              title={`打开飞书开发者后台 (${c.larkAppId})`}
                              className="inline-flex shrink-0 items-center gap-0.5 text-blue-400/80 hover:text-blue-300 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {st?.botName || c.larkBotName || c.larkAppId.slice(0, 12) + "…"}
                              <ExternalLink size={10} />
                            </a>
                            <span className="text-gray-700">·</span>
                          </>
                        )}
                        <span className="truncate">{resource?.name ?? "Cursor CLI"} · 主模型 {modelSlug(c.model, c.modelParams) || "auto"}{c.othersModel ? ` · 其他人 ${modelSlug(c.othersModel, c.othersModelParams)}` : ""}{c.workspaceDir ? ` · 📁${c.workspaceDir.split(/[\\/]/).pop()}` : ""}</span>
                      </p>
                    </div>
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    <button onClick={() => openEdit(c)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                    <button onClick={() => void handleDelete(c)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                    <button
                      onClick={() => void handleToggle(c.id)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${c.enabled ? "bg-green-500" : "bg-gray-600"}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${c.enabled ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
          {channels.length === 0 && (
            <div className="grid grid-cols-2 gap-3 py-2">
              <button
                onClick={() => openAdd("feishu")}
                className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-600 px-4 py-8 transition hover:border-blue-500 hover:bg-blue-950/20"
              >
                <Bird size={28} className="text-blue-400" />
                <span className="text-sm font-medium text-gray-200">飞书通道</span>
                <span className="text-center text-xs text-gray-500">通过飞书自建应用收发消息<br />支持私聊和群聊</span>
                <span className="mt-1 rounded-md bg-blue-600/20 px-3 py-1 text-xs font-medium text-blue-300">点击创建</span>
              </button>
              <button
                onClick={() => openAdd("wechat")}
                className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-600 px-4 py-8 transition hover:border-green-500 hover:bg-green-950/20"
              >
                <MessageSquare size={28} className="text-green-400" />
                <span className="text-sm font-medium text-gray-200">微信通道</span>
                <span className="text-center text-xs text-gray-500">扫码绑定 ClawBot 接入微信<br />支持私聊</span>
                <span className="mt-1 rounded-md bg-green-600/20 px-3 py-1 text-xs font-medium text-green-300">点击创建</span>
              </button>
            </div>
          )}
        </div>
      </section>

      {editing && (
        <ChannelEditModal
          channel={editing}
          isNew={isNew}
          resources={resources}
          onClose={() => setEditing(null)}
          onSave={async (c) => { await handleSave(c); setEditing(null) }}
          onSaveDraft={async (c) => { await handleSave(c); setEditing({ ...c }) }}
          showAlert={showAlert}
          showConfirm={showConfirm}
        />
      )}
      {ModalPortal}
    </>
  )
}

// ── 通道编辑弹窗 ──────────────────────────────────────────

interface EditProps {
  channel: ChannelConfig
  isNew: boolean
  resources: AgentResource[]
  onClose: () => void
  onSave: (c: ChannelConfig) => Promise<void>
  /** 保存但不关闭（绑定主用户前需先落库） */
  onSaveDraft: (c: ChannelConfig) => Promise<void>
  showAlert: (title: string, message: string) => Promise<void>
  showConfirm: (title: string, message: string) => Promise<boolean>
}

/** 通道名仍是默认占位（"飞书"/"飞书 2"…）时允许用解析出的应用名自动覆盖 */
function isDefaultChannelName(name: string): boolean {
  return !name.trim() || /^飞书( \d+)?$/.test(name.trim()) || /^微信( \d+)?$/.test(name.trim())
}

function ChannelEditModal({ channel, isNew, resources, onClose, onSave, onSaveDraft, showAlert, showConfirm }: EditProps) {
  const [draft, setDraft] = useState<ChannelConfig>(channel)
  const [showSecret, setShowSecret] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [appInfoState, setAppInfoState] = useState<{ checking: boolean; error?: string }>({ checking: false })
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [binding, setBinding] = useState(false)
  const [testing, setTesting] = useState(false)
  // 飞书一键创建
  const [feishuQrUrl, setFeishuQrUrl] = useState("")
  const [feishuQrStatus, setFeishuQrStatus] = useState<"idle" | "loading" | "wait" | "error">("idle")
  const [feishuQrMsg, setFeishuQrMsg] = useState("")
  const [registerForm, setRegisterForm] = useState<{ name: string; desc: string } | null>(null)
  // 微信扫码
  const [wechatQrUrl, setWechatQrUrl] = useState("")
  const [wechatQrStatus, setWechatQrStatus] = useState<"idle" | "loading" | "wait" | "scaned" | "error">("idle")
  const [wechatQrMsg, setWechatQrMsg] = useState("")
  const wechatQrBusy = useRef(false)

  const set = (p: Partial<ChannelConfig>) => setDraft((d) => ({ ...d, ...p }))

  const resource = resources.find((r) => r.id === draft.agentResourceId) ?? resources[0]

  const modelOptLabel = (id?: string, params?: string) =>
    modelOptions.find((o) => o.id === id && o.params === (params ?? ""))?.label
    || modelSlug(id, params)

  const fetchModels = useCallback(async (silent = false) => {
    setLoadingModels(true)
    try {
      if (resource?.type === "sdk") {
        const r = await window.electronAPI.listSdkModels(resource.apiKey ?? "", draft.model, draft.modelParams)
        if (r.ok && r.models.length > 0) setModelOptions(r.models)
        else if (!r.ok && !silent) void showAlert("错误", r.error || "获取模型列表失败")
      } else {
        const r = await window.electronAPI.listModels()
        if (r.ok && r.models.length > 0) setModelOptions(r.models.map((m) => ({ ...m, label: m.id, params: "" })))
        else if (!r.ok && !silent) void showAlert("错误", r.error || "获取模型列表失败")
      }
    } finally {
      setLoadingModels(false)
    }
  }, [resource, draft.model, draft.modelParams, showAlert])

  // 打开弹窗与切换 Agent 资源时自动加载模型列表（静默失败，按钮可手动重试）
  useEffect(() => {
    setModelOptions([])
    void fetchModels(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.agentResourceId])

  // 飞书一键创建应用
  useEffect(() => {
    const unsub1 = window.electronAPI.onFeishuSetupQrCode((url) => { setFeishuQrUrl(url); setFeishuQrStatus("wait") })
    const unsub2 = window.electronAPI.onFeishuSetupStatus(() => {})
    return () => { unsub1(); unsub2() }
  }, [])

  // 凭据齐全时自动解析应用名（防抖），默认通道名自动替换为应用名
  const appId = draft.type === "feishu" ? (draft.larkAppId?.trim() ?? "") : ""
  const appSecret = draft.type === "feishu" ? (draft.larkAppSecret?.trim() ?? "") : ""
  useEffect(() => {
    if (!appId || !appSecret) { setAppInfoState({ checking: false }); return }
    let cancelled = false
    const t = setTimeout(async () => {
      setAppInfoState({ checking: true })
      const r = await window.electronAPI.fetchFeishuAppInfo(appId, appSecret)
      if (cancelled) return
      if (r.ok && r.name) {
        setAppInfoState({ checking: false })
        setDraft((d) => ({
          ...d,
          larkBotName: r.name,
          name: isDefaultChannelName(d.name) ? r.name! : d.name,
        }))
      } else {
        setAppInfoState({ checking: false, error: r.error })
        setDraft((d) => ({ ...d, larkBotName: "" }))
      }
    }, 600)
    return () => { cancelled = true; clearTimeout(t) }
  }, [appId, appSecret])

  const openRegisterForm = () => {
    setRegisterForm({
      name: !isDefaultChannelName(draft.name) ? draft.name.trim() : "Cursor Claw",
      desc: "Cursor AI 协作助手",
    })
  }

  const startFeishuRegister = async (preset: { name: string; desc: string }) => {
    setRegisterForm(null)
    setFeishuQrStatus("loading"); setFeishuQrUrl(""); setFeishuQrMsg("")
    const r = await window.electronAPI.feishuRegisterApp(preset)
    if (r.ok && r.appId && r.appSecret) {
      set({ larkAppId: r.appId, larkAppSecret: r.appSecret, larkAppQuickCreated: true })
      setFeishuQrStatus("idle"); setFeishuQrUrl("")
    } else if (r.error === "cancelled") {
      setFeishuQrStatus("idle"); setFeishuQrUrl("")
    } else {
      setFeishuQrStatus("error"); setFeishuQrMsg(r.error ?? "创建失败")
    }
  }

  // 微信扫码获取 Token
  useEffect(() => {
    const unsub1 = window.electronAPI.onWechatSetupQrCode((url) => { setWechatQrUrl(url); setWechatQrStatus("wait") })
    const unsub2 = window.electronAPI.onWechatSetupStatus((status) => { if (status === "scaned") setWechatQrStatus("scaned") })
    return () => { unsub1(); unsub2() }
  }, [])

  const startWechatQrLogin = async () => {
    if (wechatQrBusy.current) return
    wechatQrBusy.current = true
    setWechatQrStatus("loading"); setWechatQrUrl(""); setWechatQrMsg("")
    try {
      const r = await window.electronAPI.wechatQrLogin()
      wechatQrBusy.current = false
      if (r.ok && r.botToken) {
        set({ wechatToken: r.botToken, wechatAccountId: r.accountId ?? "" })
        setWechatQrStatus("idle"); setWechatQrUrl("")
      } else if (r.error === "cancelled") {
        setWechatQrStatus("idle"); setWechatQrUrl("")
      } else {
        setWechatQrStatus("error"); setWechatQrMsg(r.error ?? "登录失败")
      }
    } catch (e: unknown) {
      wechatQrBusy.current = false
      setWechatQrStatus("error"); setWechatQrMsg(e instanceof Error ? e.message : String(e))
    }
  }

  // 主用户绑定
  const handleBind = async () => {
    const credOk = draft.type === "feishu" ? !!(draft.larkAppId?.trim() && draft.larkAppSecret?.trim()) : !!draft.wechatToken?.trim()
    if (!credOk) { void showAlert("提示", draft.type === "feishu" ? "请先填写飞书凭据" : "请先扫码获取微信 Token"); return }
    setBinding(true)
    try {
      // 先落库，保证主进程读到最新通道配置
      await onSaveDraft({ ...draft, mainUserEnabled: true })
      const r = await window.electronAPI.startChannelBind(draft.id)
      if (r.ok && r.chatId) {
        set({ mainUserEnabled: true, mainUserChatId: r.chatId })
        await onSaveDraft({ ...draft, mainUserEnabled: true, mainUserChatId: r.chatId })
      } else if (r.error && r.error !== "cancelled") {
        void showAlert("绑定失败", r.error)
      }
    } finally {
      setBinding(false)
    }
  }

  const cancelBind = async () => {
    await window.electronAPI.cancelChannelBind(draft.id)
    setBinding(false)
  }

  const handleUnbind = async () => {
    if (!await showConfirm("解绑确认", "确定解除该通道的主用户绑定吗？解绑后该通道私聊将按\"其他人\"模式处理。")) return
    set({ mainUserChatId: "" })
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      await onSaveDraft(draft)
      const r = await window.electronAPI.testBind(draft.id)
      if (r.ok) void showAlert("成功", "测试消息已发送")
      else void showAlert("错误", r.error || "测试失败")
    } finally {
      setTesting(false)
    }
  }

  const selectWorkDir = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (d) set({ workspaceDir: d })
  }

  const credOk = draft.type === "feishu" ? !!(draft.larkAppId?.trim() && draft.larkAppSecret?.trim()) : !!draft.wechatToken?.trim()

  const modelKey = (id: string, params: string) => id + (params ? "\0" + params : "")
  const parseModelKey = (key: string): { id: string; params: string } => {
    const sep = key.indexOf("\0")
    return sep >= 0 ? { id: key.slice(0, sep), params: key.slice(sep + 1) } : { id: key, params: "" }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "85vh" }}>
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-200">
            {draft.type === "feishu" ? <Bird size={15} className="text-blue-400" /> : <MessageSquare size={15} className="text-green-400" />}
            {isNew ? "添加" : "编辑"}{draft.type === "feishu" ? "飞书" : "微信"}通道
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {/* 名称 */}
          <div>
            <label className="mb-1 block text-xs text-gray-500">通道名称</label>
            <input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder={draft.type === "feishu" ? "飞书" : "微信"} />
          </div>

          {/* ── 凭据 ── */}
          {draft.type === "feishu" ? (
            <div className="space-y-3 rounded-lg border border-gray-800 p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-gray-400">飞书凭据</h4>
                <div className="flex items-center gap-2">
                  <a href={draft.larkAppId?.trim() ? `https://open.feishu.cn/app/${draft.larkAppId.trim()}` : "https://open.feishu.cn/app"}
                    target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400">
                    <ExternalLink size={11} />开发者后台
                  </a>
                  <button type="button" onClick={openRegisterForm} disabled={feishuQrStatus === "loading" || feishuQrStatus === "wait" || registerForm !== null}
                    className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2 py-1 text-xs text-blue-300 hover:bg-blue-600/20 disabled:opacity-50">
                    <LogIn size={11} />一键创建应用
                  </button>
                </div>
              </div>
              {registerForm && (
                <div className="space-y-2 rounded-lg border border-blue-800/40 bg-blue-950/20 p-3">
                  <p className="text-xs font-medium text-blue-200">新应用信息（创建页将预填，扫码后可修改）</p>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">应用名称（群内机器人显示名）</label>
                    <input type="text" value={registerForm.name} onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })} className={inputCls} placeholder="如：排课助手" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">应用描述</label>
                    <input type="text" value={registerForm.desc} onChange={(e) => setRegisterForm({ ...registerForm, desc: e.target.value })} className={inputCls} placeholder="如：排课领域知识问答助手" />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => setRegisterForm(null)} className="rounded-md px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                    <button onClick={() => void startFeishuRegister(registerForm)} disabled={!registerForm.name.trim()} className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40">开始扫码创建</button>
                  </div>
                </div>
              )}
              {(feishuQrStatus === "loading" || (feishuQrStatus === "wait" && feishuQrUrl)) && (
                <div className="flex flex-col items-center gap-2 py-3">
                  {feishuQrStatus === "loading"
                    ? <Loader2 size={22} className="animate-spin text-blue-400" />
                    : <img src={feishuQrUrl} alt="Feishu QR" className="h-40 w-40 rounded bg-white p-1" />}
                  <p className="text-xs text-gray-400">{feishuQrStatus === "loading" ? "正在生成二维码..." : "请使用飞书扫码创建应用，完成后凭据将自动回填"}</p>
                  <div className="flex items-center gap-3">
                    <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400"
                      title="已创建成功但未自动回填时，可到开发者平台复制凭据手动填入">
                      <ExternalLink size={11} />开发者平台
                    </a>
                    <button onClick={async () => { await window.electronAPI.feishuRegisterAppCancel(); setFeishuQrStatus("idle"); setFeishuQrUrl("") }} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                  </div>
                </div>
              )}
              {feishuQrStatus === "error" && (
                <p className="text-xs text-red-400">
                  {feishuQrMsg} <button onClick={openRegisterForm} className="text-blue-400 hover:underline">重试</button>
                  <span className="text-gray-500"> · 若飞书侧已创建成功，可到</span>
                  <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">开发者平台</a>
                  <span className="text-gray-500">复制凭据手动填入</span>
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="mb-1 block text-xs text-gray-500">App ID</label><input type="text" value={draft.larkAppId ?? ""} onChange={(e) => set({ larkAppId: e.target.value })} className={inputCls} /></div>
                <div><label className="mb-1 block text-xs text-gray-500">App Secret</label>
                  <div className="relative">
                    <input type={showSecret ? "text" : "password"} value={draft.larkAppSecret ?? ""} onChange={(e) => set({ larkAppSecret: e.target.value })} className={inputCls + " pr-9"} />
                    <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showSecret ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                  </div>
                </div>
              </div>
              {appInfoState.checking && <p className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 size={11} className="animate-spin" />正在识别应用...</p>}
              {!appInfoState.checking && draft.larkBotName && <p className="flex items-center gap-1.5 text-xs text-green-400"><CheckCircle2 size={12} />已识别应用：{draft.larkBotName}</p>}
              {!appInfoState.checking && appInfoState.error && <p className="flex items-center gap-1.5 text-xs text-red-400"><ShieldAlert size={12} />{appInfoState.error}</p>}
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-gray-800 p-3">
              <h4 className="text-xs font-medium text-gray-400">微信账号</h4>
              {draft.wechatToken && wechatQrStatus === "idle" ? (
                <div className="flex items-center gap-3 rounded-lg border border-gray-700 px-3 py-2">
                  <CheckCircle2 size={14} className="text-green-400" />
                  <span className="flex-1 text-xs text-gray-300">已获取 Token{draft.wechatAccountId && <span className="ml-1 font-mono text-gray-500">{draft.wechatAccountId}</span>}</span>
                  <button type="button" onClick={() => void startWechatQrLogin()} className="text-xs text-gray-500 hover:text-blue-400">重新扫码</button>
                </div>
              ) : (
                <div className="space-y-2">
                  {wechatQrStatus === "loading" && (
                    <div className="flex items-center gap-2 py-2 text-xs text-gray-400">
                      <Loader2 size={13} className="animate-spin" />正在获取二维码...
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); wechatQrBusy.current = false; setWechatQrStatus("idle") }} className="text-gray-500 hover:text-red-400">取消</button>
                    </div>
                  )}
                  {(wechatQrStatus === "wait" || wechatQrStatus === "scaned") && wechatQrUrl && (
                    <div className="flex flex-col items-center gap-2 py-2">
                      <div className="rounded-lg bg-white p-2"><img src={wechatQrUrl} alt="WeChat QR" className="h-40 w-40" /></div>
                      <p className="text-xs text-gray-400">{wechatQrStatus === "scaned" ? "✅ 已扫描，请在手机上确认" : "请使用手机微信扫码"}</p>
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); wechatQrBusy.current = false; setWechatQrStatus("idle") }} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                    </div>
                  )}
                  {wechatQrStatus === "error" && <p className="text-xs text-red-400">{wechatQrMsg} <button onClick={() => void startWechatQrLogin()} className="text-blue-400 hover:underline">重试</button></p>}
                  {wechatQrStatus === "idle" && (
                    <button onClick={() => void startWechatQrLogin()} className="flex items-center gap-2 rounded-md border border-gray-600 px-3 py-2 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400">
                      <LogIn size={13} />扫码绑定ClawBot
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Agent 资源与模型 ── */}
          <div className="space-y-3 rounded-lg border border-gray-800 p-3">
            <h4 className="text-xs font-medium text-gray-400">Agent 资源与模型</h4>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Agent 资源</label>
              <select value={draft.agentResourceId} onChange={(e) => set({ agentResourceId: e.target.value })} className={inputCls}>
                {resources.map((r) => <option key={r.id} value={r.id}>{r.name}{r.type === "sdk" && r.email ? ` (${r.email})` : ""}</option>)}
              </select>
              {resource?.type === "sdk" && <p className="mt-1 text-xs text-amber-500/80">⚠ SDK 不支持单独设置代理，请根据网络环境选择模型或使用 TUN 模式。</p>}
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">主模型 <span className="text-gray-600">— 主用户私聊 / 定时任务默认</span></label>
              {loadingModels
                ? <div className={inputCls + " flex cursor-not-allowed items-center gap-2 text-gray-500"}><Loader2 size={13} className="animate-spin" />模型列表加载中...</div>
                : modelOptions.length > 0
                  ? <SearchableSelect
                      value={modelKey(draft.model, draft.modelParams)}
                      onChange={(key) => { const { id, params } = parseModelKey(key); set({ model: id, modelParams: params }) }}
                      options={modelOptions.map((o) => ({ id: modelKey(o.id, o.params), label: o.label }))}
                      placeholder="选择模型..."
                      fallbackLabel={modelOptLabel(draft.model, draft.modelParams)}
                    />
                  : <input type="text" value={modelOptLabel(draft.model, draft.modelParams)} onChange={(e) => set({ model: e.target.value, modelParams: "" })} placeholder="auto" className={inputCls} />}
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">其他人模型 <span className="text-gray-600">— 其他用户私聊 & 群聊</span></label>
              {loadingModels
                ? <div className={inputCls + " flex cursor-not-allowed items-center gap-2 text-gray-500"}><Loader2 size={13} className="animate-spin" />模型列表加载中...</div>
                : modelOptions.length > 0
                  ? <SearchableSelect
                      value={draft.othersModel ? modelKey(draft.othersModel, draft.othersModelParams) : ""}
                      onChange={(key) => { if (!key) { set({ othersModel: "", othersModelParams: "" }); return } const { id, params } = parseModelKey(key); set({ othersModel: id, othersModelParams: params }) }}
                      options={[{ id: "", label: "跟随主模型" }, ...modelOptions.map((o) => ({ id: modelKey(o.id, o.params), label: o.label }))]}
                      placeholder="跟随主模型"
                      fallbackLabel={modelOptLabel(draft.othersModel, draft.othersModelParams)}
                    />
                  : <input type="text" value={modelOptLabel(draft.othersModel, draft.othersModelParams)} onChange={(e) => set({ othersModel: e.target.value, othersModelParams: "" })} placeholder="留空则跟随主模型" className={inputCls} />}
            </div>
          </div>

          {/* ── 会话保活模式 ── */}
          <div className="space-y-3 rounded-lg border border-gray-800 p-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-medium text-gray-400">保留会话</h4>
                <p className="text-xs text-gray-600">回答结束后保留会话上下文，新消息自动恢复延续对话（应用重启也不丢）；关闭后每条消息都是全新会话</p>
              </div>
              <button onClick={() => set({ keepSession: !(draft.keepSession ?? true) })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.keepSession ?? true) ? "bg-blue-600" : "bg-gray-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.keepSession ?? true) ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {(draft.keepSession ?? true) && (
              <div className="flex items-center justify-between border-t border-gray-800 pt-3">
                <div>
                  <p className="text-xs text-gray-400">保持长连接 <span className="ml-1 rounded bg-blue-900/50 px-1.5 py-0.5 text-[10px] text-blue-300">次数套餐用户推荐</span></p>
                  <p className="text-xs text-gray-600">无限轮询保活，有新消息立即处理，会话期间多条消息共享一次额度；关闭后回答完即结束回合、新消息重新冷启动</p>
                </div>
                <button onClick={() => set({ persistentPoll: !(draft.persistentPoll ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.persistentPoll ?? true) ? "bg-blue-600" : "bg-gray-600"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.persistentPoll ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
            {draft.type === "feishu" && (
              <div className="flex items-center justify-between border-t border-gray-800 pt-3">
                <div>
                  <p className="text-xs text-gray-400">展示思考过程</p>
                  <p className="text-xs text-gray-600">开启：显示 AI 工作过程中的思考与步骤；关闭：静默处理，只收到最终回复</p>
                </div>
                <button onClick={() => set({ showThinking: !(draft.showThinking ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.showThinking ?? true) ? "bg-blue-600" : "bg-gray-600"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.showThinking ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
          </div>

          {/* ── 主用户绑定 ── */}
          <div className="space-y-3 rounded-lg border border-gray-800 p-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-medium text-gray-400">主用户绑定 <span className="font-normal text-gray-600">— 让机器人认识"你"</span></h4>
                <p className="text-xs text-gray-600">绑定你自己的账号后：你私聊机器人 = 直接指挥工作文件夹里的 AI，聊天记忆一直保留。不绑定的话，谁发消息都只能在临时文件夹里干活，碰不到你的项目</p>
              </div>
              <button onClick={() => set({ mainUserEnabled: !draft.mainUserEnabled })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${draft.mainUserEnabled ? "bg-blue-600" : "bg-gray-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${draft.mainUserEnabled ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {draft.mainUserEnabled && (
              <div className="flex items-center gap-3 rounded-lg border border-gray-700 px-3 py-2.5">
                {binding
                  ? <>
                      <Loader2 size={14} className="animate-spin text-blue-400" />
                      <span className="flex-1 text-xs text-blue-300">请在{draft.type === "feishu" ? "飞书" : "微信"}私聊中向机器人发送一条消息...</span>
                      <button type="button" onClick={() => void cancelBind()} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                    </>
                  : draft.mainUserChatId
                    ? <>
                        <CheckCircle2 size={14} className="text-green-400" />
                        <span className="flex-1 truncate text-xs text-gray-300">已绑定 <span className="ml-1 font-mono text-gray-500">{draft.mainUserChatId}</span></span>
                        <button type="button" onClick={() => void handleBind()} className="text-xs text-gray-500 hover:text-blue-400">重新绑定</button>
                        <span className="text-gray-700">|</span>
                        <button type="button" onClick={() => void handleUnbind()} className="text-xs text-gray-500 hover:text-red-400">解绑</button>
                        <span className="text-gray-700">|</span>
                        <button type="button" onClick={() => void handleTest()} disabled={testing} className="text-xs text-gray-500 hover:text-green-400 disabled:opacity-50">{testing ? "发送中..." : "测试"}</button>
                      </>
                    : <>
                        <ShieldAlert size={14} className="text-yellow-500" />
                        <span className="flex-1 text-xs text-gray-500">未绑定</span>
                        <button type="button" onClick={() => void handleBind()} disabled={!credOk} className="rounded-md border border-gray-600 px-2.5 py-1 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">绑定</button>
                      </>}
              </div>
            )}
          </div>

          {/* ── 其他人使用 ── */}
          <div className="space-y-3 rounded-lg border border-gray-800 p-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-medium text-gray-400">允许其他人使用</h4>
                <p className="text-xs text-gray-600">开启后别人也能私聊机器人、在群里 @它。放心：他们的 AI 在单独的临时文件夹里干活，看不到也改不了你的项目文件</p>
              </div>
              <button onClick={() => set({ allowOthers: !draft.allowOthers })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${draft.allowOthers ? "bg-blue-600" : "bg-gray-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${draft.allowOthers ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {draft.allowOthers && (
              <div>
                <label className="mb-1 block text-xs text-gray-500">对外身份规则</label>
                <textarea value={draft.digitalIdentity} onChange={(e) => set({ digitalIdentity: e.target.value })} rows={5} placeholder="定义 Agent 面向该通道其他用户时的角色、职责与行为规范...&#10;留空则不注入" className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none" />
                <p className="mt-1 text-xs text-gray-600">该通道其他人触发的会话启动时，将此内容作为 Agent 身份规则注入</p>
              </div>
            )}
          </div>

          {/* ── 高级设置 ── */}
          <div className="rounded-lg border border-gray-800">
            <button onClick={() => setShowAdvanced(!showAdvanced)} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-gray-400 hover:text-gray-200">
              <span>高级设置</span>
              {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {showAdvanced && (
              <div className="space-y-3 border-t border-gray-800 px-3 py-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">通道工作目录 <span className="text-gray-600">— 留空使用全局主工作目录</span></label>
                  <div className="flex items-center gap-2">
                    <div onClick={() => void selectWorkDir()} className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 transition hover:border-blue-500">
                      <FolderOpen size={14} className="text-blue-400" />
                      <span className="truncate text-xs">{draft.workspaceDir || "（全局默认）"}</span>
                    </div>
                    {draft.workspaceDir && <button onClick={() => set({ workspaceDir: "" })} className="text-xs text-gray-500 hover:text-red-400">清除</button>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-6 py-4">
          <button onClick={onClose} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
          <button onClick={() => void onSave(draft)} disabled={!draft.name.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
        </div>
      </div>
    </div>
  )
}
