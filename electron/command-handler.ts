import { randomUUID } from "node:crypto"
import {
  getConfig, getEnabledChannels, getAgentResource, updateChannel,
  resolveChannelForSession, type MessageChannel, type ScheduledTask,
} from "./config-store"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { broadcastLog } from "./ui-logger"
import { applyProxyEnv, execAgentSync } from "./agent-cli"
import { listSdkModels } from "./agent-sdk"
import { McpServerEntry, getMcpServerList, getMcpEnabledMap, toggleMcpServer, deleteMcpServer, saveMcpServer } from "./mcp-manager"
import { httpPost } from "./daemon-client"
import { deleteDefinition, getDefinition, listDefinitions, listInstances } from "./workflow-file"
import { runWorkflowDefinition } from "./workflow-runner"
import type { WorkflowDefinition } from "../src/shared/workflow-types"

// ── 共享类型与工具 ─────────────────────────────────────────

export interface FileCommand { id: string; command: string; messageId: string; chatId?: string; chatType?: string }

export interface CommandButton { label: string; cmd: string }

export async function reportCommandResult(port: number, messageId: string, ok: boolean, message: string, chatId?: string, buttons?: CommandButton[]): Promise<void> {
  try {
    await httpPost(`http://127.0.0.1:${port}/cmd/result`, { messageId, ok, message, chatId, buttons })
  } catch (e: unknown) {
    broadcastLog(`指令结果回报失败: ${e instanceof Error ? e.message : e}`, "WARN")
  }
}


// ── Model 命令 ─────────────────────────────────────────────

const MODEL_SUBCMD_HELP =
  "💡 /model 子命令\n" +
  "🔹 /model ls — 列出可用模型与序号\n" +
  "🔹 /model info — 查看当前应用配置的模型\n" +
  "🔹 /model set <序号> — 按 /model ls 的 # 设置模型（写入配置，下次启动 Agent 生效）"

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

export async function handleFeishuModelCommand(port: number, messageId: string, raw: string, chatId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  const channel = chatId ? resolveChannelForSession(chatId) : getEnabledChannels()[0]
  if (!channel) {
    await reportCommandResult(port, messageId, false, "❌ 未找到当前会话所属的消息通道")
    return
  }

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP)
    return
  }

  if (sub === "info") {
    const cfgModel = channel.model?.trim() || "auto"
    const lines: string[] = [`📝 通道「${channel.name}」主模型: ${cfgModel}`]
    if (cfgModel === "auto") {
      lines.push("（auto：启动 Agent 时不传 --model，由 CLI 默认策略选择）")
    }
    const lr = await listCursorModelsForCommands(channel)
    if (lr.ok) {
      const hit = lr.models.findIndex((m) => m.id === cfgModel)
      if (hit >= 0) {
        lines.push(`对应列表序号: #${hit + 1}`)
        lines.push(`   ${lr.models[hit].id} — ${lr.models[hit].label}`)
      } else if (cfgModel !== "auto") {
        lines.push("（当前配置 id 不在本次列表中，若刚换模型列表可再执行 /model ls）")
      }
      const cliCur = lr.models.filter((m) => m.current)
      if (cliCur.length > 0) {
        lines.push(`标注 (current): ${cliCur.map((m) => m.id).join(", ")}`)
      }
    } else {
      lines.push(`⚠️ 无法拉取模型列表: ${lr.error}`)
    }
    await reportCommandResult(port, messageId, true, lines.join("\n"))
    return
  }

  if (sub === "ls") {
    const lr = await listCursorModelsForCommands(channel)
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`)
      return
    }
    const blocks = lr.models.map((m, i) => {
      const n = i + 1
      const tag = m.current ? "  ⭐current" : ""
      return [`#${n}`, `\t id · ${m.id}`, `\t说明 · ${m.label}${tag}`].join("\n")
    })
    const body = [`🧠 模型列表（共 ${lr.models.length} 个）`, "", ...blocks, "", "💡 设置：/model set <序号>"].join("\n")
    // 前几个模型附一键设置按钮，其余仍用 /model set <序号>
    const btns = lr.models.slice(0, 6).map((m, i) => ({ label: `设为 #${i + 1} ${m.id}`, cmd: `/model set ${i + 1}` }))
    await reportCommandResult(port, messageId, true, body, undefined, btns)
    return
  }

  if (sub === "set") {
    const lr = await listCursorModelsForCommands(channel)
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`)
      return
    }
    if (parts.length < 3) {
      await reportCommandResult(port, messageId, false, "💡 用法：/model set <序号>（数字见 /model ls 的 #）")
      return
    }
    const idx = parseInt(parts[2], 10)
    if (!Number.isInteger(idx) || idx < 1 || idx > lr.models.length) {
      await reportCommandResult(port, messageId, false, `😅 序号须为 1～${lr.models.length} 之间的整数（先 /model ls）`)
      return
    }
    const picked = lr.models[idx - 1]
    updateChannel(channel.id, { model: picked.id, modelParams: picked.params ?? "" })
    await reportCommandResult(port, messageId, true, [
      `✅ 已保存通道「${channel.name}」主模型（下次启动 Agent 生效）`,
      ` # · ${idx}`,
      ` id · ${picked.id}`,
      `说明 · ${picked.label}`,
      "",
      "若 Agent 正在运行，可 /stop 后由新消息再拉起以使用新模型。",
    ].join("\n"))
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${MODEL_SUBCMD_HELP}`)
}

// ── Task 命令 ──────────────────────────────────────────────

const TASK_SUBCMD_HELP =
  "💡 可用指令\n" +
  "🔹 /task 显示本说明\n" +
  "🔹 /task ls 列出所有任务\n" +
  "🔹 /task info <序号> 查看详情\n" +
  "🔹 /task run <序号> 立即触发一次\n" +
  "🔹 /task stop <序号> 停止任务\n" +
  "🔹 /task start <序号> 启动任务\n" +
  "🔹 /task delete <序号> 删除任务\n" +
  "🔹 /task create <名称> <cron> <内容> 创建任务\n" +
  "🔹 /task update <序号> [-name 值] [-cron 值] [-content 值] 更新任务"

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
    return { ok: false, error: "❌ 参数不足：/task create <名称> <cron五或六段> <内容>" }
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
    return { ok: false, error: "💡 用法：/task update <序号> [-name 值] [-cron 值] [-content 值]" }
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

  if (parts.length <= 1) { await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP); return }
  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") { await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP); return }

  let tasks = readTasksFromFile()

  if (sub === "ls") {
    if (tasks.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 当前还没有定时任务～\n\n💡 需要的话可以用：\n   /task create <名称> <cron> <内容>")
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
    await reportCommandResult(port, messageId, true, `${header}\n\n${blocks.join("\n\n")}\n\n✨ 看某条详情：/task info <序号>`)
    return
  }

  if (sub === "info") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/task info <序号>（数字见 /task ls 的 #）"); return }
    if (tasks.length === 0) { await reportCommandResult(port, messageId, false, "📭 还没有任何任务，先用 /task ls 确认一下吧～"); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（当前共 ${tasks.length} 条）`); return }
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
    await reportCommandResult(port, messageId, true, body)
    return
  }

  if (sub === "run") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/task run <序号>（数字见 /task ls 的 #）"); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`); return }
    const t = tasks[idx - 1]
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${t.name}] (手动触发: ${nowStr})\n\n${t.content}`
    if (t.independent !== false) {
      const result = await taskRunFn(t, content)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已独立启动任务 #${idx} ${t.name}`)
      } else {
        await reportCommandResult(port, messageId, false, `❌ 独立启动失败: ${result.error}`)
      }
    } else {
      const enqueue = taskEnqueueFn ?? (async (c) => {
        await httpPost(`http://127.0.0.1:${port}/enqueue`, { content: c, chatId, chatType: chatId ? "p2p" : undefined })
        return { ok: true }
      })
      const result = await enqueue(content, chatId)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已手动触发任务 #${idx} ${t.name}`)
      } else {
        await reportCommandResult(port, messageId, false, `❌ 触发失败: ${result.error}`)
      }
    }
    return
  }

  if (sub === "stop") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/task stop <序号>（数字见 /task ls 的 #）"); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`); return }
    const name = tasks[idx - 1].name
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: false } : t))
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `⏸️ 已停止任务 #${idx} ${name}`)
    return
  }

  if (sub === "start") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/task start <序号>（数字见 /task ls 的 #）"); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`); return }
    const name = tasks[idx - 1].name
    const cron = tasks[idx - 1].cron
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: true } : t))
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(cron)
    await reportCommandResult(port, messageId, true, `✅ 已启动任务 #${idx} ${name}\n下次执行: ${next}`)
    return
  }

  if (sub === "delete") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/task delete <序号>（数字见 /task ls 的 #）"); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`); return }
    const name = tasks[idx - 1].name
    tasks = tasks.filter((_, j) => j !== idx - 1)
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `🗑️ 已删除任务 #${idx} ${name}`)
    return
  }

  if (sub === "create") {
    const parsed = parseTaskCreateArgs(parts)
    if (!parsed.ok) { await reportCommandResult(port, messageId, false, parsed.error); return }
    const taskChannel = chatId ? resolveChannelForSession(chatId) : getEnabledChannels()[0]
    const newTask: ScheduledTask = { id: randomUUID(), name: parsed.name, cron: parsed.cron, content: parsed.content, enabled: true, channelId: taskChannel?.id }
    tasks = [...tasks, newTask]
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(parsed.cron)
    await reportCommandResult(port, messageId, true, `✅ 已创建并启动：${parsed.name}\n下次执行: ${next}`)
    return
  }

  if (sub === "update") {
    const pu = parseTaskUpdateArgs(parts)
    if (!pu.ok) { await reportCommandResult(port, messageId, false, pu.error); return }
    if (pu.oneBasedIndex > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${pu.oneBasedIndex} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const t = tasks[pu.oneBasedIndex - 1]
    let nextName = t.name, nextCron = t.cron, nextContent = t.content
    if (pu.updates.name !== undefined) nextName = pu.updates.name
    if (pu.updates.cron !== undefined) nextCron = pu.updates.cron
    if (pu.updates.content !== undefined) nextContent = pu.updates.content
    if (pu.updates.cron !== undefined && !validateCron(nextCron)) {
      await reportCommandResult(port, messageId, false, "😅 新 Cron 表达式无效")
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
    await reportCommandResult(port, messageId, true, body)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${TASK_SUBCMD_HELP}`)
}

// ── MCP 命令 ──────────────────────────────────────────────

const MCP_SUBCMD_HELP = [
  "📦 MCP 服务器管理",
  "",
  "  /mcp ls              列出所有 MCP 服务器",
  "  /mcp info <序号|名称>  查看详情",
  "  /mcp enable <序号|名称> 启用",
  "  /mcp disable <序号|名称> 禁用",
  "  /mcp delete <序号|名称> 删除",
  '  /mcp add <json>       添加（如 /mcp add {"name":"test","command":"npx","args":["-y","xxx"]}）',
].join("\n")

function resolveMcpTarget(list: McpServerEntry[], token: string): McpServerEntry | null {
  const idx = parseInt(token, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]
  return list.find((s) => s.name.toLowerCase() === token.toLowerCase()) ?? null
}

export async function handleFeishuMcpCommand(port: number, messageId: string, raw: string, chatId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)

  if (parts.length <= 1) { await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP); return }
  const sub = parts[1].toLowerCase()
  if (sub === "help" || sub === "-h") { await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP); return }

  if (sub === "ls" || sub === "list") {
    const list = getMcpServerList()
    const enabledMap = await getMcpEnabledMap()
    if (list.length === 0) { await reportCommandResult(port, messageId, true, "📭 暂无 MCP 服务器"); return }
    const lines = list.map((s, i) => {
      const flag = enabledMap[s.name] === false ? "🔴" : "🟢"
      const src = s.source === "global" ? "[G]" : "[P]"
      const detail = s.type === "url" ? s.url : s.command
      return `  ${i + 1}. ${flag} ${src} ${s.name}  (${detail})`
    })
    await reportCommandResult(port, messageId, true, `📦 MCP 服务器列表：\n${lines.join("\n")}`)
    return
  }

  if (sub === "info") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mcp info <序号|名称>"); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
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
    await reportCommandResult(port, messageId, true, lines.join("\n"))
    return
  }

  if (sub === "enable" || sub === "disable") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, `用法: /mcp ${sub} <序号|名称>`); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    const enabled = sub === "enable"
    const result = await toggleMcpServer(target.name, enabled)
    await reportCommandResult(port, messageId, result.ok,
      result.ok ? `✅ ${target.name} 已${enabled ? "启用" : "禁用"}` : `❌ 操作失败: ${result.output}`)
    return
  }

  if (sub === "delete" || sub === "rm") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mcp delete <序号|名称>"); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    deleteMcpServer(target.name, target.source as "global" | "project")
    await reportCommandResult(port, messageId, true, `🗑️ ${target.name} 已删除`)
    return
  }

  if (sub === "add") {
    const jsonStr = raw.replace(/^\/mcp\s+add\s*/i, "").trim()
    if (!jsonStr) {
      await reportCommandResult(port, messageId, false, '用法: /mcp add {"name":"xxx","command":"npx","args":[...]}')
      return
    }
    try {
      const parsed = JSON.parse(jsonStr)
      const name = parsed.name as string
      if (!name) { await reportCommandResult(port, messageId, false, "❌ 缺少 name 字段"); return }
      const { name: _, ...entry } = parsed
      saveMcpServer(name, entry, "project")
      await reportCommandResult(port, messageId, true, `✅ ${name} 已添加`)
    } catch (e: unknown) {
      await reportCommandResult(port, messageId, false, `❌ JSON 解析失败: ${e instanceof Error ? e.message : e}`)
    }
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${sub}\n\n${MCP_SUBCMD_HELP}`)
}

// ── Workflow 命令 ────────────────────────────────────────────

const WORKFLOW_SUBCMD_HELP =
  "💡 /workflow 子命令\n" +
  "🔹 /workflow ls — 列出工作流定义\n" +
  "🔹 /workflow info <序号|ID> — 查看定义详情\n" +
  "🔹 /workflow run <序号|ID> [初始输入] — 启动工作流\n" +
  "🔹 /workflow status [实例ID] — 查看实例状态\n" +
  "🔹 /workflow delete <序号|ID> — 删除工作流定义"

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
    await reportCommandResult(port, messageId, true, WORKFLOW_SUBCMD_HELP)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, WORKFLOW_SUBCMD_HELP)
    return
  }

  const defs = listDefinitions()

  if (sub === "ls" || sub === "list") {
    if (defs.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 当前还没有工作流定义～")
      return
    }
    const lines = defs.map((d, i) => `#${i + 1}\t📋 ${d.name} · ${d.nodes.length} 节点 · ID: ${d.id}`)
    await reportCommandResult(port, messageId, true, `🔀 工作流一览（共 ${defs.length} 条）\n\n${lines.join("\n")}\n\n✨ 详情：/workflow info <序号>`)
    return
  }

  if (sub === "info" || sub === "get") {
    const target = resolveWorkflowDef(defs, parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/workflow info <序号|ID>")
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
    await reportCommandResult(port, messageId, true, body)
    return
  }

  if (sub === "run") {
    const target = resolveWorkflowDef(defs, parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/workflow run <序号|ID> [初始输入]")
      return
    }
    const input = parts.slice(3).join(" ").trim() || undefined
    const result = await runWorkflowDefinition(target.id, { input, notifyChatId: chatId })
    if (!result.ok) {
      await reportCommandResult(port, messageId, false, `❌ 启动失败: ${result.error}`)
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
        await reportCommandResult(port, messageId, false, "❌ 找不到该实例")
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
      await reportCommandResult(port, messageId, true, body)
      return
    }
    if (instances.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 暂无工作流实例")
      return
    }
    const lines = instances.slice(0, 10).map((inst, i) => {
      const def = getDefinition(inst.workflowId)
      return `#${i + 1}\t${def?.name || inst.workflowId} · ${inst.status} · ${inst.id.slice(0, 8)}…`
    })
    await reportCommandResult(port, messageId, true, `📊 工作流实例（最近 ${lines.length} 条）\n\n${lines.join("\n")}\n\n✨ 详情：/workflow status <实例ID>`)
    return
  }

  if (sub === "delete" || sub === "del") {
    const target = resolveWorkflowDef(defs, parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/workflow delete <序号|ID>")
      return
    }
    if (!deleteDefinition(target.id)) {
      await reportCommandResult(port, messageId, false, "❌ 删除失败")
      return
    }
    await reportCommandResult(port, messageId, true, `✅ 工作流「${target.name}」已删除`)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${sub}\n\n${WORKFLOW_SUBCMD_HELP}`)
}
