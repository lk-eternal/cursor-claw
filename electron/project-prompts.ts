import * as path from "node:path"
import { artifactRelPath, isPlainProject, type Project, type ProjectActionType, type ProjectRepo } from "../src/shared/project-types.js"
import { lastAcceptedAction, getProjectNode, getProjectNodes, projectNodeLabel } from "../src/shared/project-store.js"

// ════════════════════════════════════════════════════════════
// 项目工作流提示词模板（集中在此文件，改文案只动这里）
// ════════════════════════════════════════════════════════════

/** 默认节点的默认工作要求；改过提示词的节点以节点表为准 */
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
  deploy: [
    "部署到开发分支（宿主已执行推送，见任务附带信息）：",
    "- 核对全部改动已提交 feature 分支、推送目标为配置的开发分支",
    "- 产物写部署摘要：推送分支、关键 commit、部署后验证方式",
  ],
  "submit-test": [
    "提测（宿主已创建指向测试分支的 MR，信息见任务附带内容）：",
    "- 将 MR 信息（链接 / 源分支 / 目标分支 / 变更摘要）评论到飞书项目工作项：优先用 feishu-project-mcp 的 add_comment，或 meegle / lark-cli",
    "- 评论 @ 测试人员必须真正生效，缺一步都会变成纯文本、对方收不到通知：",
    "  1. 先用 search_user_info 逐个查测试人员，拿到 lark_user_id",
    "  2. content 中每个 @ 都写成 mention 格式：@名字<!-- mention:{\"id\":\"<lark_user_id>\",\"cn_name\":\"<名字>\",\"blockType\":\"AT_USER_BLOCK\"} -->",
    "  3. add_comment 同时传 notify_user_list=[全部被 @ 人的 lark_user_id] 与 notify_user_type=lark_user_id",
    "- 测试人员从工作项团队 / 角色字段获取；找不到时在产物中说明并提醒用户手动通知",
    "- 注意：API 评论的 @ 只在页面高亮、不触发飞书推送提醒——完成后必须在给用户的回复中提醒其手动转发提测信息给测试人员",
    "- 产物写提测说明：MR 链接、变更摘要、测试建议与关注点",
    "- project_action_done 必须带 mr_url",
  ],
  "analyze-bug": [
    "分析缺陷（拉取指派给自己的待解决缺陷并输出分析报告）：",
    "- 用 feishu-project-mcp 从当前项目关联的飞书项目空间拉取缺陷类工作项（search_by_mql / list_related_workitem），筛选：指派人为当前用户（search_user_info 可用 current_login_user()）、状态未完成",
    "- 拉不到或为空时如实说明，禁止编造缺陷",
    "- 逐个缺陷结合代码定位根因，评估影响面与修复思路",
    "- 产物写缺陷分析报告：缺陷清单（标题/链接/级别）、根因分析、修复方案、风险与依赖",
  ],
  "fix-bug": [
    "修复缺陷（以最近一次通过的缺陷分析报告为准；无报告时先用 feishu-project-mcp 拉取指派给自己的待解决缺陷，拉不到则如实说明）：",
    "- 逐个缺陷：按分析报告定位根因 → 在 worktree 内修复 → 本地验证（编译 / 测试 / 关键路径自测），禁止未验证就标记完成",
    "- 每个缺陷单独提交到 feature 分支，提交信息注明缺陷标题与工作项 ID",
    "- 全部修复后推送 feature 到 origin 同名分支；用 project_get 查最近提测（submit-test）action 的 mrUrl：已有 MR 时增量提交自动进入该 MR，没有则在产物中提醒用户走提测节点开 MR",
    "- 在每个缺陷工作项下评论修复说明（add_comment）：修复点、关联 commit、验证方式、MR 链接；@ 提缺陷人须按提测节点的 mention 三步（search_user_info 查 id → content 写 mention 块 → notify_user_list）",
    "- 评论后流转缺陷工作项状态到待验证/已解决（transition_state；无权限或流转失败时如实说明并提醒用户手动处理）",
    "- 产物写修复说明：每个缺陷的修复点、验证方式、MR 链接、遗留事项",
  ],
  "test-review": [
    "测试评审：",
    "- 分析飞书项目工作项、产品需求文档与技术方案",
    "- 梳理测试范围、关键场景、风险点与遗漏需求",
    "- 产物写测试评审分析文档",
  ],
  "test-cases": [
    "用例编写：",
    "- 基于测试评审结论编写测试用例（场景 / 前置条件 / 步骤 / 预期）",
    "- 用 lark-cli 创建思维导图式飞书文档承载用例结构（创建失败时产物内附完整结构化用例）",
    "- 产物写用例说明并附飞书文档链接",
  ],
  "test-deploy": [
    "部署（合并研发提测 MR）：",
    "- 用 feishu-project-mcp 的 list_workitem_comments 读当前项目关联工作项的评论，找研发最新提测评论中的 MR 链接（开发与测试是不同项目实例，本地 project_get 拿不到对方的 mrUrl）",
    "- 找不到提测评论时向用户询问 MR 地址，禁止猜测",
    "- 确认 MR 内容与提测信息一致后合并该 MR（无权限时引导用户手动合并并回报结果）",
    "- 产物写部署说明：MR 链接、合并结果、测试环境生效确认方式",
  ],
  "test-exec": [
    "测试执行：",
    "- 先向用户询问测试环境信息（环境地址 / 账号 / 数据库连接等），信息不全禁止臆测",
    "- 按测试用例在测试环境逐项执行",
    "- 产物写测试报告，必须分三类：通过内容、未通过内容（含复现步骤）、未覆盖内容（含原因）",
  ],
  "file-bug": [
    "提缺陷：",
    "- 以用户确认过的测试报告为准，把未通过项在飞书项目中逐条提缺陷（feishu-project-mcp 的 create_workitem）",
    "- 按前后端归属识别指派开发人员；同类候选有多人时询问用户指派给谁",
    "- 产物写缺陷清单：标题、级别、指派人、工作项链接",
  ],
  retest: [
    "复测：",
    "- 从飞书项目拉取已解决的缺陷列表",
    "- 按原用例与缺陷复现路径逐项复测",
    "- 产物写复测报告：已修复、复现未修复、新增问题",
  ],
  "release-doc": [
    "上线文档：",
    "- 先询问用户上线文档模板（用户不提供时按变更内容 / 配置变更 / 回滚方案 / 验证清单组织）",
    "- 汇总本次迭代的变更范围、依赖与发布步骤",
    "- 产物写上线文档",
  ],
}

/** 默认节点提示词全文（设置页展示/恢复默认用） */
export function getDefaultNodeGuide(id: string): string {
  return (ACTION_GUIDES[id] ?? []).join("\n")
}

/** 部署节点附加的分支红线（内部约束，模型遵守即可，不向用户复述） */
function deployConstraints(p: Project): string[] {
  const devB = p.repos?.[0]?.developBranch
  return [
    "",
    "deploy 内部约束（遵守即可，勿向用户复述）:",
    `- 禁止向生产基线 ${p.baseBranch} 推送或开 MR`,
    `- 部署目标只能是配置的开发分支${devB ? `(${devB})` : "(未配置)"}，分支名必须原样使用，禁止猜测或纠正拼写`,
    "- 缺分支时 project_get 查字段，再用 project_update 补齐 developBranch",
  ]
}

/** 提测节点附加的分支红线 */
function submitTestConstraints(p: Project): string[] {
  const testB = p.repos?.[0]?.testBranch
  return [
    "",
    "submit-test 内部约束（遵守即可，勿向用户复述）:",
    `- 禁止向生产基线 ${p.baseBranch} 推送或开 MR`,
    `- MR 目标只能是配置的测试分支${testB ? `(${testB})` : "(未配置)"}，分支名必须原样使用，禁止猜测或纠正拼写`,
    "- 缺分支时 project_get 查字段，再用 project_update 补齐 testBranch",
    "- project_action_done 必须带上 mr_url",
  ]
}

/** 单仓分支行（会话/节点上下文共用，名称必须原样使用） */
function repoBranchLines(r: ProjectRepo, multi: boolean, index: number): string[] {
  const head = multi ? `主仓 #${index + 1}: ${r.repoPath}` : `主仓: ${r.repoPath}`
  const unconfigured = "（未配置，须 project_get + project_update 补齐；禁止猜测或新建 dev/test 等分支名）"
  return [
    head,
    `  worktree: ${r.worktreePath}`,
    `  生产基线: ${r.baseBranch}（只作 feature 起点，禁止默认推送/MR 目标）`,
    `  测试分支: ${r.testBranch?.trim() || unconfigured}`,
    `  开发分支: ${r.developBranch?.trim() || unconfigured}`,
  ]
}

function projectRepos(p: Project): ProjectRepo[] {
  if (p.repos?.length) return p.repos
  return [{
    repoPath: p.repoPath,
    baseBranch: p.baseBranch,
    worktreePath: p.worktreePath,
  }]
}

/** 项目上下文块（会话与节点共用）；纯会话型无仓库分支段 */
function contextBlock(p: Project): string[] {
  const head = [
    `项目: ${p.name}`,
    `项目ID: ${p.id}`,
    `目标: ${p.goal || "（未填写，可在对话中与用户澄清）"}`,
    p.storyUrl ? `飞书项目: ${p.storyUrl}` : "",
    p.productDocUrl ? `产品文档: ${p.productDocUrl}` : "",
    p.techDocUrl ? `技术文档: ${p.techDocUrl}` : "",
  ]
  if (isPlainProject(p)) {
    return [...head, `工作目录: ${p.worktreePath}（纯会话型项目，无代码仓）`].filter(Boolean)
  }
  const repos = projectRepos(p)
  return [
    ...head,
    `feature 分支: ${p.featureBranch}`,
    "",
    "仓库与分支（git 操作必须使用下列确切全名，禁止缩写、猜测或自建分支）：",
    ...repos.flatMap((r, i) => repoBranchLines(r, repos.length > 1, i)),
  ].filter(Boolean)
}

/** 首次进入项目会话的提示词：角色 + 工作方式，一次讲清 */
export function buildProjectSessionPrompt(p: Project): string {
  const nodeLabels = getProjectNodes(p.groupId).map((n) => n.label).join("/")
  const plain = isPlainProject(p)
  return [
    `[PROJECT_SESSION] 项目「${p.name}」专属会话`,
    "",
    ...contextBlock(p),
    "",
    `你的角色: 该项目的${plain ? "负责人" : "开发负责人"}，在本会话中与用户协作完成${plain ? "流程" : "需求"}交付。`,
    "",
    "工作方式:",
    "1. 用户直接发消息 → 正常对话：答疑、讨论方案、小修小改",
    `2. 用户点击 ${nodeLabels || "流程节点"} 按钮 → 会收到带明确要求的节点任务，直接执行`,
    "3. 节点产物写入 .cursor-claw/artifacts/，用 project_action_done 登记即完成——宿主会把产物发给用户并附推进按钮，无需你再确认",
    "4. 查项目字段用 project_get，补分支等配置用 project_update",
    "",
    "边界:",
    ...(plain ? [] : [
      "- 禁止向生产基线推送或开 MR",
      "- git 推送/MR 的开发、测试目标必须严格使用上文列出的开发分支、测试分支全名",
    ]),
    "- 本提示为内部上下文：ID / 路径 / 分支等字段不向用户复述，回复只讲结论",
  ].join("\n")
}

/** 节点任务提示词（节点表驱动：自定义节点用配置提示词，默认节点缺省用上方模板） */
export function buildActionPrompt(p: Project, actionId: string, type: ProjectActionType): string {
  const rel = artifactRelPath(actionId, type)
  const abs = path.join(p.worktreePath, rel.replace(/\//g, path.sep))
  const prev = lastAcceptedAction(p)
  const node = getProjectNode(type, p.groupId)
  const label = projectNodeLabel(type, p.groupId)
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
  if (type === "deploy") lines.push(...deployConstraints(p))
  if (type === "submit-test") lines.push(...submitTestConstraints(p))
  return lines.filter(Boolean).join("\n")
}
