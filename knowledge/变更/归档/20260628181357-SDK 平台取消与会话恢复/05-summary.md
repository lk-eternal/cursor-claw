# SDK 平台取消与会话恢复 - 变更总结

## 1、实际变更

- `electron/finalize-sdk-run.ts` — 新增 `PLATFORM_RUN_LIMIT_MS`（7min）平台长时 SSOT；收紧 `isRunTimeoutFailure`（移除 ERROR/EXPIRED 无条件 true）；`finalizeSdkRunOnTimeout` 先 notify 再 abort；超时路径统一 close+delete session（闭合 R1）
- `electron/agent-sdk.ts` — `handleSdkEvent` 平台长时 CANCELLED/ERROR/EXPIRED 经 `isRunTimeoutFailure` 走 finalizer；`completeSdkRun` / `streamRunEvents` 补充 cancelled 兜底
- `electron/sdk-failure-messages.ts` — `isTimeoutFailure` 分支优先于 CANCELLED 固定「任务已取消」句
- `electron/AGENTS.md` — 平台长时、notify 顺序、R2 收紧、非长驻清理约定对齐
- `package.json` — version `1.8.7` → `1.8.8`
- `changelog/1.8.8.json` — 用户可见 IM 文案与会话恢复改进

## 2、与设计的差异

无。`notifySdkFailure` 采用 finalizer 先 notify 再 abort，未增 `ignoreAborted` 参数（设计二选一，实现取 diff 更小侧）。W1 cancelled-only 无 status 边界路径未在本变更扩展，记 04-review W1 待 staging 联调。

## 3、影响范围

- **模块**：Electron SDK 运行收尾（`finalize-sdk-run`、`agent-sdk`、`sdk-failure-messages`）
- **用户可见**：平台约 7～8min 结束 → IM 等待超时类提示（非「任务已取消」）；超时后会话 idle + 重建可续聊
- **归档**：平台长时 `failureType=sdk_timeout`（非 `sdk_cancelled`）；用户 Stop 仍静默

### 3.1 Ponytail 技术债

无（本次 diff 未新增 `ponytail:` 注释；存量 `agent-sdk.ts` 行数超 300 为 W2 继承债务）

## 4、知识库影响清单

- [x] `electron/AGENTS.md` — T4 已更新平台长时、`PLATFORM_RUN_LIMIT_MS`、notify 顺序、R2/R1
- [x] `knowledge/业务域/**` — 无 IM 产品域结构变更，不需要更新
- [x] `knowledge/工程平台/**` — 无独立 Electron SDK 生命周期叶子文档；以 `electron/AGENTS.md` 为 SSOT
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
