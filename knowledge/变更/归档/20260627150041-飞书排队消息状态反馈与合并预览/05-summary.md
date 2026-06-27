# 飞书排队消息状态反馈与合并预览 - 变更总结

## 1、实际变更

### 代码

| 文件 | 关键改动 |
|------|----------|
| `src/file-queue.ts` | 新增 `getSessionUnclaimedCount`、`listUnclaimedMessages`、`replaceSessionUnclaimedMessages` |
| `src/daemon.ts` | F1 `buildEnqueueStatusText` + `sessionAgentPhaseMap`；F2/F3 `MergePreviewState`/`mergePreviewRegistry`、`scheduleMergePreview`/`sendMergePreview`/`tryHandleMergePreviewReply`；F4 `shouldSuppressMergePreview`；`POST /api/session-agent-phase`；poll `applyMergeOverrideForPoll` + `clearMergePreviewState` |
| `electron/daemon-client.ts` | 新增 `reportSessionAgentPhase` helper |
| `electron/session-dispatcher.ts` | starting/processing/idle 三处 phase 上报 |
| `electron/agent-sdk.ts` | processing/idle phase 上报 |
| `src/AGENTS.md` | 补充 merge preview 与 phase 边界说明 |
| `electron/AGENTS.md` | 补充 phase 上报约定 |

### 自动化测试

| 文件 | 说明 |
|------|------|
| `auto_test/20260627150041-feishu-merge-preview/README.md` | 联调说明 |
| `auto_test/20260627150041-feishu-merge-preview/phase-api-contract.sh` | phase API 契约脚本 |

## 2、与设计的差异

无实质性偏差。文案细节：预览引导为「回复本条消息」，失败提示为「回复合并预览消息」，与 01 示例「回复本条预览消息」语义等价。

## 3、影响范围

- **daemon**：入队 F1 文案、合并预览状态机、F3 拦截、phase API、poll override 与清理。
- **file-queue**：待领取计数与 override 替换；`.qmsg` 文件格式不变。
- **electron**：session-dispatcher / agent-sdk 经 HTTP 上报 Agent 阶段；poll 消费端契约不变。
- **范围**：合并预览与 F3 仅飞书私聊主用户 SDK；微信/群聊不要求。

### 3.1 Ponytail 技术债

无

## 4、知识库影响清单

- [x] `knowledge/业务域/消息桥接/04-消息队列与路由.md` — F1 阶段文案、unclaimed 计数、phase API、merge override 与 poll 清理
- [x] `knowledge/业务域/消息桥接/02-飞书通道.md` — 合并预览格式、MG-id、F3 回复修改、F4 抑制规则
- [x] `knowledge/业务域/消息桥接/01-概览.md` — 主流程图增加预览/修改分支；术语表补 AgentPhase/MG-id
- [x] `knowledge/业务域/消息桥接/00-README.md` — 子模块职责未变，无需更新
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新

## 5、遗留债务

| 来源 | 债务 | 级别 |
|------|------|------|
| 04-review §3 | F3 失败纠错超长全文未分条，可能触达飞书单条上限 | suggestion |
| 04-review §3 | `processing` 阶段 session-dispatcher 与 agent-sdk 可能双报 | suggestion |
| 06-automation-test | 飞书私聊端到端联调（F1/F2/F3/F4、NF1/NF2/NF4）未跑 | 手工验收债务 |
