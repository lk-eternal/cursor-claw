import { BrowserWindow } from "electron"
import { getEnabledChannels } from "./config-store"
import { makeChatKey } from "../src/shared/channel-types"
import { getDefinition } from "./workflow-file"
import { createInstance, startWorkflow } from "../src/workflow-engine"
import { getInstance } from "../src/workflow-store"
import { launchWorkflowAgent, notifyWorkflowChat } from "./session-dispatcher"

export async function runWorkflowDefinition(
  workflowId: string,
  opts?: { input?: string; workingDirectory?: string; notifyChatId?: string },
): Promise<{ ok: boolean; error?: string; instanceId?: string }> {
  const def = getDefinition(workflowId)
  if (!def) {
    return { ok: false, error: "工作流不存在" }
  }

  const mainUserChannel = getEnabledChannels().find((c) => c.mainUserEnabled && c.mainUserChatId?.trim())
  const notifyChatId = opts?.notifyChatId?.trim()
    || (mainUserChannel ? makeChatKey(mainUserChannel.id, mainUserChannel.mainUserChatId.trim()) : undefined)
  const inst = createInstance(def, {
    input: opts?.input?.trim() || undefined,
    workingDirectory: opts?.workingDirectory || def.workingDirectory,
    notifyChatId,
  })

  const result = startWorkflow(inst.id)
  if (result.failed) {
    return { ok: false, error: result.message || "启动失败" }
  }

  const fresh = getInstance(inst.id)
  if (fresh) {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("workflow:instance-updated", fresh))
  }

  if (result.node && result.prompt && fresh) {
    const launchResult = await launchWorkflowAgent({
      instanceId: inst.id,
      nodeId: result.node.id,
      nodeName: result.node.name,
      prompt: result.prompt,
      workingDirectory: fresh.workingDirectory,
      notifyChatId: fresh.notifyChatId,
      model: result.node.model,
    })
    if (!launchResult.ok) {
      return { ok: false, error: launchResult.error || "Agent 启动失败" }
    }
  }

  if (notifyChatId && result.node?.name) {
    void notifyWorkflowChat(notifyChatId, `🚀 工作流「${def.name}」已启动，第一个节点: ${result.node.name}`)
  }

  return { ok: true, instanceId: inst.id }
}
