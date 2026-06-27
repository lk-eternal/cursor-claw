# 上下文占用统计修复 - 变更总结

> **变更 ID**：`20260627231201-上下文占用统计修复`
> **来源**：kb-lite
> **lite 类型**：hotfix-lite
> **阶段**：`tested`（LITE-01/02 done；待 kb-release 迁移与 changelog 扩充）

---

## 1、根因确认

| # | 根因 | 说明 |
|---|------|------|
| 1 | **`mergeTurnUsage` Run 内累加** | `turn-ended` 每次 merge 叠加 usage，同一 Run 多 turn（含 tool 轮次）导致 `used` 虚高，短对话也可能显示 100% 且 `(used/limit)` 中 used 远超 limit |
| 2 | **`totalContextTokens` 口径过重** | 原计算含 **output** token，展示侧把「已用上下文」放大，与窗口占用语义不符 |

## 2、实际变更

| 文件 | 关键改动 |
|------|----------|
| `electron/context-usage.ts` | `turn-ended` 经 `updateContextUsageDisplay` → `setTurnUsage` **replace**（非 Run 内 merge）；`totalContextTokens` 收窄为 prompt 侧（`input + cacheRead + cacheWrite`，**不含 output**）；`contextUsagePeakTokens` 跨 turn 抬升 peak，footer 展示取 `max(current, peak)`；`formatContextFooter` 新增 `usedOverride` 参数，优先 Run 级 `totalTokens` |
| `electron/context-usage-run-end.ts` | **新建**：Run 结束读 `run.usage`，与 turn-ended 快照 **并排打 `[context-usage]` 对照日志**；写入 `contextUsageFromRunTotal` / `contextUsageFinalized`；footer 源优先 `run.usage.totalTokens` |
| `electron/agent-sdk.ts` | 新增 `finalizeRunContextUsage`（`run.stream()` 结束后、`flushStreamPost(final=true)` 前调用；异常路径亦 finalize）；session 字段 `contextUsageFromRunTotal` / `contextUsageFinalized`；`applyContextFooterToBuffer` 传 `usedOverride` |
| `electron/AGENTS.md` | 沉淀 footer 时序：`finalizeRunContextUsage` → 对照日志 → final flush 前 append；`run.usage.totalTokens` 优先于 turn-ended/peak 约定 |

**变更文档**：`01-proposal.md`、`00-manifest.json`、`05-summary.md`（本文件）、`06-automation-test.md`。

**不在本变更 scope**：`electron/mcp-manager.ts`、proto/DB、飞书 CardKit 协议。

## 3、与设计的差异

相对 `01-proposal.md`（LITE-01 仅 `context-usage.ts`）有**实现扩展**，非口径回退：

| 项 | 01 预期 | 实际 |
|----|---------|------|
| 改动文件 | 单文件 `context-usage.ts` | 增 `context-usage-run-end.ts`，并改 `agent-sdk.ts` 挂载 finalize |
| footer 用量源 | turn-ended replace + prompt 口径 | 同上，且 Run 结束 **优先** `run.usage.totalTokens`（不可得时回退 turn-ended/peak） |
| 可观测 | 无明确要求 | SDK UI 日志 `[context-usage]` 并排输出 turn-ended 与 `run.usage` 字段，便于联调对照 |

扩展动机：turn-ended 末轮快照可能低于 Run 内真实峰值；`run.usage` 为 SDK 终态，与 footer 展示更一致。

## 4、影响范围

- **涉及模块**：Electron `context-usage` helper、`context-usage-run-end`、`agent-sdk` Run 收尾路径；飞书/SDK IM 终态回复 footer 数字。
- **用户可见**：**是** — footer 百分比与 `(used/limit)` 反映真实占用（虚高修复）；同 session 多 Run 间 peak / run total 口径一致；开发/联调可见 `[context-usage]` 对照日志（非 IM 下发）。
- **接口/数据**：无 HTTP/proto/持久化变更；session 内存态 only。
- **关联变更**：修正 `knowledge/变更/归档/20260627215516-Agent自动压缩与上下文占用展示/` 引入的统计口径；footer 展示格式与下发路径不变。

### 4.1 Ponytail 技术债

无（diff 中无 `ponytail:` 注释）。

## 5、知识库影响清单

hotfix-lite / 记录型：**业务域无需更新**。

| 文件/分区 | 结论 | 原因 |
|-----------|------|------|
| `knowledge/业务域/**` | 无需更新 | footer 展示形态未变，仅数字口径与 Run 终态源修正 |
| `knowledge/工程平台/**` | 无需更新 | 统计 helper 为 Electron 内部实现；口径与时序已写入 `electron/AGENTS.md` |
| `knowledge/知识索引.md` | 无需更新 | 无新领域/分区入口 |
| `electron/AGENTS.md` | 已更新（代码仓 AGENTS，非 KB） | replace 语义、prompt 侧 used、`run.usage` 优先与 finalize 时序已沉淀 |

- [x] 业务域 — 无结构性文档变更
- [x] 工程平台 — 记录型不扩 KB
- [x] 知识索引 — 总入口未变化

## 6、验收与复测建议

| # | 项 | 操作 | 状态 |
|---|-----|------|------|
| 1 | **飞书短对话 footer** | 私聊/群聊仅 1～2 轮简单问答，确认 footer 百分比合理、used 不应远超 limit、不应无故 100% | ⏳ **建议用户复测** |
| 2 | 多 turn Run | 同一 Run 内多次 tool turn 后，footer 反映 peak / run total，不因 merge 重复累加 | ⏳ 建议人工 |
| 3 | 口径一致 | prompt 侧 `used` 不含 output；与 `electron/AGENTS.md` 约定一致 | ✅ 代码已实现 |
| 4 | **run.usage finalize** | `streamRunEvents` 流结束后调用 `finalizeRunContextUsage`；日志含 turn-ended 与 `run.usage` 对照；footer `usedOverride` 优先 run total | ✅ 静态 + quick check Q4 |
| 5 | 回归 | 自动压缩、`[compression]` 日志、footer append 行为不退化 | ⏳ 建议人工 |
| 6 | 编译 | TypeScript 编译通过 | ✅ tsc 通过（`06-automation-test`） |

## 7、归档待办（`/kb-archive`）

- **版本**：`package.json` 已为 **1.8.1**（scribe 不 bump）。
- **changelog**：`changelog/1.8.1.json` 已存在；**条目扩充**（run.usage 对照、peak 等）由 **kb-release** 执行。
- **迁移**：kb-release 将 `stage` → `archived`，目录 `mv` 至 `knowledge/变更/归档/`。
