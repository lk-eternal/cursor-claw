# Agent失败日志崩溃分析归档 - 变更总结

## 1、实际变更

### 代码与配置

| 文件 | 关键改动 |
|------|----------|
| `electron/crash-log-archiver.ts` | **新增**（175 行）。单一入口 `archiveAgentFailureLogs`：读 `crashAnalysisDir`、触发行锚点、`getLogBuffer` ±30 截取、上海时区 `yyyymmddhhmmss[-NNN]` 事件目录、写 `electron-log.txt` + `meta.json`；未配置 WARN 节流跳过；内部 catch 不 throw |
| `electron/config-store.ts` | `AppConfig` 增 `crashAnalysisDir: string`，defaults 空字符串 |
| `electron/preload.ts` | `AppConfig` 类型同步 `crashAnalysisDir` |
| `src/renderer/env.d.ts` | Renderer 侧 `AppConfig` 类型同步 |
| `electron/agent-sdk.ts` | `SdkSessionAgent.failureArchiveDone`；`notifySdkFailure` / `notifyDispatchFailure` 在 IM notify 前调用归档；`startSdkRun` / `resetSdkRunPresentationState` 清零闩；stream catch 传 `sdk_stream_exception` |
| `electron/finalize-sdk-run.ts` | `finalizeSdkRunOnTimeout` 在 `notifySdkFailure` **之前**调用归档（`sdk_timeout`） |
| `src/renderer/pages/Settings.tsx` | general tab 增「崩溃分析目录」：目录选择器 + 清除 + autoSave |
| `electron/AGENTS.md` | 新增「Agent 失败日志归档」小节：挂接点、`crashAnalysisDir`、`failureArchiveDone`、产物结构与 notify/daemon.log 边界 |

### 版本与 Changelog（由 kb-release 创建）

| 文件 | 说明 |
|------|------|
| `package.json` | 版本由 **1.8.5** bump 至 **1.8.6**（kb-release 执行） |
| `changelog/1.8.6.json` | 用户可见变更摘要（kb-release 新建） |

### 变更文档

| 文件 | 说明 |
|------|------|
| `05-summary.md` | 本文件 |

## 2、与设计的差异

1. **W2（accepted_debt）**：`crash-log-archiver.ts` 中 `failureArchiveDone` 仅在写盘 try 块成功末尾置位；若 `mkdirSync` 成功而 `writeFileSync` 失败进入 catch，闩未置位，同次 finalizer→notify 链可能产生第二个事件目录。低概率边缘，06-automation-test 记为 accepted_debt，不阻断归档；后续可选 T-FIX-01 修复。
2. **meta.buffer.totalInSnapshot**：实现为导出片段行数，非全 buffer 总长；02 schema 示例易歧义，功能不受影响（04-review 轻微偏差）。
3. **W1（已关闭）**：评审时 `electron/AGENTS.md` 未更新；apply 后已补齐失败归档约定，T5 done。
4. 其余实现与 `02-design.md` 一致（单一入口、三处挂接、finalizer 先于 notify、未配置 WARN 跳过、±30 截取、同秒 `-NNN`、不改 IM 文案、不归档 `daemon.log`）。

## 3、影响范围

| 模块 | 影响 |
|------|------|
| Agent 失败路径 | Run error、流 catch、dispatch catch、超时 finalizer、CANCELLED 经 notify 或 finalizer 触发归档 |
| 配置 | 新增 `crashAnalysisDir`；Settings general 可配；空字符串跳过 |
| IM / Daemon | **无行为变更**；归档在 `notifySessionChat` 前 best-effort，不增 IM 条数或长日志 |
| 磁盘 | 用户配置目录下按事件建子目录；无自动清理 |
| CLI / 非 notify 链 | 不覆盖（02 §九·3）；`no resident agent` 早退不归档 |

### 3.1 Ponytail 技术债

无（本次 diff 未新增 `ponytail:` 注释）。

## 4、知识库影响清单

- [x] `electron/AGENTS.md` — 失败归档挂接点、`crashAnalysisDir`、`failureArchiveDone`、产物与 notify/daemon.log 边界（代码侧已更新）
- [ ] `knowledge/工程平台/Electron桌面应用/04-配置与更新.md` — 「六、数据」或相关段补 `crashAnalysisDir` 与 Settings 入口（**kb-librarian** 同轮更新）
- [ ] `knowledge/工程平台/Electron桌面应用/02-主进程与IPC.md` — 可观测/失败路径段补 `archiveAgentFailureLogs` 挂接与产物约定（**kb-librarian** 同轮更新）
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
- [x] 飞书/IM 业务域、Daemon 编排文档 — 02 §十·（三）定案不需要更新
