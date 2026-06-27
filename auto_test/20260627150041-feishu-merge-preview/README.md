# 飞书排队消息状态反馈与合并预览 — 轻量契约脚本

变更 ID：`20260627150041-飞书排队消息状态反馈与合并预览`

## 用途

- 验证 `POST /api/session-agent-phase` HTTP 契约（对应 `03-tasks` T2）。
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

## 通过准则

- starting → processing → idle 均返回 HTTP 200 且 body `ok: true`。
- 缺 `session_key` 或非法 `phase` 返回 HTTP 400。
- 任一步失败则脚本 exit 1。

## 局限

- 无 GET 端点，无法 HTTP 断言 Map 内存态；idle 删除由 daemon 单测/04 静态覆盖。
- 不写入真实凭据；勿在日志中打印 token。
