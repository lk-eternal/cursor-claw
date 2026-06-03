# Cursor Claw

远程协作应用 —— 将 Cursor 变成 7×24 小时在线的数字雇员，通过飞书 / 微信随时随地与 AI 协作。

## 为什么需要它？

Cursor Agent 的交互被锁死在本地 IDE 中，一旦离开电脑，所有 AI 协作都会停滞。

**Cursor Claw** 打破了这种限制：

- AI 的提问会通过飞书机器人或微信发到你手机上，你回复后 AI 自动继续工作
- 即使 Cursor 会话断开，守护进程也能自动重连拉起新会话
- 支持私聊 + 群聊多会话并行，每个会话独立工作区
- 支持定时任务和临时独立 Agent，让 AI 按计划自动执行
- 支持**多节点工作流**：需求分析 → 编码 → 审查 → 交付等流水线，节点可驳回重做
- 通过飞书 / 微信指令系统远程管理 Agent、MCP、Rules、Skills、定时任务、工作流
- 飞书和微信双通道可同时运行，消息自动路由到对应平台

## 功能特性

| 功能 | 说明                                                     |
|------|--------------------------------------------------------|
| 可视化配置 | 5 步初始化向导 + 完整设置页面，零手写配置                                |
| 多会话管理 | 私聊 / 群聊 / 定时任务 / 临时 Agent 并行运行，Dashboard 实时展示活跃会话      |
| 双通道消息桥接 | 飞书 + 微信双平台支持，发文本、发图片、发文件，支持消息回复和群聊 @消息路由               |
| 自动重连 | Agent 断开后自动拉起新会话，支持 `--resume` 延续上下文                   |
| 指令系统 | 发送 `/stop` `/status` `/model` `/task` 等 12+ 指令远程控制     |
| 定时任务 | Cron 表达式调度，支持独立 Agent 模式，可视化编辑 + 运行预览                  |
| 工作流 | 多节点流水线编排（YAML 定义），设置页可视化管理，飞书 `/workflow` 指令，支持驳回与重试 |
| MCP 管理 | 可视化管理 MCP 服务器（JSON 编辑 / 启停 / OAuth 认证 / 工具列表）          |
| Rule & Skill | 管理 Cursor Rules 和 Agent Skills，支持文件树浏览和编辑              |
| 自管理能力 | Agent 可通过 MCP 工具管理自身（MCP/Rules/Skills/Tasks/Workspace） |
| 数字身份 | 为群聊和非主用户会话注入自定义角色定义                                    |
| 工作区注入 | 自动写入 `.cursor/mcp.json`、Loop 协议规则和自管理 Skill            |
| 应用隔离 | 支持多开，通过启动参数 `--profile=xxx` 隔离多个应用数据                   |
| 应用内更新 | 支持检查更新 / 一键更新，Homebrew 用户可通过 brew 升级                   |
| 系统托盘 | 关闭窗口可最小化到托盘，后台持续运行                                     |

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  Electron 应用                                          │
│  · 配置向导 / Dashboard / 设置（React + Tailwind）          │
│  · 管理 Daemon 生命周期、Cron 调度、多会话管理               │
│  · 自动注入 .cursor/mcp.json、Rules 和 Skills               │
└──────────────┬──────────────────────────────┬──────────────┘
               │ spawn                        │ 写入工作区
               ▼                              ▼
┌──────────────────────────┐    ┌─────────────────────────────┐
│  Daemon 守护进程          │    │  .cursor/                    │
│  · 飞书 WebSocket 长连接  │    │  ├── mcp.json                │
│  · 微信 iLink 长轮询      │    │  ├── rules/                  │
│  · 本机 HTTP API          │    │  │   └── cursor-claw.mdc     │
│  · 文件消息队列           │    │  └── skills/                 │
│  · 指令路由（飞书/微信）  │    │      └── cursor-claw-admin │
│  · 会话保活（自动重连）   │    └──────────────┬──────────────┘
└──────────────┬───────────┘                   │ stdio
               │ HTTP 127.0.0.1                ▼
               │                  ┌─────────────────────────────┐
               └─────────────────►│  MCP Server                  │
                                  │  · sync_message（收发消息）   │
                                  │  · send_image / send_file    │
                                  │  · manage_agent / mcp / ...  │
                                  │  Cursor 子进程，stdio 通信    │
                                  └─────────────────────────────┘
```

**多会话模型：**

```
Daemon ──┬── 主用户私聊 Agent（使用配置的工作目录）
         ├── 群聊 Agent A（自动创建隔离工作目录）
         ├── 群聊 Agent B（自动创建隔离工作目录）
         ├── 定时任务 Agent（独立会话）
         ├── 工作流 Agent（按节点顺序执行，可 isolated 独立会话）
         └── 临时 Agent（/run 指令触发）
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

#### macOS 通过 Homebrew 安装
##### 初次安装

```bash
# 1. 添加 tap
brew tap lk-eternal/tap

# 2. 安装
brew install --cask cursor-claw
```

安装完成后在「应用程序」中打开 **Cursor Claw** 即可。

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
```

如果 `untap` 报错 `Refusing to untap because it contains installed casks`，加上 `--force`：

```bash
brew untap --force lk-eternal/tap
brew tap lk-eternal/tap
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

由于应用未经过 Apple 公证，首次打开时可能会被 Gatekeeper 拦截：

```bash
# 移除隔离属性
xattr -cr /Applications/Cursor\ Claw.app
```

或者在「系统设置 → 隐私与安全性」中点击「仍要打开」。


## 快速开始

1. 下载安装并启动应用
2. 按照 5 步向导完成配置：
   - **飞书凭据**：填入 App ID / App Secret
   - **配置权限**：按引导在飞书后台开通权限和事件订阅
   - **绑定用户**：选择工作目录，在飞书私聊机器人完成绑定
   - **Cursor CLI**：检测 / 安装 CLI，选择模型
   - **检查启动**：一键保存、注入工作区并启动 Daemon
3. （可选）在设置页面中配置微信接入，扫码登录即可双通道运行
4. 在 Dashboard 查看运行状态，通过飞书或微信开始协作
5. （可选）在设置页「工作流」Tab 编辑示例流水线，或通过 `/workflow run` 启动

## MCP 工具

### 基础通信工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `sync_message` | `message?`, `timeout_seconds?`, `message_id?`, `session_key?` | 发送消息 / 等待回复，自动路由到飞书或微信 |
| `send_image` | `image_path`, `message_id?`, `session_key?` | 发送本地图片到飞书 / 微信 |
| `send_file` | `file_path`, `message_id?`, `session_key?` | 发送本地文件到飞书 / 微信 |

### 自管理工具

提供一组管理工具，Agent 可通过这些工具管理自身运行环境：

| 工具 | 说明 |
|------|------|
| `manage_agent` | 查询状态、停止 Agent、重启应用、重置会话、清空队列 |
| `manage_mcp` | 管理 MCP 服务器配置（列出 / 添加 / 删除） |
| `manage_rules` | 管理 Cursor Rules 文件（列出 / 读取 / 保存 / 删除） |
| `manage_skills` | 管理 Agent Skills（列出 / 读取 / 保存 / 删除） |
| `manage_tasks` | 管理定时任务（列出 / 添加 / 更新 / 删除 / 切换启用） |
| `manage_workspace` | 查看或切换工作目录（切换后热更新生效） |
| `manage_workflows` | 工作流管理（列出 / 查看 / 创建 / 更新 / 删除 / 运行 / 状态查询） |

### 工作流执行工具

在工作流节点执行过程中，Agent 使用以下工具控制流程流转：

| 工具 | 说明 |
|------|------|
| `workflow_next` | 完成当前工作流节点，提交产物并流转到下一个节点 |
| `workflow_reject` | 驳回当前工作流节点产物，回退到指定节点重新执行 |

## 工作流引擎

工作流引擎将复杂任务编排为**多节点流水线**：每个节点由 Agent 执行，产物写入上下文并传给下一节点；审查类节点可 `workflow_reject` 驳回到前序节点重做。

### 核心概念

| 概念 | 说明 |
|------|------|
| **WorkflowDefinition** | 工作流定义（名称、描述、`config`、有序 `nodes`） |
| **WorkflowNode** | 单节点：Prompt、可选模型、`maxRetries`、可选 `isolated` |
| **WorkflowInstance** | 运行实例：当前节点、状态、各节点产物、执行历史 |

定义文件位于用户数据目录 `workflows/definitions/{id}.yaml`（首次启动会从 `resources/template/workflow/example/` 种子示例）。

### 使用方式

1. **设置页**：打开「工作流」Tab，查看/编辑定义，点击 ▶ 启动并填写初始输入
2. **飞书指令**：`/workflow ls`、`/workflow run <序号|ID> [输入]`、`/workflow status` 等
3. **Agent MCP**：`manage_workflows` 创建/更新/运行；节点内用 `workflow_next` / `workflow_reject` 流转

### 工作流定义示例（YAML）

```yaml
name: 代码审查流水线
description: 需求分析 → 编码实现 → 代码审查 → 产出报告
config:
  gitlab_token: glpat-xxxxxxxxxxxx
nodes:
  - id: analyze
    name: 需求分析
    prompt: 分析需求并输出技术方案
    maxRetries: 2
  - id: implement
    name: 编码实现
    prompt: 根据技术方案编码
    maxRetries: 3
  - id: review
    name: 代码审查
    prompt: 审查代码质量，不达标则 workflow_reject 驳回
    isolated: true
    maxRetries: 1
  - id: report
    name: 产出报告
    prompt: 汇总产物生成交付报告
    maxRetries: 1
```

### 执行流程

1. 创建或编辑工作流定义（设置页 / `manage_workflows` / 直接编辑 YAML）
2. 启动实例（设置页 ▶、`/workflow run` 或 `manage_workflows` run）
3. 引擎拉起首节点 Agent；完成后 Agent 调用 `workflow_next` 提交产物
4. 不合格时调用 `workflow_reject` 回退到指定节点
5. 全部节点完成后实例状态为 `completed`

### 关键特性

| 特性 | 说明 |
|------|------|
| 上下文传递 | 每个节点的产物自动注入到下一个节点的输入中 |
| 全局配置 | `config` 字段支持注入工作流级别的配置（如 API Token），所有节点可用 |
| 驳回重做 | 审查节点可驳回到任意前序节点，支持迭代式质量把关 |
| 失败重试 | 每个节点可配置 `maxRetries`，失败后自动重试 |
| 独立 Agent | `isolated: true` 的节点使用全新 Agent 执行，避免上下文污染 |
| 模型覆盖 | 每个节点可独立指定模型，关键节点可使用更强模型 |

> 详细设计文档见 [docs/workflow-design.md](docs/workflow-design.md)

### 内置示例

系统首次启动时会自动创建内置工作流示例，帮助快速上手：

| 示例 | 说明 |
|------|------|
| 飞书需求开发 | 从飞书需求文档出发：编写技术方案 → 实施编码 → 代码检查 → 创建 GitLab MR |

使用方法：
1. 在工作流管理页面找到「飞书需求开发（示例）」
2. 编辑 `config.gitlab_token` 填入你的 GitLab 访问令牌
3. 运行工作流，输入飞书需求文档链接即可

## 指令系统

在飞书或微信对话中直接发送指令（不区分大小写），由 Daemon 处理无需 Agent 运行：

| 指令 | 说明 |
|------|------|
| `/stop` | 停止运行中的 Agent |
| `/status` | 查看 Agent / Daemon 状态 |
| `/list` | 查看消息队列中的待处理消息 |
| `/task` | 定时任务管理（`/task ls` 列表、`/task trigger <id>` 手动触发） |
| `/workflow` / `/wf` | 工作流管理（`ls` / `info` / `run` / `status` / `delete`） |
| `/run` | 启动一个独立临时 Agent 执行指定任务 |
| `/model` | Cursor CLI 模型（`/model ls` / `info` / `set <序号>`） |
| `/mcp` | MCP 服务器管理（`/mcp ls` / `info` / `enable` / `disable` / `add` / `delete`） |
| `/workspace` | 查看 / 切换工作目录 |
| `/clean` | 清空消息队列 |
| `/reset` | 重置会话（下次拉起不使用 --continue） |
| `/restart` | 停止 Agent → 清空队列 → 重启 Daemon |
| `/help` | 列出所有可用指令 |

## 多会话与自动重连

### 多会话模型

- **主用户私聊**：使用配置的工作目录，支持 `--resume` 延续会话上下文
- **群聊**：开启后响应 @消息，每个群自动创建隔离工作目录
- **定时任务**：按 Cron 表达式触发，支持独立 Agent 模式
- **临时 Agent**：通过 `/run` 指令启动，执行完毕自动退出

### 自动重连

Daemon 进程独立于 Cursor 运行，即使 Agent 会话中断，系统也能自动恢复：

1. **Daemon** 通过飞书 WebSocket 长连接 / 微信 iLink 长轮询持续监听消息
2. 当收到新消息且 Agent 已断开时，自动通过 Cursor CLI 拉起新会话
3. 支持 `--resume` 模式延续上一次会话上下文

## 设置页面

应用提供完整的可视化设置，包含以下模块：

| Tab | 功能 |
|-----|------|
| 通用 | 飞书凭据、微信接入、主用户绑定、工作目录、数字身份、群聊开关、关闭行为、应用更新 |
| 网络 | HTTP/HTTPS 代理、NO_PROXY 配置 |
| Agent | 模型选择（主模型 / 其他用户模型 / 定时任务模型）、驱动模式（CLI / SDK）、会话模式 |
| MCP | MCP 服务器可视化管理（启停 / 编辑 / 认证 / 工具列表） |
| Rules | Cursor Rules 文件管理 |
| Skills | Agent Skills 文件树管理 |
| 定时任务 | Cron 任务编辑、运行预览、手动触发、状态监控 |
| 工作流 | 工作流定义编辑（YAML）、实例状态、▶ 启动运行 |
| 帮助引导 | 飞书权限/事件订阅配置参考、重新进入引导 |

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
| `im:resource` | 上传/下载图片与文件 |
| `im:chat:read` | 获取群聊名称 |
| `contact:contact.base:readonly` | 获取用户名（私聊会话显示） |

<details>
<summary>批量导入权限 JSON</summary>

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:resource",
      "im:chat:read",
      "contact:contact.base:readonly"
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

6. 在「版本管理与发布」中发布应用

### 微信

1. 在设置页面「通用」Tab 中找到微信接入区域
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
- **工具调用过多**：单次会话中工具调用次数过多可能触发 Cursor 安全机制
- **网络波动**：本地网络不稳定可能导致 MCP stdio 通信中断
- **Cursor 更新/重启**：IDE 自动更新会中断当前会话

> 应用可在 Agent 断开后自动拉起新会话。

</details>

<details>
<summary>为什么飞书收不到消息？</summary>

请按顺序排查：
1. 确认添加了 `im.message.receive_v1` 事件订阅，且选择「长连接」模式
2. 确认已开通「读取用户发给机器人的单聊消息」和「获取群组中用户@机器人消息」
3. 确认应用已发布（未发布的应用无法接收消息）
4. 确认所有 6 个权限已添加并发布
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
- **Cursor CLI 依赖**：自动拉起 Agent 功能依赖 Cursor CLI，可在向导中一键安装

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
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=lk-eternal/cursor-claw&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=lk-eternal/cursor-claw&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=lk-eternal/cursor-claw&type=date&legend=top-left" />
 </picture>
</a>
