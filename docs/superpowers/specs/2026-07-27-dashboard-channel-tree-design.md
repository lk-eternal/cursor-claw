# Dashboard 通道树改版设计

**日期:** 2026-07-27  
**状态:** 已通过产品确认（待实现计划）  
**范围:** 首页 `Dashboard.tsx` 信息架构与展示；不改设置页/通道配置表单

## 背景与问题

当前首页用四宫格 StatusCard + 顶栏「快捷会话 / 快捷模型」chip，把**通道、会话、模型、队列**拆成平行入口，层级关系弱：

- 会话切换与模型切换是页级全局条，易与「当前通道 / 当前会话」脱节（含空闲时模型高亮跨会话假象）
- 消息队列是全局面板，不挂在会话下
- Agent / 通道详情靠点卡片展开，卡片感重，扫一眼难看出从属关系

## 目标

1. **消息通道成为主体**，会话挂在通道下的分组里
2. 去掉页级快捷会话条、快捷模型条与四宫格卡片式总览
3. **模型切换**下沉到每个会话行的下拉
4. **消息队列**挂到每个会话下
5. 信息铺开为可折叠大纲树，层级一目了然
6. 日志保留但可折叠，默认收起

## 决策摘要

| 项 | 决策 |
|---|---|
| 布局 | **A 单栏大纲树**（否决双栏 / 通道 Tab） |
| 顶栏状态 | 只留 **Daemon 一行**精简状态（启停 + uptime + 关键错误） |
| 其他组划分 | 按 chatType：**私聊他人 / 群 / 项目 / 任务·临时** |
| 主用户组展示 | 运行中 + 未运行（承接现快捷会话 / 常用目录） |
| 其他组展示 | **仅运行中**；空组折叠并显示「运行 0」 |
| 日志 | 可折叠，**默认收起** |

## 信息架构

```
TitleBar（版本 · 设置）
Daemon 精简行
通道₁（名称 · 在线状态 · 可折叠；默认展开已连接）
  ├ 主用户
  │    ├ 会话行…（运行● / 未运行○）
  │    └ [+ 常用目录]
  ├ 私聊他人（仅运行中）
  ├ 群（仅运行中）
  ├ 项目（仅运行中）
  └ 任务/临时（仅运行中）
通道₂ …
▶ 日志（默认收起｜展开后：过滤 · 导出 · 复制 · 清空 · 日志流）
```

### 会话行（统一）

- 标题：现有 label 规则（主仓名 / 项目名 / 群名等）
- 运行态：● / ○；可选显示 source（sdk/cli）
- **模型下拉**：常用 ∪ 最近（`listQuickModels`）；选择调用 `setSessionModel(sessionKey, model, modelParams)`
- 操作：停止该会话（若运行）、删除可移除会话（沿用 removable）
- **展开区**：工作目录（若有）、队列计数、队列条目列表（预览 · pending/processing · 删单条）

### 主用户组特殊规则

- 数据来源：通道 `mainUserChatId` 对应会话 ∪ `listSessionTabs` 中属该通道主用户范围的 tab（main / dir）∪ favoriteWorkspaces 生成的可切换项
- 点击未运行会话：沿用 `switchSession` / 切换工作目录语义（与现快捷会话一致）
- 「当前」会话视觉标记（替代顶栏 chip 高亮）

### 其他组规则

- **私聊他人**：`chatType=p2p` 且非主用户
- **群**：`chatType=group`（非 project 语义的独立群若已映射为 project，归「项目」）
- **项目**：`chatType=project` 或 sessionKey 含 `::project_`
- **任务/临时**：`chatType=task|temp`
- 只渲染 `sessionList`（或等价运行态）中匹配项；无运行会话则组折叠

## 明确删除 / 不再展示

- 顶部 `sessionTabs` chip 条与「+常用」页级入口（「+常用」挪到主用户组下）
- 顶部 `modelTabs` 快捷模型条与页级「+常用模型」
- 四宫格：消息通道 / Agent / 消息队列 StatusCard（通道状态并入通道行；Agent 停止可保留为 Daemon 行旁或通道树工具条的次要操作，实现时二选一，默认：**通道树右上「停止全部 Agent」**）
- 全局 `showQueue` 队列面板

## 数据与 API 映射（优先复用）

| UI 需求 | 现有来源 |
|---|---|
| 通道列表与在线 | `DaemonStatus.channels` |
| 运行中会话 | `getSessionAgents` / `onSessionAgents` |
| 主用户可切换会话 | `listSessionTabs` + `switchSession` + `favoriteWorkspaces` |
| 会话诊断/Resume | 现 `sessionDiag` IPC（若有） |
| 队列 | 现刷新队列 API，按 `sessionKey` filter |
| 切模 | `setSessionModel` + `listQuickModels` |
| 主用户判定 | 通道 `mainUserEnabled` / `mainUserChatId` 与 sessionKey 前缀 chatId |

**后端：** 本轮以 UI 重组为主；若「按通道列出主用户未运行会话」现 API 不足，可小补只读聚合 IPC（例如 `listDashboardTree`），但语义不得改变调度/路由。

## 交互细节

1. 通道默认：已连接展开，未连接折叠
2. 会话默认：仅「当前主用户会话」或「有队列」的会话自动展开；其余折叠
3. 模型下拉打开时加载/使用缓存的 quickModels；切换中显示 spinner；失败 `actionError`
4. 空通道：显示「无会话」占位，不回退到旧四宫格
5. 保留引导 onboard（workspace/agent/channel 未就绪）逻辑，位置在 Daemon 行下方

## 非目标

- 设置页、ChannelPanel、Agent 资源配置重做
- 新视觉主题 / 大改色板
- 单独 ticket：空闲模型高亮假象的 store 层修复（本 IA 去掉页级高亮后大部分消解）
- 微信/飞书消息协议变更

## 实现约束

- 主要改动文件：`src/renderer/pages/Dashboard.tsx`（可拆子组件如 `ChannelTree` / `SessionRow` 降低单文件体积）
- 保持现有 electron preload API 稳定；新增聚合 API 须可选且有降级
- 不引入新依赖
- 文案简体中文

## 验收标准

1. 首页无顶栏会话 chip、无顶栏模型 chip、无四宫格通道/Agent/队列卡
2. 每个已配置通道在树中可见；主用户组可见未运行快捷会话；其他组无运行时不占大块空白
3. 在会话行切换模型，只影响该 `sessionKey`
4. 会话展开可见该会话队列；全局队列面板不存在
5. 日志默认收起，展开后与现网能力一致（过滤/导出/复制/清空）
6. Daemon 启停仍可用

## 风险

- `listSessionTabs` 今日可能按「当前 chat」过滤，多通道同时展示需核对是否丢非活跃通道的主用户 tab——不足则补聚合
- 会话行过多时纵向变长：依赖折叠 + 仅其他组显示运行中缓解
