# 飞书排队消息状态反馈与合并预览 - 代码评审报告

## 1、审查范围

- **变更类型**: apply 产出的未提交变更（`git diff`，+519/-13 行）
- **评审等级**: focused-review（daemon + electron 联动、无 proto/DB/权限变更；跨端但范围可收敛）
- **涉及文件**: 5 个实现文件 + `src/AGENTS.md`、`electron/AGENTS.md`
- **设计文档**: `02-design.md`、`03-tasks.md`（对照基准）
- **评审方式**: 全量 `git diff` + CodeGraph（`projectPath` 指定仓库根）+ 关键符号定点复核

## 2、严重（必须处理）

无

## 3、警告（建议处理）

1. **F3 纠错回复未做超长分条**
   - 位置: `src/daemon.ts:812-814`（`tryHandleMergePreviewReply` → `failReply`）
   - 说明: 合并预览正文已对 outbound 做 `splitMergePreviewText`（NF4），但失败纠错路径将 `mergeId + 全文` 拼成单条 `replyToMessage`；超长合并时可能触达飞书单条上限导致纠错不完整，弱违反 F3.3/F3.5。建议在失败路径复用分条或截断策略。评分约 65，不阻断归档。

2. **`processing` 阶段重复上报**
   - 位置: `electron/session-dispatcher.ts:364-366`、`electron/agent-sdk.ts:469`
   - 说明: CLI/SDK 成功路径均 POST `processing`；`launchAgent` 与 `launchSdkAgent` 串联时可能双报，功能无害但多余 HTTP。`shrink:` 可保留 dispatcher 单点上报。评分约 50。

## 4、设计偏差

无实质性偏差。实现与 `02-design.md` 分层、接口、数据结构一致：

- F1 → `buildEnqueueStatusText` + phase/`.claimed` 兜底
- F2/F3 → `scheduleMergePreview` / `sendMergePreview` / `tryHandleMergePreviewReply` / registry 多 messageId 登记（含分条续页，满足旧预览回复）
- F4 → `shouldSuppressMergePreview`（processing + `.claimed` + 流式字段）
- S11/S13 → `applyMergeOverrideForPoll` + poll/ack 清理

文案用词：预览引导为「回复本条消息」，失败提示为「回复合并预览消息」，与 01 示例「回复本条预览消息」略有差异，语义等价，不构成验收失败。

## 5、验收标准检查

### 03 任务验收

| 任务 | 验收条件 | 状态 |
|------|---------|------|
| T1 | `.qmsg` 仅计 unclaimed；replace 折叠为单条 | ✅ |
| T1 | 空会话/无效输入不抛异常 | ✅ |
| T2 | `POST /api/session-agent-phase` 校验与 idle 删除 | ✅ |
| T2 | 不影响既有 poll/send/stream 路由 | ✅ |
| T3 | starting/processing/idle 三处上报；失败 WARN | ✅ |
| T3 | 不重复 F1 近义 send-text | ✅ |
| T4 | F1.1–F1.3 文案 + 排队数组合 | ✅ |
| T4 | phase 缺失 + `.claimed` 兜底 processing | ✅ |
| T5 | processing/claimed/流式时 suppress | ✅ |
| T6 | debounce 500ms；≥2 触发；MG-id 沿用；已更新标记 | ✅ |
| T6 | p2p + `isStreamTextEligible` 门控 | ✅ |
| T6 | 超长分条 + 续页 registry | ✅ 代码就绪 |
| T7 | parentId 拦截；成功/失败 ID+全文+操作说明 | ✅ |
| T7 | 已领取不可改文案 | ✅ |
| T8 | poll override 交付；领取/ack 清理 preview 态 | ✅ |
| T8 | 未改 electron poll 消费端（最小范围） | ✅ |

### 01 核心验收（12 条）

| # | 验收项 | 状态 |
|---|--------|------|
| 1 | Agent 忙连发：入队反馈含「正在处理上一条」+ 排队数 | ✅ 代码路径成立 |
| 2 | Agent 空闲连发：不误报处理中 | ✅ idle 分支 |
| 3 | 冷启动：「正在启动」+ 排队 | ✅ starting 分支 |
| 4 | 连发 3 条：领取前 1 次预览含【消息 1】～【消息 3】 | ✅ 代码就绪，需联调 |
| 5 | MG-id 格式与批次内一致 | ✅ `buildMergeId` |
| 6 | 回复预览修改成功 → Agent 领新全文 | ✅ replace + poll 单条交付 |
| 7 | 引导/失败含 ID + 全文 + 回复操作 | ✅ |
| 8 | 无效修改纠错含 ID + 全文 + 操作 | ⚠️ 超长全文见 §3 警告 |
| 9 | 单条无预览 | ✅ unclaimed < 2 不发 |
| 10 | 流式进行中不插预览、无重复「处理中」 | ✅ suppress 守卫 |
| 11 | 预览更新沿用 ID +「已更新」 | ✅ `state.updated` |
| 12 | 范围：飞书私聊；微信/群聊不要求 | ✅ p2p + mainUser gated |

### 02 §八·（二）工程补充验收

| 项 | 状态 |
|----|------|
| phase 全链路 F1 文案 | ⚠️ 需联调 |
| phase 缺失 + `.claimed` 兜底 | ✅ |
| debounce 4 条 ≤5s 一次预览 | ⚠️ 需联调 |
| 回复旧版 preview messageId | ✅ registry 全量登记 |
| 超长分条全文可见 | ⚠️ 需联调 |
| 流式连发无预览插入 | ✅ 代码路径成立 |

## 6、调用链与回归风险

```mermaid
flowchart TD
  IN[飞书 inbound] --> F3{回复预览?}
  F3 -->|是| MOD[tryHandleMergePreviewReply]
  F3 -->|否| PM[pushMessage]
  PM --> F1[confirmEnqueueAndStartProgress / buildEnqueueStatusText]
  PM --> SCH[scheduleMergePreview debounce]
  SCH --> SUP{shouldSuppressMergePreview?}
  SUP -->|否| PRE[sendMergePreview]
  EP[electron phase POST] --> MAP[sessionAgentPhaseMap]
  MAP --> F1
  MAP --> SUP
  POLL[/api/poll-message] --> OVR[applyMergeOverrideForPoll]
  OVR --> CLR[clearMergePreviewState]
  ACK[ackOnReply] --> CLR
```

| 回归点 | 风险 | 说明 |
|--------|------|------|
| poll 契约 | 低 | 响应 shape 未变，仅 poll 前 transform |
| 三态/流式 | 低 | F1 与 notify 语义分工保持；suppress 读 `sessionProgressMap` |
| 队列 ack 语义 | 低 | override 保留末条 messageId，整批 ack 不变 |
| phase 上报丢失 | 中 | `.claimed` 兜底 processing；冷启动窗口可能短暂 idle 文案 |
| 并行变更 20260627162620 | 低 | 本期 daemon 内聚；archive 时再评估 absorb |

## 7、遗留债务

1. **NF1/NF2/NF4 与 01 验收 4/6/8 依赖飞书联调**，代码逻辑就绪，评审阶段未执行端到端脚本。
2. **F3 失败纠错超长全文**（见 §3 警告 #1），归档后可按需 T-FIX-01 补分条。
3. **知识库未同步**（`02` §十 列出的 `04-消息队列与路由.md`、`02-飞书通道.md` 等）——属 `/kb-archive` 职责，非本次 apply 范围。

## 8、修复任务建议

| 问题 ID | 建议动作 | 关联任务 |
|---------|----------|----------|
| — | 无 open 阻断项；联调通过后可直接 archive | — |
| （可选） | F3 failReply 超长分条 | T-FIX-01 |

## 9、结论

**通过**，可进入 `/kb-archive`。

T1–T8 实现与 `02-design`/`03-tasks` 对齐；01 十二条验收在代码层均可追溯，无评分 ≥75 的功能性阻断项。§3 两项为体验/精简建议；§7 联调与知识库同步为归档前/后常规定动作。`tsc --noEmit` 通过。
