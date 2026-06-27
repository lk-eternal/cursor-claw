# 飞书作为 Cursor 展示与控制层 - 变更总结

> **归档范围**：MVP 阶段 0+1（T1–T7 done + tested + reviewed）。T8–T12（阶段 2/3：卡片按钮回调、工具批准、MCP 废弃、会话持久化、Electron 托盘 spawn-only）为**后续迭代，本归档仅覆盖 MVP**。

## 1、实际变更

| 文件 | 关键改动 |
|------|----------|
| `electron/workspace-injector.ts` | launch/启动路径注入 no-op；`cleanupLegacyInjection` 可选手动清理 |
| `electron/session-dispatcher.ts` | `dispatchSessionAgents` 空实现；IM 调度迁入 Daemon；launch 不调 inject |
| `electron/agent-sdk.ts` | `postPresentationEvent`（tool/thinking/assistant）；`f41Eligible` 扩展群聊；长驻 Agent + `dispatchToSdkAgent`；`agent-api-port.json` |
| `electron/config-store.ts` | 与 Daemon 转发 launch 契约对齐 |
| `electron/daemon-manager.ts` | 移除 Electron SSE/队列扫描调度 |
| `electron/AGENTS.md` | SDK-only、长驻 Agent、inject 废弃、Daemon SSOT 调度 |
| `src/daemon.ts` | MergeBatch 状态机 + 合并 CardKit；Presentation 路由；Daemon `runAgentDispatchLoop`；claim-and-merge；`poll-message` 404 |
| `src/shared/lark-core.ts` | 合并/工具/thinking CardKit；按钮占位（T8 接线） |
| `src/shared/channel-types.ts` | 类型微调（与通道配置一致） |
| `src/AGENTS.md` | CardKit 流式与进度约定 |
| `knowledge/变更/.../00-manifest.json` | T1–T7 done；T8–T12 pending |
| `knowledge/变更/.../01-proposal.md` | 业务 PRD |
| `knowledge/变更/.../02-design.md` | 分层设计与知识库计划 |
| `knowledge/变更/.../03-tasks.md` | 任务清单 |
| `knowledge/变更/.../04-review.md` | MVP 评审通过（R2/R3 info 债务） |
| `knowledge/变更/.../06-automation-test.md` | 自动化验收追溯 |

## 2、与设计的差异

| 项 | 设计 | 实际 | 原因 |
|----|------|------|------|
| 合并卡按钮 | MVP 可 fallback 斜杠 | HTTP `POST /api/merge-batch/action` + 回复卡片编辑；按钮渲染无 `card.action.trigger` | T8 后续迭代（R2，非 blocking） |
| dispatch 失败 | — | claim 后 ack，用户须手动重发 | 可选 re-queue 优化（R3，info） |
| 群聊 SDK 流式 | S1.8 | R1 修复后 `f41Eligible` 与 `isStreamTextEligible` 一致 | 已关闭 |

无其他与已确认决策（移除 inject、MergeBatch、SDK-only、长驻 Agent、Daemon 调度）相悖的偏差。

## 3、影响范围

- **架构**：Daemon 为 IM→调度→展示唯一编排进程；Electron `agent-api`（`agent-api-port.json`）负责 SDK launch/dispatch；Agent 不再 `poll-message`。
- **飞书展示**：合并 CardKit（静默窗口 2.5s）、工具/thinking CardKit、assistant 经 Presentation→stream-text；群聊 + `allowOthers` 可走同管道。
- **调度**：`scheduleAgentDispatch` 300ms 防抖 → `runAgentDispatchLoop` → `POST /api/agent/launch|dispatch`；长驻 Agent 二次任务走 dispatch。
- **配置**：launch/Daemon 就绪不再写 `~/.cursor` rules/MCP；手动 `workspace:inject` 仅写 admin Skill。

### 3.1 Ponytail 技术债

| 位置 | 注释摘要 | 升级路径 |
|------|----------|----------|
| `src/shared/lark-core.ts:405` | 合并卡按钮占位，回调由 T8 接线 | T8 `card.action.trigger` → `merge-batch/action` |
| `src/daemon.ts:1105` | split 后单条顺序 dispatch | T8 后评估是否需要并行 claim |
| `electron/workspace-injector.ts:28,71` | 注入缓存/写盘废弃，符号保留 | 阶段 3 清理或文档化手动 cleanup |
| `electron/agent-sdk.ts:698` | agent-api-port 写入；Daemon 转发 SSOT 后仍可直连 | T12 Electron 瘦身后统一端口发现 |
| `electron/session-dispatcher.ts:367` | 空调度保留兼容 | T12 删除空实现 |

## 4、知识库影响清单

- [x] `knowledge/业务域/消息桥接/01-概览.md` — Daemon 编排架构、MergeBatch 术语、Presentation 管道
- [x] `knowledge/业务域/消息桥接/02-飞书通道.md` — 合并 CardKit、F3 回复编辑、工具/thinking CardKit、群聊 eligible
- [x] `knowledge/业务域/消息桥接/04-消息队列与路由.md` — MergeBatch、静默窗口、dispatch 门控、新 HTTP 端点
- [x] `knowledge/业务域/Agent调度/01-概览.md` — Daemon 调度、SDK-only IM 路径
- [x] `knowledge/业务域/Agent调度/02-多会话模型.md` — 长驻 Agent 与 dispatch 边界
- [x] `knowledge/业务域/Agent调度/03-启动与自动重连.md` — SDK 长驻、废弃 poll 保活、无 inject
- [x] `knowledge/业务域/Agent调度/04-远程指令.md` — 控制层 MVP 路径（HTTP/回复编辑；按钮 T8）
- [x] `knowledge/工程平台/Daemon守护进程/01-概览.md` — 唯一编排进程、poll 移除
- [x] `knowledge/工程平台/Daemon守护进程/02-HTTP与MCP服务.md` — presentation/merge/agent API；poll 404
- [x] `knowledge/工程平台/Daemon守护进程/03-进程模型与部署.md` — agent-api-port 转发
- [x] `knowledge/工程平台/Electron桌面应用/04-配置与更新.md` — inject no-op
- [x] `knowledge/业务域/消息桥接/00-README.md` — 源码锚点补充 daemon 编排
- [x] `knowledge/业务域/Agent调度/00-README.md` — 职责边界（inject/调度）
- [x] `knowledge/工程平台/Daemon守护进程/00-README.md` — 移除 poll-message 表述
- [x] `knowledge/业务域/消息桥接/03-微信通道.md` — MVP 未改微信管道，无需更新
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新

**后续迭代（T8–T12，不在本清单）**：卡片按钮闭环、工具批准、admin MCP 废弃、Agent 持久化、Electron spawn-only — 对应知识在下一阶段 archive 合并。
