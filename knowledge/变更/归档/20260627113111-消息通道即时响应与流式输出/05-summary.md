# 消息通道即时响应与流式输出 - 变更总结

## 1、实际变更

| 文件 | 关键改动 |
|------|----------|
| `src/file-queue.ts` | 新增 `getSessionPendingCount`（`.qmsg` + `.claimed` 计数） |
| `src/wechat-manager.ts` | `startProgressTyping`/`stopProgressTyping`；`sendText`/`sendMedia` 默认 `skipTyping: true` |
| `src/daemon.ts` | 入队确认 `confirmEnqueueAndStartProgress`；`sessionProgressMap`/`sessionGetReactedIds`；`POST /api/stream-text`；`send-text` 增 `stop_progress`；poll Get 去重；`ackOnReply` 含 stop |
| `src/shared/lark-core.ts` | `sendStreamMessage`、`updateMessageContent`（PATCH/update 降级） |
| `electron/session-dispatcher.ts` | 冷启动「正在启动」；启动成功「Agent 处理中…」；失败 notify + `stop_progress` |
| `electron/agent-sdk.ts` | `f41Eligible` 流式桥接 `/api/stream-text`；SDK 错误 notify |
| `src/AGENTS.md` | 进度状态机、send-text/stop 边界、poll Get 去重约定 |
| `electron/AGENTS.md` | SDK notify/stream 约定（随 T7 补充） |
| `knowledge/变更/.../03-tasks.md` | 任务清单 |
| `knowledge/变更/.../04-review.md` | 复评通过 + T-FIX 闭环 |
| `knowledge/变更/.../06-automation-test.md` | 验收追溯与联调占位 |

**统计**：8 个实现/约定文件，约 +800 / −54 行（`git diff --stat`）。

## 2、与设计的差异

无结构性偏差。04-review 复评确认 R1–R4 已修复。联调项（NF1/NF2 首段时效、PATCH POC）仍待手工验证，不阻断归档。

## 3、影响范围

- **端点**：`POST /api/stream-text`（主用户私聊 SDK 流式）；`POST /api/send-text` 增可选 `stop_progress`。
- **内部**：`SessionProgressState` 内存 Map；`sessionGetReactedIds` 独立 Get 去重。
- **通道**：飞书入队即 Get + 流式 PATCH/分段；微信进度 typing 与 sendText 解耦。
- **Agent 侧**：session-dispatcher 三态文案；agent-sdk assistant delta → stream-text。

### 3.1 Ponytail 技术债

diff 中无 `ponytail:` 注释。

| 位置 | 注释摘要 | 升级路径 |
|------|----------|----------|
| `electron/agent-sdk.ts`（04-review §7） | SDK `stream-text final` 未传 inbound `message_id`；`.claimed` 依赖后续 MCP `send_text` | 联调后追加 T-FIX-04：agent-sdk 跟踪 poll 领取 id，或 daemon final 无 id 时 ack 会话全部 claimed |
| `electron/agent-sdk.ts:41` + `daemon.ts:305`（04-review §3 shrink） | 双层流式节流（400ms + 500–1500ms）可能抬高首段延迟 | 合并为单点 `STREAM_TEXT_THROTTLE_MS` 配置 |
| `src/daemon.ts` send-image/file（04-review §7） | 成功且带 `session_key` 时外层重复 `stopSessionProgress`（幂等） | 可删外层重复调用，仅保留 `ackOnReply` 内 stop |

## 4、知识库影响清单

- [x] `knowledge/业务域/消息桥接/04-消息队列与路由.md` — 入队确认、pending 计数、stream-text API、进度 Map
- [x] `knowledge/业务域/消息桥接/02-飞书通道.md` — Get 时序、流式 PATCH/分段降级
- [x] `knowledge/业务域/消息桥接/03-微信通道.md` — typing 生命周期与 sendText 解耦
- [x] `knowledge/业务域/消息桥接/01-概览.md` — 三态主流程 mermaid、术语与全局约束
- [x] `knowledge/业务域/消息桥接/00-README.md` — 未变（文件清单与阅读路径仍有效）
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
- [x] `knowledge/工程平台/` Agent/SDK 子模块 — 02 §10·（二）列为可能更新；本期行为已写入消息桥接域，工程平台无独立叶子文档，暂不新增
