# 飞书排队消息状态反馈与合并预览 — 轻量契约脚本

变更 ID：`20260627150041-飞书排队消息状态反馈与合并预览`

## 用途

- 验证 `POST /api/session-agent-phase` HTTP 契约（对应 `03-tasks` T2）。
- T-FIX-01 非破坏冒烟：`processing` 后、`idle` 后各一次 `GET /api/poll-message?wait=false`，断言 instant poll 路径不 500 且响应含 `messages`（`ensureMergePreviewSentBeforeClaim` / idle 补偿钩子可达；无队列文件时不 claim）。
- **T-FIX-02 手工冒烟**（无 HTTP 脚本）：模拟 08 第 2 轮「重启首条」— 见下文；对应 `06-automation-test.md` §4.1 **F15**。
- **非**飞书端到端联调；F1/F2/F3 须按 `06-automation-test.md` §4.1 手工验收。

## 前置

- daemon 已启动（Electron 应用或独立守护进程）。
- 端口可读：环境变量 `DAEMON_PORT` 或 `LARK_DAEMON_PORT`；未设置时默认 `19528`。

## 运行

```bash
export DAEMON_PORT=19528   # 按本地 lock 实际端口调整
./phase-api-contract.sh
```

可选：`KB_TEST_SESSION_KEY` 指定测试用 session_key（默认 `__kb_test_phase__`，非真实会话）。

## T-FIX-02 手工冒烟（重启首条 / F15）

`cleanupOrphanClaimedOnColdStart` 在 `initQueue` 执行，**无法**用 `phase-api-contract.sh` 覆盖；按下列步骤非破坏或本地队列目录验证。

### 方式 A — 复现 08 第 2 轮（推荐）

1. 正常使用至会话目录存在未 ack 的 `.claimed`（或上轮 instant poll 后未清理）。
2. **完全退出** Electron 应用（确保 daemon 进程结束）。
3. 重新启动应用；查看 daemon 日志是否出现 `冷启动回收遗留 claimed→qmsg: N 条`（N≥1 时）。
4. 飞书私聊对该会话发**首条**消息。
5. **通过**：F1 为「已收到，等待 Agent 领取」或冷启动「正在启动」类文案；**不**出现「Agent 正在处理上一条」及基于 stale claimed 的虚假「前面还有 5 条待处理」。

### 方式 B — 本地队列目录 ⚠

1. 停止 daemon；在目标 `sessionKey` 队列目录手工放入若干 `*.claimed`（可从同结构 `.qmsg` 改名，勿用生产密钥路径以外环境）。
2. 启动 daemon → 确认 claimed 已变 `.qmsg` 且日志有条数。
3. 飞书发首条验证 F1（同方式 A 第 5 步）。

**失败判责**：未全量重启 → 操作问题；重启后仍误报 processing → 服务/实现问题。

## 通过准则

- starting → processing → idle 均返回 HTTP 200 且 body `ok: true`。
- T-FIX-01：`wait=false` instant poll 在 processing / idle 后均 HTTP 200；连续 idle 不报错。
- 缺 `session_key` 或非法 `phase` 返回 HTTP 400。
- 任一步失败则脚本 exit 1。

## 局限

- 无 GET 端点，无法 HTTP 断言 Map 内存态；idle 删除由 daemon 单测/04 静态覆盖。
- 不写入真实凭据；勿在日志中打印 token。
- T-FIX-02 依赖重启与文件队列，本目录**不**新增 shell 脚本；以 06 §4.1 F15 为准。
