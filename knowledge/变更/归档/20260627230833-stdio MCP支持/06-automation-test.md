# stdio MCP 支持 - 验收记录

> **变更 ID**：`20260627230833-stdio MCP支持`
> **阶段**：`/kb-test`（lite；以 Settings/SDK 手工验证 + build 冒烟为主）
> **设计来源**：`01-proposal.md`（无 `02-design` / `03-tasks`；追溯 manifest `LITE-01` / `LITE-02`）

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **build 冒烟**（`npm run build`）+ **Settings 手工**（Path B 工具列表探测）+ **SDK 通道联调**（Path A inline stdio MCP）；**不新增**单元测试 / `auto_test/` 脚本 |
| **目标** | 覆盖 `01-proposal` 验收 1–4、`LITE-01` / `LITE-02` |
| **通过口径** | TypeScript 编译 exit 0；Settings 能列出 stdio MCP 工具且无 close 误报；SDK 会话可实际调用 stdio MCP（或记录 SDK 剩余限制）；HTTP MCP 行为无退化 |
| **与 review 分工** | 若有 `04-review` 则偏静态实现；本文负责验收追溯与手工证据占位 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| **Settings stdio 探测** | 依赖 Electron UI、本机 `~/.cursor/mcp.json` / 项目 `.cursor/mcp.json` 与 stdio 子进程 spawn；无稳定 headless 契约 |
| **SDK inline MCP 调用** | 需真实 SDK Agent 会话与通道（飞书/微信等）；工具调用时序与模型选择不可脚本化 |
| **HTTP MCP 回归** | 须对照既有 HTTP 型 MCP 配置手工 spot-check；本变更无专属契约脚本 |
| **`auto_test/`** | lite 变更未新增；验收以 §4 手工清单为主 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01·1 / LITE-01** | Settings → MCP → codegraph（或项目 stdio MCP）工具列表正常；无 close 误报 / cwd 缺失 | Settings 手工 + 可选 `agent mcp list-tools` | UI / CLI 摘要 | ⏳ 待用户验收 |
| **01·2 / LITE-02** | SDK 会话可调用 stdio MCP（如 codegraph） | 飞书/通道触发 SDK 会话，观察 tool 调用 | 联调 / UI 日志 | ⏳ 待用户验收 |
| **01·3** | HTTP MCP 配置与调用无退化 | 既有 HTTP MCP spot-check | 手工 | ⏳ 待用户验收 |
| **01·4** | TypeScript 编译通过 | `npm run build` | 构建摘要 | ✅ builder 已验证 |
| **LITE-01** | `mcp-manager` CLI 优先、cwd、close 修复 | Settings 探测 + 代码路径 | 手工 / 代码 | ⏳ 待用户验收 |
| **LITE-02** | `mcp-sdk-loader` + `agent-sdk` inline / resident send 重传 | SDK 联调 | 联调 | ⏳ 待用户验收 |

## 4、场景摘要

### 4.1 手工验收清单（优先）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **S1 Settings 工具列表** | 应用已启动；`~/.cursor/mcp.json` 或项目 `.cursor/mcp.json` 已配置 **stdio** 型 MCP（如 `plugin-kb-workflow-codegraph` / codegraph） | **设置 → MCP** → 选择该 server → 查看工具列表 | 列表正常加载；**无**「进程 close」类误报；相对路径 / npx 依赖 cwd 时不失败 | 01·1、LITE-01 |
| **S2 CLI 对照（可选）** | 同上；终端可执行 `agent` | 在项目根执行 `agent mcp list-tools <serverName>` | 与 Settings 列表一致或均为成功 | LITE-01 |
| **S3 SDK stdio 调用** | 通道已连；会话走 **SDK** 资源（非纯 CLI）；工作区含 stdio MCP 配置 | 经飞书/微信等发消息，要求 Agent 使用 codegraph（例：「用 codegraph 搜索 symbol X」或「列出 codegraph 可用工具」） | 回复或 UI/开发者日志可见 **CallMcpTool** / MCP 工具调用；无「MCP 未连接」类错误 | 01·2、LITE-02 |
| **S4 resident 重传（可选）** | 同会话连续多轮 SDK 对话 | 第二轮再次触发需 MCP 的任务 | 仍可调 stdio MCP（验证 `agent.send` 重传 inline 配置） | LITE-02 |
| **S5 HTTP MCP 回归** | 若环境配置了 **url/HTTP** 型 MCP | Settings 列出工具；SDK 或 CLI 会话各调用 1 次 | 与变更前一致；**不**因 stdio inline 去重而失效 | 01·3 |
| **S6 编译冒烟** | 项目根依赖已安装 | `npm run build` | exit 0 | 01·4 |

**SDK 验证说明**：Path A 仅 **inline command/stdio** 型；HTTP 仍走 `settingSources`。若 SDK 对某些 server 仍有未覆盖限制，在 `05-summary.md` 记录剩余限制与规避（如改用 CLI 路径或调整 `mcp.json`）。

**凭据**：不写密钥；MCP / SDK / 通道凭据以本地「已配置」为准。

### 4.2 轻量命令（非阻断）

| 检查 | 命令/操作指针 | 期望 |
|------|---------------|------|
| 构建 | 项目根 `npm run build` | exit 0 |
| CLI 工具列表 | 项目根 `agent mcp list-tools <stdioServerName>` | 返回工具名列表或明确错误（与 Settings 对照） |
| MCP 配置 | 检查 `~/.cursor/mcp.json`、`<workspace>/.cursor/mcp.json` | 含目标 stdio server 的 `command` / `args` |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **脚本目录** | 本期无 `auto_test/` 新增 |
| **运行依赖** | Electron 应用；Cursor CLI（`agent`）；已配置 stdio MCP；SDK 模式 Agent 资源 |
| **环境变量** | 仅名称：stdio MCP 条目内 `env`（如 `CODEGRAPH_*`）；通道 `LARK_*` / `WECHAT_*`；SDK `apiKey` 在应用内配置 |
| **推荐 server** | `plugin-kb-workflow-codegraph`（codegraph）或项目内其它 **command/stdio** 型 MCP |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token 的 JSON。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- 失败时区分：**本地配置 / cwd** vs **SDK 或 MCP 服务**（记备注列）。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-27 | 本地 dev | `npm run build` | 通过 | builder 已验证 |
| 2026-06-27 | — | S1 Settings 工具列表 | 待执行 | 用户验收 |
| 2026-06-27 | — | S3 SDK stdio 调用 | 待执行 | 用户验收 |
| 2026-06-27 | — | S5 HTTP MCP 回归 | 待执行 | 可选 spot-check |
