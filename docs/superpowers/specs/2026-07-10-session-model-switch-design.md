# 会话级快速切模型 + 问题卡片输入加高

日期: 2026-07-10  
状态: 待用户确认  
范围: 飞书指令/卡片 + Dashboard UI；不改通道默认模型语义（快捷切换仅本会话）

## 背景

- 已有 `/workspace` 常用目录快捷切换；模型仍主要靠 `/model ls|set`，且 `set` 写的是通道配置，注释为「下次启动生效」。
- 用户需要：**仅本会话**快速切模型；会话未拉起时也能先记下；已在跑时立刻换模但必须 **Resume 保留上下文**（禁止 Create）。
- 另：`send_question` 卡片底部输入框偏小；Dashboard 也要有快捷切模型入口。

## 目标

1. 飞书侧：常用/最近模型一键切到**当前会话**。
2. Dashboard：活跃会话行可快捷切模型（与飞书同一套 override）。
3. `/model set` 改为仅本会话（与快捷按钮一致）；通道默认模型仍由设置页维护。
4. 问题卡片输入框加高（`rows`）。
5. 会话未拉起：写 pending，唤醒时消费。

## 非目标

- 不把快捷切换写成 `channel.model`。
- 换模不用 `Agent.create`。
- 不在本需求里重做设置页「主模型/他人模型」大改。

## 数据模型

### 配置（持久化）

- `favoriteModels: { id: string; params?: string; label?: string }[]`  
  手动收藏，通道级或应用级（建议**通道级**，与通道 agentResource/apiKey 一致）。
- `recentModels: { id: string; params?: string; usedAt: number }[]`  
  自动记录，上限例如 8；成功 Create/Resume 或会话 override 生效后写入。

### 运行时（可落盘，建议与 session-routing 同级）

- `sessionModelOverride: Record<sessionKey, { model: string; modelParams?: string; updatedAt: number }>`
- `pendingModelOverride: Record<pendingKey, { model: string; modelParams?: string; updatedAt: number }>`  
  `pendingKey = chatKey + "::" + workspaceDir`（与 sessionKey 形态对齐，无 `::` 后缀时用通道当前 workspace）。

## 模型解析优先级

启动/Resume 选模时：

1. `sessionModelOverride[sessionKey]`
2. 若无：`pendingModelOverride[pendingKey]`（消费后写入 session override 并删除 pending）
3. 否则：`channel.model` / scenario 原有逻辑（主用户/他人/任务）

## 行为

### 飞书

**入口**

- `/help` 底部：收藏置顶 + 最近补充，去重后约 6 个按钮，cmd 形如 `/model use <slug或序号>`（新子命令，明确「仅本会话」）。
- `/model`：展示当前会话有效模型、override 状态、收藏/最近按钮；保留 `ls`；`set` 改为调用与 `use` 相同的会话级逻辑（文案改为「仅本会话」）。
- 收藏管理：`/model fav add|rm|ls`（可二期；一期可用设置页或 `/model ls` 长列表旁按钮）。

**有活跃会话（可 Resume 的 agentId 或 live agent）**

1. 写 `sessionModelOverride`
2. 停止当前 run（不删 resume 映射）
3. `Agent.resume(agentId, { model: 新模型 })`
4. 回执：本会话已切换为 xxx（Resume）
5. 记入 `recentModels`

**无活跃会话**

1. 写 `pendingModelOverride`
2. 回执：已记下，下次唤醒本会话用 xxx
3. 下次 Create/Resume 前合并 pending → session override

### Dashboard UI

- 活跃会话列表：已有模型 slug 展示；增加下拉/弹出：收藏+最近+「更多…」打开完整列表。
- 选择后走与飞书相同的 IPC：`setSessionModel(sessionKey, model, params)` → 有会话则 Resume 换模，无则 pending。
- 首页常用目录标签旁（或设置→通道）：管理 `favoriteModels`（增删排序），交互对齐 `favoriteWorkspaces`。

### 问题卡片输入框

- `LarkSender.buildCard` 的 `input` 增加 `rows: 3`（或可配置，默认 3）。
- 若飞书 schema 不认 `rows`，再查官方字段（如 multiline）；以真机验证为准。

## 风险与验证

- SDK `Agent.resume` 换 `model` 是否稳定：需真机验证；失败时回执明确错误，保留旧 override 或回滚。
- 同 chat 多 workspace 会话：override 必须按完整 `sessionKey`，pending 按 `chatKey::workspace`。
- CLI agent 路径：若无 Resume 等价能力，则「立刻换」降级为「下次消息再生效」并提示。

## 验收

1. 会话在跑：飞书点常用模型 → 日志 Resume + 新 model，上下文仍在，通道设置页主模型不变。
2. 会话未拉起：点切换 → pending；发消息唤醒后用新模型。
3. Dashboard 对活跃会话切换，行为与飞书一致。
4. `/model set` 只影响本会话。
5. `send_question` 输入框明显变高。
6. 未订阅 reaction 告警 / internal_ 表情 400 / 窜台修复仍保持（可同包发布）。

## 实现分期（建议）

- P0：session/pending override + Resume 换模 + `/model use|set` 会话化 + 飞书快捷按钮
- P0：Dashboard 会话行切模型
- P0：input `rows`
- P1：收藏管理 UI + `/model fav`
- P1：CLI 路径降级策略打磨
