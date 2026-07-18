# Cursor Claw

远程协作应用 —— 将 Cursor 变成 7×24 小时在线的数字雇员，通过飞书 / 微信随时随地与 AI 协作。

## 为什么需要它？

Cursor Agent 的交互被锁死在本地 IDE 中，一旦离开电脑，所有 AI 协作都会停滞。

**Cursor Claw** 打破了这种限制：

- AI 的提问会通过飞书机器人或微信发到你手机上，你回复后 AI 自动继续工作
- 基于 Cursor Agent SDK 驱动，飞书侧实时展示**流式进度卡**（思考过程 / 工具调用时间线）
- 即使会话断开，守护进程也能自动重连拉起新会话，`Resume` 延续上下文
- 支持私聊 + 群聊 + 项目多会话并行，每个会话独立工作区
- 支持**项目工作区**：一个需求一个 git worktree，规划 → 实现 → 审查 → 提测等节点化推进，可绑定项目独立群协作
- 支持定时任务和临时独立 Agent，让 AI 按计划自动执行
- 通过飞书 / 微信指令系统远程管理会话、项目、MCP、模型、定时任务
- 多通道并行：可同时接入多个飞书机器人 + 微信账号，每个通道独立配置模型与工作目录

## 功能特性

| 功能 | 说明                                                     |
|------|--------------------------------------------------------|
| 可视化配置 | 5 步初始化向导 + 完整设置页面，零手写配置                                |
| SDK 驱动 | 基于 `@cursor/sdk` 在应用内直跑 Agent（API Key 接入），本机 Cursor CLI 可作为备选资源 |
| 流式进度卡 | 飞书 CardKit 流式卡片实时展示思考过程与工具调用时间线，回复自动并入卡片，可按通道关闭思考展示 |
| 多会话管理 | 私聊 / 群聊 / 项目 / 定时任务 / 临时会话并行运行，Dashboard 实时展示活跃会话与日志 |
| 多通道消息桥接 | 多个飞书机器人 + 微信账号同时运行，发文本 / 图片 / 文件，消息按 `session_key` 自动路由 |
| 项目工作区 | `/p` 建项，一个需求一个 git worktree（支持多仓），节点化推进（规划/实现/审查/提测…），可绑定项目独立群 |
| 自动重连 | Agent 断开后自动拉起新会话，`Resume` 延续上下文；处理中消息掉线不丢（至少一次投递） |
| 指令系统 | 发送 `/status` `/chat` `/project` `/model` 等 14 组指令远程控制，均有单字母缩写 |
| 定时任务 | Cron 表达式调度，支持独立 Agent 模式，可视化编辑 + 运行预览                  |
| MCP 管理 | 可视化管理 MCP 服务器（JSON 编辑 / 启停 / OAuth 认证 / 工具列表）          |
| Rule & Skill | 管理 Cursor Rules 和 Agent Skills，支持文件树浏览和编辑              |
| 自管理能力 | Agent 可通过 MCP 工具管理自身（MCP/Rules/Skills/Tasks/Workspace） |
| AI 间协作 | 群内机器人可互相 @ 派活（需开通机器人互收消息权限），消息带协作机器人名册         |
| 数字身份 | 为群聊和非主用户会话注入自定义角色定义                                    |
| 工作区注入 | 自动写入 `.cursor/mcp.json`、Loop 协议规则和自管理 Skill            |
| 工具箱 | 一键安装 / 更新 `lark-cli`（飞书全家桶 CLI）与 `meegle`（飞书项目 CLI）    |
| 应用隔离 | 支持多开，通过启动参数 `--profile=xxx` 隔离多个应用数据                   |
| 应用内更新 | 支持检查更新 / 一键更新，Homebrew 用户可通过 brew 升级                   |
| 系统托盘 | 关闭窗口可最小化到托盘，后台持续运行                                     |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 应用                                               │
│  · 配置向导 / Dashboard / 设置（React + Tailwind）           │
│  · Agent SDK 会话池（@cursor/sdk 直跑，流式事件 → 进度卡）   │
│  · 管理 Daemon 生命周期、Cron 调度、项目工作区               │
│  · 自动注入 .cursor/mcp.json、Rules 和 Skills                │
└──────────────┬──────────────────────────────┬───────────────┘
               │ spawn                        │ 写入工作区
               ▼                              ▼
┌──────────────────────────┐    ┌─────────────────────────────┐
│  Daemon 守护进程          │    │  .cursor/                    │
│  · 飞书 WebSocket 长连接  │    │  ├── mcp.json                │
│    （可多个飞书通道）     │    │  ├── rules/                  │
│  · 微信 iLink 长轮询      │    │  │   └── cursor-claw.mdc     │
│  · 本机 HTTP API + MCP    │    │  └── skills/                 │
│  · 文件消息队列           │    │      └── cursor-claw-admin │
│    （至少一次投递）       │    └─────────────────────────────┘
│  · 指令路由 / 卡片回调    │
│  · CardKit 流式进度卡     │         Agent 通过 HTTP / MCP
│  · 会话保活（自动重连）   │◄──── 连接 127.0.0.1:19528：
└──────────────────────────┘         · send_text / send_question
                                     · poll-message（拉取消息）
                                     · project_* / manage_* 工具
```

**多会话模型：**

```
Daemon ──┬── 主用户私聊 Agent（使用配置的工作目录）
         ├── 群聊 Agent A / B（自动创建隔离工作目录）
         ├── 项目 Agent（独立 git worktree，可绑定项目专属群）
         ├── 定时任务 Agent（可独立会话）
         └── 临时会话 Agent（/chat new 或 MCP launch 触发）
```

## 安装

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 格式 | 备注 |
|------|------|------|
| Windows | `.exe` | 直接运行安装 |
| macOS (Intel) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Apple Silicon) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Homebrew) | `brew install --cask` | 推荐，便于升级管理 |
| Linux | `.deb` / `.AppImage` | 直接运行 |

#### macOS 首次启动：信任应用（必读）

应用未经过 Apple 公证，无论通过 `.dmg` 还是 Homebrew 安装，**首次打开都会被 Gatekeeper 拦截**（提示"无法打开，因为无法验证开发者"或"已损坏"）。建议安装完成后、首次启动前先解除：

```bash
# 方式一：命令行移除隔离属性（推荐先尝试）
xattr -cr /Applications/Cursor\ Claw.app
```

如果命令执行失败（如提示 `Operation not permitted` / `No such xattr`），或执行后打开仍被拦截，请改走系统设置手动信任：

1. 双击打开一次 **Cursor Claw**，触发拦截弹窗后点「完成」关闭（不要点「移到废纸篓」）
2. 打开「系统设置 → 隐私与安全性」，滚动到「安全性」区域
3. 找到"已阻止 Cursor Claw"的提示，点击「仍要打开」，在弹窗中再次确认

完成后即可在「应用程序」中正常启动。

#### macOS 通过 Homebrew 安装
##### 初次安装

```bash
# 1. 添加 tap
brew tap lk-eternal/tap

# 2. 信任 tap
brew trust --cask lk-eternal/tap/cursor-claw

# 2. 安装
brew install --cask cursor-claw
```

安装完成后按上方[「首次启动：信任应用」](#macos-首次启动信任应用必读)操作解除拦截，再在「应用程序」中打开 **Cursor Claw** 即可。

##### 更新到最新版本

```bash
# 常规升级（推荐）
brew update && brew upgrade --cask cursor-claw
```

如果提示 `the latest version is already installed` 但实际版本较旧，请参考下方 FAQ。

##### 卸载

```bash
brew uninstall --cask cursor-claw
brew untap lk-eternal/tap   # 可选，移除 tap 源
```

##### FAQ

###### Q: `brew upgrade` 提示已是最新，但实际还是旧版本？

这是 Homebrew Cask 的常见问题，通常是本地 tap 缓存没有刷新。按以下步骤操作：

```bash
# 方法 1：强制刷新 tap 后重装
brew untap lk-eternal/tap
brew tap lk-eternal/tap
brew trust --cask lk-eternal/tap/cursor-claw
brew upgrade --cask cursor-claw

# 方法 2：直接强制重装
brew reinstall --cask cursor-claw
```

###### Q: `brew update` 时出现 `Warning: No remote 'origin'` 导致 tap 无法更新？

这是 Homebrew 本地 git 仓库的问题，需要手动修复：

```bash
# 删除损坏的 tap 并重新添加
brew untap lk-eternal/tap
brew tap lk-eternal/tap
brew trust --cask lk-eternal/tap/cursor-claw
```

如果 `untap` 报错 `Refusing to untap because it contains installed casks`，加上 `--force`：

```bash
brew untap --force lk-eternal/tap
brew tap lk-eternal/tap
brew trust --cask lk-eternal/tap/cursor-claw
brew upgrade --cask cursor-claw
```

###### Q: 如何确认当前安装的版本？

```bash
brew info --cask cursor-claw
```

输出中 `cursor-claw: x.x.x` 即为 tap 中的最新版本，`Installed` 下方的路径显示本地已安装的版本。

###### Q: Apple Silicon (M1/M2/M3/M4) 和 Intel Mac 都支持吗？

是的，Cask 会自动根据芯片架构下载对应的 dmg：
- **Apple Silicon** → `*-arm64.dmg`
- **Intel** → `*.dmg`

###### Q: macOS 提示"无法打开，因为无法验证开发者"？

参见上方[「首次启动：信任应用」](#macos-首次启动信任应用必读)：先尝试 `xattr -cr /Applications/Cursor\ Claw.app`；命令失败或无效时，到「系统设置 → 隐私与安全性 → 安全性」找到被阻止的提示并点「仍要打开」。


## 快速开始

1. 下载安装并启动应用
2. 按照 5 步向导完成配置：
   - **选工作文件夹**：选择 AI 的默认工作目录
   - **接入 AI**：填入 Cursor API Key（SDK 直跑，无需本机 IDE 常驻）
   - **连上飞书**：填入自建应用 App ID / App Secret，按引导开通权限与事件订阅
   - **绑定你自己**：扫码 / 私聊机器人完成主用户绑定
   - **装点工具**：一键安装 `lark-cli` / `meegle`（可跳过，之后在工具箱补装）
3. （可选）在设置页「消息通道」中添加更多飞书机器人或微信账号
4. 在 Dashboard 查看运行状态，通过飞书或微信开始协作
5. （可选）发送 `/p new` 创建项目工作区，体验节点化研发流程

## MCP 工具

### 基础通信工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `send_text` | `text`, `message_id?`, `session_key?` | 发送文本消息，自动路由到飞书或微信 |
| `send_image` | `image_path`, `message_id?`, `session_key?` | 发送本地图片到飞书 / 微信 |
| `send_file` | `file_path`, `message_id?`, `session_key?` | 发送本地文件到飞书 / 微信 |
| `send_question` | `text`, `options`, `message_id?`, `session_key` | 提问并附选项按钮（飞书卡片 / 微信文本降级） |

### 自管理工具

提供一组管理工具，Agent 可通过这些工具管理自身运行环境：

| 工具 | 说明 |
|------|------|
| `manage_agent` | 查询状态、停止 Agent、重启应用、重置会话、清空队列、启动临时会话 |
| `manage_mcp` | 管理 MCP 服务器配置（列出 / 添加 / 删除） |
| `manage_rules` | 管理 Cursor Rules 文件（列出 / 读取 / 保存 / 删除） |
| `manage_skills` | 管理 Agent Skills（列出 / 读取 / 保存 / 删除） |
| `manage_tasks` | 管理定时任务（列出 / 添加 / 更新 / 删除 / 切换启用） |
| `manage_workspace` | 查看或切换工作目录（切换后热更新生效） |

### 项目工具

在项目会话中，Agent 使用以下工具读写项目元数据：

| 工具 | 说明 |
|------|------|
| `project_get` / `project_list` | 查询项目详情 / 列出所有项目 |
| `project_update` | 更新项目元数据（目标、文档链接、分支信息等） |
| `project_register_artifact` | 登记节点产物（路径 / 摘要 / MR 链接 / 飞书文档），供后续节点注入上下文 |
| `project_delete` | 删除项目（连带移除 worktree，不动主仓与远程分支） |

## 项目工作区

项目工作区把「一个需求」封装为独立协作单元：**一个项目 = 一个 git worktree（可多仓）+ 一条 feature 分支 + 一个专属会话**，通过节点化按钮推进研发流程。

### 核心概念

| 概念 | 说明 |
|------|------|
| **项目（Project）** | 名称、目标、需求/文档链接、主仓 + 基线分支、feature 分支、worktree 路径 |
| **流程组（NodeGroup）** | 节点集合，建项可多选；默认提供「开发」「测试」两组，节点可在设置页自由增删改 |
| **节点（Node）** | 一个推进动作（如 规划 / 实现 / 审查），点按钮或发 `/p <节点>` 即把对应任务派给项目 Agent |
| **工作区类型** | `worktree`＝代码开发（主仓隔离检出、分支借还）；`plain`＝纯会话目录（测试/文档协作，无 git） |

默认节点：

- **开发组**：规划 → 实现 → 审查 → 部署 → 提测 → 分析缺陷 → 修复缺陷 → 上线文档
- **测试组**：测试评审 → 用例编写 → 部署 → 测试 → 提缺陷 → 复测 → 上线文档

### 使用方式

1. **建项**：发送 `/p new` 走飞书表单（或一行命令 `/p new <名> <主仓> <基线> <feature> <目标…>`）
2. **进入**：`/p ls` 列出项目，`/p use <序号>` 进入；后续消息路由到项目专属会话与 worktree
3. **推进**：`/p` 打开项目菜单，点节点按钮（规划 / 实现 / 审查…）派发任务
4. **交付**：Agent 通过 `project_register_artifact` 登记产物，`send_file` / MR 链接交付
5. **回主会话**：`/p leave` 或 `/c main`

### 关键特性

| 特性 | 说明 |
|------|------|
| 隔离检出 | 独立 clone / worktree，与主仓互不干扰，同一分支可两边同时检出 |
| 多仓支持 | 一个项目可挂多个仓库，各自独立 worktree 与分支配置 |
| 独立群协作 | 建项可自动创建项目专属飞书群（需 `im:chat:create` 权限），群内消息强制路由到本项目，与私聊互相隔离 |
| 产物流转 | 节点产物（文档 / MR / 文件）登记后自动注入后续节点的上下文 |
| 分支红线 | 基线分支只作切 feature 起点，禁止直接作为推送 / MR 目标 |
| GitLab / 飞书项目集成 | 配合 `lark-cli` / `meegle` / GitLab Token，可打通需求文档 → MR → 工作项流转 |

## 指令系统

在飞书或微信对话中直接发送指令（不区分大小写），由 Daemon 处理无需 Agent 运行；每个指令都有单字母缩写：

| 指令 | 缩写 | 说明 |
|------|------|------|
| `/status` | `/s` | 查看 Agent / Daemon 状态（飞书返回可刷新的状态卡片） |
| `/chat` | `/c` | 会话管理（`ls` 列表 / `<序号>` 切换 / `stop <序号>` / `new <描述>` 开临时会话 / `main` 回主会话） |
| `/project` | `/p` | 项目工作区（`new` / `ls` / `use` / `leave` / `status` / `setup` / `sync` / `ship` 及各节点推进） |
| `/task` | `/t` | 定时任务管理（`/task ls` 列表、`/task trigger <id>` 手动触发） |
| `/model` | `/m` | 模型管理（`ls` / `info` / `set <序号>`） |
| `/mcp` | `/mc` | MCP 服务器管理（`ls` / `info` / `enable` / `disable` / `add` / `delete`） |
| `/workspace` | `/w` | 查看 / 切换工作目录 |
| `/list` | `/ls` | 查看消息队列中的待处理消息 |
| `/stop` | `/x` | 停止运行中的 Agent |
| `/clean` | `/cl` | 清空消息队列 |
| `/reset` | `/r` | 重置会话（下次拉起不延续上下文） |
| `/restart` | `/rr` | 停止 Agent → 清空队列 → 重启 Daemon |
| `/help` | `/h` | 列出所有可用指令 |

## 多会话与自动重连

### 多会话模型

- **主用户私聊**：使用通道配置的工作目录，`Resume` 延续会话上下文
- **群聊**：开启后响应 @消息，每个群自动创建隔离工作目录；群内机器人可互相 @ 协作
- **项目会话**：独立 git worktree + 专属会话，可绑定项目独立群
- **定时任务**：按 Cron 表达式触发，支持独立 Agent 模式
- **临时会话**：通过 `/chat new <描述>` 或 MCP `manage_agent` launch 启动，执行完自动收尾

### 自动重连与消息可靠性

Daemon 进程独立运行，即使 Agent 会话中断，系统也能自动恢复：

1. **Daemon** 通过飞书 WebSocket 长连接 / 微信 iLink 长轮询持续监听消息
2. 消息先落**文件队列**（至少一次投递）：Agent 挂阻塞 poll 才确认删除，掉线未确认的消息会在新会话重投
3. 收到新消息且 Agent 已断开时，自动通过 Agent SDK / Cursor CLI 拉起新会话，`Resume` 延续上下文
4. 会话保活策略可按通道配置：保留会话（Resume 延续）与长连接保活（无限 poll）均可开关

## 设置页面

应用提供完整的可视化设置，包含以下模块：

| Tab | 功能 |
|-----|------|
| 通用 | 主工作目录、开机自启、关闭窗口行为 |
| 网络 | HTTP/HTTPS 代理、NO_PROXY 配置 |
| Agent | Agent 资源管理（Cursor API Key / 本机 CLI）、默认模型、定时任务模型 |
| 消息通道 | 多通道管理：飞书 / 微信凭据、主用户绑定、模型与工作目录、数字身份、群聊开关、保活策略、思考展示开关 |
| 项目 | 项目列表（切换 / 修改 / 删除）、工作区与仓库配置、流程组与节点编辑、GitLab Token |
| MCP | MCP 服务器可视化管理（启停 / 编辑 / 认证 / 工具列表） |
| Rules | Cursor Rules 文件管理 |
| Skills | Agent Skills 文件树管理 |
| 定时任务 | Cron 任务编辑、运行预览、手动触发、状态监控 |
| 工具箱 | `lark-cli` / `meegle` 一键安装与更新、Node.js 环境检测 |
| 帮助引导 | 飞书权限/事件订阅配置参考、重新进入引导 |
| 关于 | 版本信息、检查更新 / 一键更新 |

## 平台接入配置

### 飞书

1. 前往 [飞书开放平台](https://open.feishu.cn/app/) 创建自建应用
2. 获取 App ID 和 App Secret
3. 添加「机器人」能力
4. 在「权限管理」中开通以下权限：

| 权限标识 | 用途 |
|----------|------|
| `im:message` | 发送消息（create / reply） |
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊 @消息 |
| `im:message.group_at_msg.include_bot:readonly` | 接收其他机器人 @本机器人的群消息（AI 间协作） |
| `im:resource` | 上传/下载图片与文件 |
| `im:chat:read` | 获取群聊名称 |
| `im:chat:create` | 创建项目独立群 |
| `contact:contact.base:readonly` | 获取通讯录基本信息（需同时配置通讯录数据范围） |
| `contact:user.base:readonly` | 获取用户基本信息（姓名/昵称，私聊会话显示） |
| `cardkit:card:write` | 创建与更新 CardKit 流式卡片（Agent 进度卡） |

<details>
<summary>批量导入权限 JSON</summary>

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_at_msg.include_bot:readonly",
      "im:resource",
      "im:chat:read",
      "im:chat:create",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "cardkit:card:write"
    ],
    "user": []
  }
}
```

</details>

5. 在「事件订阅」中：
   - 选择 **「长连接」** 模式（无需配置回调 URL）
   - 添加 `im.message.receive_v1`（接收消息 v2.0）事件
   - 开通「读取用户发给机器人的单聊消息」
   - 开通「获取群组中用户@机器人消息」

   > **注意：** 配置事件订阅前需先启动 Daemon，否则飞书无法验证 WebSocket 连接。
   > 卡片按钮回调（`card.action.trigger`）同样走长连接自动接收，无需额外配置回调地址。

6. 在「版本管理与发布」中发布应用

### 微信

1. 在设置页「消息通道」Tab 中添加微信通道
2. 填入 iLink Token 和 Account ID（从微信 iLink 平台获取）
3. 点击「连接」，扫码登录
4. 登录成功后微信消息即可与 Agent 交互

> 微信通道使用微信ClawBot，通过长轮询方式接收消息。

## 全链路研发自动化

配合以下 MCP 服务，可实现从需求分析到代码交付的全链路自动化：

- **飞书文档 MCP**：读取 PRD、撰写技术方案、同步变更说明
  - 配置入口：[https://open.feishu.cn/page/mcp](https://open.feishu.cn/page/mcp)
- **飞书项目 MCP**：获取待办任务、更新工作项状态、生成进度报告
  - 配置入口：[https://project.feishu.cn/b/mcp](https://project.feishu.cn/b/mcp)

## 常见问题

<details>
<summary>Agent 会话为什么会断开？</summary>

常见原因：
- **上下文窗口超限**：超长会话会被自动截断，建议复杂任务拆分或使用 `.cursor/memory.md` 持久化关键信息
- **工具调用过多**：单次会话中工具调用次数过多可能触发安全机制
- **网络波动**：本地网络不稳定可能导致 SDK / MCP 通信中断

> 应用会在 Agent 断开后自动拉起新会话；未确认的消息不会丢失，会重投给新会话。

</details>

<details>
<summary>为什么飞书收不到消息？</summary>

请按顺序排查：
1. 确认添加了 `im.message.receive_v1` 事件订阅，且选择「长连接」模式
2. 确认已开通「读取用户发给机器人的单聊消息」和「获取群组中用户@机器人消息」
3. 确认应用已发布（未发布的应用无法接收消息）
4. 确认所有权限已添加并发布
5. 确认 Daemon 已启动且飞书 WebSocket 连接成功
6. 确认是在机器人私聊窗口或群聊 @机器人 发送消息

</details>

<details>
<summary>为什么微信收不到消息？</summary>

请按顺序排查：
1. 确认 iLink Token 和 Account ID 已正确填入设置页面
2. 确认已点击「连接」并成功扫码登录
3. 确认设置页面显示微信状态为「已连接」
4. 确认 Daemon 已启动

</details>

<details>
<summary>定时任务需要电脑一直开着吗？</summary>

是的，但可以锁屏或关闭显示器。定时任务由应用调度，需要应用保持运行。关闭窗口后应用会最小化到系统托盘继续运行，但完全退出或关机后定时任务不会触发。

</details>

<details>
<summary>群聊消息如何路由？</summary>

每个群聊会创建独立的 Agent 会话和工作目录。消息通过 `session_key` 路由到对应会话，Agent 回复时需携带 `message_id` 或 `session_key` 以确保消息发送到正确的群（飞书群）或群聊（微信群）。

</details>

## 注意事项

- **凭据安全**：App Secret / iLink Token 是敏感信息，应用会加密存储
- **网络要求**：Daemon 需保持与飞书 / 微信服务器的网络连接，企业网络如有代理限制，可在设置中配置代理
- **AI 接入方式**：推荐使用 Cursor API Key（SDK 直跑）；也可绑定本机 Cursor CLI 作为 Agent 资源

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

## License

MIT

## Star History

<a href="https://www.star-history.com/?repos=lk-eternal%2Fcursor-claw&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=lk-eternal/cursor-claw&type=date&theme=dark&legend=top-left&sealed_token=WIlkJeujXI5zTfjw5krA3Q7_WbJQKuq02Bez7x6u-nxdu5ObaFvIRY77eXpAH_8MHRkB0SAp0iuuP6EWA4FtdmATTM2YL8InZi3vF5ovFW8LUHFBhb7Wurk-5Zyru4XI64YFZ0yUC4_tqmIiY6W454b7hjNGbDMdOND5iQ01bBBII6XDq9XHUNgMGa3G" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=lk-eternal/cursor-claw&type=date&legend=top-left&sealed_token=WIlkJeujXI5zTfjw5krA3Q7_WbJQKuq02Bez7x6u-nxdu5ObaFvIRY77eXpAH_8MHRkB0SAp0iuuP6EWA4FtdmATTM2YL8InZi3vF5ovFW8LUHFBhb7Wurk-5Zyru4XI64YFZ0yUC4_tqmIiY6W454b7hjNGbDMdOND5iQ01bBBII6XDq9XHUNgMGa3G" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=lk-eternal/cursor-claw&type=date&legend=top-left&sealed_token=WIlkJeujXI5zTfjw5krA3Q7_WbJQKuq02Bez7x6u-nxdu5ObaFvIRY77eXpAH_8MHRkB0SAp0iuuP6EWA4FtdmATTM2YL8InZi3vF5ovFW8LUHFBhb7Wurk-5Zyru4XI64YFZ0yUC4_tqmIiY6W454b7hjNGbDMdOND5iQ01bBBII6XDq9XHUNgMGa3G" />
 </picture>
</a>
