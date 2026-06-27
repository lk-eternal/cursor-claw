# Agent 自动压缩与上下文占用展示 - 变更总结

## 1、实际变更

| 文件 | 要点 |
|------|------|
| `electron/context-usage.ts`（新建，~180 行） | `ContextUsageState` 与 `mergeTurnUsage`；`resolveModelContextLimit` / `resolveContextLimitForSession`（`Cursor.models.list` + session 级缓存）；`formatContextFooter` / `appendContextFooter`（`\n\n---\n上下文：{p}% ({usedK}k/{limitK}k)`，limit 或 usage 不可得返回 null）；`handleAgentSendDelta` / `createAgentSendOptions`（turn-ended 累积 usage，summary-* 写 `[compression]` UI 日志） |
| `electron/agent-sdk.ts` | `SdkSessionAgent` 扩展 `contextUsage`、`contextLimitTokens`、`modelId`、`apiKey`；`resetSdkRunPresentationState` 清零 usage；`launchSdkAgent` / `dispatchToSdkAgent` send 前 `resolveContextLimitForSession` 并传入 `createAgentSendOptions`；`doFlushStreamPost(final=true)` 前 `applyContextFooterToBuffer`；`notifySdkFailure` optional append footer |
| `electron/AGENTS.md` | 补充 SDK 自动压缩（harness 默认、onDelta 可观测）、上下文 footer（final-only、单一落点 agent-sdk、省略条件）、错误 notify optional footer |
| `package.json` | 版本 bump `1.6.4` → `1.7.0`（用户可见 minor） |
| `changelog/1.7.0.json` | 用户可感知变更摘要 |

**未改（与设计一致）**：`src/daemon.ts`、飞书 CardKit 渲染、CLI `launchAgent` 路径；daemon 不二次 append footer。

## 2、与设计的差异

引用 `04-review.md` §4 设计偏差：

1. **B3-b 非 f41 成功 notify 路径未 append footer**
   - 设计预期：`02-design.md` S5 / T4 — 非流式终态 notify 正文末尾 append。
   - 实际：成功 Run 的非 f41 路径 assistant 正文仅 `appendSdkLog` 写 UI 日志，**无**经 `notifySessionChat` 下发用户可见终态正文，故无 append 挂点。
   - 评审结论：**非偏差**，属既有出站架构约束；飞书主路径（主用户私聊 + 飞书群聊 `allowOthers`）均 `f41Stream=true`，footer 经 `doFlushStreamPost(final=true)` 覆盖 PRD 验收 1/2/3。

无其他与 `02-design.md` 已确认决策相悖的偏差。

## 3、影响范围

- **模块**：Electron `agent-sdk`（SDK Run 生命周期、流式出站、错误 notify）；新建 `context-usage` helper；`electron/AGENTS.md` 约定。
- **用户可见**：飞书/SDK IM 流式终态回复末尾附上下文占用 footer；SDK UI 日志可检索 `[compression]` 压缩事件；错误 notify 在 usage 与 limit 可得时 optional footer。
- **接口/数据**：无 HTTP/proto/持久化变更；session 内存态 only。
- **风险（非阻断）**：`models.list` 上限字段依赖运行时探测，部分模型可能长期省略 footer（见 `04-review` §3 警告 1）；`agent-sdk.ts` 仍 >300 行为变更前存量债务（§7）。

### 3.1 Ponytail 技术债

无（本次 diff 未新增 `ponytail:` 注释）。

## 4、知识库影响清单

对照 `02-design.md` §十：

- [x] `electron/AGENTS.md` — footer 格式、final-only、占用不可得省略、压缩日志、CLI 范围外（implement 已更新）
- [ ] `knowledge/业务域/消息桥接/02-飞书通道.md` — **预期**由 kb-librarian 同轮视实现补一句「回复末尾上下文占用 footer」；若 librarian 判定与现有「回复形态」段已足够则可标不需要
- [x] `src/AGENTS.md` — daemon 侧无 append，预计不需要更新（与 §十·（三）一致）
- [x] `knowledge/知识索引.md` — 总入口未变化，不需要更新
- [x] Proto / 工程平台 Electron 十段式子模块 — 无结构性架构变更，不需要更新
