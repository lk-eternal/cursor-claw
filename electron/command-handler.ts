import { randomUUID } from "node:crypto"
import {
  getConfig, getAgentResource, updateChannel,
  resolveChannelForSession, effectiveWorkspaceDir, type MessageChannel, type ScheduledTask,
} from "./config-store"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { broadcastLog } from "./ui-logger"
import { applyProxyEnv, execAgentSync } from "./agent-cli"
import { listSdkModels, switchSdkSessionModel, getSdkSessionList, hasResumableSdkSession, isSdkSessionRunning } from "./agent-sdk"
import { listQuickModels, getSessionOverride, type ModelEntry } from "../src/shared/session-model-store.js"
import { resolveModelLabel, rememberModelLabel } from "../src/shared/model-utils.js"
import { McpServerEntry, getMcpServerList, getMcpEnabledMap, toggleMcpServer, deleteMcpServer, saveMcpServer } from "./mcp-manager"
import { httpPost } from "./daemon-client"
import { deleteDefinition, getDefinition, listDefinitions, listInstances } from "./workflow-file"
import { runWorkflowDefinition } from "./workflow-runner"
import type { WorkflowDefinition } from "../src/shared/workflow-types"

// ── 共享类型与工具 ─────────────────────────────────────────

export interface FileCommand { id: string; command: string; messageId: string; chatId?: string; chatType?: string }

export interface CommandButton { label: string; cmd: string; /** 分组标题（飞书插在按钮前，微信列表分段） */ section?: string }

export async function reportCommandResult(port: number, messageId: string, ok: boolean, message: string, chatId?: string, buttons?: CommandButton[]): Promise<void> {
  try {
    await httpPost(`http://127.0.0.1:${port}/cmd/result`, { messageId, ok, message, chatId, buttons })
  } catch (e: unknown) {
    broadcastLog(`指令结果回报失败: ${e instanceof Error ? e.message : e}`, "WARN")
  }
}


// ── Model 命令 ─────────────────────────────────────────────

export type ListedModel = { id: string; label: string; current: boolean; params?: string }

export function parseListModelsStdout(out: string): ListedModel[] {
  const cleaned = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "")
  const models: ListedModel[] = []
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || /^available models/i.test(trimmed)) continue
    const match = trimmed.match(/^(\S+)\s+[–—-]\s+(.+?)(\s+\((?:default|current)\))?\s*$/)
    if (match) {
      models.push({ id: match[1], label: match[2].trim(), current: !!match[3] })
    }
  }
  return models
}

async function listCursorModelsForCommands(channel?: MessageChannel): Promise<{ ok: true; models: ListedModel[] } | { ok: false; error: string }> {
  const resource = getAgentResource(channel?.agentResourceId)
  if (resource.type === "sdk") {
    const r = await listSdkModels(resource.apiKey ?? "", channel?.model, channel?.modelParams)
    if (!r.ok) return { ok: false, error: r.error || "SDK 获取模型列表失败" }
    return { ok: true, models: r.models }
  }
  const config = getConfig()
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
  applyProxyEnv(env, config)
  const ws = config.workspaceDir?.trim() || undefined
  const run = execAgentSync(["--list-models"], env, { timeoutMs: 30_000, logLabel: "list-models-cmd", cwd: ws })
  if (!run.ok) {
    return { ok: false, error: run.error || run.stderr.trim() || "获取模型列表失败" }
  }
  const models = parseListModelsStdout(run.stdout)
  if (models.length === 0) {
    return { ok: false, error: "未解析到任何模型，请检查 agent --list-models 输出格式是否变化" }
  }
  return { ok: true, models }
}

const MODEL_SUBCMD_HELP = [
  "💡 /m 子命令（切换仅影响本会话，不改通道默认；全称 /model）",
  "🔹 /m ls — 列出可用模型与序号",
  "🔹 /m info — 查看本会话有效模型 / 通道默认",
  "🔹 /m set <序号> — 按 /m ls 的 # 切换本会话模型",
  "🔹 /m use <序号|id> — 同 set（快捷按钮用）",
].join("\n")

function resolveModelSessionKey(chatId?: string, channel?: MessageChannel): string | undefined {
  if (!chatId) return undefined
  const live = getSdkSessionList().find((s) => s.sessionKey === chatId || s.sessionKey.startsWith(chatId + "::"))
  if (live) return live.sessionKey
  const ws = effectiveWorkspaceDir(channel)
  return ws ? `${chatId}::${ws}` : chatId
}

async function applySessionModelPick(
  port: number,
  messageId: string,
  channel: MessageChannel,
  chatId: string | undefined,
  picked: ListedModel,
  idxLabel?: string,
): Promise<void> {
  const sessionKey = resolveModelSessionKey(chatId, channel)
  if (!sessionKey) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话（缺少 chatId）", chatId)
    return
  }
  const r = await switchSdkSessionModel(sessionKey, picked.id, picked.params ?? "")
  if (!r.ok) {
    await reportCommandResult(port, messageId, false, `❌ 切换失败: ${r.error}`, chatId)
    return
  }
  const display = resolveModelLabel(picked.id, picked.params, picked.label) || picked.id
  if (picked.label) rememberModelLabel(picked.id, picked.params, picked.label)
  const lines = [
    r.deferred
      ? `✅ 已记下本会话模型（会话未拉起，下次唤醒生效）`
      : `✅ 本会话已切换模型（Resume 保留上下文）`,
    idxLabel ? ` # · ${idxLabel}` : undefined,
    `🧠 ${display}`,
    `session · ${sessionKey}`,
    `通道默认仍为 · ${resolveModelLabel(channel.model, channel.modelParams) || channel.model?.trim() || "auto"}（未改）`,
  ].filter(Boolean) as string[]
  await reportCommandResult(port, messageId, true, lines.join("\n"), chatId)
}

export async function handleFeishuModelCommand(port: number, messageId: string, raw: string, chatId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  const channel = chatId ? resolveChannelForSession(chatId) : undefined
  if (!channel) {
    await reportCommandResult(port, messageId, false, "❌ 未找到当前会话所属的消息通道", chatId)
    return
  }

  if (parts.length <= 1) {
    const favs = (getConfig().favoriteModels ?? []) as ModelEntry[]
    const quick = listQuickModels(favs, 6)
    const subBtns = [
      { label: "/m ls", cmd: "/m ls" },
      { label: "/m info", cmd: "/m info" },
    ]
    const favBtns = quick.map((m, i) => {
      const slug = resolveModelLabel(m.model, m.modelParams, m.label) || m.model
      return { label: `⚡ ${slug}`.slice(0, 40), cmd: `/m use q${i + 1}` }
    })
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP, chatId, [...subBtns, ...favBtns])
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP, chatId)
    return
  }

  if (sub === "info") {
    const sessionKey = resolveModelSessionKey(chatId, channel)
    const cfgDisplay = resolveModelLabel(channel.model, channel.modelParams) || channel.model?.trim() || "auto"
    const ov = sessionKey ? getSessionOverride(sessionKey) : undefined
    const ovDisplay = ov ? resolveModelLabel(ov.model, ov.modelParams) : undefined
    const lines: string[] = [
      `📝 通道「${channel.name}」默认主模型: ${cfgDisplay}`,
      sessionKey ? `会话: ${sessionKey}` : "会话: （未知）",
      ovDisplay ? `本会话 override: ${ovDisplay}` : "本会话 override: （无）",
      sessionKey && (isSdkSessionRunning(sessionKey) || hasResumableSdkSession(sessionKey))
        ? "状态: 可 Resume / 运行中"
        : "状态: 未拉起（切换将记为下次唤醒生效）",
    ]
    await reportCommandResult(port, messageId, true, lines.join("\n"), chatId)
    return
  }

  if (sub === "ls") {
    const lr = await listCursorModelsForCommands(channel)
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`, chatId)
      return
    }
    const blocks = lr.models.map((m, i) => {
      const n = i + 1
      const tag = m.current ? "  ⭐current" : ""
      const display = resolveModelLabel(m.id, m.params, m.label) || m.label || m.id
      return `#${n}  ${display}${tag}`
    })
    const body = [`🧠 模型列表（共 ${lr.models.length} 个）`, "", ...blocks, "", "💡 仅本会话：/m set <序号>"].join("\n")
    const btns = lr.models.slice(0, 6).map((m, i) => {
      const cmd = `/m set ${i + 1}`
      const display = resolveModelLabel(m.id, m.params, m.label) || m.label || m.id
      return { label: `#${i + 1} ${display}`.slice(0, 40), cmd }
    })
    await reportCommandResult(port, messageId, true, body, chatId, btns)
    return
  }

  if (sub === "set" || sub === "use") {
    if (parts.length < 3) {
      await reportCommandResult(port, messageId, false, `💡 用法：/m ${sub} <序号|id|qN>`, chatId)
      return
    }
    const token = parts[2]
    const qMatch = /^q(\d+)$/i.exec(token)
    if (qMatch) {
      const favs = (getConfig().favoriteModels ?? []) as ModelEntry[]
      const quick = listQuickModels(favs, 20)
      const qi = parseInt(qMatch[1], 10)
      if (qi < 1 || qi > quick.length) {
        await reportCommandResult(port, messageId, false, `😅 常用模型序号须为 1～${quick.length}（先 /m）`, chatId)
        return
      }
      const fromQuick = quick[qi - 1]
      const picked: ListedModel = {
        id: fromQuick.model,
        label: resolveModelLabel(fromQuick.model, fromQuick.modelParams, fromQuick.label) || fromQuick.model,
        current: false,
        params: fromQuick.modelParams,
      }
      await applySessionModelPick(port, messageId, channel, chatId, picked, `q${qi}`)
      return
    }
    const lr = await listCursorModelsForCommands(channel)
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`, chatId)
      return
    }
    const idx = parseInt(token, 10)
    let picked: ListedModel | undefined
    let idxLabel: string | undefined
    if (Number.isInteger(idx) && idx >= 1 && String(idx) === token) {
      if (idx > lr.models.length) {
        await reportCommandResult(port, messageId, false, `😅 序号须为 1～${lr.models.length} 之间的整数（先 /m ls）`, chatId)
        return
      }
      picked = lr.models[idx - 1]
      idxLabel = String(idx)
    } else {
      picked = lr.models.find((m) => {
        const slug = resolveModelLabel(m.id, m.params, m.label)
        return m.id === token || m.id.startsWith(token) || slug === token || m.label === token
      })
      if (!picked) {
        const favs = (getConfig().favoriteModels ?? []) as ModelEntry[]
        const fromQuick = listQuickModels(favs, 20).find((m) => {
          const slug = resolveModelLabel(m.model, m.modelParams, m.label) || m.model
          return m.model === token || slug === token
        })
        if (fromQuick) {
          picked = {
            id: fromQuick.model,
            label: resolveModelLabel(fromQuick.model, fromQuick.modelParams, fromQuick.label) || fromQuick.model,
            current: false,
            params: fromQuick.modelParams,
          }
        }
      }
      if (!picked) {
        await reportCommandResult(port, messageId, false, `😅 未找到模型: ${token}（先 /m ls）`, chatId)
        return
      }
    }
    const pIdx = parts.indexOf("--params")
    if (pIdx >= 0 && parts[pIdx + 1] !== undefined) {
      picked = { ...picked, params: parts.slice(pIdx + 1).join(" ") }
    } else if (!picked.params) {
      const favs = (getConfig().favoriteModels ?? []) as ModelEntry[]
      const hit = listQuickModels(favs, 20).find((m) => m.model === picked!.id)
      if (hit?.modelParams) picked = { ...picked, params: hit.modelParams }
    }
    await applySessionModelPick(port, messageId, channel, chatId, picked, idxLabel)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${MODEL_SUBCMD_HELP}`, chatId)
}

// ── Task 命令 ──────────────────────────────────────────────

const TASK_SUBCMD_HELP = [
  "💡 /t 子命令（全称 /task）",
  "🔹 /t ls — 列出所有任务",
  "🔹 /t info <序号> — 查看详情",
  "🔹 /t run <序号> — 立即触发一次",
  "🔹 /t stop <序号> — 停止任务",
  "🔹 /t start <序号> — 启动任务",
  "🔹 /t delete <序号> — 删除任务",
  "🔹 /t create <名称> <cron> <内容> — 创建任务",
  "🔹 /t update <序号> [-name 值] [-cron 值] [-content 值] — 更新任务",
].join("\n")

function parseTaskOneBasedIndex(s: string | undefined): number | null {
  if (s === undefined || s === "") return null
  const n = parseInt(s, 10)
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

function parseTaskCreateArgs(parts: string[]):
  | { ok: true; name: string; cron: string; content: string }
  | { ok: false; error: string } {
  const afterCreate = parts.slice(2)
  if (afterCreate.length < 1 + 5 + 1) {
    return { ok: false, error: "❌ 参数不足：/t create <名称> <cron五或六段> <内容>" }
  }
  for (const cronLen of [6, 5] as const) {
    if (afterCreate.length < cronLen + 2) continue
    for (let nameLen = 1; nameLen <= afterCreate.length - cronLen - 1; nameLen++) {
      const name = afterCreate.slice(0, nameLen).join(" ").trim()
      if (!name) continue
      const cronToks = afterCreate.slice(nameLen, nameLen + cronLen)
      const cronExpr = cronToks.join(" ").trim()
      if (!validateCron(cronExpr)) continue
      const content = afterCreate.slice(nameLen + cronLen).join(" ").trim()
      if (!content) return { ok: false, error: "任务内容不能为空" }
      return { ok: true, name, cron: cronExpr, content }
    }
  }
  return { ok: false, error: "无法解析：请保证「名称」「cron（连续 5 或 6 段）」「内容」三部分，且 cron 能通过校验" }
}

function parseTaskUpdateArgs(parts: string[]):
  | { ok: true; oneBasedIndex: number; updates: { name?: string; cron?: string; content?: string } }
  | { ok: false; error: string } {
  if (parts.length < 4) {
    return { ok: false, error: "💡 用法：/t update <序号> [-name 值] [-cron 值] [-content 值]" }
  }
  const idx = parseTaskOneBasedIndex(parts[2])
  if (idx === null) return { ok: false, error: "❌ 序号须为正整数" }
  const known = new Set(["-name", "-cron", "-content"])
  let i = 3
  const updates: { name?: string; cron?: string; content?: string } = {}
  while (i < parts.length) {
    const flag = parts[i].toLowerCase()
    if (!known.has(flag)) {
      return { ok: false, error: `❌ 未知选项: ${parts[i]}（仅支持 -name -cron -content）` }
    }
    i++
    const valBuf: string[] = []
    while (i < parts.length) {
      const t = parts[i]
      if (t.startsWith("-") && known.has(t.toLowerCase())) break
      valBuf.push(t)
      i++
    }
    if (valBuf.length === 0) return { ok: false, error: `❌ ${flag} 缺少取值` }
    const val = valBuf.join(" ").trim()
    if (flag === "-name") updates.name = val
    else if (flag === "-cron") updates.cron = val
    else updates.content = val
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "❌ 至少指定一项：-name / -cron / -content" }
  }
  return { ok: true, oneBasedIndex: idx, updates }
}

const TASK_PREVIEW_BULLETS = ["①", "②", "③", "④", "⑤"] as const
function taskPreviewBullet(i: number): string { return TASK_PREVIEW_BULLETS[i] ?? `${i + 1}.` }
function formatTaskStatusLine(enabled: boolean): string { return enabled ? "✅ 运行中" : "⏸️ 已停止" }

export type TaskRunFn = (task: ScheduledTask, content: string) => Promise<{ ok: boolean; error?: string }>
export type TaskEnqueueFn = (content: string, chatId?: string) => Promise<{ ok: boolean; error?: string }>

export async function handleFeishuTaskCommand(
  port: number, messageId: string, raw: string, taskRunFn: TaskRunFn, chatId?: string, taskEnqueueFn?: TaskEnqueueFn,
): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  const taskHelpBtns = [
    { label: "/t ls", cmd: "/t ls" },
  ]
  if (parts.length <= 1) { await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP, chatId, taskHelpBtns); return }
  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") { await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP, chatId, taskHelpBtns); return }

  let tasks = readTasksFromFile()

  if (sub === "ls") {
    if (tasks.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 当前还没有定时任务～\n\n💡 需要的话可以用：\n   /t create <名称> <cron> <内容>", chatId)
      return
    }
    const blocks = tasks.map((t, i) => {
      const n = i + 1
      return [
        "┈┈┈┈┈┈┈┈┈┈",
        `#${n}\t📋 名称 · ${t.name}`,
        `\t💠 状态 · ${formatTaskStatusLine(t.enabled)}`,
        `\t🔄 Cron · ${t.cron}`,
        `\t⏱️ 下次 · ${t.enabled ? getNextCronFireLabel(t.cron) : "-"}`
      ].join("\n")
    })
    const header = `⏰ 定时任务一览（共 ${tasks.length} 条）`
    await reportCommandResult(port, messageId, true, `${header}\n\n${blocks.join("\n\n")}\n\n✨ 看某条详情：/t info <序号>`, chatId)
    return
  }

  if (sub === "info") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t info <序号>（数字见 /t ls 的 #）", chatId); return }
    if (tasks.length === 0) { await reportCommandResult(port, messageId, false, "📭 还没有任何任务，先用 /t ls 确认一下吧～", chatId); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（当前共 ${tasks.length} 条）`, chatId); return }
    const t = tasks[idx - 1]
    let scheduleSection = ""
    const prev = previewCronNextRuns(t.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    }
    const body = [
      `📋 任务详情  #${idx}`, "",
      `📝 名称 · ${t.name}`,
      `💠 状态 · ${formatTaskStatusLine(t.enabled)}`,
      `🔄 Cron · ${t.cron}`,
      scheduleSection, "",
      "✉️ 任务内容", "────────────", t.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body, chatId)
    return
  }

  if (sub === "run") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t run <序号>（数字见 /t ls 的 #）", chatId); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId); return }
    const t = tasks[idx - 1]
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${t.name}] (手动触发: ${nowStr})\n\n${t.content}`
    if (t.independent !== false) {
      const result = await taskRunFn(t, content)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已独立启动任务 #${idx} ${t.name}`, chatId)
      } else {
        await reportCommandResult(port, messageId, false, `❌ 独立启动失败: ${result.error}`, chatId)
      }
    } else {
      const enqueue = taskEnqueueFn ?? (async (c) => {
        await httpPost(`http://127.0.0.1:${port}/enqueue`, { content: c, chatId, chatType: chatId ? "p2p" : undefined })
        return { ok: true }
      })
      const result = await enqueue(content, chatId)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已手动触发任务 #${idx} ${t.name}`, chatId)
      } else {
        await reportCommandResult(port, messageId, false, `❌ 触发失败: ${result.error}`, chatId)
      }
    }
    return
  }

  if (sub === "stop") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t stop <序号>（数字见 /t ls 的 #）", chatId); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId); return }
    const name = tasks[idx - 1].name
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: false } : t))
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `⏸️ 已停止任务 #${idx} ${name}`, chatId)
    return
  }

  if (sub === "start") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t start <序号>（数字见 /t ls 的 #）", chatId); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId); return }
    const name = tasks[idx - 1].name
    const cron = tasks[idx - 1].cron
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: true } : t))
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(cron)
    await reportCommandResult(port, messageId, true, `✅ 已启动任务 #${idx} ${name}\n下次执行: ${next}`, chatId)
    return
  }

  if (sub === "delete") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t delete <序号>（数字见 /t ls 的 #）", chatId); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId); return }
    const name = tasks[idx - 1].name
    tasks = tasks.filter((_, j) => j !== idx - 1)
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `🗑️ 已删除任务 #${idx} ${name}`, chatId)
    return
  }

  if (sub === "create") {
    const parsed = parseTaskCreateArgs(parts)
    if (!parsed.ok) { await reportCommandResult(port, messageId, false, parsed.error, chatId); return }
    const taskChannel = chatId ? resolveChannelForSession(chatId) : undefined
    if (!taskChannel) {
      await reportCommandResult(port, messageId, false, "❌ 未找到当前会话所属的消息通道，无法创建任务", chatId)
      return
    }
    const newTask: ScheduledTask = { id: randomUUID(), name: parsed.name, cron: parsed.cron, content: parsed.content, enabled: true, channelId: taskChannel.id }
    tasks = [...tasks, newTask]
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(parsed.cron)
    await reportCommandResult(port, messageId, true, `✅ 已创建并启动：${parsed.name}\n下次执行: ${next}`, chatId)
    return
  }

  if (sub === "update") {
    const pu = parseTaskUpdateArgs(parts)
    if (!pu.ok) { await reportCommandResult(port, messageId, false, pu.error, chatId); return }
    if (pu.oneBasedIndex > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${pu.oneBasedIndex} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId)
      return
    }
    const t = tasks[pu.oneBasedIndex - 1]
    let nextName = t.name, nextCron = t.cron, nextContent = t.content
    if (pu.updates.name !== undefined) nextName = pu.updates.name
    if (pu.updates.cron !== undefined) nextCron = pu.updates.cron
    if (pu.updates.content !== undefined) nextContent = pu.updates.content
    if (pu.updates.cron !== undefined && !validateCron(nextCron)) {
      await reportCommandResult(port, messageId, false, "😅 新 Cron 表达式无效", chatId)
      return
    }
    const updated: ScheduledTask = { ...t, name: nextName, cron: nextCron, content: nextContent }
    tasks = tasks.map((x, j) => (j === pu.oneBasedIndex - 1 ? updated : x))
    writeTasksToFile(tasks)
    let scheduleSection = ""
    const prev = previewCronNextRuns(updated.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    }
    const body = [
      `✅ 已更新任务`, `📋 任务详情  #${pu.oneBasedIndex}`, "",
      `📝 名称 · ${updated.name}`,
      `💠 状态 · ${formatTaskStatusLine(updated.enabled)}`,
      `🔄 Cron · ${updated.cron}`,
      scheduleSection, "",
      "✉️ 任务内容", "────────────", updated.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body, chatId)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${TASK_SUBCMD_HELP}`, chatId)
}

// ── MCP 命令 ──────────────────────────────────────────────

const MCP_SUBCMD_HELP = [
  "💡 /mc 子命令（全称 /mcp）",
  "🔹 /mc ls — 列出所有 MCP 服务器",
  "🔹 /mc info <序号|名称> — 查看详情",
  "🔹 /mc enable <序号|名称> — 启用",
  "🔹 /mc disable <序号|名称> — 禁用",
  "🔹 /mc delete <序号|名称> — 删除",
  '🔹 /mc add <json> — 添加（如 /mc add {"name":"test","command":"npx","args":["-y","xxx"]}）',
].join("\n")

function resolveMcpTarget(list: McpServerEntry[], token: string): McpServerEntry | null {
  const idx = parseInt(token, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]
  return list.find((s) => s.name.toLowerCase() === token.toLowerCase()) ?? null
}

export async function handleFeishuMcpCommand(port: number, messageId: string, raw: string, chatId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)

  const mcpHelpBtns = [{ label: "/mc ls", cmd: "/mc ls" }]
  if (parts.length <= 1) { await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP, chatId, mcpHelpBtns); return }
  const sub = parts[1].toLowerCase()
  if (sub === "help" || sub === "-h") { await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP, chatId, mcpHelpBtns); return }

  if (sub === "ls" || sub === "list") {
    const list = getMcpServerList()
    const enabledMap = await getMcpEnabledMap()
    if (list.length === 0) { await reportCommandResult(port, messageId, true, "📭 暂无 MCP 服务器", chatId); return }
    const lines = list.map((s, i) => {
      const flag = enabledMap[s.name] === false ? "🔴" : "🟢"
      const src = s.source === "global" ? "[G]" : "[P]"
      const detail = s.type === "url" ? s.url : s.command
      return `  ${i + 1}. ${flag} ${src} ${s.name}  (${detail})`
    })
    await reportCommandResult(port, messageId, true, `📦 MCP 服务器列表：\n${lines.join("\n")}\n\n💡 用法：/mc info|enable|disable|delete <序号|名称> · /mc add {JSON}`, chatId)
    return
  }

  if (sub === "info") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mc info <序号|名称>", chatId); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`, chatId); return }
    const enabledMap = await getMcpEnabledMap()
    const lines = [
      `📦 ${target.name}`,
      `  类型: ${target.type}`,
      `  来源: ${target.source}`,
      `  状态: ${enabledMap[target.name] === false ? "🔴 已禁用" : "🟢 已启用"}`,
    ]
    if (target.type === "url") lines.push(`  URL: ${target.url}`)
    else lines.push(`  命令: ${target.command} ${(target.args ?? []).join(" ")}`)
    if (target.env && Object.keys(target.env).length > 0) {
      lines.push(`  环境变量: ${Object.keys(target.env).join(", ")}`)
    }
    await reportCommandResult(port, messageId, true, lines.join("\n"), chatId)
    return
  }

  if (sub === "enable" || sub === "disable") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, `用法: /mc ${sub} <序号|名称>`, chatId); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`, chatId); return }
    const enabled = sub === "enable"
    const result = await toggleMcpServer(target.name, enabled)
    await reportCommandResult(port, messageId, result.ok,
      result.ok ? `✅ ${target.name} 已${enabled ? "启用" : "禁用"}` : `❌ 操作失败: ${result.output}`, chatId)
    return
  }

  if (sub === "delete" || sub === "rm") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mc delete <序号|名称>", chatId); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`, chatId); return }
    deleteMcpServer(target.name, target.source as "global" | "project")
    await reportCommandResult(port, messageId, true, `🗑️ ${target.name} 已删除`, chatId)
    return
  }

  if (sub === "add") {
    const jsonStr = raw.replace(/^\/mcp\s+add\s*/i, "").trim()
    if (!jsonStr) {
      await reportCommandResult(port, messageId, false, '用法: /mc add {"name":"xxx","command":"npx","args":[...]}', chatId)
      return
    }
    try {
      const parsed = JSON.parse(jsonStr)
      const name = parsed.name as string
      if (!name) { await reportCommandResult(port, messageId, false, "❌ 缺少 name 字段", chatId); return }
      const { name: _, ...entry } = parsed
      saveMcpServer(name, entry, "project")
      await reportCommandResult(port, messageId, true, `✅ ${name} 已添加`, chatId)
    } catch (e: unknown) {
      await reportCommandResult(port, messageId, false, `❌ JSON 解析失败: ${e instanceof Error ? e.message : e}`, chatId)
    }
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${sub}\n\n${MCP_SUBCMD_HELP}`, chatId)
}

// ── Workflow 命令 ────────────────────────────────────────────

const WORKFLOW_SUBCMD_HELP = [
  "💡 /wf 子命令（全称 /workflow）",
  "🔹 /wf ls — 列出工作流定义",
  "🔹 /wf info <序号|ID> — 查看定义详情",
  "🔹 /wf run <序号|ID> [初始输入] — 启动工作流",
  "🔹 /wf status [实例ID] — 查看实例状态",
  "🔹 /wf delete <序号|ID> — 删除工作流定义",
].join("\n")

function resolveWorkflowDef(defs: WorkflowDefinition[], token: string | undefined): WorkflowDefinition | null {
  if (!token) return null
  const idx = parseTaskOneBasedIndex(token)
  if (idx !== null && idx >= 1 && idx <= defs.length) return defs[idx - 1]
  return defs.find((d) => d.id === token) ?? null
}

export async function handleFeishuWorkflowCommand(
  port: number,
  messageId: string,
  raw: string,
  chatId?: string,
): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, WORKFLOW_SUBCMD_HELP, chatId, [
      { label: "/wf ls", cmd: "/wf ls" },
      { label: "/wf status", cmd: "/wf status" },
    ])
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, WORKFLOW_SUBCMD_HELP, chatId, [
      { label: "/wf ls", cmd: "/wf ls" },
      { label: "/wf status", cmd: "/wf status" },
    ])
    return
  }

  const defs = listDefinitions()

  if (sub === "ls" || sub === "list") {
    if (defs.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 当前还没有工作流定义～", chatId)
      return
    }
    const lines = defs.map((d, i) => `#${i + 1}\t📋 ${d.name} · ${d.nodes.length} 节点 · ID: ${d.id}`)
    await reportCommandResult(port, messageId, true, `🔀 工作流一览（共 ${defs.length} 条）\n\n${lines.join("\n")}\n\n✨ 详情：/wf info <序号>`, chatId)
    return
  }

  if (sub === "info" || sub === "get") {
    const target = resolveWorkflowDef(defs, parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/wf info <序号|ID>", chatId)
      return
    }
    const idx = defs.findIndex((d) => d.id === target.id) + 1
    const nodeLines = target.nodes.map((n, i) => `   ${i + 1}. ${n.name} (${n.id})`).join("\n")
    const body = [
      `📋 工作流详情 #${idx}`,
      `📝 名称 · ${target.name}`,
      target.description ? `📄 描述 · ${target.description}` : "",
      `📁 目录 · ${target.workingDirectory || "(默认工作目录)"}`,
      `🔗 ID · ${target.id}`,
      `🧩 节点 (${target.nodes.length})`,
      nodeLines,
    ].filter(Boolean).join("\n")
    await reportCommandResult(port, messageId, true, body, chatId)
    return
  }

  if (sub === "run") {
    const target = resolveWorkflowDef(defs, parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/wf run <序号|ID> [初始输入]", chatId)
      return
    }
    const input = parts.slice(3).join(" ").trim() || undefined
    const result = await runWorkflowDefinition(target.id, { input, notifyChatId: chatId })
    if (!result.ok) {
      await reportCommandResult(port, messageId, false, `❌ 启动失败: ${result.error}`, chatId)
      return
    }
    await reportCommandResult(
      port,
      messageId,
      true,
      `🚀 工作流「${target.name}」已启动\n实例 ID: ${result.instanceId}${input ? `\n初始输入: ${input}` : ""}`,
      chatId,
    )
    return
  }

  if (sub === "status") {
    const instances = listInstances().sort((a, b) => b.updatedAt - a.updatedAt)
    const token = parts[2]
    if (token) {
      const idx = parseTaskOneBasedIndex(token)
      const inst = instances.find((i) => i.id === token)
        ?? (idx !== null && idx >= 1 && idx <= instances.length ? instances[idx - 1] : undefined)
      if (!inst) {
        await reportCommandResult(port, messageId, false, "❌ 找不到该实例", chatId)
        return
      }
      const def = getDefinition(inst.workflowId)
      const body = [
        `📊 实例状态`,
        `📋 工作流 · ${def?.name || inst.workflowId}`,
        `💠 状态 · ${inst.status}`,
        `🔗 ID · ${inst.id}`,
        `📍 当前节点 · ${inst.currentNodeId || "(无)"}`,
        `📈 步数 · ${inst.stepCount}/${inst.maxSteps}`,
        inst.input ? `✉️ 输入 · ${inst.input}` : "",
      ].filter(Boolean).join("\n")
      await reportCommandResult(port, messageId, true, body, chatId)
      return
    }
    if (instances.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 暂无工作流实例", chatId)
      return
    }
    const lines = instances.slice(0, 10).map((inst, i) => {
      const def = getDefinition(inst.workflowId)
      return `#${i + 1}\t${def?.name || inst.workflowId} · ${inst.status} · ${inst.id.slice(0, 8)}…`
    })
    await reportCommandResult(port, messageId, true, `📊 工作流实例（最近 ${lines.length} 条）\n\n${lines.join("\n")}\n\n✨ 详情：/wf status <实例ID>`, chatId)
    return
  }

  if (sub === "delete" || sub === "del") {
    const target = resolveWorkflowDef(defs, parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/wf delete <序号|ID>", chatId)
      return
    }
    if (!deleteDefinition(target.id)) {
      await reportCommandResult(port, messageId, false, "❌ 删除失败", chatId)
      return
    }
    await reportCommandResult(port, messageId, true, `✅ 工作流「${target.name}」已删除`, chatId)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${sub}\n\n${WORKFLOW_SUBCMD_HELP}`, chatId)
}
