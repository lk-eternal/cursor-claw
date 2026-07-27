# Dashboard 通道树改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本仓库用户规则禁止启动 subagent，勿用 subagent-driven-development）。Steps use checkbox (`- [ ]`) syntax for tracking。**改码前须用户明确同意；commit 仅当用户要求。**

**Goal:** 将首页从四宫格 + 页级快捷会话/模型条，改成「消息通道 → 分组 → 会话 → 队列」单栏大纲树；模型在会话行下拉；日志默认可折叠收起。

**Architecture:** 抽出纯函数 `buildDashboardTree`（可单测）把 channels / running sessions / per-channel 主用户可切换项 / queue 合成树；Electron 增加只读 IPC `session:dashboard-tree`（按通道聚合，弥补现 `listSessionTabs` 只绑一个 mainChatId 的缺口）；`Dashboard.tsx` 拆出展示组件渲染树并删掉旧 chip/四宫格。

**Tech Stack:** React + Tailwind（现有渲染器）、Electron IPC、vitest、现有 `session-dispatcher` / `session-model-store` / queue API。

**Spec:** `docs/superpowers/specs/2026-07-27-dashboard-channel-tree-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/shared/dashboard-tree.ts` | 纯函数：分组规则、树节点类型、`buildDashboardTree` |
| `tests/dashboard-tree.test.ts` | 分组/主用户未运行/他组仅运行中 单测 |
| `electron/session-dispatcher.ts` | `listDashboardTree()`：按通道拉主用户 tabs + 运行会话标签 |
| `electron/daemon-manager.ts` | 注册 `session:dashboard-tree` |
| `electron/preload.ts` + `src/renderer/env.d.ts` | 暴露 IPC 类型 |
| `src/renderer/components/dashboard/ChannelTree.tsx` | 通道/组/会话树 UI |
| `src/renderer/components/dashboard/SessionRow.tsx` | 会话行：模型下拉、展开队列 |
| `src/renderer/components/dashboard/DaemonStrip.tsx` | Daemon 精简行 |
| `src/renderer/pages/Dashboard.tsx` | 组装：去掉 chip/四宫格；接树；日志默认收起 |
| `changelog.json` | 实现完成后补条目（发版时） |

---

### Task 1: 纯函数树模型 + 单测

**Files:**
- Create: `src/shared/dashboard-tree.ts`
- Create: `tests/dashboard-tree.test.ts`

- [ ] **Step 1: 写失败单测**

```ts
import { describe, it, expect } from "vitest"
import { buildDashboardTree, classifySessionGroup } from "../src/shared/dashboard-tree.js"

describe("classifySessionGroup", () => {
  it("maps project_ key to project", () => {
    expect(classifySessionGroup("ch_x|ou_y::project_abc", "project")).toBe("project")
  })
  it("maps non-main p2p to other_p2p", () => {
    expect(classifySessionGroup("ch_x|ou_other::D:\\ws", "p2p", { mainChatId: "ch_x|ou_main" })).toBe("other_p2p")
  })
  it("maps main p2p to main", () => {
    expect(classifySessionGroup("ch_x|ou_main::D:\\ws", "p2p", { mainChatId: "ch_x|ou_main" })).toBe("main")
  })
})

describe("buildDashboardTree", () => {
  it("main group keeps idle switchable sessions; other groups only running", () => {
    const tree = buildDashboardTree({
      channels: [{ id: "c1", name: "飞书", connected: true, mainUserChatId: "ch|ou_main" }],
      running: [
        { sessionKey: "ch|ou_main::D:\\a", chatType: "p2p", model: "grok-4.5" },
        { sessionKey: "ch|ou_other::D:\\b", chatType: "p2p", model: "composer-2.5" },
      ],
      mainSwitchable: [
        { channelId: "c1", sessionKey: "ch|ou_main::D:\\idle", label: "idle-dir", kind: "dir" },
      ],
      activeKeyByChat: { "ch|ou_main": "ch|ou_main::D:\\a" },
      queue: [],
    })
    const ch = tree.channels[0]
    expect(ch.groups.main.sessions.map((s) => s.sessionKey)).toEqual([
      "ch|ou_main::D:\\a",
      "ch|ou_main::D:\\idle",
    ])
    expect(ch.groups.other_p2p.sessions).toHaveLength(1)
    expect(ch.groups.group.sessions).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/dashboard-tree.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/shared/dashboard-tree.ts`**

导出类型（保持精简）：

```ts
export type SessionGroupId = "main" | "other_p2p" | "group" | "project" | "task"

export interface DashboardSessionNode {
  sessionKey: string
  label: string
  group: SessionGroupId
  running: boolean
  current?: boolean
  removable?: boolean
  chatType?: string
  model?: string
  modelParams?: string
  workspaceDir?: string
  queue: { fileId: string; preview: string; status?: "pending" | "processing" }[]
}

export interface DashboardChannelNode {
  channelId: string
  name: string
  connected: boolean
  mainUserChatId?: string
  groups: Record<SessionGroupId, { sessions: DashboardSessionNode[] }>
}

export function classifySessionGroup(
  sessionKey: string,
  chatType: string | undefined,
  opts?: { mainChatId?: string },
): SessionGroupId { /* project_ / temp|task / group / p2p vs mainChatId */ }

export function buildDashboardTree(input: { /* 见单测 */ }): { channels: DashboardChannelNode[] }
```

规则对齐 spec：主用户组合并 running∪switchable；其他组只留 `running===true`；队列按 `sessionKey` 挂载（大小写路径用已有 normalize 思路，简单 `===` 不够时对 win 做 lower-case 比较）。

- [ ] **Step 4: 跑测通过**

Run: `npx vitest run tests/dashboard-tree.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**（仅用户要求时）

---

### Task 2: IPC `session:dashboard-tree`

**Files:**
- Modify: `electron/session-dispatcher.ts`（新增 `listDashboardTree`）
- Modify: `electron/daemon-manager.ts`（`ipcMain.handle("session:dashboard-tree", ...)`）
- Modify: `electron/preload.ts`、`src/renderer/env.d.ts`

- [ ] **Step 1: 实现 `listDashboardTree`**

伪代码（放在 `session-dispatcher.ts`，复用现有 helper，勿复制粘贴大段逻辑）：

```ts
export async function listDashboardTree(): Promise<{
  ok: boolean
  channels: Array<{
    channelId: string
    name: string
    connected: boolean
    mainUserChatId?: string
    mainTabs: SessionTabItem[]  // 该通道主用户：running+switchable+current
    activeKey?: string
  }>
  running: ReturnType<typeof getSessionAgentList>
  error?: string
}> {
  const cfg = getConfig()
  const allRunning = getSessionAgentList()
  const channels = (cfg.channels ?? []).filter((c) => c.enabled)
  const out = []
  for (const c of channels) {
    const mainChatId = c.mainUserEnabled ? c.mainUserChatId?.trim() : ""
    // 对每个有 mainChatId 的通道：复用 buildSwitchableSessions + sessionBelongsToChat
    // 无主用户：mainTabs = []，运行会话仍可在 UI 侧靠 chatType 归入其他组
    ...
  }
  return { ok: true, channels: out, running: allRunning }
}
```

注意：今日 `listMainSessionTabs` 只服务 `resolveMainChatId()`；新 API 必须 **按配置里每个通道自己的 `mainUserChatId`** 迭代，不能只打主私聊。

- [ ] **Step 2: 注册 IPC + preload**

```ts
// daemon-manager
ipcMain.handle("session:dashboard-tree", () => listDashboardTree())

// preload
listDashboardTree: () => ipcRenderer.invoke("session:dashboard-tree"),
```

`env.d.ts` 同步类型。

- [ ] **Step 3: 本地手工冒烟**

Run: 启动应用或 `npm run typecheck`  
Expected: typecheck 通过；DevTools 里 `window.electronAPI.listDashboardTree()` 返回多通道结构（若仅一通道则一组）。

- [ ] **Step 4: Commit**（仅用户要求时）

---

### Task 3: UI 组件 DaemonStrip + SessionRow + ChannelTree

**Files:**
- Create: `src/renderer/components/dashboard/DaemonStrip.tsx`
- Create: `src/renderer/components/dashboard/SessionRow.tsx`
- Create: `src/renderer/components/dashboard/ChannelTree.tsx`

- [ ] **Step 1: `DaemonStrip`**

从 Dashboard 挪出 Daemon 启停/uptime/错误展示；**不要** StatusCard 外框，一行 `flex` 即可。Props：`status`、`onStart`、`onStop`、loading flags。

- [ ] **Step 2: `SessionRow`**

Props 含 `node`、`quickModels`、`expanded`、`onToggle`、`onSwitchModel`、`onStop`、`onDelete`、`onSwitchSession`（未运行主用户）、`onDeleteQueueItem`。

- 行内：`●/○` + label + `<select>` 或现有下拉菜单切模型（调用父级 `setSessionModel`）
- 展开：workspaceDir、队列列表（复用现 preview/status/删单条 UI，去掉卡片阴影）

- [ ] **Step 3: `ChannelTree`**

- 映射 `buildDashboardTree` 结果
- 组标题中文：`主用户` / `私聊他人` / `群` / `项目` / `任务/临时`
- 空其他组：折叠 + `运行 0`
- 主用户组底：`+ 常用` 触发现 `addFavoriteWorkspace`
- 右上可选「停止全部 Agent」按钮（替代原 Agent 卡）

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`  
Expected: PASS

---

### Task 4: 改造 `Dashboard.tsx` 组装

**Files:**
- Modify: `src/renderer/pages/Dashboard.tsx`

- [ ] **Step 1: 删除 UI**

删除/停用：
- 四宫格里「消息通道 / Agent / 消息队列」三张卡（保留逻辑可内联到树）
- `sessionTabs.map` 顶栏 chip
- `modelTabs.map` 顶栏模型 chip
- `showChannels` / `showSessions` / `showQueue` 全局展开面板

- [ ] **Step 2: 接入树**

```ts
// 轮询或与 sessionList 更新时：
const dash = await window.electronAPI.listDashboardTree()
const queue = await window.electronAPI.getQueueMessages()
const tree = buildDashboardTree({ channels: dash.channels, running: dash.running, ... queue })
```

渲染顺序：`TitleBar` → `DaemonStrip` → onboard（若有）→ `ChannelTree` → 可折叠日志（**默认 `showLogs=false`**）。

- [ ] **Step 3: 切模目标**

删除 `resolveModelTargetSession` 页级猜测；`SessionRow` 一律带自己的 `sessionKey` 调用 `setSessionModel`。

- [ ] **Step 4: 手工验收（对照 spec 验收标准 1–6）**

- [ ] **Step 5: Commit**（仅用户要求时）

---

### Task 5: changelog（实现合并进发版前）

**Files:**
- Modify: `changelog.json`

- [ ] 在下一版本（或补丁版本）`changes` 增加一条简述通道树首页改版。  
- [ ] 不在本任务擅自 bump 版本 / 打 tag（另按升级流程）。

---

## Spec 覆盖自检

| Spec 要求 | Task |
|-----------|------|
| 单栏大纲树 A | 3–4 |
| 只留 Daemon 一行 | 3 DaemonStrip + 4 |
| 按 chatType 多组 | 1 classify + 4 |
| 主用户运行+未运行 | 1 + 2 IPC |
| 他组仅运行中 | 1 |
| 模型会话行下拉 | 3 SessionRow |
| 队列挂会话 | 1 queue 挂载 + 3 |
| 去 chip / 四宫格 / 全局队列 | 4 |
| 日志默认收起 | 4 |
| 多通道主用户 tabs | 2（补齐 listMainSessionTabs 缺口） |

## 执行方式说明

本仓库禁止 Task/subagent：实现时用 **Inline Execution（executing-plans）**，按 Task 顺序在本会话推进；每 Task 结束后用 `send_text`/`send_question` 向用户同步并征求是否继续。
