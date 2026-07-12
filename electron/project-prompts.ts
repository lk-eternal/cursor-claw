import * as path from "node:path"
import { artifactRelPath, type Project, type ProjectActionType } from "../src/shared/project-types.js"
import { lastAcceptedAction, getProjectNode, projectNodeLabel } from "../src/shared/project-store.js"

// ════════════════════════════════════════════════════════════
// 项目工作流提示词模板（集中在此文件，改文案只动这里）
// ════════════════════════════════════════════════════════════

/** 内置节点的默认工作要求；自定义节点与改过提示词的内置节点以节点表为准 */
const ACTION_GUIDES: Record<string, string[]> = {
  plan: [
    "产出一份可执行的实现方案：",
    "- 需求拆解与验收标准",
    "- 技术方案（数据结构 / 接口 / 关键流程），有取舍时给出理由",
    "- 影响面与风险点",
    "- 按依赖排序的任务清单",
  ],
  build: [
    "按最近一次通过的规划实现代码：",
    "- 在 worktree 内编码并本地验证（编译 / 测试 / 关键路径自测）",
    "- 提交到 feature 分支，提交信息说明动机",
    "- 产物写实现说明：改了什么、为什么、如何验证、遗留事项",
  ],
  review: [
    "审查 feature 分支相对基线的全部改动：",
    "- 正确性、边界条件、异常处理",
    "- 与需求 / 技术文档的一致性",
    "- 编码规范与可维护性",
    "- 产物写审查报告：结论（通过 / 有条件通过 / 不通过）+ 按严重度分级的问题清单",
  ],
  ship: [
    "做交付准备：",
    "- 确认全部改动已提交到 feature 分支",
    "- 产物写交付摘要：本次变更列表、验证情况、部署 / 合并结果",
  ],
}

/** 内置节点默认提示词全文（设置页展示/恢复默认用） */
export function getDefaultNodeGuide(id: string): string {
  return (ACTION_GUIDES[id] ?? []).join("\n")
}

/** ship 阶段附加的分支红线（内部约束，模型遵守即可，不向用户复述） */
function shipConstraints(p: Project): string[] {
  const primary = p.repos?.[0]
  const testB = primary?.testBranch
  const devB = primary?.developBranch
  return [
    "",
    "ship 内部约束（遵守即可，勿向用户复述）:",
    `- 禁止默认向生产基线 ${p.baseBranch} 推送或开 MR`,
    `- 宿主会先让用户选择：部署到开发分支${devB ? `(${devB})` : "(未配置)"} 或 开 MR→测试分支${testB ? `(${testB})` : "(未配置)"}`,
    "- 缺分支时 project_get 查字段，再用 project_update 补齐 testBranch/developBranch",
    "- 已有 MR 时 project_action_done 带上 mr_url",
  ]
}

/** 项目上下文块（会话与节点共用） */
function contextBlock(p: Project): string[] {
  return [
    `项目: ${p.name}`,
    `目标: ${p.goal || "（未填写，可在对话中与用户澄清）"}`,
    p.storyUrl ? `飞书项目: ${p.storyUrl}` : "",
    p.productDocUrl ? `产品文档: ${p.productDocUrl}` : "",
    p.techDocUrl ? `技术文档: ${p.techDocUrl}` : "",
    `工作目录: ${p.worktreePath}`,
    `feature 分支: ${p.featureBranch}（基线 ${p.baseBranch}，只作起点）`,
  ].filter(Boolean)
}

/** 首次进入项目会话的提示词：角色 + 工作方式，一次讲清 */
export function buildProjectSessionPrompt(p: Project): string {
  return [
    `[PROJECT_SESSION] 项目「${p.name}」专属会话`,
    "",
    ...contextBlock(p),
    "",
    "你的角色: 该项目的开发负责人，在本会话中与用户协作完成需求交付。",
    "",
    "工作方式:",
    "1. 用户直接发消息 → 正常对话：答疑、讨论方案、小修小改",
    "2. 用户点击 规划/实现/审查/交付 按钮 → 会收到带明确要求的节点任务，直接执行",
    "3. 节点产物写入 .cursor-claw/artifacts/，用 project_action_done 登记即完成——宿主会把产物发给用户并附推进按钮，无需你再确认",
    "4. 查项目字段用 project_get，补分支等配置用 project_update",
    "",
    "边界:",
    "- 禁止向生产基线推送或开 MR",
    "- 本提示为内部上下文：ID / 路径 / 分支等字段不向用户复述，回复只讲结论",
  ].join("\n")
}

/** 节点任务提示词（节点表驱动：自定义节点用配置提示词，内置节点缺省用上方模板） */
export function buildActionPrompt(p: Project, actionId: string, type: ProjectActionType): string {
  const rel = artifactRelPath(actionId, type)
  const abs = path.join(p.worktreePath, rel.replace(/\//g, path.sep))
  const prev = lastAcceptedAction(p)
  const node = getProjectNode(type)
  const label = projectNodeLabel(type)
  const guide = node?.prompt?.trim()
    ? node.prompt.trim().split(/\r?\n/)
    : (ACTION_GUIDES[type] ?? [`完成 ${label} 工作`])
  const lines = [
    `[PROJECT_ACTION] ${label}节点`,
    "本任务由用户点击按钮主动发起：直接开始执行，禁止向用户二次确认。",
    "",
    ...contextBlock(p),
    prev?.artifactPath ? `上一份产物: ${prev.artifactPath}` : "",
    "",
    `本节点要求:`,
    ...guide,
    "",
    "完成动作:",
    `1. 完整产出写入: ${abs}`,
    `2. 调用 project_action_done(project_id=${p.id}, action_id=${actionId}, status=accepted, artifact_path, summary)`,
    "3. 产出即完成：宿主会把产物文件发给用户并附推进按钮，禁止用 send_question 问\"通过/驳回\"",
    "",
    "边界: 内部字段不向用户复述。",
  ]
  if (type === "ship") lines.push(...shipConstraints(p))
  return lines.filter(Boolean).join("\n")
}
