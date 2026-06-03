import { useState, useEffect, useCallback, useRef } from "react"
import {
  ChevronRight,
  ChevronLeft,
  KeyRound,
  Shield,
  Cpu,
  Rocket,
  CheckCircle2,
  Loader2,
  XCircle,
  Eye,
  EyeOff,
  RefreshCw,
  ExternalLink,
  Copy,
  FolderOpen,
  LogOut,
  SkipForward,
  ChevronDown,
  ChevronUp,
  LogIn,
  MessageSquare,
  Bird,
} from "lucide-react"
import SearchableSelect from "../components/SearchableSelect"
import TitleBar from "../components/TitleBar"
import useInlineModal from "../components/useInlineModal"
import { REQUIRED_FEISHU_SCOPES, FEISHU_SCOPES_JSON } from "../constants"

interface Props {
  onComplete: () => void
  onExit?: () => void
}

interface StepStatus {
  label: string
  status: "pending" | "running" | "done" | "error"
  message?: string
}

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

export default function Setup({ onComplete, onExit }: Props) {
  const [step, setStep] = useState(0)
  const totalSteps = 4

  // Step 0: channel selection
  const [enableFeishu, setEnableFeishu] = useState(false)
  const [enableWechat, setEnableWechat] = useState(false)

  // Feishu
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [showSecret, setShowSecret] = useState(false)
  const [showBotTip, setShowBotTip] = useState(false)
  const [showScopes, setShowScopes] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [scopesCopied, setScopesCopied] = useState(false)
  const [larkQuickCreated, setLarkQuickCreated] = useState(false)
  const [feishuQrUrl, setFeishuQrUrl] = useState("")
  const [feishuQrStatus, setFeishuQrStatus] = useState<"idle" | "loading" | "wait" | "error">("idle")
  const [feishuQrMsg, setFeishuQrMsg] = useState("")
  const [tempConnecting, setTempConnecting] = useState(false)
  const [tempConnected, setTempConnected] = useState(false)
  const [bindingStatus, setBindingStatus] = useState<"idle" | "waiting" | "bound" | "error">("idle")
  const [bindMsg, setBindMsg] = useState("")
  const [receiveId, setReceiveId] = useState("")
  const prevReceiveId = useRef("")

  // WeChat QR login
  const [wechatToken, setWechatToken] = useState("")
  const [wechatAccountId, setWechatAccountId] = useState("")
  const prevWechatToken = useRef("")
  const prevWechatAccountId = useRef("")
  const [wechatQrUrl, setWechatQrUrl] = useState("")
  const [wechatQrStatus, setWechatQrStatus] = useState<"idle" | "loading" | "wait" | "scaned" | "confirmed" | "waitmsg" | "expired" | "error">("idle")
  const [wechatQrMsg, setWechatQrMsg] = useState("")

  // Proxy
  const [proxy, setProxy] = useState("")
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1,feishu.cn")

  // Agent
  const [workspaceDir, setWorkspaceDir] = useState("")
  const [agentMode, setAgentMode] = useState<"cli" | "sdk">("cli")
  const [cursorApiKey, setCursorApiKey] = useState("")
  const [showApiKey, setShowApiKey] = useState(false)
  const [model, setModel] = useState("auto")
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [cliReady, setCliReady] = useState<boolean | null>(null)
  const [cliLoggedIn, setCliLoggedIn] = useState<boolean | null>(null)
  const [cliIdentity, setCliIdentity] = useState<string | undefined>()
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliLoggingIn, setCliLoggingIn] = useState(false)
  const [cliMsg, setCliMsg] = useState("")

  // Launch
  const [launchSteps, setLaunchSteps] = useState<StepStatus[]>([])
  const [launching, setLaunching] = useState(false)

  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const tempConnCleanupRef = useRef(false)

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      if (cfg.larkAppId) { setAppId(cfg.larkAppId); setEnableFeishu(true) }
      if (cfg.larkAppSecret) setAppSecret(cfg.larkAppSecret)
      if (cfg.larkAppQuickCreated) setLarkQuickCreated(true)
      if (cfg.workspaceDir) setWorkspaceDir(cfg.workspaceDir)
      if (cfg.model) setModel(cfg.model)
      if (cfg.httpProxy) setProxy(cfg.httpProxy)
      if (cfg.noProxy) setNoProxy(cfg.noProxy)
      if (cfg.larkReceiveId) { setReceiveId(cfg.larkReceiveId); setBindingStatus("bound") }
      if (cfg.wechatEnabled) setEnableWechat(true)
      if (cfg.wechatToken) {
        setWechatToken(cfg.wechatToken)
        setWechatQrStatus("confirmed")
      }
      if (cfg.wechatAccountId) setWechatAccountId(cfg.wechatAccountId)
      if (cfg.agentMode) setAgentMode(cfg.agentMode)
      if (cfg.cursorApiKey) setCursorApiKey(cfg.cursorApiKey)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (!tempConnCleanupRef.current) {
        tempConnCleanupRef.current = true
        window.electronAPI.stopTempConnection()
      }
    }
  }, [])

  const startTempAndBind = useCallback(async () => {
    window.electronAPI.stopTempConnection()
    setTempConnecting(true)
    setTempConnected(false)
    setBindingStatus("waiting")
    setBindMsg("正在启动临时长连接...")

    try {
      await window.electronAPI.saveConfig({ larkAppId: appId.trim(), larkAppSecret: appSecret.trim() })
      setBindMsg("临时长连接已启动，请先确保应用已发布，然后在飞书中向机器人发送任意消息完成绑定...")
      setTempConnected(true)

      const result = await window.electronAPI.startTempConnection(appId.trim(), appSecret.trim())
      setTempConnecting(false)

      if (result.ok && result.chatId) {
        setReceiveId(result.chatId)
        setBindingStatus("bound")
        setBindMsg("")
        await window.electronAPI.saveConfig({ larkReceiveId: result.chatId })
        window.electronAPI.stopTempConnection()
      } else if (prevReceiveId.current) {
        setReceiveId(prevReceiveId.current)
        setBindingStatus("bound")
        setBindMsg("")
        setTempConnected(false)
      } else {
        setBindingStatus("error")
        setBindMsg(result.error ?? "绑定失败")
        setTempConnected(false)
      }
    } catch (e: unknown) {
      setTempConnecting(false)
      setTempConnected(false)
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === "cancelled" && prevReceiveId.current) {
        setReceiveId(prevReceiveId.current)
        setBindingStatus("bound")
        setBindMsg("")
      } else if (msg === "cancelled") {
        setBindingStatus("idle")
        setBindMsg("")
      } else if (prevReceiveId.current) {
        setReceiveId(prevReceiveId.current)
        setBindingStatus("bound")
        setBindMsg("")
      } else {
        setBindingStatus("error")
        setBindMsg(msg)
      }
    }
  }, [appId, appSecret])

  const startFeishuRegisterApp = useCallback(async () => {
    setFeishuQrStatus("loading")
    setFeishuQrUrl("")
    setFeishuQrMsg("")
    const result = await window.electronAPI.feishuRegisterApp()
    if (result.ok && result.appId && result.appSecret) {
      setAppId(result.appId)
      setAppSecret(result.appSecret)
      setLarkQuickCreated(true)
      setFeishuQrStatus("idle")
      setFeishuQrUrl("")
    } else if (result.error === "cancelled") {
      setFeishuQrStatus("idle")
      setFeishuQrUrl("")
    } else {
      setFeishuQrStatus("error")
      setFeishuQrMsg(result.error ?? "创建失败")
    }
  }, [])

  useEffect(() => {
    const unsub1 = window.electronAPI.onFeishuSetupQrCode((url) => {
      setFeishuQrUrl(url)
      setFeishuQrStatus("wait")
    })
    const unsub2 = window.electronAPI.onFeishuSetupStatus(() => {})
    return () => { unsub1(); unsub2() }
  }, [])

  const startWechatQrLogin = useCallback(async () => {
    setWechatQrStatus("loading")
    setWechatQrUrl("")
    setWechatQrMsg("")
    const result = await window.electronAPI.wechatQrLogin()
    if (result.ok && result.botToken) {
      const newToken = result.botToken
      const newAccountId = result.accountId ?? ""
      setWechatToken(newToken)
      setWechatAccountId(newAccountId)
      await window.electronAPI.saveConfig({ wechatToken: newToken, wechatAccountId: newAccountId })
      setWechatQrStatus("waitmsg")
      setWechatQrMsg("")
      window.electronAPI.wechatWaitFirstMessage(newToken, newAccountId).then((r) => {
        setWechatQrStatus("confirmed")
        if (!r.ok && r.error) setWechatQrMsg(r.error)
        window.electronAPI.reloadWechat(newToken, newAccountId).catch(() => {})
      }).catch(() => { setWechatQrStatus("confirmed") })
    } else if (result.error === "cancelled") {
      if (prevWechatToken.current) {
        setWechatToken(prevWechatToken.current)
        setWechatAccountId(prevWechatAccountId.current)
        setWechatQrStatus("confirmed")
      } else {
        setWechatQrStatus("idle")
      }
    } else {
      setWechatQrStatus("error")
      setWechatQrMsg(result.error ?? "登录失败")
    }
  }, [])

  useEffect(() => {
    const unsub1 = window.electronAPI.onWechatSetupQrCode((url) => {
      setWechatQrUrl(url)
      setWechatQrStatus("wait")
    })
    const unsub2 = window.electronAPI.onWechatSetupStatus((status) => {
      if (status === "scaned") setWechatQrStatus("scaned")
    })
    return () => { unsub1(); unsub2() }
  }, [])

  const checkAndLoadCli = useCallback(async (forceRefresh = false) => {
    const ok = await window.electronAPI.checkCli()
    setCliReady(ok)
    if (ok) {
      setCliLoggedIn(null)
      setCliIdentity(undefined)
      const loginStatus = await window.electronAPI.checkCliLogin({ forceRefresh })
      setCliLoggedIn(loginStatus.loggedIn ?? false)
      setCliIdentity(loginStatus.identityLine)
      if (loginStatus.loggedIn) await fetchModels()
    }
  }, [])

  const doLoginCli = useCallback(async () => {
    setCliLoggingIn(true)
    setCliMsg("")
    try {
      const r = await window.electronAPI.loginCli()
      setCliMsg(r.output)
      if (r.ok) await checkAndLoadCli(true)
    } catch (e: unknown) {
      setCliMsg(e instanceof Error ? e.message : String(e))
    }
    setCliLoggingIn(false)
  }, [checkAndLoadCli])

  const fetchModels = async () => {
    setLoadingModels(true)
    const result = await window.electronAPI.listModels()
    if (result.ok && result.models.length > 0) setModelOptions(result.models)
    else if (result.ok) void showAlert("提示", "未解析到任何模型。请确认已登录 Cursor CLI。")
    else void showAlert("错误", result.error || "获取模型列表失败")
    setLoadingModels(false)
  }

  useEffect(() => {
    if (step === 1 && enableWechat && wechatQrStatus === "idle") {
      startWechatQrLogin()
    }
  }, [step, wechatQrStatus])

  useEffect(() => {
    if (step === 2 && agentMode === "cli" && cliReady === null) {
      checkAndLoadCli(true)
    }
  }, [step, agentMode])

  const canNext = (): boolean => {
    if (step === 0) return enableFeishu || enableWechat
    if (step === 1) {
      if (enableFeishu && (!appId.trim() || !appSecret.trim() || bindingStatus !== "bound")) return false
      if (enableWechat && wechatQrStatus !== "confirmed") return false
      return true
    }
    if (step === 2) {
      if (!workspaceDir.trim()) return false
      if (agentMode === "cli") return cliReady === true && cliLoggedIn === true
      if (agentMode === "sdk") return !!cursorApiKey.trim()
      return true
    }
    return true
  }

  const saveStepConfig = async (currentStep: number) => {
    if (currentStep === 0) {
      await window.electronAPI.saveConfig({
        wechatEnabled: enableWechat,
      })
    } else if (currentStep === 1) {
      const partial: Record<string, unknown> = {}
      if (enableFeishu) {
        partial.larkAppId = appId.trim()
        partial.larkAppSecret = appSecret.trim()
        if (receiveId) partial.larkReceiveId = receiveId
      }
      if (enableWechat && wechatToken) {
        partial.wechatToken = wechatToken.trim()
        partial.wechatAccountId = wechatAccountId.trim()
      }
      await window.electronAPI.saveConfig(partial)
    } else if (currentStep === 2) {
      await window.electronAPI.saveConfig({
        workspaceDir: workspaceDir.trim(),
        agentMode,
        cursorApiKey: cursorApiKey.trim(),
        httpProxy: proxy.trim(),
        httpsProxy: proxy.trim(),
        noProxy: noProxy.trim(),
        model,
      })
    }
  }

  const cleanupStep1 = () => {
    if (tempConnecting || tempConnected || bindingStatus === "waiting") {
      window.electronAPI.stopTempConnection()
      setTempConnecting(false)
      setTempConnected(false)
      if (prevReceiveId.current) {
        setReceiveId(prevReceiveId.current)
        setBindingStatus("bound")
      } else {
        setBindingStatus((s) => s === "bound" ? s : "idle")
      }
      setBindMsg("")
    }
    if (wechatQrStatus !== "confirmed" && wechatQrStatus !== "idle") {
      if (wechatQrStatus === "waitmsg") {
        window.electronAPI.wechatCancelWaitMessage()
        setWechatQrStatus("confirmed")
      } else {
        window.electronAPI.wechatQrLoginCancel()
        if (prevWechatToken.current) {
          setWechatToken(prevWechatToken.current)
          setWechatAccountId(prevWechatAccountId.current)
          setWechatQrStatus("confirmed")
        } else {
          setWechatQrStatus("idle")
        }
      }
      setWechatQrUrl("")
    }
  }

  const next = async () => {
    await saveStepConfig(step)
    if (step === 1) cleanupStep1()
    setStep((s) => Math.min(s + 1, totalSteps - 1))
  }
  const prev = () => {
    if (step === 1) cleanupStep1()
    setStep((s) => Math.max(s - 1, 0))
  }
  const skip = () => next()

  const selectDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setWorkspaceDir(dir)
  }

  const updateLaunchStep = (index: number, update: Partial<StepStatus>) => {
    setLaunchSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...update } : s)))
  }

  const runInjectAndFinish = async () => {
    updateLaunchStep(1, { status: "running" })
    const wsResult = await window.electronAPI.injectWorkspace()
    const summary = wsResult.results.map((r) => `${r.file}: ${r.action}`).join(", ")
    updateLaunchStep(1, { status: "done", message: summary })

    updateLaunchStep(2, { status: "running" })
    const daemonResult = await window.electronAPI.getDaemonStatus()
    if (daemonResult.running) {
      updateLaunchStep(2, { status: "done", message: "Daemon 运行中" })
    } else {
      const startResult = await window.electronAPI.startDaemon()
      if (startResult.ok) {
        updateLaunchStep(2, { status: "done", message: "Daemon 已启动" })
      } else {
        updateLaunchStep(2, { status: "error", message: startResult.error ?? "启动失败" })
        return
      }
    }
    setTimeout(onComplete, 1500)
  }

  const launch = async () => {
    setLaunching(true)
    const initialSteps: StepStatus[] = [
      { label: "保存配置", status: "pending" },
      { label: "注入工作区规则", status: "pending" },
      { label: "检查 Daemon", status: "pending" },
    ]
    setLaunchSteps(initialSteps)

    try {
      updateLaunchStep(0, { status: "running" })
      const saveR = await window.electronAPI.saveConfig({
        larkAppId: appId.trim(),
        larkAppSecret: appSecret.trim(),
        workspaceDir: workspaceDir.trim(),
        model,
        httpProxy: proxy.trim(),
        httpsProxy: proxy.trim(),
        noProxy: noProxy.trim(),
        wechatEnabled: enableWechat,
        wechatToken: wechatToken.trim(),
        wechatAccountId: wechatAccountId.trim(),
        agentMode,
        cursorApiKey: cursorApiKey.trim(),
        setupComplete: true,
      })

      if (saveR.needWorkspaceConfirm && saveR.newWorkspaceDir) {
        updateLaunchStep(0, { status: "running", message: "正在切换工作目录…" })
        const r = await window.electronAPI.applyWorkspaceSwitch(saveR.newWorkspaceDir.trim(), false)
        if (!r.ok) {
          updateLaunchStep(0, { status: "error", message: r.error ?? "切换目录失败" })
          setLaunching(false)
          return
        }
        if (saveR.deferredSetupComplete) await window.electronAPI.saveConfig({ setupComplete: true })
        setWorkspaceDir(saveR.newWorkspaceDir)
      }

      updateLaunchStep(0, { status: "done", message: "配置已加密保存" })
      await runInjectAndFinish()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setLaunchSteps((prev) => {
        const idx = prev.findIndex((s) => s.status === "running")
        if (idx >= 0) return prev.map((s, i) => (i === idx ? { ...s, status: "error" as const, message: msg } : s))
        return prev
      })
      setLaunching(false)
    }
  }

  const stepLabels = ["选择通道", "通道配置", "Agent 设置", "检查启动"]
  const stepIcons = [MessageSquare, KeyRound, Cpu, Rocket]

  return (
    <div className="flex h-screen flex-col">
      <TitleBar>
        <h1 className="text-lg font-semibold">Cursor Claw 初始设置</h1>
      </TitleBar>

      {/* Progress bar */}
      <div className="flex items-center gap-0 border-b border-gray-800 px-6 py-5">
        {stepLabels.map((label, i) => {
          const Icon = stepIcons[i]
          const active = i === step
          const done = i < step
          return (
            <div key={i} className="flex flex-1 items-center">
              <div className="flex items-center gap-1.5">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${active ? "bg-blue-600 text-white" : done ? "bg-green-600 text-white" : "bg-gray-800 text-gray-500"}`}>
                  {done ? <CheckCircle2 size={14} /> : <Icon size={14} />}
                </div>
                <span className={`text-xs ${active ? "font-medium text-white" : "text-gray-500"}`}>{label}</span>
              </div>
              {i < totalSteps - 1 && <div className={`mx-2 h-px flex-1 ${i < step ? "bg-green-600" : "bg-gray-800"}`} />}
            </div>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">

        {/* ─── Step 0: 选择通道 ─── */}
        {step === 0 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">选择消息通道</h2>
            <p className="text-sm text-gray-400">
              Cursor Claw 支持通过飞书和/或微信与 AI Agent 协作，请选择至少一个通道。
            </p>
            <div className="space-y-3">
              {([
                { key: "feishu" as const, label: "飞书", desc: "通过飞书机器人收发消息，支持私聊和群聊", icon: <Bird size={18} className="text-blue-400" /> },
                { key: "wechat" as const, label: "微信", desc: "通过微信ClawBot接入，支持私聊", icon: <MessageSquare size={18} className="text-green-400" /> },
              ]).map((ch) => {
                const enabled = ch.key === "feishu" ? enableFeishu : enableWechat
                const toggle = ch.key === "feishu" ? setEnableFeishu : setEnableWechat
                return (
                  <label
                    key={ch.key}
                    className={`flex cursor-pointer items-start gap-4 rounded-xl border px-5 py-4 transition ${enabled ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-600"}`}
                  >
                    <input type="checkbox" checked={enabled} onChange={() => toggle(!enabled)} className="mt-1 h-4 w-4 rounded border-gray-600 text-blue-600" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {ch.icon}
                        <span className="text-sm font-medium">{ch.label}</span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">{ch.desc}</p>
                    </div>
                  </label>
                )
              })}
            </div>
            {!enableFeishu && !enableWechat && (
              <p className="text-xs text-amber-400">⚠️ 请至少选择一个通道</p>
            )}
          </div>
        )}

        {/* ─── Step 1: 通道配置 ─── */}
        {step === 1 && (
          <div className="mx-auto max-w-lg space-y-6">
            <h2 className="text-xl font-semibold">通道配置</h2>

            {/* Feishu config */}
            {enableFeishu && (
              <section className="space-y-4 rounded-xl border border-gray-800 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-sm font-medium"><Bird size={16} className="text-blue-400" /> 飞书</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={startFeishuRegisterApp}
                      disabled={feishuQrStatus === "loading" || feishuQrStatus === "wait"}
                      className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2 py-1 text-xs text-blue-300 hover:bg-blue-600/20 disabled:opacity-50"
                    >
                      <LogIn size={12} />一键创建应用
                    </button>
                    <a href="https://open.feishu.cn/app?lang=zh-CN" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-400">
                      <ExternalLink size={12} />手动创建
                    </a>
                  </div>
                </div>

                {feishuQrStatus === "loading" && (
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-gray-800 py-6">
                    <Loader2 size={24} className="animate-spin text-blue-400" />
                    <p className="text-xs text-gray-400">正在生成二维码...</p>
                    <button
                      type="button"
                      onClick={async () => { await window.electronAPI.feishuRegisterAppCancel(); setFeishuQrStatus("idle"); setFeishuQrUrl("") }}
                      className="text-xs text-gray-500 hover:text-red-400"
                    >
                      取消
                    </button>
                  </div>
                )}

                {feishuQrStatus === "wait" && feishuQrUrl && (
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-blue-800/40 bg-blue-950/20 py-5">
                    <img src={feishuQrUrl} alt="Feishu QR" className="h-48 w-48 rounded bg-white p-1" />
                    <p className="text-xs text-blue-200/80">请使用飞书扫描上方二维码，按提示完成应用创建</p>
                    <button
                      type="button"
                      onClick={async () => { await window.electronAPI.feishuRegisterAppCancel(); setFeishuQrStatus("idle"); setFeishuQrUrl("") }}
                      className="text-xs text-gray-500 hover:text-red-400"
                    >
                      取消
                    </button>
                  </div>
                )}

                {feishuQrStatus === "error" && (
                  <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <XCircle size={14} className="text-red-400" />
                      <span className="text-xs font-medium text-red-300">创建失败</span>
                    </div>
                    <p className="text-xs text-red-200/70">{feishuQrMsg}</p>
                    <button type="button" onClick={startFeishuRegisterApp} className="text-xs text-blue-400 hover:underline">重试</button>
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-400">App ID</label>
                    <input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxxxxxxx" className={inputCls} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-400">App Secret</label>
                    <div className="relative">
                      <input type={showSecret ? "text" : "password"} value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="xxxxxxxxxxxxxxxx" className={inputCls + " pr-10"} />
                      <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                        {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Bot tip — 仅手动创建应用时展示 */}
                {!larkQuickCreated && <div className="rounded-lg border border-gray-800">
                  <button onClick={() => setShowBotTip(!showBotTip)} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-gray-400 hover:text-gray-200">
                    <span>💡 还没有添加机器人能力？</span>
                    {showBotTip ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  {showBotTip && (
                    <div className="border-t border-gray-800 px-3 py-2 text-xs text-gray-400 space-y-1">
                      <p>创建应用后需添加「机器人」能力。</p>
                      {appId.trim() && (
                        <a href={`https://open.feishu.cn/app/${appId.trim()}/capability`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-400 hover:underline">
                          <ExternalLink size={12} />前往添加
                        </a>
                      )}
                    </div>
                  )}
                </div>}

                {/* Permission scopes (collapsible) */}
                {!larkQuickCreated && <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <button onClick={() => setShowScopes(!showScopes)} className="flex items-center gap-1 text-xs text-gray-400 hover:text-white">
                      <ChevronRight size={12} className={`transition-transform ${showScopes ? "rotate-90" : ""}`} />
                      应用权限 ({REQUIRED_FEISHU_SCOPES.length})
                    </button>
                    <div className="flex items-center gap-2">
                      {appId.trim() && (
                        <a href={`https://open.feishu.cn/app/${appId.trim()}/auth`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400">
                          <ExternalLink size={10} />设置权限
                        </a>
                      )}
                      <button onClick={() => { navigator.clipboard.writeText(FEISHU_SCOPES_JSON); setScopesCopied(true); setTimeout(() => setScopesCopied(false), 2000) }} className="flex items-center gap-1 text-xs text-gray-500 hover:text-white">
                        <Copy size={10} />{scopesCopied ? "已复制" : "复制 JSON"}
                      </button>
                    </div>
                  </div>
                  {showScopes && (
                    <div className="rounded-lg border border-gray-800 divide-y divide-gray-800">
                      {REQUIRED_FEISHU_SCOPES.map((p) => (
                        <div key={p.scope} className="flex items-center justify-between px-3 py-1.5">
                          <code className="text-[11px] text-blue-400">{p.scope}</code>
                          <span className="text-[11px] text-gray-600">{p.desc}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>}

                {/* Event subscription (collapsible) */}
                {!larkQuickCreated && <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <button onClick={() => setShowEvents(!showEvents)} className="flex items-center gap-1 text-xs text-gray-400 hover:text-white">
                      <ChevronRight size={12} className={`transition-transform ${showEvents ? "rotate-90" : ""}`} />
                      事件订阅 (1)
                    </button>
                    {appId.trim() && (
                      <a href={`https://open.feishu.cn/app/${appId.trim()}/event`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400">
                        <ExternalLink size={10} />设置事件
                      </a>
                    )}
                  </div>
                  {showEvents && (
                    <div className="rounded-lg border border-gray-800 divide-y divide-gray-800 text-xs">
                      <div className="flex items-center justify-between px-3 py-1.5">
                        <code className="text-blue-400">im.message.receive_v1</code>
                        <span className="text-gray-600">长连接（WebSocket）</span>
                      </div>
                    </div>
                  )}
                </div>}

                {/* Publish reminder */}
                {!larkQuickCreated && <div className="flex items-center gap-1 text-xs text-gray-500">
                  <span>绑定前请确保已在飞书后台「版本管理」中创建并发布版本。</span>
                  {appId.trim() && (
                    <a href={`https://open.feishu.cn/app/${appId.trim()}/version`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-400 hover:underline">
                      <ExternalLink size={10} />前往版本管理
                    </a>
                  )}
                </div>}

                {larkQuickCreated && appId.trim() && appSecret.trim() && (
                  <p className="text-xs text-green-400/80">✓ 已通过扫码创建应用，凭据已自动填入。请向机器人发送消息完成主用户绑定。</p>
                )}

                {/* Bind status */}
                {appId.trim() && appSecret.trim() && (<>
                  {bindingStatus === "idle" && (
                    <button
                      onClick={startTempAndBind}
                      className="w-full rounded-lg border border-blue-600 bg-blue-600/20 px-4 py-2.5 text-xs font-medium text-blue-300 hover:bg-blue-600/30 transition"
                    >
                      开始绑定
                    </button>
                  )}
                  {bindingStatus === "waiting" && (
                    <div className="rounded-lg border border-blue-800/50 bg-blue-950/20 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin text-blue-400" />
                        <span className="text-xs font-medium text-blue-300">{tempConnected ? "等待绑定..." : "正在启动长连接..."}</span>
                      </div>
                      {tempConnected && <p className="text-xs text-blue-200/70">请在飞书中向机器人发送任意消息。</p>}
                      <button
                        onClick={() => window.electronAPI.stopTempConnection()}
                        className="text-xs text-gray-500 hover:text-red-400"
                      >
                        取消
                      </button>
                    </div>
                  )}
                  {bindingStatus === "bound" && (
                    <div className="flex items-center gap-3 rounded-lg border border-gray-700 px-3 py-2">
                      <CheckCircle2 size={14} className="text-green-400" />
                      <span className="flex-1 text-xs text-gray-300">已绑定 <span className="font-mono text-gray-500">{receiveId}</span></span>
                      <button
                        onClick={() => { prevReceiveId.current = receiveId; setReceiveId(""); startTempAndBind() }}
                        className="text-xs text-gray-500 hover:text-blue-400"
                      >
                        重新绑定
                      </button>
                      <span className="text-gray-700">|</span>
                      <button onClick={async () => { const r = await window.electronAPI.testBind(); if (!r.ok) void showAlert("错误", r.error || "测试失败"); else void showAlert("成功", "测试消息已发送") }} className="text-xs text-gray-500 hover:text-green-400">测试</button>
                    </div>
                  )}
                  {bindingStatus === "error" && (
                    <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-3 space-y-1">
                      <div className="flex items-center gap-2">
                        <XCircle size={14} className="text-red-400" />
                        <span className="text-xs font-medium text-red-300">连接失败</span>
                      </div>
                      <p className="text-xs text-red-200/70">{bindMsg}</p>
                      <button onClick={startTempAndBind} className="text-xs text-blue-400 hover:underline">重试</button>
                    </div>
                  )}
                </>)}
              </section>
            )}

            {/* WeChat config - QR code login */}
            {enableWechat && (
              <section className="space-y-4 rounded-xl border border-gray-800 p-5">
                <h3 className="flex items-center gap-2 text-sm font-medium"><MessageSquare size={16} className="text-green-400" /> 微信</h3>
                <p className="text-xs text-gray-400">使用手机微信扫描二维码绑定ClawBot。</p>

                {wechatQrStatus === "loading" && (
                  <div className="flex flex-col items-center gap-3 py-6">
                    <Loader2 size={32} className="animate-spin text-blue-400" />
                    <span className="text-sm text-gray-400">正在生成二维码...</span>
                    {prevWechatToken.current && (
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); setWechatToken(prevWechatToken.current); setWechatAccountId(prevWechatAccountId.current); setWechatQrStatus("confirmed"); setWechatQrUrl("") }} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                    )}
                  </div>
                )}

                {(wechatQrStatus === "wait" || wechatQrStatus === "scaned") && wechatQrUrl && (
                  <div className="flex flex-col items-center gap-3 py-2">
                    <div className="rounded-xl border border-gray-700 bg-white p-3">
                      <img src={wechatQrUrl} alt="WeChat QR" className="h-48 w-48" />
                    </div>
                    <span className="text-sm text-gray-300">
                      {wechatQrStatus === "scaned" ? "✅ 已扫码，请在手机上确认登录" : "请使用微信扫描上方二维码"}
                    </span>
                    {prevWechatToken.current && (
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); setWechatToken(prevWechatToken.current); setWechatAccountId(prevWechatAccountId.current); setWechatQrStatus("confirmed"); setWechatQrUrl("") }} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                    )}
                  </div>
                )}

                {wechatQrStatus === "waitmsg" && (
                  <div className="space-y-2 py-2">
                    <div className="flex items-center gap-2 text-xs text-green-400"><CheckCircle2 size={14} />扫码成功</div>
                    <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 size={14} className="animate-spin" />请在微信中给机器人发送一条消息以完成绑定...</div>
                    <button onClick={async () => { await window.electronAPI.wechatCancelWaitMessage(); setWechatQrStatus("confirmed") }} className="text-xs text-gray-500 hover:text-red-400">跳过</button>
                  </div>
                )}

                {wechatQrStatus === "confirmed" && (
                  <div className="flex items-center gap-3 rounded-lg border border-gray-700 px-3 py-2">
                    <CheckCircle2 size={14} className="text-green-400" />
                    <span className="flex-1 text-xs text-gray-300">已绑定{wechatAccountId && <span className="ml-1 font-mono text-gray-500">{wechatAccountId}</span>}</span>
                    <button onClick={() => { prevWechatToken.current = wechatToken; prevWechatAccountId.current = wechatAccountId; setWechatQrStatus("idle"); setWechatToken(""); setWechatQrUrl("") }} className="text-xs text-gray-500 hover:text-blue-400">重新绑定</button>
                    <span className="text-gray-700">|</span>
                    <button onClick={async () => { const r = await window.electronAPI.testWechat(); if (!r.ok) void showAlert("提示", r.error || "测试失败"); else void showAlert("成功", "测试消息已发送") }} className="text-xs text-gray-500 hover:text-green-400">测试</button>
                  </div>
                )}

                {wechatQrStatus === "expired" && (
                  <div className="flex flex-col items-center gap-3 py-4">
                    <XCircle size={24} className="text-yellow-400" />
                    <p className="text-sm text-yellow-300">二维码已过期</p>
                    <button onClick={() => { setWechatQrStatus("idle"); setWechatQrUrl("") }} className="rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-300 hover:bg-gray-800">
                      <RefreshCw size={12} className="mr-1 inline" />重新生成
                    </button>
                  </div>
                )}

                {wechatQrStatus === "error" && (
                  <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <XCircle size={14} className="text-red-400" />
                      <span className="text-xs font-medium text-red-300">登录失败</span>
                    </div>
                    <p className="text-xs text-red-200/70">{wechatQrMsg}</p>
                    <button onClick={() => { setWechatQrStatus("idle"); setWechatQrUrl("") }} className="text-xs text-blue-400 hover:underline">重试</button>
                  </div>
                )}
              </section>
            )}

            {!enableFeishu && !enableWechat && (
              <div className="rounded-lg border border-gray-800 p-8 text-center">
                <p className="text-sm text-gray-500">请返回上一步选择至少一个通道。</p>
              </div>
            )}
          </div>
        )}

        {/* ─── Step 2: Agent 设置 ─── */}
        {step === 2 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">Agent 设置</h2>
            <p className="text-sm text-gray-400">配置工作目录、Agent 驱动模式和网络代理。</p>

            {/* 工作目录 */}
            <div>
              <label className="mb-1 block text-sm text-gray-300">工作目录</label>
              <div onClick={selectDir} className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-gray-600 p-4 transition hover:border-blue-500 hover:bg-gray-900/50">
                <FolderOpen size={24} className="text-blue-400" />
                {workspaceDir ? (
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{workspaceDir.split(/[/\\]/).pop()}</div>
                    <div className="truncate text-xs text-gray-500">{workspaceDir}</div>
                  </div>
                ) : (
                  <span className="text-sm text-gray-400">点击选择目录...</span>
                )}
              </div>
            </div>

            {/* Agent 驱动模式 */}
            <div className="border-t border-gray-800 pt-4 space-y-3">
              <h3 className="text-sm font-medium text-gray-400">Agent 驱动模式</h3>
              <div className="space-y-2">
                {([
                  { v: "cli" as const, t: "Cursor CLI", d: "通过命令行工具驱动 Agent（经典模式）" },
                  { v: "sdk" as const, t: "Cursor SDK", d: "通过 @cursor/sdk 直接驱动 Agent（实验性）" },
                ]).map((opt) => (
                  <label
                    key={opt.v}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition ${agentMode === opt.v ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-600"}`}
                  >
                    <input type="radio" name="agentMode" checked={agentMode === opt.v} onChange={() => setAgentMode(opt.v)} className="mt-1" />
                    <div>
                      <p className="text-sm font-medium">{opt.t}</p>
                      <p className="text-xs text-gray-500">{opt.d}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* CLI specific */}
            {agentMode === "cli" && (
              <div className="border-t border-gray-800 pt-4 space-y-3">
                <h3 className="text-sm font-medium text-gray-400">CLI 状态</h3>
                {cliReady === null && (
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <Loader2 size={14} className="animate-spin" />正在检测 Cursor CLI...
                  </div>
                )}
                {cliReady === false && (
                  <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-3">
                    <p className="text-sm text-yellow-300">Cursor CLI 未安装。</p>
                    <button
                      onClick={async () => { setCliInstalling(true); setCliMsg(""); const r = await window.electronAPI.installCli(); setCliMsg(r.output); if (r.ok) await checkAndLoadCli(true); setCliInstalling(false) }}
                      disabled={cliInstalling}
                      className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                    >
                      {cliInstalling ? <Loader2 size={14} className="animate-spin" /> : null}
                      {cliInstalling ? "安装中..." : "一键安装 CLI"}
                    </button>
                    {cliMsg && <pre className="text-xs text-gray-400 whitespace-pre-wrap">{cliMsg}</pre>}
                  </div>
                )}
                {cliReady && cliLoggedIn === null && (
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <Loader2 size={14} className="animate-spin" />正在检查登录状态...
                  </div>
                )}
                {cliReady && cliLoggedIn === false && (
                  <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-3">
                    <p className="text-sm text-yellow-300">CLI 已安装但尚未登录。</p>
                    <div className="flex items-center gap-2">
                      <button onClick={doLoginCli} disabled={cliLoggingIn} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
                        {cliLoggingIn ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                        {cliLoggingIn ? "登录中..." : "登录 CLI"}
                      </button>
                      <button onClick={() => checkAndLoadCli(true)} className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800">
                        <RefreshCw size={14} />重新检测
                      </button>
                    </div>
                    {cliMsg && <pre className="text-xs text-gray-400 whitespace-pre-wrap">{cliMsg}</pre>}
                  </div>
                )}
                {cliReady && cliLoggedIn && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm text-green-400"><CheckCircle2 size={16} />CLI 已就绪（已登录）</div>
                      <div className="flex items-center gap-1">
                        <button onClick={doLoginCli} disabled={cliLoggingIn} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-400 hover:bg-gray-800 disabled:opacity-50">
                          {cliLoggingIn ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
                          {cliLoggingIn ? "登录中..." : "重新登录"}
                        </button>
                        <button onClick={() => checkAndLoadCli(true)} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-800">
                          <RefreshCw size={12} />刷新
                        </button>
                      </div>
                    </div>
                    {cliIdentity && <p className="text-xs text-gray-400 ml-6">{cliIdentity}</p>}
                    <button onClick={fetchModels} disabled={loadingModels} className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50">
                      {loadingModels ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}刷新模型列表
                    </button>
                    {modelOptions.length > 0 ? (
                      <SearchableSelect value={model} onChange={setModel} options={modelOptions} placeholder="选择模型..." />
                    ) : (
                      <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" className={inputCls} />
                    )}
                    <p className="text-xs text-gray-500">也可以直接输入模型名称。</p>
                  </div>
                )}
              </div>
            )}

            {/* SDK specific */}
            {agentMode === "sdk" && (
              <div className="border-t border-gray-800 pt-4 space-y-3">
                <h3 className="text-sm font-medium text-gray-400">Cursor API Key</h3>
                <div className="relative">
                  <input type={showApiKey ? "text" : "password"} value={cursorApiKey} onChange={(e) => setCursorApiKey(e.target.value)} placeholder="crsr_..." className={inputCls + " pr-10"} />
                  <button type="button" onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <p className="text-xs text-gray-600">
                  从{" "}
                  <a href="https://cursor.com/dashboard/integrations" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Cursor Dashboard</a>
                  {" "}获取 API Key。
                </p>
              </div>
            )}

            {/* 代理设置 */}
            <div className="border-t border-gray-800 pt-4">
              <h3 className="mb-3 text-sm font-medium text-gray-400">代理设置（可选）</h3>
              <div>
                <label className="mb-1 block text-xs text-gray-500">HTTP / HTTPS 代理</label>
                <input type="text" value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://127.0.0.1:1080" className={inputCls} />
              </div>
              <div className="mt-3">
                <label className="mb-1 block text-xs text-gray-500">NO_PROXY</label>
                <input type="text" value={noProxy} onChange={(e) => setNoProxy(e.target.value)} placeholder="localhost,127.0.0.1,feishu.cn" className={inputCls} />
              </div>
            </div>
          </div>
        )}

        {/* ─── Step 3: 检查启动 ─── */}
        {step === 3 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">配置完成</h2>
            <p className="text-sm text-gray-400">
              点击下方按钮保存配置、注入工作区规则并完成启动。
            </p>

            {launchSteps.length > 0 ? (
              <div className="space-y-3">
                {launchSteps.map((s, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-gray-800 px-4 py-3">
                    {s.status === "pending" && <div className="h-5 w-5 rounded-full border-2 border-gray-700" />}
                    {s.status === "running" && <Loader2 size={20} className="animate-spin text-blue-400" />}
                    {s.status === "done" && <CheckCircle2 size={20} className="text-green-400" />}
                    {s.status === "error" && <XCircle size={20} className="text-red-400" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{s.label}</div>
                      {s.message && <div className="truncate text-xs text-gray-500">{s.message}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <button
                onClick={launch}
                disabled={launching}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
              >
                <Rocket size={18} />一键注入并启动
              </button>
            )}
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between border-t border-gray-800 px-8 py-4">
        <div className="flex items-center gap-2">
          {onExit && (
            <button onClick={onExit} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-500 transition hover:text-gray-300">
              <LogOut size={14} />退出引导
            </button>
          )}
          {step > 0 && (
            <button onClick={prev} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-400 transition hover:text-white">
              <ChevronLeft size={16} />上一步
            </button>
          )}
        </div>

        {step < totalSteps - 1 ? (
          <div className="flex items-center gap-2">
            <button onClick={skip} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-500 transition hover:text-gray-300">
              <SkipForward size={14} />跳过
            </button>
            <button onClick={next} disabled={!canNext()} className="flex items-center gap-1 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">
              下一步<ChevronRight size={16} />
            </button>
          </div>
        ) : (
          <button onClick={async () => { await window.electronAPI.saveConfig({ setupComplete: true }); onComplete() }} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-500 transition hover:text-gray-300">
            <SkipForward size={14} />跳过
          </button>
        )}
      </div>
      {ModalPortal}
    </div>
  )
}
