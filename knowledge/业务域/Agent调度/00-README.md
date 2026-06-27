# Agent 调度

> 负责 Cursor Agent 的多会话并行、启动/重连、远程指令与定时任务调度。

## 职责边界

**负责**：会话模型（私聊/群聊/临时/定时/工作流）、CLI/SDK 双驱动启动、`--resume` 上下文、消息队列调度、远程 `/` 指令、Cron 定时触发、工作区规则/MCP/Skills 注入。

**不负责**：消息通道连接（飞书/微信 WebSocket）、MCP 工具实现、工作流 YAML 编排细节（见工作流域）。

## 文件清单

| 编号 | 文件 | 内容 |
|------|------|------|
| 01 | [01-概览.md](./01-概览.md) | 模块总图、架构、术语、依赖 |
| 02 | [02-多会话模型.md](./02-多会话模型.md) | 五类 ChatType、sessionKey、工作目录隔离 |
| 03 | [03-启动与自动重连.md](./03-启动与自动重连.md) | CLI/SDK 启动、resume、崩溃自愈、僵尸检测 |
| 04 | [04-远程指令.md](./04-远程指令.md) | 12+ 远程指令与权限模型 |
| 05 | [05-定时任务.md](./05-定时任务.md) | Cron 调度、独立 Agent、文件热重载 |

## 推荐阅读路径

1. **新人**：01 → 02 → 03
2. **运维/飞书指令**：04 → 05
3. **排查 Agent 未拉起**：03 → 02

## 关键源码

| 模块 | 路径 |
|------|------|
| 会话调度 | `electron/session-dispatcher.ts` |
| CLI 启动 | `electron/agent-launcher.ts`、`electron/agent-cli.ts` |
| SDK 启动 | `electron/agent-sdk.ts` |
| Daemon 编排 | `electron/daemon-manager.ts` |
| 指令处理 | `electron/command-handler.ts` |
| Cron（UI） | `electron/cron-scheduler.ts` |
| Cron（Daemon） | `src/daemon-scheduled-tasks.ts` |
| 配置 | `electron/config-store.ts` |
| 工作区注入 | `electron/workspace-injector.ts` |

## 变更记录

2026-06-27：kb-sync 初始建立。
