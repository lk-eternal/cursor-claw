# 上下文占用统计修复 - 验收记录

> **变更 ID**：`20260627231201-上下文占用统计修复`
> **阶段**：`/kb-test`（hotfix-lite；**quick check** 单元逻辑推演 + tsc 冒烟 + run.usage 静态；飞书 E2E 可选）
> **设计来源**：`01-proposal.md`（无 `02-design` / `03-tasks`；追溯 `LITE-01`/`LITE-02` 与 `01` 验收 1–5）

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **quick check**（helper 纯函数逻辑推演 + 静态代码路径）+ **tsc 冒烟**（`npm run build:mcp`）；**不新增**单元测试 / `auto_test/` 脚本 |
| **目标** | 覆盖 `01-proposal` 验收 1–5、`LITE-01`（replace 口径 + `totalContextTokens` 不含 output）、`LITE-02`（run.usage finalize + 对照日志 + `usedOverride`） |
| **通过口径** | 三场景推演结论与修复意图一致 + Q4 静态路径确认 + `handleAgentSendDelta` 使用 `updateContextUsageDisplay`/`setTurnUsage` + tsc exit 0；飞书 footer 真实数值可选联调 |
| **与 review 分工** | review 偏实现；本文负责 quick check 追溯与执行记录 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **01·1 短对话飞书 footer** | 依赖真实 SDK Run 与 `turn-ended.usage`；本地 quick check 用典型 token 切片推演 |
| **01·2 多 turn Run 真实观测** | 须同 Run 连续多轮 send；逻辑层已由 replace vs merge 对比覆盖 |
| **01·4 自动压缩回归** | 须长上下文触发 summarization；本 hotfix 不改压缩路径，仅 spot-check |
| **Q4 run.usage 运行时对照** | 静态确认调用链与日志格式；真实 `[context-usage]` 并排字段需 SDK Run 联调 |
| **`auto_test/` 脚本** | hotfix-lite 未新增；quick check 足够阻断 merge/口径回归 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1** | 短对话 footer 合理，used 不应远超 limit、无故 100% | quick check Q2 + 可选 E2E | 推演 / 飞书摘要 | ✅ 推演 |
| **01·2** | 同 Run 多 `turn-ended` 反映**最新 turn** + peak，非 merge 累加 | quick check Q1 | 推演 | ✅ 推演 |
| **01·3** | `totalContextTokens` 不含 output | quick check Q2 + 静态读 `totalContextTokens` | 推演 / 代码 | ✅ 推演 + 静态 |
| **01·4** | 自动压缩与 footer append 不退化 | 静态（未改 `appendContextFooter` / compression 分支） | 代码复核 | ✅ 静态 |
| **01·5** | TypeScript 编译通过 | `npm run build:mcp` | 构建摘要 | ✅ tsc 通过 |
| **LITE-01** | `turn-ended` → `setTurnUsage` replace | 静态读 `handleAgentSendDelta` | 代码复核 | ✅ 静态 |
| **LITE-02 / Q4** | stream 结束后 `finalizeRunContextUsage`；`[context-usage]` 含 turn-ended 与 run.usage 对照；footer `usedOverride` 优先 run total | 静态读 `context-usage-run-end.ts`、`agent-sdk.ts` | 代码复核 | ✅ 静态 |
| **percent clamp** | 0–100；used > limit 时 percent=100 可接受 | quick check Q3 | 推演 | ✅ 推演 |

## 4、场景摘要

### 4.1 quick check（单元逻辑推演）

假定 `limitTokens = 200_000`（composer/claude 启发式上限）。推演调用链：`setTurnUsage` → `totalContextTokens` → `formatContextFooter`。

| 场景 ID | 输入（每 turn `turn-ended.usage`） | 旧行为（merge + 含 output） | 新行为（replace + prompt 口径） | 期望 footer 摘要 | 关联 |
|---------|-----------------------------------|-----------------------------|----------------------------------|-------------------|------|
| **Q1 多 turn replace** | 同 Run 连续 3 次 turn-ended；每次 `input=50k`、`cacheRead=50k`、`output=0` | merge 累加 used ≈ **300k**；percent 顶格 100%，`(468.7k/200k)` 类虚高 | 每次 replace，最终 used = **100k**（50k+50k）；percent ≈ **50%** | `上下文：50% (100k/200k)` | 01·2、LITE-01 |
| **Q2 短对话不虚高** | 1～2 轮：`input=3k`、`cacheRead=1k`、`output=50k`（output 大但不应计入窗口） | 若含 output，used ≈ **54k+** 仍偏低；merge 多 turn 或更大 output 易触顶 | used = **4k**（3k+1k）；percent ≈ **2%** | 非无故 100%；used ≪ limit | 01·1、01·3 |
| **Q3 percent clamp** | `input=150k`、`cacheRead=100k` → used=**250k**，limit=200k | 同上 clamp | `Math.round(125)` → clamp **100%**；`(250k/200k)` 可接受 | `上下文：100% (250k/200k)` | 展示边界 |

**Q1 对比要点**：`mergeTurnUsage` 三轮后 `totalContextTokens` = 300_000；`setTurnUsage` 三轮后仍为 100_000（最后一轮快照）。

**Q2 对比要点**：`totalContextTokens` 忽略 `outputTokens`；短句问答典型 prompt 侧 token 远低于 limit。

### 4.2 静态 / tsc 冒烟

| 检查 | 操作指针 | 期望 |
|------|----------|------|
| replace 挂载 | `handleAgentSendDelta` 在 `turn-ended` 分支 | 调用 `updateContextUsageDisplay` → `setTurnUsage`，**非** `mergeTurnUsage` |
| 口径函数 | `totalContextTokens` | `input + cacheRead + cacheWrite`，**不含** `outputTokens` |
| footer 格式化 | `formatContextFooter` | `usedOverride > 0` 时优先 override；否则 `resolveDisplayContextTokens`；percent ∈ [0,100] |
| **Q4 finalize 时序** | `agent-sdk.ts` `streamRunEvents` | `run.stream()` 循环结束后、`flushStreamPost(final=true)` **前** `await finalizeRunContextUsage` |
| **Q4 对照日志** | `context-usage-run-end.ts` `finalizeContextUsageAtRunEnd` | 单行 `[context-usage]` 含 `turn-ended:` 与 `run.usage:` 字段；`contextUsageFinalized` 防重复 |
| **Q4 footer 源** | `applyContextFooterToBuffer` → `formatContextFooter` | 第四参 `session.contextUsageFromRunTotal` 作为 `usedOverride` |
| 行数 | `electron/context-usage.ts` | ≤300 行 |
| TypeScript | 项目根 `npm run build:mcp` | exit 0 |

### 4.3 可选 E2E（非 quick check 阻断）

| 场景 ID | 步骤摘要 | 期望 |
|---------|----------|------|
| **E1 短对话** | 飞书私聊 1～2 轮简单问答 | footer 百分比低，used 与 limit 同量级 |
| **E2 多 turn** | 同 Run 多轮后继续对话 | footer 反映 peak / run total，非逐 turn merge 叠加 |
| **E3 run.usage 日志** | SDK UI 日志过滤 `[context-usage]` | turn-ended 与 run.usage 并排可读 |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无 `auto_test/` 新增 |
| **运行依赖** | quick check 无需启动应用；E2E 需 Electron + daemon + SDK Agent + 飞书通道 |
| **环境变量** | 仅名称：`LARK_*`、SDK `apiKey`（应用内已配置）；**不写密钥** |
| **推演入口** | 只读 `electron/context-usage.ts` 导出：`setTurnUsage`、`mergeTurnUsage`、`totalContextTokens`、`formatContextFooter`；finalize 读 `context-usage-run-end.ts`、`agent-sdk.ts` |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- quick check 失败时区分：**推演/静态误判** vs **实现与 01 不一致**。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-27 | 本地 dev | Q1 多 turn replace 推演 | 通过 | used=100k 非 300k+ |
| 2026-06-27 | 本地 dev | Q2 短对话口径推演 | 通过 | output 不计入 |
| 2026-06-27 | 本地 dev | Q3 percent clamp 推演 | 通过 | 250k/200k→100% |
| 2026-06-27 | 本地 dev | LITE-01 静态（setTurnUsage 挂载） | 通过 | turn-ended replace |
| 2026-06-27 | 本地 dev | **Q4 / LITE-02 静态（finalize + 对照日志）** | 通过 | stream 后 finalize；usedOverride |
| 2026-06-27 | 本地 dev | `npm run build:mcp`（tsc） | 通过 | exit 0 |
| 2026-06-27 | — | E1–E3 飞书/SDK E2E | 待执行 | 可选联调 |
