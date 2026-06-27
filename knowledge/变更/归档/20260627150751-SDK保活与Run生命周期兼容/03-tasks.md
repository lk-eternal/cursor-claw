# SDK 保活与 Run 生命周期兼容 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 1、执行计划

### 1.1 依赖图

```
T3 ──→ T1
T2（独立）
```

**说明**：T3 确认 `@cursor/sdk ^1.0.22` 与 build 通过后，T1 再落地 errorCode 解析等 SDK 1.0.22 能力；T2 改规则模板，与 T1/T3 **无文件冲突**，可与 T3 并行。

### 1.2 分组调度

- **第一轮（并行）**：T2、T3
- **第二轮**：T1（前置 T3 完成）

## 2、任务清单

## T1: SDK 可观测性与保活失败文案（agent-sdk.ts）

### 背景

SDK Run 在保活阶段以 `status=error` 终止时，现网缺少 `run.result`、errorCode、末次 tool 等结构化字段，且用户 notify 一律走通用「请稍后重试」。本任务在 `electron/agent-sdk.ts` 增加 `lastTool` 跟踪、error 终态日志增强，并扩展 `formatSdkStreamFailure` 实现 F3.2 保活/Run 超时文案分类，对应设计 S7、S8 与 F1、F3。

### 上下文文件

- CodeGraph: `formatSdkStreamFailure` `handleSdkEvent` `streamRunEvents` `SdkSessionAgent` — 定位 SDK 事件流与 notify 入口
- 必读: `electron/agent-sdk.ts` — `SdkSessionAgent` 接口（L11–37）、`formatSdkStreamFailure`（L61–70）、`notifySdkFailure`（L72–78）、`handleSdkEvent` tool_call/status（L282–316）、`streamRunEvents`（L259–279）、`launchSdkAgent` error 收尾（L437–451）
- 必读: `knowledge/变更/进行中/20260627150751-SDK保活与Run生命周期兼容/01-proposal.md` — F1、F3、验收 1/2/5/6/7/10
- 参考: `electron/AGENTS.md` — SDK 错误 notify 约定
- 参考: `knowledge/变更/进行中/20260627150751-SDK保活与Run生命周期兼容/02-design.md` §5.1、§5.2、§8.2（error 终态与 F3.2 工程验收）

### 实现范围

- 修改: `electron/agent-sdk.ts`
  - **`SdkSessionAgent`**：新增 `lastTool?: { name: string; status: string }`
  - **`handleSdkEvent`** → `case "tool_call"`：在现有 `[tool] name: status` 日志旁同步赋值 `session.lastTool = { name: event.name, status: event.status }`
  - **`streamRunEvents` / `launchSdkAgent` error 收尾**（`run.status === "error"`）：扩展 `pushUiLog` 单行或相邻日志，合并 `run.wait()` 返回值、`run.result`、`run.durationMs`、`session.lastTool`、`session.lastStatus`；从 `run.wait()` 或 `status` 事件解析 **errorCode**（SDK 1.0.22 暴露则记录）；含 `sessionKey`、`agentId`/run 短码；**不得**将上述技术字段写入用户 notify
  - **`formatSdkStreamFailure`**：扩展签名或在调用处传入 session 上下文（如 `lastTool`、`durationMs`）；当 `lastTool.name === "shell"` 且 `lastTool.status === "running"`（或等价）且无更安全 `message` 时，返回 F3.2：「会话在等待下一条消息时已结束（等待超时）。请重新发送消息，我会继续为你处理。」；**保留** CANCELLED、EXPIRED、通用失败分支（F3.3、F3.4）；用户主动 stop（aborted）仍不 notify（F3.5）
  - **`notifySdkFailure`**：调用扩展后的 `formatSdkStreamFailure` 时传入 session 上下文

### 接口契约

- `SdkSessionAgent.lastTool?: { name: string; status: string }` — 末次 tool 事件快照，供日志与保活失败分类
- `formatSdkStreamFailure(status?: string, message?: string, ctx?: { lastTool?: { name: string; status: string }; durationMs?: number })` — 用户可见失败文案；保活/Run 超时 → F3.2；CANCELLED/EXPIRED/通用互斥
- error 终态 UI 日志字段（有则写）：`sessionKey`、`agentId`、`run.result`、`run.durationMs`、`errorCode`、`lastTool.name`、`lastTool.status`、`lastStatus`

### 验收标准

- [ ] **01 验收 1**：复现或模拟 `status=error` 时，UI/开发者日志可见 `run.result`、errorCode（若 SDK 暴露）、末次 tool 名与状态中**至少两项**
- [ ] **01 验收 2**：保活失败路径下日志 `lastTool` 为 `shell` + `running`（或与实现一致的等价表述）
- [ ] **01 验收 5**：保活导致 Run error 时用户 notify 为 F3.2 文案，**非**单独「请稍后重试」
- [ ] **01 验收 6**：非保活类 tool 失败仍走通用失败文案，**不**误触发 F3.2
- [ ] **01 验收 7**：CANCELLED、EXPIRED、用户 stop 路径文案与变更前一致
- [ ] **01 验收 10**：验收记录可引用 Run id 或等价日志片段，证明可观测性字段已落地
- [ ] **02 §8.2**：error 终态 UI 日志含 `run.result`、`lastTool`、`durationMs` 中至少两项，且保活复现路径 `lastTool` 为 `shell` + `running`
- [ ] **02 §8.2**：保活类 Run error（若 SDK 仍终止）用户 notify 为 F3.2，非单独「请稍后重试」
- [ ] **02 §8.2**：非保活 tool 失败仍走通用文案，不误触发 F3.2
- [ ] **F1.4**：结构化字段仅写 UI 日志，不下发终端用户
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T3
- 后续任务: 无

---

## T2: 阶段 4 非阻塞保活规则（cursor-claw.mdc）

### 背景

现网 `cursor-claw.mdc` 阶段 4 要求单次 blocking poll 无限挂起，与 SDK Run 生命周期（约 23min 档 error）冲突。本任务将阶段 4 改为 `wait=false` 非阻塞 poll + `sleep 5` 短循环，保留 SYSTEM OVERRIDE 处理与 Loop 禁令，对应设计 S3、S6 与 F2、验收 3（锁定为 Run 不因 blocking poll error）。

### 上下文文件

- CodeGraph: `poll-message` `KEEP-ALIVE` `cursor-claw.mdc` — 定位保活规则与 Daemon poll 契约
- 必读: `resources/template/rule/cursor-claw.mdc` — 阶段 4（L118–127）、陷阱一/三（L124–127）、核心禁令
- 必读: `knowledge/变更/进行中/20260627150751-SDK保活与Run生命周期兼容/01-proposal.md` — F2、验收 3/4/8/9
- 参考: `src/daemon.ts` L1958–2020 — `/api/poll-message` 的 `wait=false` 与 blocking + SYSTEM OVERRIDE（**只读，本任务不改**）
- 参考: `knowledge/变更/进行中/20260627150751-SDK保活与Run生命周期兼容/02-design.md` §1.2 S3/S5/S6、§8.2 验收 3 锁定

### 实现范围

- 修改: `resources/template/rule/cursor-claw.mdc` 阶段 4 及关联陷阱表述：
  - **poll 调用**：`GET /api/poll-message?sessionKey=...&wait=false`（非阻塞，立即返回）
  - **无消息循环**：`messages` 为空时执行 **`sleep 5`**（秒级 Shell，可调范围 3–10s，默认 5）后重复 poll
  - **有用户消息**：重置状态机回到阶段 1（语义不变）
  - **SYSTEM OVERRIDE**：收到系统指令文本后**立即**下一轮 poll，继续保活（语义不变，对应 01 验收 4 / 场景 D）
  - **禁令保留**：阶段 4 仍仅 Shell、禁止自然语言/CoT/总结；不放松 Loop 协议（F2.5）
  - **陷阱一/三**：改写为匹配非阻塞循环（不再描述「curl 还挂着 / long-poll 两条相同调用」为正常保活形态；可说明短循环 poll 可能触发 looping 误报时的正确行为）
  - **删除/替换**：不再将「单次 poll 无限挂起」作为**唯一**保活手段

### 接口契约

- Agent 规则语义：`wait=false` poll → 空则 `sleep 5` → 循环；SYSTEM OVERRIDE → 继续 poll
- Daemon 契约不变：`sessionKey` 必填；blocking + 25min OVERRIDE 仍供 CLI/legacy，SDK 保活路径不依赖 blocking

### 验收标准

- [ ] **01 验收 3（锁定）**：主用户私聊 SDK Run，Agent 完成回复后连续等待 **≥25 分钟**无新消息，Run **不因**单次 blocking poll 被 SDK 以 `status=error` 终止；实现为非阻塞 poll + sleep 5s 循环，期间无单次 Shell 阻塞 ≥1min
- [ ] **01 验收 4**：若 Daemon 25min SYSTEM OVERRIDE 仍被触发（mixed/legacy 路径），Agent 继续保活循环，**不**向用户发送误导性「处理失败」（除非 Run 确已终止）
- [ ] **01 验收 8**：新注入工作区规则描述非阻塞短循环保活，**不再要求**单次 poll 无限挂起为唯一手段
- [ ] **01 验收 9**：本任务**不改**飞书排队/合并/流式代码；相关用例无回归
- [ ] **02 §8.2 验收 3（锁定）**：同上 ≥25min 无 blocking poll error
- [ ] **02 §8.2**：`cursor-claw.mdc` 阶段 4 含 `wait=false` 与 sleep 循环，不以 blocking 无限挂起为唯一手段
- [ ] **02 §8.2**：Daemon `/api/poll-message` **无代码 diff**；blocking + SYSTEM OVERRIDE 手工用例仍可触发（curl 不带 `wait=false`）
- [ ] **NF1**：5s 间隔下单 idle 会话约 12 次/min GET，无 Daemon CPU/连接数显著劣化
- [ ] **NF4**：CLI Agent 共用规则模板，非阻塞循环与 `wait=false` 契约兼容
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: 无

---

## T3: @cursor/sdk 依赖升级确认（package.json / package-lock.json）

### 背景

设计将 `@cursor/sdk` 升至 `^1.0.22` 以支持 errorCode 等终态字段解析；manifest 已登记 package 变更且 builder 预改通过 build。本任务确认 lockfile 与版本一致、构建通过，作为 T1 的前置依赖，对应设计步骤 5 与 §1.3。

### 上下文文件

- 必读: `package.json` — `@cursor/sdk` 版本行（预期 `^1.0.22`）
- 必读: `package-lock.json` — 解析后的 `@cursor/sdk` 锁定版本
- 参考: `knowledge/变更/进行中/20260627150751-SDK保活与Run生命周期兼容/02-design.md` §1.3、§6 步骤 5

### 实现范围

- 确认/修改: `package.json` — `dependencies["@cursor/sdk"]` 为 `^1.0.22`（若已满足则仅验证）
- 确认/修改: `package-lock.json` — 与 `package.json` 一致；必要时 `npm install` 刷新 lock
- 验证: 项目 build 命令通过（与现网 CI/本地 `npm run build` 一致）

### 接口契约

- `package.json` → `"@cursor/sdk": "^1.0.22"`
- lockfile 解析版本 ≥ 1.0.22
- build 成功 exit 0

### 验收标准

- [ ] `package.json` 与 `package-lock.json` 中 `@cursor/sdk` 版本符合 `^1.0.22` 且 lock 可复现
- [ ] `npm run build`（或项目标准 build）通过
- [ ] 无引入 `02`/`03` 未批准的新 npm 依赖
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T1
