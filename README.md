# Cursor Claw

> 微信 × Cursor AI 协作桌面应用

Cursor Claw 是一款桌面应用，通过微信 ClawBot (iLink 协议) 将微信消息与 Cursor AI Agent 连接，让你可以在微信中直接与 Cursor 进行交互。

基于 [feishu-cursor-bridge](https://github.com/lk-eternal/feishu-cursor-bridge) 项目 fork，扩展支持微信 ClawBot 接入。

## 特性

- 🔗 **微信 ClawBot 接入** — 通过 iLink 协议直接对接微信，无需额外二进制依赖
- 🤖 **Cursor Agent 调度** — 自动将微信消息路由到 Cursor AI Agent 处理
- 💬 **飞书消息桥接** — 保留完整的飞书接入能力
- 🖥️ **桌面应用** — Electron 桌面应用，系统托盘常驻
- 🔌 **MCP 协议** — 基于 Model Context Protocol 与 Cursor 通信

## 架构

```
微信用户 ←→ iLink 协议(长轮询) ←→ Daemon(WeChatClient) ←→ FileQueue ←→ Cursor Agent
飞书用户 ←→ Lark SDK ←→ Daemon ←→ FileQueue ←→ Cursor Agent
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 打包
npm run dist:win   # Windows
npm run dist:mac   # macOS
```

## 技术栈

- **Electron** — 桌面应用框架
- **React + Tailwind CSS** — UI
- **wechat-ilink-client** — 微信 iLink 协议客户端
- **MCP SDK** — Cursor Agent 通信协议
- **Lark SDK** — 飞书消息接入

## License

MIT
