# 验收问题报告

## 第 1 轮

### 反馈问题

1. **配置界面未体现新能力**：设置/配置指引页面仍显示旧版配置提示，未说明本期飞书排队、合并预览、Agent 现状反馈等新能力。
2. **飞书私聊连发后体验卡住**（主问题）：测试序列为先发 3 条「1」，再发 1 条「2」，随后又连发 3 条；用户侧未见合并预览或后续 Agent 进展。Daemon 日志停在：
   ```
   2026-06-27 17:59:48.235 [Daemon] INFO 消息已投递(instant): count=5 session=ch_0b1b964e|oc_52de16fe897f2693aedf41401525eaf8::/Users/kiki/doger/swg/vkk_client_flutter
   ```
   表现为 instant poll 一次性领取 5 条消息后无可见反馈，用户感知「卡住」。

### 归因结论

| 问题 | 归因 | `reason` |
|------|------|----------|
| 合并预览未出现 + instant 一次领 5 条 | **代码实现问题** | `code`（主） |
| 配置界面未体现新能力 | **原需求/范围问题** | `requirement`（附） |

**综合主归因**：`code` — 合并预览调度与 instant poll 时序导致核心验收路径失败；配置 UI 为 PRD 非目标范围内的产品期望缺口，单独记录。

### 判定依据

#### 问题 A（code）— 对照 01 验收 4 / 10 / 11

| 验收项 | PRD 要求 | 代码现状 | 偏差 |
|--------|----------|----------|------|
| **4 合并预览触发** | 同会话连发 ≥3 条且均未领取时，Agent 领取前须收到 1 次合并预览 | `scheduleMergePreview` 仅在 `pushMessage` 成功时调用（`src/daemon.ts:1167-1168`）；`POST /api/session-agent-phase` 转 `idle` 时仅 `delete` phase map（`:2133-2137`），**未**重调度预览 | Agent 从 processing 转 idle 后，若已有 ≥2 条 unclaimed，debounce 不会自动重跑 → 预览可能永久缺失 |
| **10 与流式/三态协调** | Agent 处理中不插入合并预览 | `shouldSuppressMergePreview` 在 phase=processing 或存在 `.claimed` 时返回 true（`:638-643`）→ F4 抑制逻辑正确 | 抑制本身符合 PRD，但 idle 后缺少补偿调度，导致本应触发的预览被「永久跳过」 |
| **11 预览更新** | 预览发出后再发新消息，须沿用同一 ID 并标注「已更新」 | 若预览从未发出（上述缺口），更新路径无法触发 | 违反验收 11 的前置条件 |

**instant poll 绕过预览窗口**（`src/daemon.ts:2300-2309`）：

- `blocking=false` 时直接 `claimSessionMessages` 领取全部未确认消息（日志 `count=5` 与此一致）。
- 领取后立即 `clearMergePreviewState`（`:2304`），清除 debounce 与已发预览注册。
- 用户侧永远看不到合并预览，且 Agent 侧已 claimed 5 条，与 F2.6「Agent 领取前须发预览」冲突。

**时序推断（与用户操作吻合）**：

1. 连发期间 Agent 处于 processing 或有 claimed 消息 → `shouldSuppressMergePreview` 抑制预览 debounce（符合 F4）。
2. Agent 转 idle 或新消息入队，但 idle 钩子未重调度 → 预览仍不发。
3. Electron instant poll（`wait=false`）一次性 claim 5 条 → 预览窗口关闭，用户无反馈。

#### 问题 B（requirement）— 对照 01 非目标

`01-proposal.md` 非目标明确写：「不涉及 Electron 设置界面、通道凭据配置等桌面端 UI 改造」（`:37`）。配置页未更新合并预览说明属 **PRD 范围未覆盖**，非实现偏差；若产品现要求补充，需 `/kb-revise` 扩展范围。

### 影响范围

| 模块 | 影响 |
|------|------|
| `src/daemon.ts` | `scheduleMergePreview` 触发点；`session-agent-phase` idle 钩子缺预览重调度；instant poll 路径 `clearMergePreviewState` 过早 |
| `electron/session-dispatcher.ts` / `electron/agent-sdk.ts` | 可选：phase→idle 上报后 daemon 侧补调度（根因在 daemon） |
| F1/F2/F3/F4 核心路径 | 飞书私聊连发 + Agent 忙后补发场景 |

### 后续处理路径

| 问题 | 建议路径 |
|------|----------|
| 主问题（预览缺失 + instant 绕过） | `/kb-apply` 或 `/kb-revise-apply`：新增 T-FIX — idle 后重调度 merge preview；instant poll 前确保预览 debounce 完成或 blocking 等待预览窗口 |
| 配置 UI 文案 | 产品确认后 `/kb-revise` 扩展 PRD 范围；或接受非目标、仅更新外部文档 |

### 关联验收标准

| 编号 | 摘要 | 本轮结果 |
|------|------|----------|
| **4** | 合并预览触发：连发 ≥3 条未领取，Agent 领取前收到 1 次预览 | **不通过** |
| **5** | 合并消息 ID 可见、可复制、格式正确 | **未测**（预览未出现） |
| **10** | Agent 流式/三态进行中不插入预览 | 抑制逻辑符合，但 idle 后补偿缺失导致整体路径失败 |
| **11** | 预览发出后再发消息，同一 ID 标注「已更新」 | **不通过**（预览未发出，更新路径不可达） |

## 第 2 轮

### 反馈问题

重启应用后发送**第一条**飞书消息，入队确认显示：

> 已收到。Agent 正在处理上一条，你的消息已排队（前面还有 5 条待处理）

**预期**：重启后首条应体现冷启动/空闲态（如「已收到，等待 Agent 领取」），不应误报 processing 与虚假排队数。

### 归因结论

| 问题 | 归因 | `reason` |
|------|------|----------|
| 重启首条误报 processing + 虚假排队 5 条 | **代码实现问题** | `code` |

**综合主归因**：`code` — F1 阶段推断与排队计数未区分「进程内 phase」与「磁盘遗留 `.claimed`」，重启后 stale claimed 被当作活跃 processing。

### 判定依据

#### 对照 01 验收 2 / 3 与 F1.2 / F1.3

| 验收项 | PRD 要求 | 代码现状 | 偏差 |
|--------|----------|----------|------|
| **2 Agent 现状 — 空闲** | Agent 空闲时入队反馈**不得**误报「正在处理上一条」 | `buildEnqueueStatusText`（`src/daemon.ts:1687-1709`）在 `getSessionAgentPhase` 无值时，若 `getSessionPendingCount - getSessionUnclaimedCount > 0` 即推断 `phase = "processing"` | 重启后 `sessionAgentPhaseMap` 为空，但磁盘仍存上轮未 ack 的 `.claimed`，首条被误判为 processing |
| **3 Agent 现状 — 冷启动** | Agent 未运行/刚启动时首条应体现「正在启动」或等待领取 | 同上 fallback 优先走 claimed→processing，**未**在 phase 缺失且无 live Agent 时走 `starting`/`idle` | 冷启动首条直接落入 F1.1 文案 |
| **F1.3 空闲** | 仅本条待领取时主文案「已收到，等待 Agent 领取」 | `confirmEnqueueAndStartProgress` 传入 `pending = getSessionPendingCount`（`:1756`），计数含 `.claimed` + `.qmsg`（`src/file-queue.ts:174-181`） | 1 条新 `.qmsg` + 5 条 stale `.claimed` → `pending=6`，排队提示「前面还有 5 条」 |

**根因链（与用户现象一致）**：

1. 上轮会话 Agent 领取后产生 5 条 `.claimed` 未 ack（或异常退出未清理）。
2. 应用重启 → daemon 内存 `sessionAgentPhaseMap` 清空，Electron 尚未上报 phase。
3. 用户发首条 → `pushToFileQueue` 写入 1 条 `.qmsg` → F1 调用 `getSessionPendingCount` 得 6。
4. phase fallback 见 5 条 `.claimed` → `processing` → 输出 F1.1 文案 + `pending - 1 = 5` 排队数。

**PRD 侧**：01 场景 B / 验收 2 明确要求空闲不误报 processing；T4 设计的「phase 缺失 + 存在 `.claimed` → processing」仅适用于**同进程 live 会话**，未覆盖重启 stale 场景，属实现边界遗漏而非 PRD 口径错误。

### 影响范围

| 模块 | 影响 |
|------|------|
| `src/daemon.ts` | `buildEnqueueStatusText` phase fallback；`confirmEnqueueAndStartProgress` 排队计数口径 |
| `src/file-queue.ts` | `getSessionPendingCount` 含 stale `.claimed`；可选冷启动 reclaim/隔离策略 |
| F1 入队确认 | 重启/冷启动首条及 stale 队列残留会话 |
| F4 / 合并预览 | 间接：`shouldSuppressMergePreview` 亦将 orphan `.claimed` 视为 suppress，可能连带影响重启后会话预览（本轮未复测） |

### 后续处理路径

| 问题 | 建议路径 |
|------|----------|
| 重启 stale claimed 导致 F1 误报 | `/kb-apply` **T-FIX-02**：冷启动 reclaim 或 F1 排队数改基于 `getSessionUnclaimedCount`；phase 缺失时区分 orphan claimed vs live processing（Electron 上报前默认 `starting`/`idle`） |
| 自动化回归 | 扩展 `phase-api-contract.sh` 或 08 场景：模拟 restart + orphan `.claimed` + 首条入队 |

### 关联验收标准

| 编号 | 摘要 | 本轮结果 |
|------|------|----------|
| **2** | Agent 空闲：不误报「正在处理上一条」 | **不通过**（重启首条误报） |
| **3** | 冷启动：体现正在启动/等待领取 | **不通过**（落入 F1.1 processing） |
| **1** | Agent 忙时连发：processing 文案 + 排队数正确 | **未复测**（本轮仅验 restart 首条） |
