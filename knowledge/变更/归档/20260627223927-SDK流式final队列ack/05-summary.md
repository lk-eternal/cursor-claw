# SDK流式final队列ack - 变更总结

> **lite 类型**：知识同步型 lite  
> **关联债务闭合**：`20260627113111-消息通道即时响应与流式输出` · `04-review` §7 **T-FIX-04**（verify-issue 第 2 轮已归因，原变更 `stage=acceptance_reopened`）

## 1、实际变更

| 文件 | 要点 |
|------|------|
| `src/daemon.ts` | `dispatchSessionToAgent` 经 `forwardElectronAgentApi` 调用 launch/dispatch 时传递当次 claim 的 `message_ids`；`/api/agent/dispatch` 解析并转发 `message_ids` |
| `electron/agent-sdk.ts` | `SdkSessionAgent.inboundMessageIds` 存当次 batch；`launchSdkAgentFromHttp` / HTTP dispatch / `dispatchToSdkAgent` 接收 `message_ids`；`StreamTextPayload.message_id`；`doFlushStreamPost(final=true)` 附带末条 inbound id → daemon `ackOnReply` |
| `electron/session-dispatcher.ts` | `launchAgent` 向 `/api/agent/launch` 传递 `meta.messageIds` |
| `electron/AGENTS.md` | 补充 f41 流式 final 包携带 `message_id`（launch/dispatch `message_ids` → `session.inboundMessageIds`） |
| `src/AGENTS.md` | 补充 stream-text final + `message_id` → `ackOnReply` 队列确认语义 |
| `package.json` | 版本 bump `1.7.1` → **`1.7.2`**（patch，用户可见 bug 修复） |
| `changelog/1.7.2.json` | 「修复 SDK 流式回复完成后队列 `.claimed` 未确认导致重启残留」 |

**方案**：采用 **方案 A**（daemon→launch/dispatch→session→`doFlushStreamPost(final)` 传末条 id）；**未采用**方案 B（final 无 id 时 ack 会话全部 claimed）。

## 2、与设计的差异

无（lite 无 `02-design.md`；实现与 `01-proposal.md` 方案 A 及验收标准一致）。

## 3、影响范围

- **模块**：Daemon dispatch 链路、Electron agent-sdk 流式出站、session-dispatcher launch 转发。
- **行为**：SDK 流式主路径 Run 完成时，对应 inbound `.claimed` 经 final stream-text 闭环 ack；resident 多次 dispatch 时每次覆盖当次 batch ids，final 仅 ack 当次末条（与 `ackMessages` 语义一致）。
- **接口**：内部 HTTP `/api/agent/launch|dispatch` 增可选 `message_ids`；`/api/stream-text` final 增可选 `message_id`（非对外 proto）。
- **用户可见**：修复重启后会话队列残留 stale `.claimed`、orphan 回收或重复投递风险（`1.7.2` changelog）。
- **不在范围**：CLI/MCP `send_text(message_id)` ack 契约不变；MergeBatch、CardKit 展示、方案 B 全量 ack。

### 3.1 Ponytail 技术债

无（本次 diff 未新增 `ponytail:` 注释）。

## 4、知识库影响清单

- [x] `knowledge/业务域/消息桥接/04-消息队列与路由.md` — kb-librarian 同轮同步：SDK 流式 final ack 链路（`message_ids` 传递 → final `message_id` → `ackOnReply`）；「三、服务端规则」或「四、客户端流程」补闭环说明；「十、变更记录」追加摘要
- [x] `electron/AGENTS.md`、`src/AGENTS.md` — implement 已更新流式 final ack 规矩
- [x] `knowledge/知识索引.md` — 总入口未变化，不需要更新
- [x] 消息桥接 `00-README.md` — 子模块清单未变，不需要更新

## 5、关联变更与债务闭合

| 变更 | 关系 |
|------|------|
| `20260627113111-消息通道即时响应与流式输出` | **闭合 T-FIX-04**：`04-review` §7 记录的 SDK stream-text final 未传 inbound `message_id` 导致 `.claimed` 滞留；verify-issue 第 2 轮复现并归因后由本 lite 修复 |
| `20260627215516-Agent自动压缩与上下文占用展示` | 无冲突；footer 仍随 final 包下发 |
