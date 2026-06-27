# 飞书临时会话工作目录可选 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 1、执行计划

### （一）依赖图

```
T4（独立）
T1 ──→ T2 ──→ T3 ──→ T5
T4 ────────────────→ T5
```

**文件冲突说明**：T1、T2、T3 均修改 `electron/session-dispatcher.ts`，须严格串行，不得并行。T4 仅改 `src/daemon.ts` 与 `electron/daemon-manager.ts`，可与 T1 并行；T3 含 `handleChatCommand` 底部用法行，T4 不改该文件。

**CodeGraph 影响面摘要**（`projectPath: /Users/kiki/github/cursor-claw`）：

| 符号 | 文件 | 变更类型 | 调用方/影响 |
|------|------|----------|-------------|
| `handleChatCommand` | `session-dispatcher.ts:429` | 改动 | 唯一调用方 `daemon-manager.ts:checkAndExecutePendingCommands` |
| `launchIndependentAgent` | `session-dispatcher.ts:375` | 签名扩展 | `handleChatCommand`；间接经 `daemon-manager` 启动链路 |
| `launchAgent` | `session-dispatcher.ts:303` | 改动 mkdir 分支 | `launchIndependentAgent`、`launchWorkflowAgent`、`launchSessionAgent` |
| `launchWorkflowAgent` | `session-dispatcher.ts:386` | 不改逻辑，须回归 | `workflow-runner.ts` |
| `effectiveWorkspaceDir` | `config-store.ts:207` | 复用 | `launchAgent`、`resolveCommandSessionKey` |
| `parseTaskUpdateArgs` | `command-handler.ts:213` | 参考旗标风格 | 无直接依赖 |

### （二）分组调度

- **第一轮（并行）**：T1、T4
- **第二轮**：T2
- **第三轮**：T3
- **第四轮**：T5（手动回归；覆盖 01 验收 1–8 与 02 §8.2 工程补充项）

## 2、任务清单

## T1: `/chat new` 参数解析与目录校验函数

### 背景

飞书管理员创建临时会话时需可选指定工作目录（`-dir` 旗标）。在 `handleChatCommand` 改造前，先在 `session-dispatcher.ts` 内实现两个内联函数：`parseChatNewArgs` 解析任务描述与可选目录，`validateWorkspacePath` 在创建前校验路径存在、可读且为目录。校验失败须在此层返回用户可理解的中文错误，供 T3 早返回且不切换活跃路由。

### 上下文文件

- CodeGraph: `parseTaskUpdateArgs` `handleWorkspaceAdmin` — 旗标解析风格与 exists 校验参考
- 必读: `electron/session-dispatcher.ts` — 文件顶部 import（`fs`、`path` 等）；`handleChatCommand` `sub === "new"` 分支（L452–477）理解现网 token 处理方式
- 必读: `electron/command-handler.ts` — `parseTaskUpdateArgs`（L213–247）旗标 `-name/-cron/-content` 解析模式
- 参考: `src/daemon.ts` — `handleWorkspaceAdmin`（L1725–1754）`existsSync` 用法
- 参考: `electron/config-store.ts` — `effectiveWorkspaceDir`（L207–210）供 T3 默认目录分支调用

### 实现范围

- 修改: `electron/session-dispatcher.ts`
  - **新增** `parseChatNewArgs(tokens: string[])`：从 `/chat new` 的 token 列表（即 `tokens.slice(2)` 传入）解析：
    - 支持 `-dir <路径>` 旗标，与任务描述顺序任意（与 `/task update` 旗标风格一致）
    - `-dir` 后路径允许多 token join（含空格路径，与 `/workspace set` 一致）
    - 缺少任务描述 → `{ ok: false, error: 含 -dir 示例的用法说明 }`
    - 成功 → `{ ok: true, taskMsg: string, workingDirectory?: string }`
  - **新增** `validateWorkspacePath(dir: string)`：
    - `trim` → `path.resolve` → `fs.existsSync` → 非目录（含指向文件）→ `fs.accessSync(R_OK)`
    - 成功 → `{ ok: true, resolved: string }`
    - 失败 → `{ ok: false, error: string }`，文案见接口契约
  - 两函数暂不被 `handleChatCommand` 调用（T3 接线）；可导出为模块内函数或同文件非 export 函数

### 接口契约

- `parseChatNewArgs(tokens: string[]): { ok: true; taskMsg: string; workingDirectory?: string } | { ok: false; error: string }`
- `validateWorkspacePath(dir: string): { ok: true; resolved: string } | { ok: false; error: string }`
- 错误文案（用户可见简体中文）：
  - 路径不存在：`目录不存在，请检查路径或省略 -dir 使用当前主会话目录`
  - 无读权限：`无法访问该目录，请检查权限或改用其他路径`
  - 路径为文件（非目录）：友好错误，不创建会话（02 §8.2）
  - 主目录未配置（T3 对默认分支调用时）：`工作目录未配置，请先在设置中配置主工作目录`
- 对外指令语法（供 T3/T4 文案对齐）：
  - `/chat new <任务描述> [-dir <工作目录路径>]`
  - `/chat new -dir <工作目录路径> <任务描述>`

### 验收标准

- [ ] `parseChatNewArgs(["修复样式"])` → `taskMsg="修复样式"`，无 `workingDirectory`
- [ ] `parseChatNewArgs(["-dir", "/path/a", "修复样式"])` 与 `["修复样式", "-dir", "/path/a"]` 均解析正确
- [ ] `-dir` 后多 token 路径 join 正确（含空格目录名）
- [ ] 仅 `-dir` 无任务描述、空任务描述 → 返回用法错误，含 `-dir` 示例
- [ ] `validateWorkspacePath` 对不存在路径、无权限路径、文件路径返回对应友好错误
- [ ] 对有效目录返回 `resolved` 为绝对路径
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T2、T3

---

## T2: 调度层透传工作目录并修正 temp mkdir 行为

### 背景

`launchIndependentAgent` 当前未接受 `workingDirectory`，temp 会话工作目录固定走 `launchAgent` 内 `effectiveWorkspaceDir`。同时 `launchAgent` L318–320 对任意显式 `workingDirectory` 会 `mkdirSync`，与用户指定且已校验存在的目录语义冲突（PRD F2.3）。本任务扩展签名并区分 temp 与工作流 mkdir 行为，为 T3 绑定 per-temp 目录做准备。

### 上下文文件

- CodeGraph: `launchIndependentAgent` `launchAgent` `launchWorkflowAgent` — 调度链与 mkdir 分支
- 必读: `electron/session-dispatcher.ts` — `LaunchAgentParams`（L287–301）、`launchAgent`（L303–365）、`launchIndependentAgent`（L375–384）、`launchWorkflowAgent`（L386–401）
- 参考: `electron/agent-launcher.ts` — `SessionAgent.workspaceDir`（L27 附近）确认目录写入内存 Map
- 参考: `electron/config-store.ts` — `effectiveWorkspaceDir` 默认目录取值

### 实现范围

- 修改: `electron/session-dispatcher.ts`
  - **扩展** `launchIndependentAgent(..., workingDirectory?: string)` 末参，透传至 `launchAgent({ workingDirectory })`
  - **调整** `launchAgent` 中 `p.workingDirectory` 分支（L318–320）：
    - 当 `chatType === "temp"` 且 `workingDirectory` 显式传入：**禁止** `mkdirSync`（路径须已在 T1/T3 校验存在）
    - 当 `chatType === "workflow"` 且显式传入：保留现有自动 `mkdirSync` 行为（工作流节点目录可能不存在）
    - 其他 chatType 行为不变
  - 未传 `workingDirectory` 时 temp 仍用 `effectiveWorkspaceDir(channel)`（现网默认）

### 接口契约

- `launchIndependentAgent(taskId, taskName, message, type?, chatId?, channelId?, model?, modelParams?, workingDirectory?: string): Promise<{ ok: boolean; error?: string }>`
- `launchAgent` temp + 显式 `workingDirectory`：直接使用 resolved 路径，不创建目录
- `launchWorkflowAgent` 行为不变：显式目录仍可自动 mkdir

### 验收标准

- [ ] temp 创建传入已存在目录时 `SessionAgent.workspaceDir` 等于该目录，且不触发 mkdir
- [ ] temp 未传 `workingDirectory` 时仍等于 `effectiveWorkspaceDir(通道)`
- [ ] 工作流 `launchWorkflowAgent` 对不存在节点目录仍能自动创建（02 §8.2 无回归）
- [ ] SDK 与 CLI 双资源路径下 `workspaceDir` / `LARK_WORKSPACE_DIR` 均正确传入 Agent 启动参数（02 §8.2）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1
- 后续任务: T3

---

## T3: `handleChatCommand` `/chat new` 分支集成与成功反馈

### 背景

将会话创建主路径从「整段 token 作任务描述」改为：解析 → 目录校验 → 失败早返回 → 成功启动 temp Agent → 切换活跃路由 → 展示含任务摘要、**完整**工作目录与会话标识的成功反馈。这是 01 F1–F5 与场景 A–E 的核心落点；群聊/他人会话不触及（仍仅管理员主私聊路径）。

### 上下文文件

- CodeGraph: `handleChatCommand` `previousActiveSessionMap` `syncActiveSession` `getCurrentActiveSession` — 创建与路由切换链
- 必读: `electron/session-dispatcher.ts` — T1 新增函数；T2 扩展后的 `launchIndependentAgent`；`handleChatCommand` `new` 分支（L452–477）；`previousActiveSessionMap`（L70）；底部 `/chat` 用法行（L521）
- 必读: `electron/daemon-client.ts` — `syncActiveSession`（L57）、`getCurrentActiveSession`
- 参考: `electron/daemon-manager.ts` — `/chat` 路由（L1065–1068）确认仅管理员调用
- 参考: `electron/config-store.ts` — `getChannel`、`effectiveWorkspaceDir` 解析默认目录

### 实现范围

- 修改: `electron/session-dispatcher.ts` — `handleChatCommand` `sub === "new"` 分支重写：
  1. 调用 `parseChatNewArgs(tokens.slice(2))`；失败 → `reply(false, error)` 返回
  2. 确定目标目录：有 `workingDirectory` 则 `validateWorkspacePath`；无则取 `effectiveWorkspaceDir(getChannel(...))` 并同样 `validateWorkspacePath`（主目录未配置时友好错误）
  3. 校验失败 → `reply(false, error)`，**不**调用 `launchIndependentAgent`、**不** `syncActiveSession`、**不**写入 `previousActiveSessionMap`
  4. 校验成功 → `launchIndependentAgent(taskId, "临时会话", taskMsg, "temp", chatId, undefined, undefined, undefined, resolvedDir)`
  5. 启动成功且 `chatId` 存在：记录 `previousActiveSessionMap`、`syncActiveSession`（逻辑与现网一致）
  6. 成功反馈文案改动：
     - 含**任务摘要**（`taskMsg` 或等价确认行）
     - **完整** `workspaceDir` 路径（禁止仅用 `path.basename`）
     - 会话标识 `SessionKey: temp_*`
     - 保留类型、PID、启动时间、切换提示行
  7. 更新文件底部 `/chat` 用法说明，含 `-dir` 示例与「省略 -dir = 当前主会话目录」
- 不改: `handleSessionClosed`、群聊/他人 `launchAgent` 隔离目录分支、`/chat ls` basename 展示（02 §8.2 允许 ls 仍用 basename）

### 接口契约

- `/chat new` 完整行为契约（见 T1 语法与错误文案）
- 校验失败时活跃会话不变：`getCurrentActiveSession` 与创建前一致（02 §8.2）
- 成功反馈必含三要素：任务确认、完整目录路径、会话标识（01 F3、验收 4）
- 指定目录仅绑定本次 temp；主会话 `/workspace` 与配置不被覆盖（01 F5、场景 B）

### 验收标准

- [ ] **默认目录（01 验收 1）**：主目录为 A，不指定 `-dir` 创建 temp，反馈展示完整路径 A；temp 内 Agent 在 A 下运行
- [ ] **指定有效目录（01 验收 2）**：指定 B≠A，反馈展示 B；主会话仍为 A；temp 结束后回退主会话且主目录仍为 A
- [ ] **无效目录（01 验收 3）**：不存在/不可访问/文件路径 → 不创建 temp、活跃会话不变、友好错误；修正后可成功创建
- [ ] **创建反馈完整性（01 验收 4）**：默认 1 次 + 指定 2 次不同路径，均含任务确认与完整目录路径
- [ ] **行为无回归（01 验收 5）**：切换、temp 内对话、结束回退与现网一致
- [ ] **边界隔离（01 验收 6）**：群聊/他人私聊无 `-dir` 入口变化；Settings 主工作目录 UI 无改动
- [ ] **并发与顺序（01 验收 7）**：连续创建两个 temp 指定不同目录，各自绑定正确、无串用
- [ ] **校验失败活跃路由（02 §8.2）**：失败前后 `getCurrentActiveSession` 一致
- [ ] **`/chat` 切换反馈（02 §8.2）**：`/chat <序号>` 切换 temp 时工作目录展示与绑定一致（全路径）
- [ ] **主目录后续变更（01 F5.1）**：temp 运行中修改主会话目录不影响已创建 temp 的 `workspaceDir`
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1、T2
- 后续任务: T5

---

## T4: 指令帮助文案补充可选 `-dir`

### 背景

01 验收 8 与 F1 要求管理员可在帮助/说明中查到「可选工作目录、默认等于主会话目录、无效则不创建」三条要点。本任务更新 Daemon 内置指令表与管理员 `/help` 列表中的 `/chat` 描述；`handleChatCommand` 底部用法由 T3 更新，本任务不重复修改 `session-dispatcher.ts`。

### 上下文文件

- CodeGraph: `COMMANDS` `/help` `/chat` — 帮助文案落点
- 必读: `src/daemon.ts` — `COMMANDS` 对象（L1037 附近 `/chat` 一行）
- 必读: `electron/daemon-manager.ts` — `case "/help"` adminOnly 列表（L1071–1093）
- 参考: T1 接口契约中的 `/chat new` 语法与默认规则文案

### 实现范围

- 修改: `src/daemon.ts` — `COMMANDS["/chat"]` 字符串：补充 `/chat new <描述> [-dir <路径>]`、省略 `-dir` 时使用当前主会话工作目录、无效目录不创建
- 修改: `electron/daemon-manager.ts` — `/help` 管理员列表中 `/chat 会话管理` 一行或相邻补充说明（可选 `-dir` 与默认规则，保持简洁一行或两行）
- 不改: MCP `handleAgentAdmin` launch、Daemon `__IND_LAUNCH__`（02 明确本期不扩展 `-dir`）

### 接口契约

- 用户可见帮助须包含三要点：可选 `-dir`、默认=当前主会话目录、无效目录不创建临时会话
- 语法与 T1/T3 一致：`-dir` 旗标，非 positional 第二参数

### 验收标准

- [ ] **文档与帮助（01 验收 8）**：`/help` 或内置 `/chat` 说明可查到上述三要点
- [ ] `src/daemon.ts` `COMMANDS["/chat"]` 与 T3 底部用法语义一致，无矛盾
- [ ] 未改动 Settings UI、群聊/他人帮助范围
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无（可与 T1 并行；文案以 T1 契约为准）
- 后续任务: T5

---

## T5: 端到端回归与范围确认

### 背景

整合 T1–T4 后，按 01 全部验收标准与 02 §8.2 工程补充项做手动回归，确认飞书管理员主路径、工作流 mkdir 无回归，并明确 MCP/Daemon `action=launch` 本期范围。

### 上下文文件

- 必读: 本文件 T1–T4 各任务验收标准（汇总执行）
- 必读: `electron/session-dispatcher.ts` — 最终实现只读核对
- 参考: `src/daemon.ts` — `handleAgentAdmin` `action=launch`（L1763–1770）确认未扩展 `-dir`
- 参考: `electron/daemon-manager.ts` — `__IND_LAUNCH__` 处理（L576 附近）确认未扩展

### 实现范围

- 无代码修改（纯验证任务）；若发现缺陷记录至 `04-test-report.md` 或触发 `/kb-revise`，不在本任务内修复
- 验证环境：飞书管理员私聊 + 至少两个不同本地项目目录 A、B
- **范围外确认**：MCP/Daemon `POST /api/agents` `action=launch` 创建 temp **本期不扩展 `-dir`**，该路径仍用默认主会话目录；在测试报告中注明，不作为本变更阻塞项

### 接口契约

- 无新增接口；验证 T1–T4 契约在运行态成立

### 验收标准

- [ ] 01 验收 1–7 全部通过（见 T3 细则，本任务做端到端复验）
- [ ] 01 验收 8 通过（T4 帮助三要点可查到）
- [ ] 02 §8.2 全部五项通过：
  - [ ] `-dir` 指向文件时友好错误且不创建
  - [ ] 校验失败活跃路由不变
  - [ ] `/chat ls` basename 与切换全路径展示一致
  - [ ] SDK/CLI 双资源 temp 指定目录正确
  - [ ] 工作流自动 mkdir 无回归
- [ ] 非飞书通道、群聊、他人私聊行为与变更前一致
- [ ] MCP/Daemon `action=launch` 范围已记录：无 `-dir`，仍默认目录（待确认项 closure）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T3、T4
- 后续任务: 无（通过后进入 `/kb-archive`）

---

## Rev1 任务（`/kb-revise`，2026-06-27）

> 来源：`07-prd-revisions.md` Rev1；实现请用 `/kb-revise-apply`。

### （一）依赖图

```
T-Rev1-01 ──→ T-Rev1-02
T-Rev1-01 ──→ T-Rev1-03
T-Rev1-02 ──→ T-Rev1-03
```

### （二）分组调度

- **第一轮**：T-Rev1-01（类型 + 调度分支，阻塞 UI）
- **第二轮**：T-Rev1-02（ChannelPanel）
- **第三轮**：T-Rev1-03（贯通验收与文案对齐）

---

## T-Rev1-01: 配置字段与 `launchAgent` 他人目录分支

### 背景

Rev1 要求「允许其他人使用」开启时可选择临时目录（现网隔离）或指定目录（留空=主会话目录）。需在 `MessageChannel` 持久化新字段，并在 `launchAgent` 他人/群聊分支按模式解析工作目录，替代当前固定 `userData/workspaces/{safeKey}` 逻辑。

### 上下文文件

- CodeGraph: `launchAgent`（`session-dispatcher.ts:303`）他人分支 L324–328；`effectiveWorkspaceDir`（`config-store.ts:207`）；`MessageChannel`（`channel-types.ts:15`）；`getChannels` 迁移兜底（`config-store.ts:139`）
- 必读: `electron/session-dispatcher.ts` — `launchAgent` else 分支；`validateWorkspacePath`（T1 已实现）
- 必读: `src/shared/channel-types.ts`、`electron/preload.ts`、`src/renderer/env.d.ts`
- 必读: `electron/config-store.ts` — `getChannels`、`saveChannel`
- 参考: `02-design.md` Rev1·（一）（二）

### 实现范围

- **新增** `MessageChannel.othersWorkspaceMode: "isolated" | "specified"`（默认 `"isolated"`）
- **新增** `MessageChannel.othersWorkspaceDir: string`（默认 `""`）
- `getChannels` 读时兜底上述默认值（旧通道兼容现网）
- 同步 `preload.ts` `MessageChannel`、`env.d.ts` `ChannelConfig`
- **改动** `launchAgent`：`!useMain && !isOwnTask` 分支按 Rev1·（二）三分支解析；`specified` + 非空路径须校验存在可读且不自动 mkdir；建议内联 `resolveOthersWorkspaceDir`
- 不改：temp `/chat new -dir`、主用户 `effectiveWorkspaceDir`、workflow mkdir 行为

### 接口契约

- `othersWorkspaceMode: "isolated"` → `path.join(app.getPath("userData"), "workspaces", safeChatId)`（可 mkdir）
- `othersWorkspaceMode: "specified"` + `othersWorkspaceDir.trim() === ""` → `effectiveWorkspaceDir(channel)`
- `othersWorkspaceMode: "specified"` + 非空路径 → `validateWorkspacePath` 通过后使用 resolved 路径
- 校验失败 → `{ ok: false, error: 用户可理解中文 }`，不启动 Agent

### 验收标准

- [ ] 旧配置无新字段时行为与现网一致（isolated + 隔离目录）
- [ ] isolated 模式下两不同 chatKey 的 `workspaceDir` 路径不同
- [ ] specified + 留空：他人会话目录等于 `effectiveWorkspaceDir(通道)`
- [ ] specified + 有效路径 B：他人会话在 B 运行
- [ ] specified + 无效路径：友好错误，不启动
- [ ] temp `/chat new -dir` 与主用户目录逻辑无回归（01 验收 1–5）
- [ ] 无 `02`/`03` 未要求的抽象层或未批准的新依赖

### 依赖

- 前置任务: 无（T1–T5 已完成）
- 后续任务: T-Rev1-02、T-Rev1-03

---

## T-Rev1-02: ChannelPanel 配置页 UI

### 背景

08 验收第 1 轮：桌面端通道配置页未体现 `-dir` 说明，且「允许其他人使用」区缺少工作目录模式配置。本任务在 `ChannelPanel` 补充主用户临时会话说明与他人目录模式 UI，并绑定 Rev1 新配置字段。

### 上下文文件

- CodeGraph: `ChannelPanel`（`ChannelPanel.tsx:38`）；现「允许其他人使用」L611–630；「主用户绑定」L572–609；高级「通道工作目录」L638–649
- 必读: `src/renderer/components/ChannelPanel.tsx` — `emptyChannel`、`persistChannels`、编辑 draft 状态
- 必读: `02-design.md` Rev1·（三）UI 布局
- 参考: T4 文案 — `/chat new` 语法与三要点

### 实现范围

- **主用户区**：新增 `text-xs` 帮助块，说明 `/chat new [-dir]`、省略 `-dir` 默认、无效不创建
- **允许其他人使用区**（`allowOthers` 为 true）：
  - 单选/分段：临时目录 vs 指定目录 → 绑定 `othersWorkspaceMode`
  - 指定目录模式下路径选择器 + 清除 → 绑定 `othersWorkspaceDir`；留空展示「与主会话目录一致」
  - 更新 L616 helper：区分两种模式语义
- **高级设置**：通道工作目录 helper 补充与主会话/他人留空回退的关系（一句）
- 保存经既有 `persistChannels` → `saveAppConfigFromRenderer` 写入 store
- 不改：全局 Settings 主工作目录选择器结构

### 接口契约

- UI 字段与 `MessageChannel` Rev1 字段一一对应
- 临时目录模式：不展示路径输入，`othersWorkspaceDir` 保存时可清空或忽略
- 文案简体中文，与 Daemon `/help` 无矛盾

### 验收标准

- [ ] 配置页可见 `/chat new -dir` 说明及默认规则（01 验收 8 / Rev1 验收 6）
- [ ] `allowOthers` 开启后可切换临时目录/指定目录并保存持久化
- [ ] 指定目录留空时 UI 明示等同主会话目录
- [ ] 切换模式后重启应用配置仍正确
- [ ] 全局 Settings 主工作目录页无结构性改动
- [ ] 无 `02`/`03` 未要求的抽象层或未批准的新依赖

### 依赖

- 前置任务: T-Rev1-01（类型字段已定义）
- 后续任务: T-Rev1-03

---

## T-Rev1-03: 类型贯通、文案对齐与 Rev1 验收回归

### 背景

Rev1 涉及 Electron 主进程、渲染进程与共享类型三处字段一致；需在 T-Rev1-01/02 完成后做端到端回归，闭合 08 验收打回项，并确认 Daemon 帮助与配置页文案一致。

### 上下文文件

- 必读: `07-prd-revisions.md` Rev1；`01-proposal.md` 验收 6–9
- 必读: `02-design.md` Rev1·（五）工程补充验收
- 必读: T-Rev1-01、T-Rev1-02 验收标准
- 参考: `src/daemon.ts` `COMMANDS["/chat"]`；`08-verify-issue.md` 第 1 轮

### 实现范围

- 核对并补漏：`ChannelPanel` reload 迁移兜底（`allowOthers` 同级兜底 `othersWorkspaceMode`/`othersWorkspaceDir`）
- 若 T-Rev1-02 未覆盖：`emptyChannel` 默认值
- **无必须代码**时可仅验证；发现缺口则在本任务内小 patch（限 Rev1 范围）
- 手动回归：01 验收 1–5 无回归 + Rev1 验收 6–9 + 02 Rev1·（五）四项

### 接口契约

- 三处类型定义字段名与类型一致
- 配置页与 `/help` 关于 `-dir`、他人模式的三要点语义一致

### 验收标准

- [ ] 01 验收 1–5、8（Daemon 帮助）仍通过
- [ ] 01 验收 6–9（配置页与他人模式）通过
- [ ] 08 第 1 轮问题闭合：配置页可找到 `-dir` 说明
- [ ] isolated / specified 留空 / specified 填路径 三种他人场景可观察验证
- [ ] `02-design` Rev1·（五）四项工程补充项通过
- [ ] 无 `02`/`03` 未要求的抽象层或未批准的新依赖

### 依赖

- 前置任务: T-Rev1-01、T-Rev1-02
- 后续任务: 无（通过后重新 `/kb-test` → 验收）

