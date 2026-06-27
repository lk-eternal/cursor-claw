# 验收问题报告

> 变更 ID：`20260627113111-消息通道即时响应与流式输出`

## 第 1 轮

### 反馈问题

本地已安装 profile（飞书 + Cursor SDK）。用户在飞书发一条消息后，Agent 开始工作时持续收到多条「半幅」递增消息，例如：

```
按
按 cursor-cl
按 cursor-claw 工作
```

期望应为同一条消息持续更新（F4.2）或段落分段降级（F4.3），不应刷屏。

### 归因结论

| 字段 | 值 |
|------|-----|
| 结论 | 代码实现问题 |
| reason | `code` |

### 判定依据

| 维度 | 说明 |
|------|------|
| PRD F4.2 | SDK 主用户私聊首选「在同一条 outbound 消息上持续更新内容」，使用户尽早看到产出并随增长而更新。 |
| PRD F4.3 | 通道不支持单条编辑时，降级为自然段落或节流策略分段发送，仍优于一次性发送。 |
| PRD NF6 | 流式更新须节流，可感知流畅且**不刷屏**。 |
| 实现链路 | `electron/agent-sdk.ts`：`appendStreamDelta` → `scheduleStreamPost`（400ms 节流，`void flushStreamPost` 未串行）→ `POST /api/stream-text` → `src/daemon.ts` `handleStreamText`（首包 `sendStreamMessage`，后续 `updateMessageContent` PATCH 或 `sendStreamSegments`）。 |
| 现象对照 | 短句多次递增更符合：并发 stream-text 请求均命中 `isFirst` 多次发新消息，和/或飞书 PATCH 路径未 Consolidate 为单条 UX；与 PRD 不符，非 PRD 故意要求的行为。 |

### 影响范围

- 通道：飞书
- 场景：SDK 模式 + 主用户私聊流式输出
- 关联实现：`electron/agent-sdk.ts`、`src/daemon.ts`、`src/shared/lark-core.ts`

### 后续处理

- 路径：`/kb-revise-apply` 或 `/kb-apply`
- 修复方向：串行化 stream 推送、飞书 PATCH/降级策略优化，使行为符合 F4.2 首选或 F4.3 降级，并满足 NF6 不刷屏
