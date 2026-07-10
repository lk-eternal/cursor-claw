# 会话级快速切模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本仓库用户规则禁止启动 subagent，勿用 subagent-driven-development）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书与 Dashboard 均可将会话模型切换为「仅本会话」；有会话则 Resume 换模保留上下文，无会话则 pending 至唤醒；顺带加高 `send_question` 输入框。

**Architecture:** 新增 session/pending model override 持久化层；启动与 Resume 选模走「override > pending > channel.model」。飞书 `/model use|set` 与 Dashboard IPC 共用同一 `setSessionModel` 入口；立刻换模只调用 `Agent.resume`，禁止 `Agent.create`。

**Tech Stack:** Electron main/preload/renderer、`@cursor/sdk`、daemon 飞书卡片、`vitest`、现有 `config-store` / `agent-sdk` / `command-handler`。

**Spec:** `docs/superpowers/specs/2026-07-10-session-model-switch-design.md`

---

## 文件结构（将创建/修改）

| 文件 | 职责 |
|------|------|
| `electron/session-model-store.ts` | session/pending override + favorite/recent 读写（新建） |
| `electron/config-store.ts` | `favoriteModels` / `recentModels` 字段 |
| `electron/agent-sdk.ts` | 选模优先级；`switchSdkSessionModel`（Resume） |
| `electron/agent-launcher.ts` | CLI 路径选模/降级提示 |
| `electron/command-handler.ts` | `/model use|set` 会话化；help 快捷按钮 |
| `electron/daemon-manager.ts` | `/help` 附带模型快捷按钮 |
| `electron/main.ts` + `preload.ts` + `src/renderer/env.d.ts` | IPC：`setSessionModel` / favorites |
| `src/renderer/pages/Dashboard.tsx` | 会话行切模型 UI；收藏管理入口 |
| `src/shared/lark-core.ts` | input `rows: 3` |
| `tests/session-model-store.test.ts` | override/pending/优先级单测 |
| `changelog.json` | 变更条目 |

---

### Task 1: session-model-store + 单测

**Files:**
- Create: `electron/session-model-store.ts`
- Create: `tests/session-model-store.test.ts`
- Modify: `electron/config-store.ts`（类型与默认值：`favoriteModels`/`recentModels`）

- [ ] **Step 1: 写失败单测**（优先级解析、pending 消费、recent 去重上限）

```ts
import { describe, it, expect, beforeEach } from "vitest"
// 测 resolveModelForSession / setPending / consumePending / pushRecent

describe("session-model-store", () => {
  it("override beats pending beats fallback", () => {
    // set override + pending + fallback → resolve === override
  })
  it("consumePending moves to override and clears pending", () => {})
  it("pushRecent dedupes and caps length", () => {})
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/session-model-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 store**

API 建议：
- `pendingKey(chatKey, workspaceDir)`
- `getSessionOverride(sessionKey)` / `setSessionOverride(...)`
- `getPending` / `setPending` / `consumePending(sessionKey)`
- `resolveModelForSession(sessionKey, fallback: {model, modelParams})`
- `pushRecentModel(...)` / `listQuickModels(channel)` → 收藏置顶 + 最近，去重 ≤6
- 落盘：`APP_DATA_DIR/session-model-overrides.json`（与 `sdk-resume-map.json` 同级）

- [ ] **Step 4: 跑测通过**

Run: `npx vitest run tests/session-model-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户明确要求提交时执行；否则跳过）

---

### Task 2: SDK Resume 换模

**Files:**
- Modify: `electron/agent-sdk.ts`（`launchSdkAgent` 选模；新增 `switchSdkSessionModel`）
- Modify: `electron/agent-launcher.ts`（CLI：写入 override；立刻换若无 Resume 则提示「下次生效」）

- [ ] **Step 1: 在 `launchSdkAgent` 开头用 `resolveModelForSession` 覆盖 `opts.model`**
- [ ] **Step 2: 实现 `switchSdkSessionModel(sessionKey, model, modelParams)`**
  1. `setSessionOverride`
  2. 若无 resumable agentId → 只写 override/pending，返回 `{ ok:true, deferred:true }`
  3. 若有 live/resumable：停当前 run（保留 resume map）→ `Agent.resume(agentId, { model })`
  4. 更新内存 session 的 model 字段；`pushRecentModel`
  5. **禁止**走 `Agent.create`
- [ ] **Step 3: 手动/日志验证路径**（有 agentId 时日志含 Resume + 新 model）
- [ ] **Step 4: Commit**（用户要求时）

---

### Task 3: 飞书 `/model` 会话化 + 快捷按钮

**Files:**
- Modify: `electron/command-handler.ts`
- Modify: `electron/daemon-manager.ts`（`/help` 按钮组装处，约常用目录旁）

- [ ] **Step 1: `/model set` 改为调用会话级 `setSessionModel`（不再 `updateChannel({model})`）**
- [ ] **Step 2: 新增 `/model use <slug|序号>`（与 set 同逻辑，文案「仅本会话」）**
- [ ] **Step 3: `/model info` 显示：有效模型、是否 override、通道默认（只读对照）**
- [ ] **Step 4: `/help` 与 `/model` 卡片附加 `listQuickModels` 按钮（cmd=`/model use ...`）**
- [ ] **Step 5: 解析 chatId→sessionKey**：有 activeSessionMap 用完整 key；否则 pendingKey(chatKey, channel.workspaceDir)
- [ ] **Step 6: 飞书侧手测清单**（写入计划备注，实现后勾选）

---

### Task 4: Dashboard IPC + UI

**Files:**
- Modify: `electron/main.ts`、`electron/preload.ts`、`src/renderer/env.d.ts`
- Modify: `src/renderer/pages/Dashboard.tsx`
- Modify: `src/renderer/pages/Settings.tsx`（通道收藏模型管理，可简：增删列表）

- [ ] **Step 1: IPC `session:set-model` / `session:list-quick-models` / `config` 已含 favorites**
- [ ] **Step 2: 活跃会话行：模型 slug 可点击 → 下拉收藏+最近+更多**
- [ ] **Step 3: 选择后调 `setSessionModel`；成功 toast/日志**
- [ ] **Step 4: 设置页或 Dashboard 管理 `favoriteModels`（对齐 favoriteWorkspaces 交互）**

---

### Task 5: 问题卡片输入加高

**Files:**
- Modify: `src/shared/lark-core.ts` `buildCard` input 元素

- [ ] **Step 1: input 增加 `rows: 3`（及文档允许的 multiline 字段）**
- [ ] **Step 2: 发一张 `send_question` 真机看高度；若无效查飞书卡片 2.0 input 字段再补**

---

### Task 6: 收尾

**Files:**
- Modify: `changelog.json`
- 可选：规则里若仍写「/model 写配置」则改文案

- [ ] **Step 1: changelog 条目**（会话级切模型、Resume 换模、Dashboard、input rows）
- [ ] **Step 2: `npm test` + `npx tsc` 相关工程**
- [ ] **Step 3: 询问用户是否 `npm run pack:local`**
- [ ] **Step 4: 提交（用户要求时）

---

## 实现时注意

1. 用户规则：不启动 subagent；Windows 文件 CRLF；不主动 commit/push。
2. 已有未打包修复一并带上：`internal_` send-text 窜台、跳过 internal_ 表情、SILENT_LOGGER 消 reaction 告警。
3. 每完成一个 Task 用飞书/Dashboard 做一次最小验证再进下一 Task。
