# SDK 保活与 Run 生命周期兼容 - 变更总结

## 1、实际变更

| 文件 | 关键改动 |
|------|----------|
| `electron/agent-sdk.ts` | `lastTool` 快照；error 终态结构化日志；`formatSdkStreamFailure` F3.2 保活超时文案（shell:running + duration≥20min） |
| `resources/template/rule/cursor-claw.mdc` | 阶段 4 改为 `wait=false` + `sleep 5` 非阻塞保活循环；前文 poll 模式表与异常恢复表述对齐 |
| `package.json` / `package-lock.json` | `@cursor/sdk` ^1.0.12 → ^1.0.22 |
| `package.json` | 版本 1.4.0 → 1.4.1（archive） |
| `changelog/1.4.1.json` | 用户可见稳定性修复条目（archive） |
| `knowledge/工程平台/Daemon守护进程/02-HTTP与MCP服务.md` | poll `wait=false` 与 blocking 适用场景 |
| `electron/AGENTS.md` | SDK lastTool / 保活失败 F3.2 约定 |
| `knowledge/业务域/Agent调度/03-启动与自动重连.md` | SDK 非阻塞保活 vs CLI blocking poll 差异 |

## 2、与设计的差异

- **R1（已修）**：archive 时同步更新 `cursor-claw.mdc` 前文 poll 模式表与 §156，与阶段 4 非阻塞循环一致。
- **R2（遗留观察）**：非阻塞保活路径下 SDK Run 终止时 `lastTool` 可能为 `completed` 而非 `shell:running`，F3.2 兜底文案需 staging ≥25min 联调确认；静态实现已按 design 三条件分类。
- **长时联调**：K1–K9 staging 必测项见 `06-automation-test.md`，未在本轮 archive 前执行。

## 3、影响范围

- **Electron SDK 路径**：`launchSdkAgent` error 可观测性、用户 notify 文案分支。
- **Agent 规则**：工作区注入的 `cursor-claw.mdc` 保活阶段行为。
- **Daemon**：`/api/poll-message` 行为未改；blocking 25min SYSTEM OVERRIDE 仍仅 CLI/legacy blocking 路径触发。
- **依赖**：`@cursor/sdk` 1.0.22。

### 3.1 Ponytail 技术债

无

## 4、知识库影响清单

- [x] `knowledge/工程平台/Daemon守护进程/02-HTTP与MCP服务.md` — poll `wait=false` 即时返回 vs blocking 25min SYSTEM OVERRIDE
- [x] `electron/AGENTS.md` — lastTool、error 日志字段、F3.2 保活失败文案
- [x] `knowledge/业务域/Agent调度/03-启动与自动重连.md` — SDK 非阻塞保活 vs CLI blocking poll
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
- [x] `changelog/1.4.1.json` + `package.json` version — 用户可见稳定性修复
