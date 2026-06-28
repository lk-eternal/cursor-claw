# Agent Run 超时自动停止 - 变更总结

> **变更 ID**：`20260628163149-Agent Run 超时自动停止`
> **来源**：kb-propose（standard）
> **阶段**：`tested`（T1–T3 done；04-review 通过（有条件）；`/kb-test` build 通过；K1/K2 staging 必测待跑，不阻断 archive）

---

## 1、实际变更

| 文件 | 关键改动 |
|------|----------|
| `electron/finalize-sdk-run.ts` | **新建**（144 行）：`isRunTimeoutFailure`（ERROR/EXPIRED、F3.2 保活超时、duration≥20min 档）；`finalizeSdkRunOnTimeout` 幂等闩 → `run.cancel()` + `abortController.abort()` → 清 `session.run`/`pendingDispatch` → `notifySdkFailure`（一次，含 `stop_progress`）→ `reportSessionAgentPhase(idle)` → 长驻模式 `agent.close()` + `sdkSessions.delete` |
| `electron/agent-sdk.ts` | 挂接 finalizer：`SdkSessionAgent.runFinalizing`；`handleSdkEvent` ERROR/EXPIRED 即时 finalizer（非 defer-only）；`streamRunEvents` 流结束超时类兜底；`completeSdkRun` 幂等 early return + 超时跳过 `failedCooldowns`；`launchSdkAgent` processing 早退 UI WARN |
| `package.json` | 版本 **1.8.4 → 1.8.5**（archive patch） |
| `changelog/1.8.5.json` | 用户可见：Run 超时自动停止与会话恢复 |

**变更文档**：`01-proposal.md`、`02-design.md`、`03-tasks.md`、`04-review.md`、`06-automation-test.md`、`00-manifest.json`、`05-summary.md`（本文件）。

**未纳入本变更 commit（显式）**：`electron/AGENTS.md` — T3 超时段落已在仓库；当前 `git diff` 无 AGENTS 改动，若 archive commit 时仍无 diff 则不列入。

**统计**：1 新建 + 1 挂接；`finalize-sdk-run.ts` 144 行（≤300）；`agent-sdk.ts` 增量挂接约 66 行；`npm run build` 已通过（见 `06-automation-test.md`）。

## 2、与设计的差异

- **finalizer 提取**：02 §2 优先内联；因 `agent-sdk.ts` 体量，按 03 T1 提取同目录 `finalize-sdk-run.ts` + `FinalizerContext` 依赖注入 — **可接受**（04-review 一致）。
- **R1（open）**：非长驻 `SDK_RESIDENT_AGENT=0` 超时后 finalizer 未 close/delete session；`completeSdkRun` 幂等 early return 跳过非 resident 清理 — 非默认配置，可选 T-FIX-01 或 accepted_debt。
- **R2（open）**：`isRunTimeoutFailure` 对任意 ERROR/EXPIRED 返回 true — 02 §5.2 有意收窄，依赖 SDK 契约；验收 7 须联调（T-FIX-02 待定）。
- **W2（open）**：`electron/AGENTS.md` 若含并行变更 MCP stdio 段落，archive 分 manifest 追溯。
- **W3（open）**：duration≥20min 宽超时档可能误判非超时 error — 02 §8.1 已知；验收 7 联调。
- **K1/K2 staging**：场景 A 超时收尾、场景 B ≥30s 后发消息为核心必测，见 `06-automation-test.md` §4.1，**待跑**。

## 3、影响范围

- **涉及模块**：Electron SDK Run 生命周期（`finalize-sdk-run.ts`、`agent-sdk.ts`）；Daemon **无 diff**，依赖 `reportSessionAgentPhase(idle)` 触发既有 `flushReadyMergeBatches` + `scheduleAgentDispatch`（M7 claim 须 processing→idle）。
- **用户可见性**：Run 超时后 **数秒内** 自动停止并恢复 idle；同会话 **稍后** 发消息可继续，**无需** Stop+Reset；一条简体中文超时友好提示（F4，复用 `formatSdkStreamFailure`）。
- **长驻 vs 非超时**：长驻模式 **超时** → close Agent + 删 session，下条走 launch 重建；**非超时** error 仍保留实例 + 写 `failedCooldowns`。
- **超时路径**：**不** 写入 `failedCooldowns`，避免 30s 冷却阻塞重试。
- **未触碰**：超时阈值（`KEEPALIVE_TIMEOUT_MS` 等）、Daemon M7 逻辑、CLI/任务路径、用户主动 Stop/CANCELLED 语义。

### 3.1 Ponytail 技术债

diff 中无 `ponytail:` 注释。**Lean already. Ship.**

| 位置 | 注释摘要 | 升级路径 |
|------|----------|----------|
| — | 无 | — |

**存量（W1 accepted_debt）**：`agent-sdk.ts` 仍超 300 行约定；本变更已提取 finalizer 部分缓解。

## 4、知识库影响清单

与 `02-design.md` §九、§十一致。

- [x] `knowledge/业务域/Agent调度/03-启动与自动重连.md` — Run 超时 finalizer、resident 超时删实例 vs 非超时保留、idle 与 Daemon M7、跳过 cooldown（archive 步骤 6–7）
- [x] `electron/AGENTS.md` — T3 超时段落已在仓库（finalizer / cooldown / resident）；无 git diff 时不重复 commit
- [x] `package.json` + `changelog/1.8.5.json` — 用户可见 patch bump
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
- [ ] `knowledge/变更/归档/20260627150751-SDK保活与Run生命周期兼容/` — F3.2 文案与本变更收尾链路交叉引用（可选，非阻断）
