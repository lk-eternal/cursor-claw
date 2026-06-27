# Daemon 守护进程

本机消息桥接守护进程：飞书 WebSocket、微信 iLink、文件队列、HTTP/MCP API。

## 文件清单

| 文件 | 职责 |
|---|---|
| [01-概览.md](./01-概览.md) | 进程定位、架构、主流程 |
| [02-HTTP与MCP服务.md](./02-HTTP与MCP服务.md) | REST API、MCP 工具、管理接口 |
| [03-进程模型与部署.md](./03-进程模型与部署.md) | spawn、端口、日志、与 Electron 通信 |

## 职责边界

- **负责**：多通道消息收发、会话路由、文件队列、IM 编排 dispatch、Presentation 路由、StreamableHTTP MCP。
- **不负责**：桌面 UI、electron-store 配置编辑（由 Electron 主进程负责）。

## 源码入口

- `src/daemon-entry.ts` → `src/daemon.ts`（`daemonMain`）
- 打包产物由 `scripts/bundle-daemon.cjs` 生成，Electron 以 `ELECTRON_RUN_AS_NODE` spawn

## 推荐阅读路径

1. 01-概览 → 2. 03-进程模型与部署 → 3. 02-HTTP 与 MCP 服务

## 变更记录

- 2026-06-27：IM 唯一编排、poll 移除（archive 20260627162620）
- 2026-06-27：kb-sync 初始建立
