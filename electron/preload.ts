import { contextBridge, ipcRenderer } from "electron"
import type { WorkflowDefinition, WorkflowInstance } from "../src/shared/workflow-types"

export interface AppConfig {
  larkAppId: string
  larkAppSecret: string
  larkAppQuickCreated: boolean
  larkReceiveId: string
  workspaceDir: string
  allowOthers: boolean
  model: string
  modelParams: string
  othersModel: string
  othersModelParams: string
  taskModel: string
  taskModelParams: string
  autoStart: boolean
  setupComplete: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
  agentNewSession: boolean
  closeWindowAction: "ask" | "minimize" | "quit"
  digitalIdentity: string
  feishuEnabled: boolean
  wechatEnabled: boolean
  wechatToken: string
  wechatAccountId: string
  agentMode: "cli" | "sdk"
  cursorApiKey: string
}

export interface DaemonStatus {
  running: boolean
  version?: string
  uptime?: number
  agentRunning?: boolean
  agentPid?: number | null
  sessionAgentCount?: number
  queueLength?: number
  hasChatId?: boolean
  model?: string
  cliAvailable?: boolean
  error?: string
  workspaceMismatch?: boolean
  daemonWorkspaceDir?: string
  feishuEnabled?: boolean
  feishuConnected?: boolean
  wechatEnabled?: boolean
  wechatStatus?: string
  wechatReady?: boolean
}

export interface ConfigSaveResult {
  ok: boolean
  needWorkspaceConfirm?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  existingSessions?: { sessionKey: string; chatName?: string }[]
  deferredSetupComplete?: boolean
  workspaceDirChanged?: boolean
}

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
  independent?: boolean
}

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

export interface CliLoginStatus {
  cliFound: boolean
  loggedIn: boolean
  identityLine?: string
  error?: string
}

export type UpdaterCheckResult =
  | { status: "dev"; currentVersion: string; message: string }
  | { status: "error"; currentVersion: string; message: string }
  | { status: "latest"; currentVersion: string; latestVersion: string }
  | {
      status: "available"
      currentVersion: string
      latestVersion: string
      htmlUrl: string
      applyHint: string
      releaseNotes: string
    }
  | {
      status: "ready"
      currentVersion: string
      latestVersion: string
      htmlUrl: string
      applyHint: string
      releaseNotes: string
    }

export interface UpdaterApplyResult {
  ok: boolean
  error?: string
  message?: string
}

export type UpdaterStatusPayload =
  | { kind: "available" }
  | { kind: "downloaded"; version: string }
  | { kind: "downloading" }

export interface AppModalRequestPayload {
  requestId: string
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
  variant?: "info" | "error" | "warning"
}

export interface SkillTreeNode {
  name: string
  type: "file" | "directory"
  children?: SkillTreeNode[]
}

export interface McpServerEntry {
  name: string
  type: "command" | "url"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  source: "global" | "project"
  authenticated?: boolean
  enabled?: boolean
  rawConfig?: Record<string, unknown>
}

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("updater:current-version"),
  checkAppUpdate: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke("updater:check"),
  applyAppUpdate: (): Promise<UpdaterApplyResult> => ipcRenderer.invoke("updater:apply"),
  onUpdaterProgress: (cb: (percent: number) => void): (() => void) => {
    const handler = (_: unknown, percent: number) => cb(percent)
    ipcRenderer.on("updater:progress", handler)
    return () => ipcRenderer.removeListener("updater:progress", handler)
  },
  onUpdaterError: (cb: (message: string) => void): (() => void) => {
    const handler = (_: unknown, message: string) => cb(message)
    ipcRenderer.on("updater:error", handler)
    return () => ipcRenderer.removeListener("updater:error", handler)
  },
  onUpdaterStatus: (cb: (payload: UpdaterStatusPayload) => void): (() => void) => {
    const handler = (_: unknown, payload: UpdaterStatusPayload) => cb(payload)
    ipcRenderer.on("updater:status", handler)
    return () => ipcRenderer.removeListener("updater:status", handler)
  },
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("config:get"),
  saveConfig: (config: Partial<AppConfig>): Promise<ConfigSaveResult> => ipcRenderer.invoke("config:save", config),
  applyWorkspaceSwitch: (workspaceDir: string, stopOldSessions: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("config:apply-workspace-switch", workspaceDir, stopOldSessions),
  respondWindowClose: (payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }): Promise<void> =>
    ipcRenderer.invoke("window:close-confirm-result", payload),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectDirectory"),
  injectWorkspace: (): Promise<{ results: InjectResult[] }> => ipcRenderer.invoke("workspace:inject"),
  startDaemon: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("daemon:start"),
  stopAgent: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("agent:stop"),
  getSessionAgents: (): Promise<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string }[]> =>
    ipcRenderer.invoke("agent:sessions"),
  stopSessionAgent: (sessionKey: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("agent:stop-session", sessionKey),
  stopAllSessionAgents: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("agent:stop-all-sessions"),
  onSessionAgents: (cb: (list: { sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string }[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, list: Parameters<typeof cb>[0]) => cb(list)
    ipcRenderer.on("agent:sessions", handler)
    return () => { ipcRenderer.removeListener("agent:sessions", handler) }
  },
  stopDaemon: (): Promise<void> => ipcRenderer.invoke("daemon:stop"),
  getDaemonStatus: (): Promise<DaemonStatus> => ipcRenderer.invoke("daemon:status"),
  getLogBuffer: (): Promise<string[]> => ipcRenderer.invoke("daemon:get-log-buffer"),
  getQueueMessages: (): Promise<{ index: number; fileId: string; preview: string; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string }[]> => ipcRenderer.invoke("daemon:queue"),
  deleteQueueMessage: (fileId: string): Promise<boolean> => ipcRenderer.invoke("daemon:queue-delete", fileId),
  clearQueueMessages: (): Promise<number> => ipcRenderer.invoke("daemon:queue-clear"),
  checkCli: (): Promise<boolean> => ipcRenderer.invoke("cli:check"),
  checkCliLogin: (opts?: { forceRefresh?: boolean }): Promise<CliLoginStatus> => ipcRenderer.invoke("cli:login-status", opts),
  installCli: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("cli:install"),
  loginCli: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("cli:login"),
  listModels: (): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }> => ipcRenderer.invoke("models:list"),
  checkSdkApiKey: (): Promise<{ ok: boolean; email?: string; error?: string }> => ipcRenderer.invoke("sdk:check-api-key"),
  listSdkModels: (): Promise<{ ok: boolean; models: { id: string; label: string; params: string; current: boolean }[]; error?: string }> => ipcRenderer.invoke("sdk:list-models"),
  getScheduledTasks: (): Promise<ScheduledTask[]> => ipcRenderer.invoke("scheduled-tasks:get"),
  saveScheduledTasks: (tasks: ScheduledTask[]): Promise<{ ok: boolean }> => ipcRenderer.invoke("scheduled-tasks:save", tasks),
  validateCron: (expression: string): Promise<boolean> => ipcRenderer.invoke("scheduled-tasks:validate-cron", expression),
  previewCronNextRuns: (expression: string): Promise<{ ok: true; runs: string[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke("scheduled-tasks:preview-cron", expression),
  triggerScheduledTask: (taskId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("scheduled-tasks:trigger", taskId),
  getScheduledTaskStatus: (): Promise<Record<string, { running: boolean; pid?: number; startedAt?: number }>> =>
    ipcRenderer.invoke("scheduled-tasks:get-status"),
  onScheduledTaskStatus: (cb: (statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => void) => {
    const handler = (_: unknown, statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => cb(statuses)
    ipcRenderer.on("scheduled-tasks:status", handler)
    return () => ipcRenderer.removeListener("scheduled-tasks:status", handler)
  },
  getMcpServers: (): Promise<McpServerEntry[]> => ipcRenderer.invoke("mcp:list-all"),
  saveMcpServer: (name: string, entry: Record<string, unknown>, source: "global" | "project"): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:save", name, entry, source),
  deleteMcpServer: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:delete", name),
  loginMcp: (name: string): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:login", name),
  toggleMcp: (name: string, enabled: boolean): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:toggle", name, enabled),
  getMcpEnabledMap: (force?: boolean): Promise<Record<string, boolean>> => ipcRenderer.invoke("mcp:enabled-map", force),
  getMcpStatusMap: (force?: boolean): Promise<Record<string, string>> => ipcRenderer.invoke("mcp:status-map", force),
  getMcpTools: (name: string): Promise<{ ok: boolean; tools: { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }[]; error?: string }> => ipcRenderer.invoke("mcp:tools", name),
  getRules: (): Promise<{ name: string; content: string }[]> => ipcRenderer.invoke("rules:list"),
  saveRule: (name: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rules:save", name, content),
  deleteRule: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rules:delete", name),
  getSkills: (): Promise<{ name: string; content: string }[]> => ipcRenderer.invoke("skills:list"),
  getSkillTree: (): Promise<SkillTreeNode[]> => ipcRenderer.invoke("skills:tree"),
  readSkillFile: (skillName: string, relativePath: string): Promise<{ ok: boolean; content?: string; error?: string }> => ipcRenderer.invoke("skills:read-file", skillName, relativePath),
  saveSkillFile: (skillName: string, relativePath: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:save-file", skillName, relativePath, content),
  deleteSkillFile: (skillName: string, relativePath: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("skills:delete-file", skillName, relativePath),
  createSkillDir: (skillName: string, relativePath: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:create-dir", skillName, relativePath),
  saveSkill: (name: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:save", name, content),
    renameSkill: (oldName: string, newName: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:rename", oldName, newName),
    deleteSkill: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:delete", name),
  onMcpLoginComplete: (cb: (data: { serverName: string; ok: boolean }) => void) => {
    const handler = (_: unknown, data: { serverName: string; ok: boolean }) => cb(data)
    ipcRenderer.on("mcp:login-complete", handler)
    return () => ipcRenderer.removeListener("mcp:login-complete", handler)
  },
  startTempConnection: (appId: string, appSecret: string): Promise<{ ok: boolean; chatId?: string; error?: string }> =>
    ipcRenderer.invoke("temp-conn:start", appId, appSecret),
  stopTempConnection: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("temp-conn:stop"),
  testBind: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("bind:test"),
  testWechat: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("bind:test-wechat"),
  reloadWechat: (token: string, accountId: string): Promise<{ ok: boolean; error?: string; message?: string }> =>
    ipcRenderer.invoke("wechat:reload", token, accountId),
  onBindResult: (cb: (data: { ok: boolean; value: string }) => void) => {
    const handler = (_: unknown, data: { ok: boolean; value: string }) => cb(data)
    ipcRenderer.on("bind:result", handler)
    return () => ipcRenderer.removeListener("bind:result", handler)
  },
  onDaemonStatus: (cb: (status: DaemonStatus) => void) => {
    const handler = (_: unknown, status: DaemonStatus) => cb(status)
    ipcRenderer.on("daemon:status-update", handler)
    return () => ipcRenderer.removeListener("daemon:status-update", handler)
  },
  onDaemonLog: (cb: (line: string) => void) => {
    const handler = (_: unknown, line: string) => cb(line)
    ipcRenderer.on("daemon:log", handler)
    return () => ipcRenderer.removeListener("daemon:log", handler)
  },
  feishuRegisterApp: (): Promise<{ ok: boolean; appId?: string; appSecret?: string; error?: string }> =>
    ipcRenderer.invoke("feishu:register-app"),
  feishuRegisterAppCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("feishu:register-app-cancel"),
  onFeishuSetupQrCode: (cb: (url: string) => void) => {
    const handler = (_: unknown, url: string) => cb(url)
    ipcRenderer.on("feishu:setup-qrcode", handler)
    return () => ipcRenderer.removeListener("feishu:setup-qrcode", handler)
  },
  onFeishuSetupStatus: (cb: (status: string) => void) => {
    const handler = (_: unknown, status: string) => cb(status)
    ipcRenderer.on("feishu:setup-status", handler)
    return () => ipcRenderer.removeListener("feishu:setup-status", handler)
  },
  wechatQrLogin: (): Promise<{ ok: boolean; botToken?: string; accountId?: string; baseUrl?: string; error?: string }> =>
    ipcRenderer.invoke("wechat:qr-login"),
  wechatQrLoginCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("wechat:qr-login-cancel"),
  wechatWaitFirstMessage: (token: string, accountId: string): Promise<{ ok: boolean; chatId?: string; error?: string }> =>
    ipcRenderer.invoke("wechat:wait-first-message", token, accountId),
  wechatCancelWaitMessage: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("wechat:cancel-wait-message"),
  onWechatSetupQrCode: (cb: (url: string) => void) => {
    const handler = (_: unknown, url: string) => cb(url)
    ipcRenderer.on("wechat:setup-qrcode", handler)
    return () => ipcRenderer.removeListener("wechat:setup-qrcode", handler)
  },
  onWechatSetupStatus: (cb: (status: string) => void) => {
    const handler = (_: unknown, status: string) => cb(status)
    ipcRenderer.on("wechat:setup-status", handler)
    return () => ipcRenderer.removeListener("wechat:setup-status", handler)
  },
  onWechatStatus: (cb: (status: string) => void) => {
    const handler = (_: unknown, status: string) => cb(status)
    ipcRenderer.on("wechat:status", handler)
    return () => ipcRenderer.removeListener("wechat:status", handler)
  },
  onWechatQrCode: (cb: (dataUrl: string) => void) => {
    const handler = (_: unknown, dataUrl: string) => cb(dataUrl)
    ipcRenderer.on("wechat:qrcode", handler)
    return () => ipcRenderer.removeListener("wechat:qrcode", handler)
  },
  onWindowCloseConfirm: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on("window:close-confirm", handler)
    return () => ipcRenderer.removeListener("window:close-confirm", handler)
  },
  onAppModalRequest: (cb: (payload: AppModalRequestPayload) => void) => {
    const handler = (_: unknown, payload: AppModalRequestPayload) => cb(payload)
    ipcRenderer.on("app:modal-request", handler)
    return () => ipcRenderer.removeListener("app:modal-request", handler)
  },
  respondAppModal: (requestId: string, response: number): Promise<void> =>
    ipcRenderer.invoke("app:modal-result", { requestId, response }),

  windowMinimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  windowMaximize: (): Promise<void> => ipcRenderer.invoke("window:maximize"),
  windowClose: (): Promise<void> => ipcRenderer.invoke("window:close"),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  onWindowMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on("window:maximized-change", handler)
    return () => ipcRenderer.removeListener("window:maximized-change", handler)
  },

  // ── Workflow ──────────────────────────────────────────
  getWorkflowDefinitions: (): Promise<WorkflowDefinition[]> => ipcRenderer.invoke("workflow:list-definitions"),
  saveWorkflowDefinition: (def: WorkflowDefinition): Promise<{ ok: boolean }> => ipcRenderer.invoke("workflow:save-definition", def),
  deleteWorkflowDefinition: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("workflow:delete-definition", id),
  getWorkflowInstances: (): Promise<WorkflowInstance[]> => ipcRenderer.invoke("workflow:list-instances"),
  getWorkflowInstance: (id: string): Promise<WorkflowInstance | undefined> => ipcRenderer.invoke("workflow:get-instance", id),
  saveWorkflowInstance: (inst: WorkflowInstance): Promise<{ ok: boolean }> => ipcRenderer.invoke("workflow:save-instance", inst),
  deleteWorkflowInstance: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("workflow:delete-instance", id),
  runWorkflow: (workflowId: string, input?: string): Promise<{ ok: boolean; error?: string; instanceId?: string }> =>
    ipcRenderer.invoke("workflow:run", workflowId, input),
  onWorkflowInstanceUpdate: (cb: (inst: WorkflowInstance) => void): (() => void) => {
    const handler = (_: unknown, inst: WorkflowInstance) => cb(inst)
    ipcRenderer.on("workflow:instance-updated", handler)
    return () => ipcRenderer.removeListener("workflow:instance-updated", handler)
  },
}

contextBridge.exposeInMainWorld("electronAPI", api)

export type ElectronAPI = typeof api
