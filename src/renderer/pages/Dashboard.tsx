import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react"
import {
  Play,
  Square,
  Settings,
  RefreshCw,
  Wifi,
  WifiOff,
  Bot,
  Bird,
  MessageSquare,
  Clock,
  Loader2,
  Trash2,
  LogIn,
  AlertTriangle,
  CheckCircle2,
  Circle,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Package,
  Rocket,
  Search,
  X,
  Plus,
  Cpu,
} from "lucide-react"
import logoUrl from "../assets/logo.png"
import TitleBar from "../components/TitleBar"
import useInlineModal from "../components/useInlineModal"
import { modelSlug } from "../model-utils"
import { disambiguatePathLabel } from "../../shared/path-label"
import { formatLogLineForUi, cardLabelFromSessionTab } from "../../shared/log-format"

interface Props {
  /** 打开设置页，可指定初始 Tab */
  onSettings: (tab?: string) => void
  /** 当前是否为可见页面（从设置页返回时立即刷新） */
  active?: boolean
}

interface OnboardState {
  workspaceReady: boolean
  agentReady: boolean
  channelReady: boolean
}

export default function Dashboard({ onSettings, active }: Props) {
  const [status, setStatus] = useState<DaemonStatus>({ running: false })
  const [logLines, setLogLines] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState("")
  const [queueMessages, setQueueMessages] = useState<{ index: number; fileId: string; preview: string; status?: "pending" | "processing"; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string; sessionLabel?: string }[]>([])
  const [showQueue, setShowQueue] = useState(false)
  const [showChannels, setShowChannels] = useState(false)
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const [modelMenuSession, setModelMenuSession] = useState<string | null>(null)
  const [quickModels, setQuickModels] = useState<{ model: string; modelParams?: string; label?: string }[]>([])
  const [cliStatus, setCliStatus] = useState<"checking" | "installed" | "missing" | "need-login">("checking")
  const [cliLoggingIn, setCliLoggingIn] = useState(false)
  const [cliMessage, setCliMessage] = useState("")
  const [stoppingAgent, setStoppingAgent] = useState(false)
  const [clearingQueue, setClearingQueue] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [onboard, setOnboard] = useState<OnboardState | null>(null)
  const [onboardDismissed, setOnboardDismissed] = useState(false)
  const [wsTabs, setWsTabs] = useState<{ current: string; favorites: string[] }>({ current: "", favorites: [] })
  const [sessionTabs, setSessionTabs] = useState<{ sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean }[]>([])
  const deletableSessionKeys = useMemo(
    () => new Set(sessionTabs.filter((t) => t.removable).map((t) => t.sessionKey)),
    [sessionTabs],
  )
  const { showConfirm, ModalPortal } = useInlineModal()
  const sessionLogLabelByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of sessionTabs) {
      m.set(t.sessionKey, cardLabelFromSessionTab(t))
    }
    return m
  }, [sessionTabs])

  const resolveLogSessionLabel = useCallback((sk: string) => {
    const direct = sessionLogLabelByKey.get(sk)
    if (direct) return direct
    const norm = sk.replace(/\\/g, "/").toLowerCase()
    for (const [k, v] of sessionLogLabelByKey) {
      if (k.replace(/\\/g, "/").toLowerCase() === norm) return v
    }
    const pid = sk.match(/::project_([a-f0-9]+)/i)?.[1]
    if (pid) {
      for (const [k, v] of sessionLogLabelByKey) {
        if (k.includes(`project_${pid}`)) return v
      }
    }
    return undefined
  }, [sessionLogLabelByKey])

  const [activeSessionKey, setActiveSessionKey] = useState("")
  const [sessionSwitching, setSessionSwitching] = useState("")
  const [modelTabs, setModelTabs] = useState<{ model: string; modelParams?: string; label?: string }[]>([])
  const [modelSwitching, setModelSwitching] = useState("")
  const [activeSessionModel, setActiveSessionModel] = useState<{ model: string; modelParams?: string } | null>(null)
  const [modelFavPickerOpen, setModelFavPickerOpen] = useState(false)
  const [modelFavLoading, setModelFavLoading] = useState(false)
  const [modelFavOptions, setModelFavOptions] = useState<{ model: string; modelParams?: string; label?: string; used?: boolean }[]>([])
  const [modelFavQuery, setModelFavQuery] = useState("")
  const modelFavPickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!actionError) return
    const t = window.setTimeout(() => setActionError(""), 4000)
    return () => window.clearTimeout(t)
  }, [actionError])

  useEffect(() => {
    if (!modelFavPickerOpen) return
    const onDoc = (e: MouseEvent) => {
      if (modelFavPickerRef.current && !modelFavPickerRef.current.contains(e.target as Node)) {
        setModelFavPickerOpen(false)
        setModelFavQuery("")
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [modelFavPickerOpen])

  const refreshModelTabs = useCallback(async () => {
    const r = await window.electronAPI.listQuickModels()
    if (r.ok) setModelTabs(r.models)
  }, [])

  const refreshSessionTabs = useCallback(async () => {
    const r = await window.electronAPI.listSessionTabs()
    if (!r.ok) {
      setSessionTabs([])
      setActiveSessionKey("")
      return
    }
    setSessionTabs(r.tabs)
    setActiveSessionKey(r.activeKey ?? r.tabs.find((t) => t.current)?.sessionKey ?? "")
  }, [])

  const refreshOnboard = useCallback(async () => {
    const cfg = await window.electronAPI.getConfig()
    const channels = cfg.channels ?? []
    const channelReady = channels.some((c) => c.enabled && (c.type === "feishu"
      ? !!(c.larkAppId?.trim() && c.larkAppSecret?.trim())
      : !!c.wechatToken?.trim()))
    const hasSdkKey = (cfg.agentResources ?? []).some((r) => r.type === "sdk" && r.apiKey?.trim())
    setOnboard((prev) => ({
      workspaceReady: !!cfg.workspaceDir?.trim(),
      agentReady: hasSdkKey || (prev?.agentReady ?? false),
      channelReady,
    }))
    // 打开过的目录自动收入常用列表，供「可切换会话」与 /c 共用
    const current = cfg.workspaceDir ?? ""
    let favorites = cfg.favoriteWorkspaces ?? []
    const same = (a: string, b: string) => a.replace(/[\\/]+$/g, "").toLowerCase() === b.replace(/[\\/]+$/g, "").toLowerCase()
    if (current.trim() && !favorites.some((f) => same(f, current))) {
      favorites = [...favorites, current]
      void window.electronAPI.saveConfig({ favoriteWorkspaces: favorites })
    }
    setWsTabs({ current, favorites })
    await Promise.all([refreshModelTabs(), refreshSessionTabs()])
  }, [refreshModelTabs, refreshSessionTabs])

  // 从设置页返回时立即刷新清单状态
  useEffect(() => {
    if (active) void refreshOnboard()
  }, [active, refreshOnboard])

  const switchSessionTab = async (sessionKey: string) => {
    if (!sessionKey || sessionKey === activeSessionKey || sessionSwitching) return
    setSessionSwitching(sessionKey)
    try {
      const r = await window.electronAPI.switchSession(sessionKey)
      if (!r.ok) {
        setActionError(r.error ?? "切换会话失败")
        return
      }
      setActionError("")
      await refreshSessionTabs()
    } finally {
      setSessionSwitching("")
    }
  }

  const addFavoriteWorkspace = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    const same = (a: string, b: string) => a.replace(/[\\/]+$/g, "").toLowerCase() === b.replace(/[\\/]+$/g, "").toLowerCase()
    const favorites = wsTabs.favorites.some((f) => same(f, dir)) ? wsTabs.favorites : [...wsTabs.favorites, dir]
    setWsTabs((t) => ({ ...t, favorites }))
    await window.electronAPI.saveConfig({ favoriteWorkspaces: favorites })
    await refreshSessionTabs()
  }

  const deleteSessionTab = async (sessionKey: string, kind?: string, label?: string) => {
    const tab = sessionTabs.find((t) => t.sessionKey === sessionKey)
    const k = kind || tab?.kind
    const name = label || tab?.label || sessionKey
    if (k === "project") {
      const short = name.split(" · ")[0]?.trim() || name
      if (!(await showConfirm(
        "删除项目",
        `确定删除「${short}」？\n将移除 AI 工作目录（含未提交改动）；主仓与远程分支不受影响。`,
        "删除",
        "取消",
      ))) return
      const pid = sessionKey.match(/::project_([a-f0-9]+)/i)?.[1]
      if (!pid) {
        setActionError("无法解析项目 id")
        return
      }
      const r = await window.electronAPI.deleteProject(pid)
      if (!r.ok) {
        setActionError(r.error ?? "删除项目失败")
        return
      }
    } else {
      if (!(await showConfirm("删除会话", `确定删除「${name}」？`, "删除", "取消"))) return
      const r = await window.electronAPI.deleteSession(sessionKey)
      if (!r.ok) {
        setActionError(r.error ?? "删除会话失败")
        return
      }
    }
    await refreshSessionTabs()
  }

  const [sessionList, setSessionList] = useState<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "cli" | "sdk"; model?: string; modelParams?: string }[]>([])
  const [sessionDiag, setSessionDiag] = useState<Record<string, { running: boolean; resumeAgentId?: string; resumeUpdatedAt?: number; lastRun?: { status: string; endedAt: number; durationMs?: number; error?: string }; lastReplyAt: number | null }>>({})

  /** 首页切模型：当前 active 会话；无则最近活跃；再无则按工作目录写 pending */
  const resolveModelTargetSession = useCallback(async (): Promise<string | null> => {
    if (activeSessionKey) return activeSessionKey
    if (sessionList.length > 0) {
      const sorted = [...sessionList].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
      return sorted[0].sessionKey
    }
    const ws = wsTabs.current
    if (!ws?.trim()) return null
    const cfg = await window.electronAPI.getConfig()
    const ch = (cfg.channels ?? []).find((c) => c.enabled && c.mainUserEnabled && c.mainUserChatId?.trim())
    if (!ch) return null
    return `${ch.id}|${ch.mainUserChatId}::${ws}`
  }, [activeSessionKey, sessionList, wsTabs.current])

  const switchSessionModel = async (m: { model: string; modelParams?: string; label?: string }) => {
    const key = `${m.model}\0${m.modelParams ?? ""}`
    if (modelSwitching) return
    setModelSwitching(key)
    try {
      const sk = await resolveModelTargetSession()
      if (!sk) {
        setActionError("无法解析目标会话：请先有活跃会话，或绑定主用户并配置工作目录")
        return
      }
      const r = await window.electronAPI.setSessionModel(sk, m.model, m.modelParams)
      if (!r.ok) {
        setActionError(r.error ?? "切换模型失败")
        return
      }
      setActionError("")
      setActiveSessionModel({ model: m.model, modelParams: m.modelParams })
      await refreshModelTabs()
    } finally {
      setModelSwitching("")
    }
  }

  const addFavoriteModel = async () => {
    setActionError("")
    if (modelFavPickerOpen) {
      setModelFavPickerOpen(false)
      setModelFavQuery("")
      return
    }
    setModelFavPickerOpen(true)
    setModelFavQuery("")
    setModelFavLoading(true)
    try {
      const cfg = await window.electronAPI.getConfig()
      const favs = cfg.favoriteModels ?? []
      const favKeys = new Set(favs.map((f) => `${f.model}\0${f.modelParams ?? ""}`))
      const out: { model: string; modelParams?: string; label?: string; used?: boolean }[] = []
      const seen = new Set<string>()
      const push = (m: { model: string; modelParams?: string; label?: string }, used?: boolean) => {
        if (!m.model) return
        const k = `${m.model}\0${m.modelParams ?? ""}`
        if (favKeys.has(k) || seen.has(k)) return
        seen.add(k)
        out.push({ model: m.model, modelParams: m.modelParams, label: m.label || modelSlug(m.model, m.modelParams), used })
      }

      const quick = await window.electronAPI.listQuickModels()
      if (quick.ok) {
        for (const m of quick.models) push(m, true)
      }
      for (const s of sessionList) {
        if (s.model) push({ model: s.model, modelParams: s.modelParams, label: modelSlug(s.model, s.modelParams) }, true)
      }
      if (activeSessionModel?.model) {
        push({ ...activeSessionModel, label: modelSlug(activeSessionModel.model, activeSessionModel.modelParams) }, true)
      }

      const sdkRes = (cfg.agentResources ?? []).find((r) => r.type === "sdk" && r.apiKey?.trim())
      if (sdkRes?.apiKey) {
        const r = await window.electronAPI.listSdkModels(sdkRes.apiKey, activeSessionModel?.model, activeSessionModel?.modelParams)
        if (r.ok) {
          for (const m of r.models) {
            push({ model: m.id, modelParams: m.params, label: m.label }, false)
          }
        }
      } else {
        const r = await window.electronAPI.listModels()
        if (r.ok) {
          for (const m of r.models) push({ model: m.id, modelParams: "", label: m.label || m.id }, false)
        }
      }

      // 用过的置顶
      out.sort((a, b) => Number(!!b.used) - Number(!!a.used))
      setModelFavOptions(out)
      if (out.length === 0) {
        setModelFavPickerOpen(false)
        setActionError(favs.length > 0 ? "可用模型均已在常用中" : "暂无模型可收藏：请先配置 Agent SDK Key 或产生过会话")
      }
    } finally {
      setModelFavLoading(false)
    }
  }

  const pickFavoriteModel = async (m: { model: string; modelParams?: string; label?: string }) => {
    setActionError("")
    const cfg = await window.electronAPI.getConfig()
    const favs = [...(cfg.favoriteModels ?? [])]
    if (favs.some((f) => f.model === m.model && (f.modelParams ?? "") === (m.modelParams ?? ""))) {
      setActionError("该模型已在常用列表中")
      setModelFavPickerOpen(false)
      setModelFavQuery("")
      return
    }
    favs.push({ model: m.model, modelParams: m.modelParams, label: m.label || modelSlug(m.model, m.modelParams) })
    await window.electronAPI.saveConfig({ favoriteModels: favs })
    setModelFavPickerOpen(false)
    setModelFavQuery("")
    await refreshModelTabs()
  }

  const removeFavoriteModel = async (m: { model: string; modelParams?: string }) => {
    const cfg = await window.electronAPI.getConfig()
    const key = `${m.model}\0${m.modelParams ?? ""}`
    const favs = (cfg.favoriteModels ?? []).filter(
      (f) => `${f.model}\0${f.modelParams ?? ""}` !== key,
    )
    await window.electronAPI.saveConfig({ favoriteModels: favs })
    // 快捷栏 = 收藏 ∪ 最近；只删收藏会从「最近」补回来，看起来像 ❌ 无效
    await window.electronAPI.forgetQuickModel(m.model, m.modelParams)
    await refreshModelTabs()
  }

  useEffect(() => {
    const hit = (activeSessionKey && sessionList.find((s) => s.sessionKey === activeSessionKey && s.model))
      || [...sessionList.filter((s) => s.model)].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0]
    if (hit?.model) setActiveSessionModel({ model: hit.model, modelParams: hit.modelParams })
  }, [sessionList, activeSessionKey])

  useEffect(() => {
    void refreshSessionTabs()
  }, [sessionList, refreshSessionTabs])

  const [exportingDiag, setExportingDiag] = useState(false)
  const [logFilter, setLogFilter] = useState("")
  const [logAtBottom, setLogAtBottom] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)
  /** 是否贴底跟随：用户上翻后暂停自动滚动，回到底部（或点击按钮）后恢复 */
  const logStickRef = useRef(true)
  const programmaticScrollRef = useRef(false)

  useEffect(() => {
    const syncCliStatus = (s: DaemonStatus) => {
      if (s.running && s.cliAvailable !== undefined) {
        setCliStatus((prev) =>
          !s.cliAvailable && (prev === "installed" || prev === "need-login") ? "missing" : prev,
        )
      }
    }

    const refresh = async () => {
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
      syncCliStatus(s)
      window.electronAPI.getSessionAgents().then(setSessionList).catch(() => {})
      await refreshOnboard()
      if (s.queueLength && s.queueLength > 0) {
        const msgs = await window.electronAPI.getQueueMessages()
        setQueueMessages(msgs)
      } else {
        setQueueMessages([])
      }
    }
    refresh()
    const timer = setInterval(refresh, 5_000)

    window.electronAPI.getLogBuffer().then((buf) => {
      if (buf.length > 0) setLogLines(buf.slice(-300))
    })

    const unsub = window.electronAPI.onDaemonStatus((s) => {
      setStatus(s)
      syncCliStatus(s)
    })
    const unsubLog = window.electronAPI.onDaemonLog((line) => {
      setLogLines((prev) => {
        const next = [...prev, line]
        return next.length > 300 ? next.slice(-300) : next
      })
    })

    let cancelCliSchedule: (() => void) | undefined
    window.electronAPI.getConfig().then((cfg) => {
      // 仅当存在绑定 CLI 资源的通道时才提示 CLI 安装/登录
      const cliInUse = (cfg.channels ?? []).some((c) => c.enabled && c.agentResourceId === "cli")
        || (cfg.channels ?? []).length === 0
      if (!cliInUse) {
        setCliStatus("installed")
        return
      }
      const runCliChecks = () => {
        void (async () => {
          const installed = await window.electronAPI.checkCli()
          if (!installed) {
            setCliStatus("missing")
            return
          }
          const st = await window.electronAPI.checkCliLogin()
          setCliStatus(st.loggedIn ? "installed" : "need-login")
        })()
      }
      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(runCliChecks, { timeout: 2500 })
        cancelCliSchedule = () => cancelIdleCallback(id)
      } else {
        const cliTimer = window.setTimeout(runCliChecks, 0)
        cancelCliSchedule = () => clearTimeout(cliTimer)
      }
    })

    window.electronAPI.getSessionAgents().then(setSessionList).catch(() => {})
    const unsubSessions = window.electronAPI.onSessionAgents?.((list: typeof sessionList) => setSessionList(list))

    return () => {
      clearInterval(timer)
      cancelCliSchedule?.()
      unsub()
      unsubLog()
      unsubSessions?.()
    }
  }, [])

  const filteredLogLines = logFilter.trim()
    ? logLines.filter((l) => l.toLowerCase().includes(logFilter.trim().toLowerCase()))
    : logLines

  useEffect(() => {
    if (!logStickRef.current) return
    const el = logRef.current
    if (!el) return
    // rAF 合并同帧多次日志更新，减少与用户滚动的竞态
    const raf = requestAnimationFrame(() => {
      if (!logStickRef.current || !logRef.current) return
      programmaticScrollRef.current = true
      logRef.current.scrollTop = logRef.current.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [logLines, logFilter])

  const handleLogScroll = () => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    // 离开底部：无条件取消吸底（覆盖程序化标记）。
    // 旧逻辑在 programmatic 期间吞掉一切 scroll，高频日志时用户上翻会被立刻拽回底部。
    if (!atBottom) {
      programmaticScrollRef.current = false
      if (logStickRef.current) logStickRef.current = false
      setLogAtBottom(false)
      return
    }
    // 仍在底部：程序化吸底触发的 scroll 只清标记，不改 stick
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false
      return
    }
    logStickRef.current = true
    setLogAtBottom(true)
  }

  const scrollLogToBottom = () => {
    logStickRef.current = true
    setLogAtBottom(true)
    programmaticScrollRef.current = true
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }

  // CLI 已登录也视为 Agent 资源就绪
  useEffect(() => {
    if (cliStatus === "installed") {
      setOnboard((prev) => (prev ? { ...prev, agentReady: true } : prev))
    }
  }, [cliStatus])

  const handleStart = async () => {
    setStarting(true)
    setActionError("")
    try {
      const result = await window.electronAPI.startDaemon()
      if (result.ok) {
        const s = await window.electronAPI.getDaemonStatus()
        setStatus(s)
      } else {
        setActionError(result.error ?? "启动失败")
        // 启动失败大多因配置缺失，重新展示引导清单
        setOnboardDismissed(false)
        void refreshOnboard()
      }
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
      setOnboardDismissed(false)
      void refreshOnboard()
    }
    setStarting(false)
  }

  const handleStop = async () => {
    setStopping(true)
    await window.electronAPI.stopDaemon()
    setStatus({ running: false })
    setStopping(false)
  }

  const handleRefresh = async () => {
    const s = await window.electronAPI.getDaemonStatus()
    setStatus(s)
    if (s.queueLength && s.queueLength > 0) {
      const msgs = await window.electronAPI.getQueueMessages()
      setQueueMessages(msgs)
    } else {
      setQueueMessages([])
    }
  }

  const handleLoginOnly = async () => {
    setCliLoggingIn(true)
    setCliMessage("")
    try {
      const loginResult = await window.electronAPI.loginCli()
      if (!loginResult.ok) {
        setCliMessage(loginResult.output)
        setCliLoggingIn(false)
        return
      }
      const st = await window.electronAPI.checkCliLogin()
      if (st.loggedIn) {
        setCliStatus("installed")
        setCliMessage("")
      } else {
        setCliMessage(st.error ?? loginResult.output ?? "登录后仍未检测到账号，请重试")
      }
    } catch (e: unknown) {
      setCliMessage(e instanceof Error ? e.message : String(e))
    }
    setCliLoggingIn(false)
  }

  const handleStopAgent = async () => {
    setStoppingAgent(true)
    try {
      await Promise.all([
        window.electronAPI.stopAgent(),
        window.electronAPI.stopAllSessionAgents(),
      ])
      setSessionList([])
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
    } catch { /* ignore */ }
    setStoppingAgent(false)
  }

  const refreshQueueMessages = async () => {
    const msgs = await window.electronAPI.getQueueMessages()
    setQueueMessages(msgs)
    return msgs
  }

  const toggleQueue = async () => {
    if (!showQueue) {
      await refreshQueueMessages()
      setShowSessions(false)
      setShowChannels(false)
    }
    setShowQueue(!showQueue)
  }

  const handleClearQueue = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setClearingQueue(true)
    await window.electronAPI.clearQueueMessages()
    setQueueMessages([])
    setStatus((prev) => ({ ...prev, queueLength: 0 }))
    setClearingQueue(false)
  }

  const handleDeleteQueueMessage = async (fileId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await window.electronAPI.deleteQueueMessage(fileId)
    const msgs = queueMessages.filter((m) => m.fileId !== fileId)
    setQueueMessages(msgs)
    setStatus((prev) => ({ ...prev, queueLength: Math.max(0, (prev.queueLength ?? 1) - 1) }))
  }

  const toggleSessionExpand = async (sessionKey: string) => {
    if (expandedSession === sessionKey) {
      setExpandedSession(null)
      return
    }
    setExpandedSession(sessionKey)
    if (queueMessages.length === 0) void refreshQueueMessages()
    try {
      const diag = await window.electronAPI.getSessionDiagnostics(sessionKey)
      setSessionDiag((prev) => ({ ...prev, [sessionKey]: diag }))
    } catch { /* daemon 未运行等，展开区显示占位 */ }
  }

  const handleExportDiagnostics = async () => {
    setExportingDiag(true)
    try {
      const r = await window.electronAPI.exportDiagnostics()
      if (!r.ok) setActionError(r.error ?? "诊断包导出失败")
    } finally {
      setExportingDiag(false)
    }
  }

  const getSessionQueueMessages = (sessionKey: string) =>
    queueMessages.filter((m) => m.sessionKey === sessionKey)

  const formatTimestamp = (ts?: number) => {
    if (!ts) return ""
    const d = new Date(ts)
    return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  }

  const getSessionLabel = (msg: { sessionKey?: string; chatType?: string; sessionLabel?: string }) => {
    if (msg.sessionLabel) return msg.sessionLabel
    if (!msg.sessionKey) return "未知会话"
    const chatLabel = msg.chatType === "group" ? "群聊" : msg.chatType === "task" ? "定时" : "私聊"
    const tab = sessionTabs.find((t) => t.sessionKey === msg.sessionKey)
    if (tab?.label) {
      const icon = tab.kind === "project" ? "📦" : tab.kind === "temp" ? "⏱" : "📁"
      return `${chatLabel} ${icon}${tab.label}`
    }
    const running = sessionList.find((s) => s.sessionKey === msg.sessionKey)
    if (running?.chatName) return `${chatLabel} ${running.chatName}`
    const parts = msg.sessionKey.split("::")
    const suffix = parts[1] || ""
    if (suffix.startsWith("project_")) return `${chatLabel} 📦项目 ${suffix.slice(8, 20)}`
    if (suffix.startsWith("temp_") || msg.sessionKey.startsWith("temp_")) return `${chatLabel} ⏱临时会话`
    const peers = [
      ...sessionList.map((s) => s.workspaceDir),
      ...queueMessages.map((m) => {
        const s = m.sessionKey?.split("::")[1]
        return s && /[\\/]/.test(s) ? s : undefined
      }),
    ].filter((d): d is string => !!d)
    const dir = suffix && /[\\/]/.test(suffix) ? disambiguatePathLabel(suffix, peers.length ? peers : [suffix]) : ""
    return `${chatLabel}${dir ? ` 📁${dir}` : ""}`
  }

  const formatUptime = (seconds?: number): string => {
    if (!seconds) return "-"
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
  }

  const isStarting = starting || !!status.starting

  const sessionWsDirs = sessionList.map((s) => s.workspaceDir).filter((d): d is string => !!d)

  return (
    <div className="flex h-screen flex-col">
      <TitleBar>
        <div className="flex flex-1 items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logoUrl} alt="logo" className="h-6 w-6" />
            <h1 className="text-lg font-semibold">Cursor Claw</h1>
            {status.version && (
              <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                v{status.version}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <button
              onClick={handleRefresh}
              className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white"
              title="刷新状态"
            >
              <RefreshCw size={16} />
            </button>
            <button
              onClick={() => onSettings()}
              className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white"
              title="设置"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>
      </TitleBar>

      {/* Status cards */}
      <div className="grid grid-cols-4 gap-3 px-6 py-4">
        <StatusCard
          icon={status.running ? Wifi : WifiOff}
          label="Daemon"
          value={status.running ? "运行中" : isStarting ? "启动中" : "已停止"}
          color={status.running ? "green" : isStarting ? "yellow" : "red"}
          sub={
            status.running
              ? [
                  `uptime ${formatUptime(status.uptime)}`,
                  status.workspaceMismatch
                    ? (status.daemonWorkspaceDir
                      ? `目录与设置不一致（Daemon: ${status.daemonWorkspaceDir}）`
                      : "工作目录与设置不一致")
                    : "",
                ].filter(Boolean).join(" · ")
              : status.error
          }
          action={status.running ? (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
              title="停止 Daemon"
            >
              {stopping ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              停止
            </button>
          ) : isStarting ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-yellow-400" title="正在启动 Daemon">
              <Loader2 size={10} className="animate-spin" />
              启动中
            </span>
          ) : (
            <button
              onClick={handleStart}
              disabled={starting}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-green-400 transition hover:bg-green-600/20 disabled:opacity-50"
              title="启动 Daemon"
            >
              {starting ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
              启动
            </button>
          )}
        />
        <div
          onClick={() => { if ((status.channels ?? []).length > 0) { const next = !showChannels; setShowChannels(next); if (next) { setShowQueue(false); setShowSessions(false) } } }}
          className={(status.channels ?? []).length > 0 ? "cursor-pointer" : ""}
        >
          <StatusCard
            icon={(status.channels ?? []).some((c) => c.connected) ? Wifi : WifiOff}
            label="消息通道"
            value={(() => {
              const chs = status.channels ?? []
              if (chs.length === 0) return status.running ? "未配置通道" : "等待连接"
              const ok = chs.filter((c) => c.connected).length
              if (ok === chs.length) return chs.length === 1 ? `${chs[0].name} 已连接` : `${ok}/${chs.length} 通道在线`
              if (ok > 0) return `${ok}/${chs.length} 通道在线`
              return status.running ? "通道连接中" : "等待连接"
            })()}
            color={(() => {
              const chs = status.channels ?? []
              const ok = chs.filter((c) => c.connected).length
              if (ok > 0 && ok === chs.length) return "green"
              if (ok > 0 || (status.running && chs.length > 0)) return "yellow"
              return "gray"
            })()}
            sub={(() => {
              const chs = status.channels ?? []
              if (chs.length === 0) return "等待目标"
              return chs.map((c) => `${c.name}${c.connected ? "✓" : c.status === "qr_pending" ? "(扫码)" : "…"}`).join(" · ")
            })()}
          />
        </div>
        <div onClick={async () => { if (sessionList.length > 0 || status.agentRunning) { const next = !showSessions; setShowSessions(next); if (next) { setShowQueue(false); setShowChannels(false); await refreshQueueMessages() } } }} className={sessionList.length > 0 || status.agentRunning ? "cursor-pointer" : ""}>
          <StatusCard
            icon={Bot}
            label="Agent"
            value={
              sessionList.length > 0
                ? `${sessionList.length} 个会话`
                : status.agentRunning ? `会话中 PID:${status.agentPid}` : "空闲"
            }
            color={status.agentRunning || sessionList.length > 0 ? "blue" : "gray"}
            sub={sessionList.length > 0 ? "点击查看详情" : "等待消息"}
            action={status.agentRunning || sessionList.length > 0 ? (
              <button
                onClick={(e) => { e.stopPropagation(); handleStopAgent() }}
                disabled={stoppingAgent}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
                title="停止全部 Agent"
              >
                {stoppingAgent ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
                停止
              </button>
            ) : undefined}
          />
        </div>
        <div onClick={toggleQueue} className="cursor-pointer">
          <StatusCard
            icon={MessageSquare}
            label="消息队列"
            value={(() => {
              const processing = status.queueCounts?.processing ?? 0
              const pending = status.queueCounts?.pending ?? 0
              if (processing === 0 && pending === 0) return "0"
              return (
                <span className="flex items-baseline gap-2.5">
                  {processing > 0 && (
                    <span className="flex items-baseline gap-1 text-blue-400" title="处理中">
                      {processing}<span className="text-[10px] text-blue-500/70">处理中</span>
                    </span>
                  )}
                  {pending > 0 && (
                    <span className="flex items-baseline gap-1 text-yellow-400" title="排队中">
                      {pending}<span className="text-[10px] text-yellow-500/70">排队</span>
                    </span>
                  )}
                </span>
              )
            })()}
            color={(status.queueCounts?.processing ?? 0) > 0 ? "blue" : (status.queueCounts?.pending ?? 0) > 0 ? "yellow" : "gray"}
            action={status.queueLength ? (
              <button
                onClick={handleClearQueue}
                disabled={clearingQueue}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
                title="清空队列"
              >
                {clearingQueue ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                清空
              </button>
            ) : undefined}
          />
        </div>
      </div>

      {/* Session quick-switch tabs（对齐 /c） */}
      <div className="mx-6 mb-3 flex flex-wrap items-center gap-1.5">
        <MessageSquare size={13} className="shrink-0 text-gray-500" />
        {sessionTabs.map((t) => {
          const short = t.label
          const Icon = t.kind === "project" ? Package : FolderOpen
          return (
            <span key={t.sessionKey} title={t.sessionKey}
              onClick={() => void switchSessionTab(t.sessionKey)}
              className={`group inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${
                t.current ? "border-blue-500/70 bg-blue-950/40 text-blue-200"
                : "cursor-pointer border-gray-700 text-gray-400 hover:border-blue-500 hover:text-blue-300"}`}
            >
              {sessionSwitching === t.sessionKey
                ? <Loader2 size={11} className="animate-spin" />
                : <Icon size={11} className={t.current ? "text-blue-300" : "text-gray-500"} />}
              {t.running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" title="运行中" />}
              {short}
              {t.removable && (
                <button onClick={(e) => { e.stopPropagation(); void deleteSessionTab(t.sessionKey, t.kind, t.label) }}
                  className="hidden text-gray-600 hover:text-red-400 group-hover:inline-flex" title={t.kind === "project" ? "删除项目" : "删除会话"}>
                  <X size={11} />
                </button>
              )}
            </span>
          )
        })}
        <button onClick={() => void addFavoriteWorkspace()}
          className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-gray-700 px-2 py-1 text-xs text-gray-500 transition hover:border-blue-500 hover:text-blue-300"
          title="添加目录型会话到可切换列表（与 /c 常用目录同源）">
          <Plus size={11} />常用
        </button>
      </div>

      {/* Model quick-switch tabs（仅本会话） */}
      <div className="relative mx-6 mb-3 flex flex-wrap items-center gap-1.5" ref={modelFavPickerRef}>
        <Cpu size={13} className="shrink-0 text-gray-500" />
        {modelTabs.map((m) => {
          const key = `${m.model}\0${m.modelParams ?? ""}`
          const label = m.label || modelSlug(m.model, m.modelParams)
          const isCurrent = !!activeSessionModel
            && activeSessionModel.model === m.model
            && (activeSessionModel.modelParams ?? "") === (m.modelParams ?? "")
          return (
            <span key={key} title={`切换本会话模型: ${m.model}`}
              onClick={() => void switchSessionModel(m)}
              className={`group inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${
                isCurrent ? "border-violet-500/70 bg-violet-950/40 text-violet-200"
                : "cursor-pointer border-gray-700 text-gray-400 hover:border-violet-500 hover:text-violet-300"}`}
            >
              {modelSwitching === key && <Loader2 size={11} className="animate-spin" />}
              {label}
              {!isCurrent && (
                <button onClick={(e) => { e.stopPropagation(); void removeFavoriteModel(m) }}
                  className="hidden text-gray-600 hover:text-red-400 group-hover:inline-flex" title="从常用移除">
                  <X size={11} />
                </button>
              )}
            </span>
          )
        })}
        <button onClick={() => void addFavoriteModel()}
          className={`inline-flex items-center gap-0.5 rounded-md border border-dashed px-2 py-1 text-xs transition ${
            modelFavPickerOpen ? "border-violet-500 text-violet-300" : "border-gray-700 text-gray-500 hover:border-violet-500 hover:text-violet-300"}`}
          title="从模型列表添加常用（用过的优先；点击标签切换本会话模型）">
          <Plus size={11} />常用模型
        </button>
        {modelFavPickerOpen && (
          <div className="absolute left-0 top-full z-30 mt-1 flex max-h-64 w-72 flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
            <div className="sticky top-0 border-b border-gray-800 bg-gray-900 p-2">
              <div className="relative flex items-center">
                <Search size={12} className="pointer-events-none absolute left-2 text-gray-600" />
                <input
                  autoFocus
                  value={modelFavQuery}
                  onChange={(e) => setModelFavQuery(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="搜索模型…"
                  className="w-full rounded border border-gray-700 bg-gray-950 py-1.5 pl-7 pr-2 text-xs text-gray-200 outline-none placeholder:text-gray-600 focus:border-violet-500"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {modelFavLoading && (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500">
                  <Loader2 size={12} className="animate-spin" />加载模型列表…
                </div>
              )}
              {!modelFavLoading && (() => {
                const q = modelFavQuery.trim().toLowerCase()
                const filtered = q
                  ? modelFavOptions.filter((m) =>
                      (m.label || "").toLowerCase().includes(q)
                      || m.model.toLowerCase().includes(q)
                      || (m.modelParams || "").toLowerCase().includes(q))
                  : modelFavOptions
                const used = filtered.filter((m) => m.used)
                const rest = filtered.filter((m) => !m.used)
                if (filtered.length === 0) {
                  return <div className="px-3 py-2 text-xs text-gray-500">{modelFavOptions.length === 0 ? "暂无可添加的模型" : "无匹配模型"}</div>
                }
                return (
                  <>
                    {used.length > 0 && (
                      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-600">用过的</div>
                    )}
                    {used.map((m) => (
                      <button key={`u:${m.model}\0${m.modelParams ?? ""}`} type="button"
                        className="block w-full truncate px-3 py-1.5 text-left text-xs text-violet-200 hover:bg-gray-800"
                        onClick={() => void pickFavoriteModel(m)}>
                        {m.label || m.model}
                      </button>
                    ))}
                    {rest.length > 0 && (
                      <div className={`px-3 py-1 text-[10px] uppercase tracking-wide text-gray-600 ${used.length ? "mt-1 border-t border-gray-800" : ""}`}>全部模型</div>
                    )}
                    {rest.map((m) => (
                      <button key={`a:${m.model}\0${m.modelParams ?? ""}`} type="button"
                        className="block w-full truncate px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800"
                        onClick={() => void pickFavoriteModel(m)}>
                        {m.label || m.model}
                      </button>
                    ))}
                  </>
                )
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Onboarding checklist */}
      {onboard && !onboardDismissed && !(onboard.workspaceReady && onboard.agentReady && onboard.channelReady) && (
        <div className="mx-6 mb-3 rounded-xl border border-blue-800/50 bg-blue-950/20 p-4">
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Rocket size={15} className="text-blue-400" />
              <span className="text-sm font-medium text-blue-200">开始使用 Cursor Claw</span>
            </div>
            <button onClick={() => setOnboardDismissed(true)} className="rounded px-1.5 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300">暂时隐藏</button>
          </div>
          <p className="mb-3 text-xs text-gray-500">完成以下三步配置，即可通过飞书 / 微信与 AI Agent 协作。</p>
          <div className="space-y-1.5">
            {(() => {
              const items = [
                { done: onboard.workspaceReady, icon: FolderOpen, label: "选择主工作目录", desc: "Agent 在此目录中工作", tab: "general" },
                { done: onboard.agentReady, icon: Bot, label: "配置 Agent 资源", desc: "登录 Cursor CLI 或添加 SDK Key", tab: "agent" },
                { done: onboard.channelReady, icon: MessageSquare, label: "添加消息通道", desc: "接入飞书或微信并绑定 Agent 资源", tab: "channel" },
              ]
              const nextIdx = items.findIndex((it) => !it.done)
              return items.map((item, i) => {
                const isNext = i === nextIdx
                return (
                  <button
                    key={item.tab}
                    onClick={() => onSettings(item.tab)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                      item.done ? "border-green-800/40 bg-green-950/20"
                      : isNext ? "border-blue-500/70 bg-blue-950/30 hover:bg-blue-900/30"
                      : "border-gray-700 hover:border-blue-500 hover:bg-gray-800/40"}`}
                  >
                    {item.done
                      ? <CheckCircle2 size={16} className="shrink-0 text-green-400" />
                      : <Circle size={16} className={`shrink-0 ${isNext ? "text-blue-400" : "text-gray-600"}`} />}
                    <item.icon size={14} className={`shrink-0 ${item.done ? "text-green-400/70" : isNext ? "text-blue-300" : "text-gray-400"}`} />
                    <div className="min-w-0 flex-1">
                      <span className={`text-xs font-medium ${item.done ? "text-green-300/80" : isNext ? "text-blue-100" : "text-gray-200"}`}>{i + 1}. {item.label}</span>
                      <span className="ml-2 text-xs text-gray-600">{item.desc}</span>
                    </div>
                    {isNext && <span className="shrink-0 rounded bg-blue-600/30 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">下一步</span>}
                    {!item.done && <ChevronRight size={14} className={`shrink-0 ${isNext ? "text-blue-400" : "text-gray-600"}`} />}
                  </button>
                )
              })
            })()}
          </div>
        </div>
      )}

      {showChannels && (status.channels ?? []).length > 0 && (
        <div className="mx-6 rounded-xl border border-gray-800 bg-gray-900/80 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400">消息通道详情</span>
            <button onClick={() => onSettings("channel")} className="text-xs text-blue-400 hover:text-blue-300">管理通道</button>
          </div>
          <div className="space-y-1.5">
            {(status.channels ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg bg-gray-800/60 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  {c.type === "feishu" ? <Bird size={14} className="shrink-0 text-blue-400" /> : <MessageSquare size={14} className="shrink-0 text-green-400" />}
                  <span className="truncate text-xs text-gray-300">{c.name}</span>
                  {c.botName && <span className="truncate text-[10px] text-gray-500">{c.botName}</span>}
                  {c.mainUserBound && <span className="shrink-0 rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">主用户</span>}
                </div>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${c.connected ? "bg-green-900/40 text-green-400" : c.status === "error" ? "bg-red-900/40 text-red-400" : "bg-yellow-900/40 text-yellow-400"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${c.connected ? "bg-green-400" : c.status === "error" ? "bg-red-400" : "bg-yellow-400"}`} />
                  {c.connected ? "在线" : (CHANNEL_STATUS_TEXT[c.status] ?? c.status ?? "未连接")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showSessions && sessionList.length > 0 && (
        <div className="mx-6 rounded-xl border border-gray-800 bg-gray-900/80 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400">活跃会话</span>
            <button onClick={async () => { await window.electronAPI.stopAllSessionAgents(); setSessionList([]) }} className="text-xs text-red-400 hover:text-red-300">全部停止</button>
          </div>
          <div className="space-y-1.5">
            {sessionList.map((s) => {
              const pendingMsgs = getSessionQueueMessages(s.sessionKey)
              const processingCount = pendingMsgs.filter((m) => m.status === "processing").length
              const queuedCount = pendingMsgs.length - processingCount
              const isExpanded = expandedSession === s.sessionKey
              return (
                <div key={s.sessionKey}>
                  <div
                    className="flex cursor-pointer items-center justify-between rounded-lg bg-gray-800/60 px-3 py-2 hover:bg-gray-800/80"
                    onClick={() => void toggleSessionExpand(s.sessionKey)}
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className={`h-2 w-2 rounded-full ${s.chatType === "group" ? "bg-green-400" : s.chatType === "task" ? "bg-yellow-400" : "bg-blue-400"}`} />
                      <span className="truncate text-xs text-gray-300" title={s.sessionKey}>
                        {s.chatType === "group" ? "群聊" : s.chatType === "task" ? "定时" : "私聊"} {s.chatName || (s.sessionKey.length > 20 ? s.sessionKey.slice(0, 20) + "…" : s.sessionKey)}
                        {s.workspaceDir && s.chatType === "p2p" && (
                          <span className="ml-1 text-[10px] text-gray-500" title={s.workspaceDir}>
                            📁{disambiguatePathLabel(s.workspaceDir, sessionWsDirs)}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-gray-600">PID:{s.pid || "sdk"}</span>
                      {s.model && (
                        <span className="relative" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="truncate text-[10px] text-violet-400 hover:text-violet-300"
                            title="切换本会话模型"
                            onClick={async () => {
                              if (modelMenuSession === s.sessionKey) { setModelMenuSession(null); return }
                              const r = await window.electronAPI.listQuickModels()
                              if (r.ok) setQuickModels(r.models)
                              setModelMenuSession(s.sessionKey)
                            }}
                          >
                            {(() => {
                              const hit = modelTabs.find((m) => m.model === s.model && (m.modelParams ?? "") === (s.modelParams ?? ""))
                              return hit?.label || modelSlug(s.model, s.modelParams)
                            })()} ▾
                          </button>
                          {modelMenuSession === s.sessionKey && (
                            <div className="absolute left-0 top-full z-20 mt-1 max-h-48 w-48 overflow-auto rounded border border-gray-700 bg-gray-900 py-1 shadow-lg">
                              {quickModels.length === 0 && (
                                <div className="px-2 py-1 text-[10px] text-gray-500">暂无常用/最近模型，先在设置收藏或 /model ls</div>
                              )}
                              {quickModels.map((m) => (
                                <button
                                  key={`${m.model}\0${m.modelParams ?? ""}`}
                                  type="button"
                                  className="block w-full truncate px-2 py-1 text-left text-[10px] text-gray-300 hover:bg-gray-800"
                                  onClick={async () => {
                                    setModelMenuSession(null)
                                    const r = await window.electronAPI.setSessionModel(s.sessionKey, m.model, m.modelParams)
                                    if (!r.ok) window.alert(r.error || "切换失败")
                                  }}
                                >
                                  {m.label || m.model}
                                </button>
                              ))}
                              {s.model && (
                                <button
                                  type="button"
                                  className="mt-1 block w-full border-t border-gray-700 px-2 py-1 text-left text-[10px] text-amber-400 hover:bg-gray-800"
                                  onClick={async () => {
                                    const cfg = await window.electronAPI.getConfig()
                                    const favs = [...(cfg.favoriteModels ?? [])]
                                    if (!favs.some((f) => f.model === s.model && (f.modelParams ?? "") === (s.modelParams ?? ""))) {
                                      favs.push({ model: s.model!, modelParams: s.modelParams, label: modelSlug(s.model, s.modelParams) })
                                      await window.electronAPI.saveConfig({ favoriteModels: favs })
                                    }
                                    setModelMenuSession(null)
                                  }}
                                >
                                  ☆ 收藏当前模型
                                </button>
                              )}
                            </div>
                          )}
                        </span>
                      )}
                      {processingCount > 0 && (
                        <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-500/90 px-1 text-[10px] font-bold text-gray-900" title={`处理中 ${processingCount} 条`}>
                          {processingCount}
                        </span>
                      )}
                      {queuedCount > 0 && (
                        <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-yellow-500/90 px-1 text-[10px] font-bold text-gray-900" title={`排队中 ${queuedCount} 条`}>
                          {queuedCount}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                    <button onClick={(e) => { e.stopPropagation(); window.electronAPI.stopSessionAgent(s.sessionKey) }} className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-600/20" title="停止此会话">
                      <Square size={10} />
                    </button>
                    {deletableSessionKeys.has(s.sessionKey) && (
                      <button onClick={(e) => {
                        e.stopPropagation()
                        const tab = sessionTabs.find((t) => t.sessionKey === s.sessionKey)
                        void deleteSessionTab(s.sessionKey, tab?.kind, tab?.label || s.chatName)
                      }} className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-red-600/20 hover:text-red-400" title="删除">
                        <Trash2 size={10} />
                      </button>
                    )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="ml-4 mt-1 space-y-1 border-l-2 border-gray-700/50 pl-3">
                      {(() => {
                        const d = sessionDiag[s.sessionKey]
                        return (
                          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 rounded bg-gray-800/30 px-2.5 py-1.5 text-[10px] text-gray-500">
                            <span>来源: {s.source === "cli" ? "CLI" : "SDK"} · 启动于 {formatTimestamp(s.startedAt)}</span>
                            <span>最后回复: {d?.lastReplyAt ? formatTimestamp(d.lastReplyAt) : "—"}</span>
                            <span title={d?.resumeAgentId}>Resume 上下文: {d?.resumeAgentId ? `${d.resumeAgentId.slice(0, 14)}…（${formatTimestamp(d.resumeUpdatedAt)}）` : "无"}</span>
                            <span className={d?.lastRun?.status === "error" ? "text-red-400" : ""}>
                              上次运行: {d?.lastRun ? `${d.lastRun.status}${d.lastRun.durationMs ? ` · ${Math.round(d.lastRun.durationMs / 1000)}s` : ""} · ${formatTimestamp(d.lastRun.endedAt)}` : "—"}
                            </span>
                            {d?.lastRun?.error && <span className="col-span-2 truncate text-red-400/80" title={d.lastRun.error}>错误: {d.lastRun.error}</span>}
                            <span className="col-span-2">队列: 排队 {pendingMsgs.filter((m) => m.status !== "processing").length} · 处理中 {pendingMsgs.filter((m) => m.status === "processing").length}</span>
                          </div>
                        )
                      })()}
                      {pendingMsgs.map((msg) => (
                        <div key={msg.fileId} className="group flex items-start justify-between gap-2 rounded bg-gray-800/40 px-2.5 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className={`rounded px-1 text-[9px] ${msg.status === "processing" ? "bg-blue-600/25 text-blue-300" : "bg-gray-700/70 text-gray-400"}`}>{msg.status === "processing" ? "处理中" : "排队中"}</span>
                              <span className="text-[10px] text-gray-500">{formatTimestamp(msg.timestamp)}</span>
                            </div>
                            <p className="truncate text-xs text-gray-300">{msg.preview}</p>
                          </div>
                          <button
                            onClick={(e) => handleDeleteQueueMessage(msg.fileId, e)}
                            className="shrink-0 rounded p-0.5 text-gray-600 opacity-0 transition hover:bg-red-600/20 hover:text-red-400 group-hover:opacity-100"
                            title="删除此消息"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Queue messages */}
      {showQueue && (
        <div className="mx-6 rounded-xl border border-gray-800 bg-gray-900/80 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400">全局消息队列</span>
            <span className="text-xs text-gray-600">{queueMessages.length} 条</span>
          </div>
          {queueMessages.length === 0 ? (
            <p className="text-center text-xs text-gray-600">队列为空</p>
          ) : (
            <div className="space-y-1.5">
              {queueMessages.map((msg) => (
                <div key={msg.fileId || msg.index} className="group flex items-start justify-between gap-2 rounded-lg bg-gray-800/60 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium text-blue-400">{getSessionLabel(msg)}</span>
                      <span className={`rounded px-1 text-[9px] ${msg.status === "processing" ? "bg-blue-600/25 text-blue-300" : "bg-gray-700/70 text-gray-400"}`}>{msg.status === "processing" ? "处理中" : "排队中"}</span>
                      <span className="text-[10px] text-gray-500">{formatTimestamp(msg.timestamp)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-gray-300">{msg.preview}</p>
                  </div>
                  <button
                    onClick={(e) => handleDeleteQueueMessage(msg.fileId, e)}
                    className="shrink-0 rounded p-0.5 text-gray-600 opacity-0 transition hover:bg-red-600/20 hover:text-red-400 group-hover:opacity-100"
                    title="删除此消息"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CLI 未安装不在首页提示（Agent 资源可选 CLI 或 SDK，向导内可安装） */}
      {cliStatus === "need-login" && (
        <div className="mx-6 flex items-center justify-between rounded-lg border border-yellow-800/50 bg-yellow-950/20 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-yellow-400" />
            <span className="text-xs text-yellow-300">
              Cursor CLI 未登录 — 请完成授权后再使用自动会话等功能
            </span>
          </div>
          <button
            onClick={handleLoginOnly}
            disabled={cliLoggingIn}
            className="flex items-center gap-1.5 rounded-md bg-blue-600/20 px-3 py-1 text-xs font-medium text-blue-400 transition hover:bg-blue-600/30 disabled:opacity-50"
          >
            {cliLoggingIn ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <LogIn size={12} />
            )}
            {cliLoggingIn ? "登录中..." : "登录 Cursor"}
          </button>
        </div>
      )}
      {cliMessage && (
        <div className="mx-6 mt-1 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-2">
          <pre className="whitespace-pre-wrap font-mono text-xs text-gray-400">{cliMessage}</pre>
        </div>
      )}

      {/* Error message */}
      {actionError && (
        <div className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-300">
          <span className="min-w-0 flex-1">{actionError}</span>
          <button type="button" onClick={() => setActionError("")}
            className="shrink-0 rounded px-1 text-red-400 hover:bg-red-900/50 hover:text-red-200" title="关闭">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Logs */}
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <div className="mb-2 flex items-center justify-between gap-3 text-sm text-gray-400">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Clock size={14} className="shrink-0" />
            <span className="shrink-0">日志</span>
            <div className="relative ml-2 flex max-w-[260px] flex-1 items-center">
              <Search size={12} className="pointer-events-none absolute left-2 text-gray-600" />
              <input
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                placeholder="搜索日志..."
                className="w-full rounded-md border border-gray-800 bg-gray-900/60 py-1 pl-7 pr-7 text-xs text-gray-300 placeholder-gray-600 outline-none transition focus:border-gray-600"
              />
              {logFilter && (
                <button
                  onClick={() => setLogFilter("")}
                  className="absolute right-1.5 rounded p-0.5 text-gray-600 transition hover:text-gray-300"
                  title="清除搜索"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            {logFilter.trim() && (
              <span className="shrink-0 text-[10px] text-gray-600">{filteredLogLines.length}/{logLines.length} 条</span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => void handleExportDiagnostics()}
              disabled={exportingDiag}
              className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300 disabled:opacity-50"
              title="汇总日志、脱敏配置、会话与队列快照到单个文件，用于远程排障"
            >
              {exportingDiag ? "导出中..." : "导出诊断包"}
            </button>
            {logLines.length > 0 && (
              <button
                onClick={() => { navigator.clipboard.writeText(filteredLogLines.join("\n")) }}
                className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
                title={logFilter.trim() ? "复制当前过滤结果" : "复制全部日志"}
              >
                复制
              </button>
            )}
            {logLines.length > 0 && (
              <button
                onClick={() => setLogLines([])}
                className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
              >
                清空
              </button>
            )}
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <div
            ref={logRef}
            onScroll={handleLogScroll}
            className="h-full overflow-auto rounded-lg border border-gray-800 bg-gray-900/50 p-3 font-mono text-xs leading-5"
          >
            {filteredLogLines.length > 0
              ? filteredLogLines.map((line, i) => <LogLine key={i} line={line} highlight={logFilter.trim()} resolveLabel={resolveLogSessionLabel} />)
              : <span className="text-gray-600">{logFilter.trim() ? "无匹配日志" : "暂无日志"}</span>}
          </div>
          {!logAtBottom && (
            <button
              onClick={scrollLogToBottom}
              className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800/95 px-2.5 py-1 text-[11px] text-gray-300 shadow-lg transition hover:bg-gray-700"
              title="恢复自动滚动"
            >
              <ChevronDown size={12} />
              回到底部
            </button>
          )}
        </div>
      </div>
      {ModalPortal}
    </div>
  )
}

const LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(\w+)\] (\w+) (.*)$/

/** 与主进程 escapeLogContentSingleLine 对应：展示时把 ⏎ 标记还原为换行 */
function displayLogMessageBody(msg: string): string {
  return msg.replace(/⏎/g, "\n")
}

const LEVEL_COLORS: Record<string, string> = {
  ERROR: "text-red-400",
  WARN: "text-yellow-400",
  INFO: "text-blue-400",
  DEBUG: "text-gray-500",
}

const PROCESS_COLORS: Record<string, string> = {
  Daemon: "text-purple-400",
  Agent: "text-cyan-400",
  Electron: "text-orange-400",
  Scheduler: "text-teal-400",
}

const CHANNEL_STATUS_TEXT: Record<string, string> = {
  connected: "在线",
  connecting: "连接中",
  qr_pending: "待扫码",
  logging_in: "登录中",
  disconnected: "已断开",
  error: "错误",
}

/** 命中片段高亮渲染（大小写不敏感） */
function renderHighlighted(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  let idx: number
  while ((idx = lower.indexOf(q, i)) >= 0) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(<mark key={idx} className="rounded-sm bg-yellow-500/40 text-yellow-100">{text.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  if (parts.length === 0) return text
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

const LogLine = memo(function LogLine({ line, highlight = "", resolveLabel }: { line: string; highlight?: string; resolveLabel?: (sk: string) => string | undefined }) {
  // 存储仍是全文；仅展示缩短 sessionKey，复制/过滤仍用原始 line
  const view = formatLogLineForUi(line, resolveLabel)
  const m = LOG_RE.exec(view)
  if (!m) {
    return <div className="whitespace-pre-wrap break-all text-gray-400">{renderHighlighted(displayLogMessageBody(view), highlight)}</div>
  }
  const [, ts, proc, level, msg] = m
  const body = displayLogMessageBody(msg)
  return (
    <div className="whitespace-pre-wrap break-all" title={line.length > 120 ? line : undefined}>
      <span className="text-gray-600">{renderHighlighted(ts, highlight)}</span>
      {" "}
      <span className={PROCESS_COLORS[proc] ?? "text-gray-400"}>{renderHighlighted(`[${proc}]`, highlight)}</span>
      {" "}
      <span className={LEVEL_COLORS[level] ?? "text-gray-400"}>{renderHighlighted(level, highlight)}</span>
      {" "}
      <span className={level === "ERROR" ? "text-red-300" : level === "WARN" ? "text-yellow-300" : "text-gray-300"}>{renderHighlighted(body, highlight)}</span>
    </div>
  )
})

function StatusCard({
  icon: Icon,
  label,
  value,
  color,
  sub,
  action,
}: {
  icon: typeof Wifi
  label: string
  value: React.ReactNode
  color: "green" | "red" | "blue" | "yellow" | "gray"
  sub?: string
  action?: React.ReactNode
}) {
  const colors: Record<string, string> = {
    green: "text-green-400",
    red: "text-red-400",
    blue: "text-blue-400",
    yellow: "text-yellow-400",
    gray: "text-gray-500",
  }

  const dotColors: Record<string, string> = {
    green: "bg-green-400",
    red: "bg-red-400",
    blue: "bg-blue-400",
    yellow: "bg-yellow-400",
    gray: "bg-gray-600",
  }

  return (
    <div className="flex h-[88px] flex-col rounded-lg border border-gray-800 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={colors[color]} />
          <span className="text-xs text-gray-500">{label}</span>
        </div>
        <div className="min-w-0">{action}</div>
      </div>
      <div className="mt-auto">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 shrink-0 rounded-full ${dotColors[color]}`} />
          <span className={`text-sm font-medium ${colors[color]}`}>{value}</span>
        </div>
        <div className="mt-1 h-4 truncate text-xs text-gray-600">{sub ?? "\u00A0"}</div>
      </div>
    </div>
  )
}
