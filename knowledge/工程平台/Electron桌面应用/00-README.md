# Electron 桌面应用

Cursor Claw 桌面端：Electron 主进程 + React 渲染层，负责配置、Daemon 生命周期、工作区注入与 UI。

## 文件清单

| 文件 | 职责 |
|---|---|
| [01-概览.md](./01-概览.md) | 端工程总图、术语、依赖 |
| [02-主进程与IPC.md](./02-主进程与IPC.md) | main.ts、preload、Daemon 管理、profile 隔离 |
| [03-渲染端界面.md](./03-渲染端界面.md) | Dashboard、Settings、向导与各 Tab |
| [04-配置与更新.md](./04-配置与更新.md) | config-store、托盘、updater |
| [05-构建与打包.md](./05-构建与打包.md) | macOS 本地出包、deploy CLI、npm 薄封装 |

## 职责边界

- **负责**：本地配置持久化、窗口/托盘、IPC 桥接、spawn Daemon、工作区模板注入、应用更新。
- **不负责**：飞书/微信长连接、消息队列、MCP HTTP 服务（见 [Daemon 守护进程](../Daemon守护进程/00-README.md)）。

## 推荐阅读路径

1. 01-概览 → 2. 02-主进程与 IPC → 3. 03-渲染端界面 → 4. 04-配置与更新
5. 本地 macOS 出包 → [05-构建与打包.md](./05-构建与打包.md)

## 变更记录

- 2026-06-27：新增 05-构建与打包（macOS deploy 入口）
- 2026-06-27：kb-sync 初始建立
