# 飞书排队消息状态反馈与合并预览 - 变更总结

## 1、实际变更

### 代码

| 文件 | 关键改动 |
|------|----------|
| `src/file-queue.ts` | 新增 `getSessionUnclaimedCount`、`listUnclaimedMessages`、`replaceSessionUnclaimedMessages` |
| `src/daemon.ts` | F1 `buildEnqueueStatusText` + `sessionAgentPhaseMap`；F2/F3 `MergePreviewState`/`mergePreviewRegistry`、`scheduleMergePreview`/`sendMergePreview`/`tryHandleMergePreviewReply`；F4 `shouldSuppressMergePreview`；`POST /api/session-agent-phase`；poll `applyMergeOverrideForPoll` + `clearMergePreviewState` |
| `src/daemon.ts`（T-FIX-01） | `scheduleMergePreviewIfEligible`（phase idle 补偿）；`ensureMergePreviewSentBeforeClaim`（instant poll claim 前预览守卫）；`resolveMergePreviewContext` |
| `src/file-queue.ts`（T-FIX-02） | 新增 `cleanupOrphanClaimedOnColdStart` — 冷启动将遗留 `.claimed` 还原为 `.qmsg` |
| `src/daemon.ts`（T-FIX-02） | `initQueue` 调用 orphan 回收并打日志；`buildEnqueueStatusText` phase 缺失默认 `idle`（移除 claimed→processing 推断）；`confirmEnqueueAndStartProgress` 排队数改 `getSessionUnclaimedCount` |
| `src/AGENTS.md`（T-FIX-02） | 冷启动 claimed 回收与 F1 计数/phase 口径约定 |
| `electron/daemon-client.ts` | 新增 `reportSessionAgentPhase` helper |
| `electron/session-dispatcher.ts` | starting/processing/idle 三处 phase 上报 |
| `electron/agent-sdk.ts` | processing/idle phase 上报 |
| `src/AGENTS.md` | 补充 merge preview 与 phase 边界说明 |
| `src/AGENTS.md`（T-FIX-01） | idle 补偿与 instant poll 守卫约定 |
| `electron/AGENTS.md` | 补充 phase 上报约定 |

### 自动化测试

| 文件 | 说明 |
|------|------|
| `auto_test/20260627150041-feishu-merge-preview/README.md` | 联调说明 |
| `auto_test/20260627150041-feishu-merge-preview/phase-api-contract.sh` | phase API 契约脚本 |
| `auto_test/20260627150041-feishu-merge-preview/phase-api-contract.sh`（T-FIX-01） | 追加 instant poll 非破坏冒烟（processing/idle 后 `wait=false`） |
| `auto_test/20260627150041-feishu-merge-preview/README.md`（T-FIX-02） | 追加 F15 重启首条手工冒烟步骤 |

### T-FIX-02 与 08 第 2 轮修复对应

| 08 根因 | T-FIX-02 修复 | 08 验收项 |
|---------|---------------|-----------|
| 重启后 phase Map 空 + stale `.claimed` 被当作 processing | `cleanupOrphanClaimedOnColdStart` + phase 缺失默认 `idle` | 验收 2、3 |
| F1 排队数含 stale claimed 导致虚假「前面还有 N 条」 | `confirmEnqueueAndStartProgress` 改用 `getSessionUnclaimedCount` | 验收 2、3 |

**测试证据**：`tsc --noEmit` 通过；06 F15 重启首条场景已记录；飞书 F15 联调待用户执行。

### 版本与 Changelog

- **版本**：`package.json` `1.6.3` → **`1.6.4`**（patch）
- **Changelog**：`changelog/1.6.4.json`
  - 修复重启后飞书首条消息误报「Agent 正在处理上一条」与虚假排队数
  - 冷启动自动回收遗留 claimed 消息并修正入队确认文案

### T-FIX-01 与 08 修复对应

| 08 根因 | T-FIX-01 修复 | 08 验收项 |
|---------|---------------|-----------|
| phase 转 `idle` 后 debounce 不重跑，预览永久缺失 | `session-agent-phase` idle 钩子调用 `scheduleMergePreviewIfEligible` | 验收 4、10、11 |
| instant poll 直接 claim + `clearMergePreviewState`，绕过预览窗口 | `wait=false` poll 在 claim 前 `await ensureMergePreviewSentBeforeClaim` | 验收 4、11 |
| F4 抑制本身正确，缺 idle 后补偿 | F4 逻辑不变；补偿仅在 `!shouldSuppressMergePreview` 时触发 | 验收 10 |

**测试证据**：`tsc --noEmit` 通过；`phase-api-contract.sh` T-FIX-01 instant poll 冒烟通过；08 第 2 轮飞书私聊场景联调待跑（R3）。

## 2、与设计的差异

无实质性偏差。文案细节：预览引导为「回复本条消息」，失败提示为「回复合并预览消息」，与 01 示例「回复本条预览消息」语义等价。

## 3、影响范围

- **daemon**：入队 F1 文案、合并预览状态机、F3 拦截、phase API、poll override 与清理；**T-FIX-01** idle 补偿 + instant poll 预览守卫；**T-FIX-02** 冷启动 orphan claimed 回收与 F1 计数/phase 口径。
- **file-queue**：待领取计数与 override 替换；`.qmsg` 文件格式不变。
- **electron**：session-dispatcher / agent-sdk 经 HTTP 上报 Agent 阶段；poll 消费端契约不变。
- **范围**：合并预览与 F3 仅飞书私聊主用户 SDK；微信/群聊不要求。

### 3.1 Ponytail 技术债

无

## 4、知识库影响清单

- [x] `knowledge/业务域/消息桥接/04-消息队列与路由.md` — F1 阶段文案、unclaimed 计数、phase API、merge override 与 poll 清理；**T-FIX-01** idle 补偿 + instant poll 守卫；**T-FIX-02** 冷启动 orphan 回收与 F1 口径
- [x] `knowledge/业务域/消息桥接/02-飞书通道.md` — 合并预览格式、MG-id、F3 回复修改、F4 抑制规则；**T-FIX-01** 时序与 ensure 路径；**T-FIX-02** 冷启动 F1 首条
- [x] `knowledge/业务域/消息桥接/01-概览.md` — 主流程图增加预览/修改/idle 补偿/instant ensure 分支；术语表补 AgentPhase/MG-id
- [x] `knowledge/业务域/消息桥接/00-README.md` — 子模块职责未变，无需更新
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新

## 5、遗留债务

| 来源 | 债务 | 级别 |
|------|------|------|
| 04-review §3 | F3 失败纠错超长全文未分条，可能触达飞书单条上限 | suggestion |
| 04-review §3 | `processing` 阶段 session-dispatcher 与 agent-sdk 可能双报 | suggestion |
| 06-automation-test | 飞书私聊端到端联调（F1/F2/F3/F4、NF1/NF2/NF4）未跑 | 手工验收债务 |
| 04-review R-FIX-W1 | debounce 与 ensure 极端并发可能重复发预览 | suggestion |
| 04-review R-FIX-W2 | `sendMergePreview` 失败仍 claim，用户可能看不到预览 | suggestion |
| 04-review R-FIX-02-W1 | daemon 独立重启时 reclaim 可能与 live Agent 重复投递 | suggestion |
| 04-review R-FIX-02-W2 | 移除 claimed fallback 后 phase 上报延迟窗口可能短暂 F1 idle 文案 | suggestion |
| 06-automation-test F15 | 飞书重启首条 F1 端到端联调待用户执行 | 手工验收债务 |
