# Agent Run 自动压缩 - 变更总结

> **变更 ID**：`20260628165558-Agent Run 自动压缩`  
> **stage**：`tested`（archive 前置；目录尚未迁移）  
> **前置**：`04-review.md` 通过；`06-automation-test.md` 已记录；`npm run build` 通过

## 1、实际变更

### 代码（与 `manifest.files` code 条目一致）

| 文件 | 状态 | 关键改动 |
|------|------|----------|
| `electron/sdk-failure-messages.ts` | 新增 | `SdkFailureContext`、`formatUserSdkFailureMessage`：超时 → 上下文已满 → 会话异常 → 可安全展示 message → 带建议兜底；禁止可归因场景仅「请稍后重试」 |
| `electron/context-usage-pressure.ts` | 新增 | `HIGH_WATERMARK_RATIO=0.85`；`evaluatePreSendContextPressureCore`（pre-send `[compression]` 日志）；`logTurnEndedHighWatermark`（turn-ended 高水位日志）；只读、不阻断 send |
| `electron/context-usage.ts` | 修改 | 导出 `evaluatePreSendContextPressure`（薄封装 re-export 压力模块）；`handleAgentSendDelta` turn-ended 挂接高水位日志；re-export `HIGH_WATERMARK_RATIO` |
| `electron/agent-sdk.ts` | 修改 | `launchSdkAgent` / `dispatchToSdkAgent` send 前调用 `evaluatePreSendContextPressure`；`formatSdkStreamFailure` 委托 `formatUserSdkFailureMessage`；`notifySdkFailure` 传入 peak/limit、errorCode、run.result、`isRunTimeoutFailure`；移除内联 `isUnsafeSdkMessage` / `KEEPALIVE_TIMEOUT_MS` |
| `electron/AGENTS.md` | 修改 | 补充失败归因类别表、pre-send / high-watermark 可观测约定、与 `finalize-sdk-run` 超时 finalizer 分工、F3.2 与分类器边界 |

### 变更文档（本阶段新增/更新）

- `04-review.md`、`06-automation-test.md`（评审与验收记录）
- 本文件 `05-summary.md`

### 未改动（显式）

- footer 格式与 `appendContextFooter` / `applyContextFooterToBuffer` 路径
- `finalize-sdk-run.ts` 超时判定与 finalizer 实现
- Daemon / CardKit / MCP stdio 路径

## 2、与设计的差异

1. **T2 落点文件拆分**（04-review §4，可接受）：设计预期 pre-send / high-watermark 合并进 `context-usage.ts`；实现将核心逻辑抽到 `context-usage-pressure.ts`（54 行），`context-usage.ts` 薄封装（278 行）。满足单文件 ≤300 行约束，**无行为差异**。
2. **F1「主动压缩」边界**（预期内）：无法新增 SDK `autoCompress`；pre-send 为只读可观测 + harness 默认压缩，**不在 send 前主动触发压缩 API**。与 02-design §二、01 非目标一致。
3. **04-review 可选改进**（不阻断 archive）：`CONTEXT_MESSAGE_PATTERNS` 可能过宽；`KEEPALIVE_TIMEOUT_MS` 与 finalizer 双处维护——归档后可抽共享常量。

除上述项外，**无**其它实质性设计偏差。

## 3、影响范围

### 模块与链路

- **Electron agent-sdk Run 生命周期**：长驻 `launchSdkAgent` / `dispatchToSdkAgent` send 前压力日志；失败 notify 经分类器输出可读 IM 文案
- **上下文用量**：`context-usage.ts` + `context-usage-pressure.ts`；onDelta turn-ended 高水位与既有 summary 压缩日志并存
- **IM 通道**：失败 notify 文案变更（上下文/会话/兜底）；压缩进行中「正在压缩上下文…」行为回归（每 Run ≤1 条，04-review 静态确认）
- **无** HTTP/proto/持久化 schema 变更

### 验收与测试状态（摘要）

| 类别 | 状态 |
|------|------|
| 构建冒烟 `npm run build` | 通过（06-automation-test §7） |
| T1～T5 静态 / 代码路径 | 通过（04-review §5、06 §3） |
| 01 验收 1～4 E2E（连续三轮 IM、压缩 notify） | 待人工/E2E（06 §4.2） |

### 3.1 Ponytail 技术债

无（本次 diff 新增/修改代码中未出现 `ponytail:` 注释）。

## 4、知识库影响清单

> 继承 `02-design.md` §十，按实现修正；`electron/AGENTS.md` 已在 apply 阶段更新。

### 必须更新（archive 阶段由 kb-librarian 执行）

- [x] `electron/AGENTS.md` — 失败归因类别、pre-send `[compression]`、与 finalizer 边界（**apply 已落盘**）

### 可能更新（视 archive 合并与文档对照）

- [ ] `knowledge/业务域/Agent调度/03-启动与自动重连.md` — 补充多轮 Run 上下文累积、pre-send 可观测与失败可读性一句（若与现网段落不一致）
- [ ] `knowledge/业务域/消息桥接/02-飞书通道.md` — 压缩进行中与失败 notify 语义（若与现网文档不一致）
- [ ] `changelog/<新版本>.json` + `package.json` version — 用户可见体验增强（失败文案可读、压缩可观测）；archive 按 kb-archive 规则 bump patch

### 不需要更新

- [x] footer 统计口径文档（`20260627231201-上下文占用统计修复` 范围；本变更未改 footer 实现）
- [x] 超时阈值与 finalizer 细节（`20260628163149-Agent Run 超时自动停止` 已归档；本变更未改 `finalize-sdk-run.ts`）
- [x] Daemon / Proto / MCP stdio 独立变更文档
- [x] `knowledge/知识索引.md` — 总入口未变化
