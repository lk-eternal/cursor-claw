import { useState, useEffect, useRef, useCallback, memo } from "react"
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
  Download,
  LogIn,
  AlertTriangle,
  CheckCircle2,
  Circle,
  ChevronRight,
  FolderOpen,
  Rocket,
} from "lucide-react"
import logoUrl from "../assets/logo.png"
import TitleBar from "../components/TitleBar"

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
  const [queueMessages, setQueueMessages] = useState<{ index: number; fileId: string; preview: string; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string }[]>([])
  const [showQueue, setShowQueue] = useState(false)
  const [showChannels, setShowChannels] = useState(false)
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const [cliStatus, setCliStatus] = useState<"checking" | "installed" | "missing" | "need-login">("checking")
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliLoggingIn, setCliLoggingIn] = useState(false)
  const [cliMessage, setCliMessage] = useState("")
  const [stoppingAgent, setStoppingAgent] = useState(false)
  const [clearingQueue, setClearingQueue] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [onboard, setOnboard] = useState<OnboardState | null>(null)
  const [onboardDismissed, setOnboardDismissed] = useState(false)

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
  }, [])

  // 从设置页返回时立即刷新清单状态
  useEffect(() => {
    if (active) void refreshOnboard()
  }, [active, refreshOnboard])
  const [sessionList, setSessionList] = useState<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string }[]>([])
  const logRef = useRef<HTMLPreElement>(null)

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

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logLines])

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

  const handleInstallCli = async () => {
    setCliInstalling(true)
    setCliMessage("")
    try {
      const result = await window.electronAPI.installCli()
      if (result.ok) {
        setCliStatus("need-login")
        setCliMessage("CLI 安装成功，正在打开浏览器进行授权...")
        try {
          const loginResult = await window.electronAPI.loginCli()
          if (loginResult.ok) {
            const st = await window.electronAPI.checkCliLogin()
            if (st.loggedIn) {
              setCliStatus("installed")
              setCliMessage("")
            } else {
              setCliStatus("need-login")
              setCliMessage(st.error ?? loginResult.output ?? "请重试登录")
            }
          } else {
            setCliMessage(loginResult.output)
          }
        } catch (e: unknown) {
          setCliMessage(`授权失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        setCliMessage(result.output)
      }
    } catch (e: unknown) {
      setCliMessage(e instanceof Error ? e.message : String(e))
    }
    setCliInstalling(false)
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
    if (queueMessages.length === 0) await refreshQueueMessages()
    setExpandedSession(sessionKey)
  }

  const getSessionQueueMessages = (sessionKey: string) =>
    queueMessages.filter((m) => m.sessionKey === sessionKey)

  const formatTimestamp = (ts?: number) => {
    if (!ts) return ""
    const d = new Date(ts)
    return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  }

  const getSessionLabel = (msg: { sessionKey?: string; chatType?: string }) => {
    if (!msg.sessionKey) return "未知会话"
    const parts = msg.sessionKey.split("::")
    const dir = parts[1]?.split(/[\\/]/).pop() || ""
    const chatLabel = msg.chatType === "group" ? "群聊" : msg.chatType === "task" ? "定时" : "私聊"
    return `${chatLabel}${dir ? ` 📁${dir}` : ""}`
  }

  const formatUptime = (seconds?: number): string => {
    if (!seconds) return "-"
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
  }

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
          value={status.running ? "运行中" : "已停止"}
          color={status.running ? "green" : "red"}
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
            value={String(status.queueLength ?? 0)}
            color={status.queueLength ? "yellow" : "gray"}
            sub={status.queueLength ? "点击查看详情" : "待处理消息"}
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
              const hasPending = pendingMsgs.length > 0
              const isExpanded = expandedSession === s.sessionKey
              return (
                <div key={s.sessionKey}>
                  <div
                    className={`flex items-center justify-between rounded-lg bg-gray-800/60 px-3 py-2 ${hasPending ? "cursor-pointer hover:bg-gray-800/80" : ""}`}
                    onClick={() => hasPending && toggleSessionExpand(s.sessionKey)}
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className={`h-2 w-2 rounded-full ${s.chatType === "group" ? "bg-green-400" : s.chatType === "task" ? "bg-yellow-400" : "bg-blue-400"}`} />
                      <span className="truncate text-xs text-gray-300" title={s.sessionKey}>
                        {s.chatType === "group" ? "群聊" : s.chatType === "task" ? "定时" : "私聊"} {s.chatName || (s.sessionKey.length > 20 ? s.sessionKey.slice(0, 20) + "…" : s.sessionKey)}
                        {s.workspaceDir && s.chatType === "p2p" && <span className="ml-1 text-[10px] text-gray-500" title={s.workspaceDir}>📁{s.workspaceDir.split(/[\\/]/).pop()}</span>}
                      </span>
                      <span className="text-xs text-gray-600">PID:{s.pid}</span>
                      {hasPending && (
                        <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-yellow-500/90 px-1 text-[10px] font-bold text-gray-900">
                          {pendingMsgs.length}
                        </span>
                      )}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); window.electronAPI.stopSessionAgent(s.sessionKey) }} className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-600/20" title="停止此会话">
                      <Square size={10} />
                    </button>
                  </div>
                  {isExpanded && hasPending && (
                    <div className="ml-4 mt-1 space-y-1 border-l-2 border-yellow-700/40 pl-3">
                      {pendingMsgs.map((msg) => (
                        <div key={msg.fileId} className="group flex items-start justify-between gap-2 rounded bg-gray-800/40 px-2.5 py-1.5">
                          <div className="min-w-0 flex-1">
                            <span className="text-[10px] text-gray-500">{formatTimestamp(msg.timestamp)}</span>
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

      {/* CLI Status - only show when missing */}
      {cliStatus === "missing" && (
        <div className="mx-6 flex items-center justify-between rounded-lg border border-yellow-800/50 bg-yellow-950/20 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-yellow-400" />
            <span className="text-xs text-yellow-300">
              Cursor CLI 未安装 — 无法自动拉起会话
            </span>
          </div>
          <button
            onClick={handleInstallCli}
            disabled={cliInstalling}
            className="flex items-center gap-1.5 rounded-md bg-blue-600/20 px-3 py-1 text-xs font-medium text-blue-400 transition hover:bg-blue-600/30 disabled:opacity-50"
          >
            {cliInstalling ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            {cliInstalling ? "安装中..." : "一键安装"}
          </button>
        </div>
      )}
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
        <div className="mx-6 mt-3 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-300">
          {actionError}
        </div>
      )}

      {/* Logs */}
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <div className="mb-2 flex items-center justify-between text-sm text-gray-400">
          <div className="flex items-center gap-2">
            <Clock size={14} />
            <span>日志</span>
          </div>
          <div className="flex gap-2">
            {logLines.length > 0 && (
              <button
                onClick={() => { navigator.clipboard.writeText(logLines.join("\n")) }}
                className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
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
        <div
          ref={logRef}
          className="flex-1 overflow-auto rounded-lg border border-gray-800 bg-gray-900/50 p-3 font-mono text-xs leading-5"
        >
          {logLines.length > 0 ? logLines.map((line, i) => <LogLine key={i} line={line} />) : <span className="text-gray-600">暂无日志</span>}
        </div>
      </div>
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

const LogLine = memo(function LogLine({ line }: { line: string }) {
  const m = LOG_RE.exec(line)
  if (!m) {
    return <div className="whitespace-pre-wrap break-all text-gray-400">{displayLogMessageBody(line)}</div>
  }
  const [, ts, proc, level, msg] = m
  const body = displayLogMessageBody(msg)
  return (
    <div className="whitespace-pre-wrap break-all">
      <span className="text-gray-600">{ts}</span>
      {" "}
      <span className={PROCESS_COLORS[proc] ?? "text-gray-400"}>[{proc}]</span>
      {" "}
      <span className={LEVEL_COLORS[level] ?? "text-gray-400"}>{level}</span>
      {" "}
      <span className={level === "ERROR" ? "text-red-300" : level === "WARN" ? "text-yellow-300" : "text-gray-300"}>{body}</span>
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
  value: string
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
