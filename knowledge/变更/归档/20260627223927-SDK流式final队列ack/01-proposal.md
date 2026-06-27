# SDK流式final队列ack轻量变更说明

> **变更 ID**：`20260627223927-SDK流式final队列ack`
> **来源**：kb-lite
> **类型**：Bug
> **优先级**：P2
> **外部 PRD**：无
> **任务记录**：无
> **Figma 设计图**：无
> **lite 类型**：知识同步型 lite（实现后同步 `knowledge/业务域/消息桥接/04-消息队列与路由.md` 与 AGENTS）
> **关联债务**：归档变更 `20260627113111-消息通道即时响应与流式输出` 的 T-FIX-04（`04-review` §7）

---

## 背景

归档变更 `20260627113111` 已在 daemon `handleStreamText` final 支持可选 `message_id` → `ackOnReply`（T-FIX-03），但 electron 桥接层 `agent-sdk` 的 `StreamTextPayload` 未携带 inbound `message_id`，且桥接层不持有 poll 领取的 messageId。SDK 流式路径 `final` 无 `message_id` 时仅 `stopSessionProgress`，`.claimed` 依赖 Agent 另行 MCP `send_text(message_id)` 清理，联调后确认存在滞留。

## 变更说明

采用**方案 A**（不采用方案 B「final 无 id 时 ack 会话全部 claimed」）：

1. **daemon** `dispatchSessionToAgent` 经 `forwardElectronAgentApi` 调用 `/api/agent/launch` 与 `/api/agent/dispatch` 时，传递当次 poll 领取的 `message_ids`。
2. **agent-sdk** `SdkLaunchOptions` / `launchSdkAgentFromHttp` / `dispatchToSdkAgent` 接收并写入 session 级「当次 inbound ids」；`dispatch` 或 `resetSdkRunPresentationState` 时刷新/覆盖当次 batch。
3. **`StreamTextPayload`** 增加 `message_id`；**`doFlushStreamPost(final)`** 附带该字段，取**当次 batch 末条 id**（与 `ackMessages` 语义一致）。
4. **resident 模式**多次 dispatch：每次 launch/dispatch **覆盖**当次 batch ids；final 只 ack 当次 batch，不误 ack 其他 batch 的 `.claimed`。

版本：用户可见 bug 修复，archive 时 **patch** bump `1.7.1` → **`1.7.2`**（勿覆盖未提交的 1.7.1 上下文功能 WIP），新建 `changelog/1.7.2.json`。

### lite 判定

| 判定项 | 结论 |
|--------|------|
| 需求清晰度 | 债务 T-FIX-04 已定位，方案 A 已定 |
| 修改范围 | daemon + agent-sdk + AGENTS + 单处知识（+2 跨端同仓） |
| 接口契约 | 内部 HTTP launch/dispatch 增可选字段，非对外 proto（+0） |
| 数据/权限 | 不变（+0） |
| 跨端联动 | Electron + Daemon 同仓（+2） |
| 知识库 | 单文件 `04-消息队列与路由.md`（+2） |
| **总分** | **≤2**，可走 lite |

## 验收标准

1. **SDK 流式路径**：飞书/SDK 会话经 stream-text 完成一轮 Run 后，对应 session 队列目录下**无残留** `.claimed` 文件（当次 inbound 已 ack）。
2. **重启后**：应用重启后**无需** orphan `.claimed` 回收或手动清理即可继续正常 poll/dispatch。
3. **resident 多次 dispatch**：同一 resident session 连续两次 dispatch（各含不同 message batch），第一次 final 仅 ack 第一次 batch；第二次 final 仅 ack 第二次 batch，**不**误 ack 其他 batch 的 claimed。
4. **`message_id` 语义**：final 携带的 `message_id` 为当次 batch **末条** id，与现有 `ackMessages` 行为一致。
5. **非流式/CLI 路径**：不改既有 MCP `send_text(message_id)` ack 契约；回归 smoke 无退化。
6. TypeScript 编译通过；涉及目录 AGENTS 已补充流式 final ack 说明。

## 影响范围

| 范围 | 说明 |
|------|------|
| `src/daemon.ts` | `dispatchSessionToAgent` / launch & dispatch 请求体传 `message_ids` |
| `electron/agent-sdk.ts` | session 存当次 ids；`StreamTextPayload.message_id`；`doFlushStreamPost(final)` 附带 |
| `electron/AGENTS.md`、`src/AGENTS.md` | 流式 final ack 与 resident batch 覆盖规矩 |
| `knowledge/业务域/消息桥接/04-消息队列与路由.md` | 知识同步：SDK 流式 final ack 闭环 |
| `package.json`、`changelog/1.7.2.json` | archive 时 patch 版本与 changelog |

**不在范围**：方案 B（无 id 时全量 ack claimed）、proto/DB、飞书 CardKit 展示、MergeBatch 合并逻辑。

## 与已有变更的关系

| 变更 | 关系 |
|------|------|
| `20260627113111-消息通道即时响应与流式输出`（已归档） | **闭合** §7 T-FIX-04 债务 |
| `20260627215516-Agent自动压缩与上下文占用展示`（进行中/归档） | 无冲突；footer 仍随 final 包下发 |
