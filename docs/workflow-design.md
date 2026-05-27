# Cursor Claw — 通用工作流引擎设计方案

> 版本: v1.0 (Draft)
> 日期: 2026-05-27

---

## 一、概述

在 Cursor Claw 中引入一套通用的工作流（Workflow）系统，允许用户通过自然语言 + AI 快速创建、编排多节点任务流水线。每个节点由独立的 Agent 会话（或同一会话内 MCP 流转）驱动，节点之间通过结构化上下文传递产物，支持审查、驳回、重跑等状态流转，最终产出完整的交付物。

### 核心理念

- **Workflow = 有序节点链 + MCP 驱动的 Agent 执行器**
- **节点类型统一化**：所有节点均为通用 `task` 节点，无需特例化 `review` / `gateway` 类型
- **Agent 模式默认单会话**：同一工作流默认在单个 Agent 会话内通过 MCP 工具驱动节点流转
- **逃生舱机制**：节点可声明 `isolated: true`，此时引擎为其 spawn 独立 Agent

---

## 二、数据模型

### 2.1 WorkflowDefinition（工作流蓝图）

存储为 JSON 文件，由 AI 通过 MCP admin 工具创建/管理。

```typescript
interface WorkflowDefinition {
  id: string                    // uuid
  name: string                  // 工作流名称
  description?: string          // 描述
  workingDirectory?: string     // 默认工作目录（可选，运行时可覆盖）
  config?: Record<string, string> // 工作流级配置（如 API Token），注入到 Agent 上下文
  nodes: WorkflowNode[]         // 节点列表（数组顺序 = 执行顺序）
  createdAt: number
  updatedAt: number
}

interface WorkflowNode {
  id: string                    // 节点唯一标识（如 "analyze"）
  name: string                  // 节点名称（如 "需求分析"）
  prompt: string                // 核心指令（Agent 的任务描述）
  model?: string                // 模型覆盖（留空跟随工作流默认）
  maxRetries: number            // 最大重试次数（默认 2）
  isolated?: boolean            // 是否独立 Agent（默认 false）
}
```

> `nodes` 数组顺序即执行顺序。节点产物自动以 `context[nodeId]` 存储。
> 产物不一定是纯文本，也可以是文档地址、URL、文件路径等引用信息——引擎不做格式约束，由节点 prompt 自行规范输出结构。

### 2.2 WorkflowInstance（运行态实例）

```typescript
interface WorkflowInstance {
  id: string                    // 实例 uuid
  workflowId: string            // 关联蓝图 id
  status: "pending" | "running" | "paused" | "completed" | "failed"
  currentNodeId: string | null  // 当前执行的节点
  context: Record<string, unknown>  // 累积的各节点产物
  nodeHistory: NodeExecution[]  // 节点执行历史
  sessionKey?: string           // 当前活跃的 Agent 会话 key（随 isolated 切换更新）
  notifyChatId?: string         // 触发方的 chatId（固定不变，用于通知投递）
  workingDirectory: string      // 工作目录（Agent 执行时的 cwd）
  input?: string                // 工作流启动时的初始输入
  maxSteps: number              // 全局最大步数（防驳回死循环，默认 50）
  stepCount: number             // 已执行步数计数器
  createdAt: number
  updatedAt: number
  completedAt?: number
}

interface NodeExecution {
  nodeId: string
  attempt: number               // 第几次执行（从 1 开始）
  status: "running" | "completed" | "rejected" | "failed"
  input: Record<string, unknown>
  output?: unknown
  rejectReason?: string         // 驳回原因（如有）
  startedAt: number
  completedAt?: number
}
```

---

## 三、执行引擎

### 3.1 执行流程（单 Agent 模式）

```
Agent 启动
  ↓ 注入工作流上下文 + 第一个节点信息
  ↓ Agent 执行任务
  ↓ 调用 MCP workflow_next(output) 或 workflow_reject(reason)
  ↓ MCP 工具内部：
  │   ├─ 写入产物到 context[nodeId]
  │   ├─ 记录 nodeHistory
  │   ├─ 推进到 nodes 数组中的下一个节点
  │   └─ 返回下一个节点的完整信息（prompt + 输入 + 规则）
  ↓ Agent 继续执行下一个节点
  ↓ ...
  ↓ 无后续节点时，引擎自动标记 completed
```

### 3.2 MCP 工具设计

在 Daemon 的 MCP Server（`cursor-claw`）中新增以下工具：

#### `workflow_next`

Agent 完成当前节点后调用，提交产物并流转到下一个节点。

```typescript
s.tool(
  "workflow_next",
  "完成当前工作流节点，提交产物并流转到下一个节点",
  {
    output: z.string().describe("当前节点的产出（结构化文本）"),
  },
  async ({ output }) => {
    // 1. 写入 context[currentNode.id] = output
    // 2. 记录 nodeHistory，stepCount++
    // 3. 通知主用户：节点完成（投递到 instance.notifyChatId）
    // 4. 取 nodes 数组中下一个节点（当前索引 + 1）
    // 5. 如果已是最后一个节点 → 标记工作流 completed，通知主用户完成
    // 6. 如果下一个节点 isolated=true → 返回 "产物已提交，独立 Agent 将接管"
    // 7. 否则返回下一个节点的完整执行信息
    return { content: [{ type: "text", text: nextNodePrompt }] }
  }
)
```

#### `workflow_reject`

Agent 审查后认为上一节点产物不合格，驳回重跑。

```typescript
s.tool(
  "workflow_reject",
  "驳回工作流节点产物，回退到指定节点重新执行（默认上一个节点）",
  {
    reason: z.string().describe("驳回原因"),
    target_node_id: z.string().optional().describe("回退目标节点 ID（可选，默认上一个节点）"),
  },
  async ({ reason, target_node_id }) => {
    // 1. 确定回退目标（target_node_id || 当前索引 - 1）
    // 2. 校验目标节点必须在当前节点之前
    // 3. 检查目标节点重试次数是否超过 maxRetries
    // 4. 超过 → 标记 failed，通知主用户失败（投递到 instance.notifyChatId）
    // 5. 未超过 → stepCount++，通知主用户驳回事件
    // 6. 组装重试 prompt（含驳回原因 + 上次产出，见 3.5 节模板）
    return { content: [{ type: "text", text: retryNodePrompt }] }
  }
)
```


### 3.3 独立 Agent 模式（isolated 节点）

当节点声明 `isolated: true` 时：

1. 前一个节点调用 `workflow_next` 后，MCP 工具返回"产物已提交，下一节点将由独立 Agent 处理"
2. 引擎在 Electron 端接收信号，为该节点 spawn 新的 Agent 会话
3. 新 Agent 的 prompt 中注入：节点信息 + 前序上下文 + 工作流 MCP 工具说明
4. 独立 Agent 完成后同样通过 `workflow_next` / `workflow_reject` 驱动后续流转

**Agent 会话归属规则**：一旦 isolated 节点 spawn 了新 Agent B，后续的非 isolated 节点将沿用 Agent B 继续执行（而不是回到原 Agent A）。直到再次遇到新的 isolated 节点才会再 spawn。引擎更新 `instance.sessionKey` 指向最新活跃的 Agent 会话。

### 3.4 工作流启动 Prompt 模板

Agent 启动时注入的初始 prompt 结构：

```
你正在执行工作流「{workflow.name}」。

## 当前节点: {node.name}

### 任务
{node.prompt}

### 输入
{assembled_input_from_context}

### 配置
{workflow.config}  （仅当工作流定义了 config 时注入）

### 输出要求
完成任务后，你 **必须** 调用 `workflow_next` 工具提交产物。
如果你认为输入不合格，调用 `workflow_reject` 驳回。
### 工作流节点一览
{nodes_brief_list}

### 可用的工作流工具
- workflow_next(output): 完成当前节点，提交产物
- workflow_reject(reason, target_node_id?): 驳回到指定节点（默认上一个节点）
```

### 3.5 驳回重跑 Prompt 模板

当节点被后续节点驳回后重跑时，注入历史诊断信息，避免 Agent 盲目重跑：

```
你正在执行工作流「{workflow.name}」。

## 当前节点: {node.name}（第 {attempt} 次执行）

⚠️ 你被后续节点「{rejectFromNodeName}」驳回了。
驳回原因：{reason}

请根据上述原因修正你的产出，并重新调用 `workflow_next` 提交。

### 任务
{node.prompt}

### 上一次的产出（供参考）
{previous_output}

### 输入
{assembled_input_from_context}
```

---

## 四、存储层

### 4.1 文件结构

```
%APPDATA%/cursor-claw/
  ├── workflows/
  │   ├── definitions/          # 工作流蓝图
  │   │   ├── {uuid}.json
  │   │   └── ...
  │   └── instances/            # 运行态实例
  │       ├── {uuid}.json
  │       └── ...
```

### 4.2 Electron 端模块: `workflow-store.ts`

```typescript
// 核心 API
export function listWorkflowDefinitions(): WorkflowDefinition[]
export function getWorkflowDefinition(id: string): WorkflowDefinition | null
export function saveWorkflowDefinition(def: WorkflowDefinition): void
export function deleteWorkflowDefinition(id: string): void

export function listWorkflowInstances(workflowId?: string): WorkflowInstance[]
export function getWorkflowInstance(id: string): WorkflowInstance | null
export function saveWorkflowInstance(inst: WorkflowInstance): void
export function deleteWorkflowInstance(id: string): void
```

---

## 五、MCP Admin 工具（AI 自助管理）

在 `cursor-claw-admin` MCP Server 中新增 `manage_workflows` 工具，使 AI 可以通过自然语言创建和管理工作流。

```typescript
s.tool(
  "manage_workflows",
  "管理工作流定义与实例。支持：list / get / create / update / delete / run / status",
  {
    action: z.enum(["list", "get", "create", "update", "delete", "run", "status"]),
    id: z.string().optional(),
    data: z.string().optional(),           // JSON 格式的工作流定义或更新数据
    input: z.string().optional(),          // run 时的初始输入
    workingDirectory: z.string().optional(), // run 时的工作目录（覆盖定义默认值）
  },
  async ({ action, id, data, input, workingDirectory }) => {
    // action="run" 时：
    // 1. 从 MCP 上下文获取当前会话的 chatId → 赋值给 instance.notifyChatId
    // 2. workingDirectory 优先级：参数传入 > 定义默认值 > 当前工作目录
    // 3. 通知固定投递到 notifyChatId（主用户私聊），不随 Agent 会话变化
  }
)
```

### 用户交互示例

```
用户: "帮我创建一个代码审查工作流，先分析需求，然后写代码，再审查代码质量"

AI:
  1. 调用 manage_workflows(action="create", data="{...定义JSON...}")
  2. 回复用户："工作流已创建：代码审查流水线（3个节点）"

用户: "跑一下这个工作流，输入是：实现用户登录功能"

AI:
  1. 调用 manage_workflows(action="run", id="xxx", input="实现用户登录功能")
  2. 工作流引擎启动 Agent，开始执行
```

---

## 六、引擎模块: `workflow-engine.ts`

Electron Main Process 中的编排引擎，负责：

1. **启动工作流**：创建实例、组装初始 prompt、launch Agent
2. **监听节点信号**：通过 Daemon HTTP 端点接收节点完成/驳回信号
3. **编排流转**：按节点数组顺序推进，处理驳回回退
4. **处理 isolated 节点**：spawn 新 Agent 并注入上下文
5. **异常处理**：超时、Agent 崩溃、超过 maxRetries 的兜底
6. **全局步数熔断**：每次节点执行（含驳回重跑）`stepCount++`，达到 `maxSteps` 时强制中断工作流标记 `failed`，防止驳回死循环导致 Token 爆炸
7. **崩溃恢复**：引擎启动时扫描 `instances/` 目录中 `status === "running"` 的实例，将其标记为 `paused` 并在 Dashboard 提供"继续执行 (Resume)"按钮，重新加载上下文恢复 Agent 会话

### 关键接口

```typescript
export async function startWorkflow(
  workflowId: string,
  input?: string
): Promise<WorkflowInstance>

export async function handleNodeSignal(
  instanceId: string,
  signal: "next" | "reject" | "complete",
  payload: { output?: string; reason?: string }
): Promise<{ nextNode?: WorkflowNode; done?: boolean; failed?: boolean }>

export function getWorkflowStatus(instanceId: string): WorkflowInstance | null
```

---

## 七、Daemon 端扩展

### 7.1 新增 HTTP 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/workflow-signal` | POST | Agent 提交节点信号（next/reject/complete） |
| `/api/workflow-status` | GET | 查询工作流实例状态 |
| `/api/workflows` | GET/POST/DELETE | 工作流 CRUD（admin API） |

### 7.2 工作流上下文注入

当 MCP 工具（`workflow_next` / `workflow_reject`）被调用时：

1. Daemon 内部更新工作流实例状态
2. 在 MCP 工具的返回值中直接携带下一个节点的完整 prompt
3. Agent 无需额外轮询，自然地继续执行

### 7.3 工作流感知的 MCP 工具注册

Daemon 在创建 MCP Server 时检测当前会话是否关联工作流实例：
- **是** → 注册 `workflow_next` / `workflow_reject` 工具
- **否** → 不注册（避免普通会话的工具列表污染）

---

## 八、UI 界面

### 8.1 工作流管理页（Settings 内新 Tab 或独立页面）

- **定义列表**：展示所有工作流蓝图，支持编辑/删除
- **可视化编辑器**（可选，Phase 2）：节点拖拽 + 连线
- **JSON 编辑器**（Phase 1）：直接编辑工作流 JSON

### 8.2 实例监控（Dashboard 扩展）

- 运行中的工作流实例列表
- 当前节点 + 进度条
- 节点执行历史（展开查看每次执行的 input/output）
- 手动干预按钮（暂停/终止/重跑某节点）

---

## 九、状态流转图

```
                        ┌──────────────────────────────────────────┐
                        │            WorkflowInstance              │
                        ├──────────────────────────────────────────┤
                        │                                          │
  startWorkflow() ──►   │  pending ──► running ──► completed       │
                        │                │                         │
                        │                ├──► paused (手动暂停)     │
                        │                │                         │
                        │                └──► failed (超限/崩溃)    │
                        └──────────────────────────────────────────┘

  节点内部：
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │   running ──► workflow_next() ──► [下一节点 running]          │
  │      │                                                      │
  │      └──► workflow_reject() ──► [目标节点 running, attempt+1]  │
  │                                   │                         │
  │                                   └──► attempt > maxRetries │
  │                                        → instance failed    │
  └─────────────────────────────────────────────────────────────┘
```

---

## 十、示例工作流 JSON

```json
{
  "id": "wf_code_review_001",
  "name": "代码审查流水线",
  "description": "需求分析 → 编码实现 → 代码审查 → 产出报告",
  "config": {
    "gitlab_token": "glpat-xxxxxxxxxxxx"
  },
  "nodes": [
    {
      "id": "analyze",
      "name": "需求分析",
      "prompt": "分析以下需求，输出详细的技术方案，包含：功能拆解、接口设计、数据模型、关键实现思路。",
      "model": "claude-4.6-opus-max-thinking",
      "maxRetries": 2
    },
    {
      "id": "implement",
      "name": "编码实现",
      "prompt": "根据技术方案进行编码实现。要求代码简洁、可读，遵循项目编码规范。",
      "maxRetries": 3
    },
    {
      "id": "review",
      "name": "代码审查",
      "prompt": "审查上一步的编码实现。检查：代码质量、潜在 Bug、性能隐患、安全风险。如果质量不达标，驳回并说明原因。",
      "model": "claude-4.6-opus-max",
      "isolated": true,
      "maxRetries": 1
    },
    {
      "id": "report",
      "name": "产出报告",
      "prompt": "汇总整个流程的产物，生成最终交付报告。包含：技术方案摘要、实现代码路径、审查结论。",
      "maxRetries": 1
    }
  ]
}
```

---

## 十一、实施路线图

### Phase 1: 核心引擎（MVP）

- [ ] `workflow-store.ts` — 定义 & 实例 JSON 文件持久化
- [ ] `workflow-engine.ts` — 基础编排引擎（单 Agent 模式）
- [ ] Daemon MCP 工具扩展 — `workflow_next` / `workflow_reject`
- [ ] Daemon HTTP 端点 — `/api/workflow-signal` / `/api/workflow-status`
- [ ] Admin MCP 工具 — `manage_workflows` (CRUD + run)
- [ ] 工作流 Prompt 模板 + 规则注入

### Phase 2: isolated 模式 + UI

- [ ] isolated 节点支持（引擎自动 spawn 独立 Agent）
- [ ] UI 工作流管理页（JSON 编辑器 + 实例列表）
- [ ] Dashboard 工作流实例监控

### Phase 3: 高级特性

- [ ] 可视化节点编辑器（拖拽连线）
- [ ] 条件 Gateway 节点（多分支路由）
- [ ] 工作流模板市场（预置常用工作流）
- [ ] 定时触发工作流（与 cron-scheduler 集成）
- [ ] 工作流嵌套（子工作流调用）

---

## 十二、新增组件清单

| 组件 | 路径 | 职责 |
|------|------|------|
| 存储层 | `electron/workflow-store.ts` | 定义 & 实例 JSON 文件 CRUD |
| 引擎 | `electron/workflow-engine.ts` | 编排引擎、状态机、Agent 启动 |
| Daemon MCP 扩展 | `src/daemon.ts` 内新增工具 | workflow_next / workflow_reject |
| Daemon HTTP 扩展 | `src/daemon.ts` 内新增端点 | /api/workflow-signal, /api/workflow-status |
| Admin MCP 扩展 | `src/daemon.ts` registerAdminTools 内 | manage_workflows |
| UI 页面 | `src/renderer/pages/Workflows.tsx` | 工作流定义管理 + 实例监控 |
| 类型定义 | `src/shared/workflow-types.ts` | WorkflowDefinition / Instance 等 |

---

## 十三、设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 节点类型 | 统一 task（无 review/gateway 特例） | 通过 prompt 描述行为，AI 自行判断前进/回退，更灵活 |
| Agent 模式 | 默认单 Agent + 可选 isolated | 单 Agent 无冷启动开销，天然携带上下文记忆；isolated 为长流程/异模型兜底 |
| 产物收集 | MCP 工具主动提交 | 结构化、实时、与现有 MCP 体系一致，优于文件约定或 stdout 解析 |
| 工作流配置 | JSON 文件 + Admin MCP 工具 | AI 可通过自然语言创建，无需复杂 UI；用户也可直接编辑 JSON |
| 流转模型 | 有序节点链 | 数组顺序即执行顺序，驳回回退上一个节点 |
| 工具注册 | 按会话动态注册 | 避免普通会话的工具列表污染 |

---

## 十四、工作流状态通知

引擎在关键节点变更时，通过会话所属的消息通道（飞书/微信）推送状态卡片：

| 事件 | 通知内容 |
|------|---------|
| 工作流启动 | `🚀 工作流「{name}」已启动` |
| 节点完成 | `✅ 节点「{nodeName}」已完成 → 进入「{nextNodeName}」` |
| 节点驳回 | `🔄 节点「{nodeName}」被驳回：{reason} → 回退至「{targetNodeName}」` |
| 工作流完成 | `🎉 工作流「{name}」已完成，耗时 {duration}` |
| 工作流失败 | `❌ 工作流「{name}」失败：{reason}` |
| 步数熔断 | `⚠️ 工作流「{name}」已达最大步数 {maxSteps}，自动终止` |

通知固定投递到 `instance.notifyChatId`（即触发方的主用户私聊），不随 isolated 节点的 Agent 会话切换而变化。底层通过 `sync_message(message, session_key=notifyChatId)` 发送，复用现有消息链路。
