# SDK MCP stdio 相对路径支持 - 验收记录

> **来源**：`/kb-test`（基于 `01-proposal.md`、`02-design.md`、`03-tasks.md`、`04-review.md`）

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | 轻量编译（冒烟）+ 手工 E2E（SDK 会话 / Settings 对照）；无新增 `auto_test/` 脚本 |
| **目标** | 验证 `mcp-sdk-loader.ts` 在有效 workspace 下将路径型相对 `command`/`args` resolve 为绝对路径，HTTP 无回归、无 workspace 边界不变 |
| **与验收关系** | 覆盖 `01-proposal` 验收 1–6 与 `03-tasks` T1/T2 全部验收条；静态/review 已覆盖项在本阶段标注，E2E 项标「待用户验收」 |
| **默认行为** | 本轮仅执行 `npm run build`；不启动 Electron、不修改 mcp.json、无破坏性副作用 |

## 2、局限与未自动化原因

| 未覆盖项 | 原因 |
|----------|------|
| SDK Agent 会话内 MCP 工具调用（01 验收 1–3） | 需绑定真实工作区、mcp.json 与 stdio MCP 进程；依赖 `@cursor/sdk` 运行时，不适合无 GUI 脚本 |
| Settings → MCP 工具列表与 SDK 对照 | 需 Electron 应用 + 用户配置；手工验收 |
| HTTP MCP 运行时回归 | 04-review 静态确认分支未改；运行时对照需用户本地 mcp.json |
| 无 workspace 边界运行时 | 04-review 静态确认 `ws` 空时行为；E2E 需解绑工作区后手工触发 |
| 单元/集成测试 | 仓库规范不写单测；resolve 逻辑由 review 静态 + 手工 E2E 覆盖 |
| `--config=./path` flag 内嵌相对路径 | 04-review 已知限制（评分 &lt;75）；依赖 `cwd=workspaceDir` 缓解，非本变更阻断项 |

## 3、验收追溯表

| 来源 | 验收条目 | 验证方式 | 状态 |
|------|----------|----------|------|
| 01 验收 1 | 相对路径脚本 MCP（`./scripts/...`）SDK 会话可调用工具 | 手工 E2E（§4.1 S1） | 待用户验收 |
| 01 验收 2 | `node_modules/.bin/...` SDK 会话可列出/调用 | 手工 E2E（§4.1 S2） | 待用户验收 |
| 01 验收 3 | 同一 mcp.json + 工作区，Settings 与 SDK 一致 | 手工 E2E（§4.1 S3） | 待用户验收 |
| 01 验收 4 | HTTP/sse MCP 无回归 | 静态/review 已覆盖；可选手工（§4.1 S4） | 静态通过 |
| 01 验收 5 | 无工作区：不崩溃、相对路径不承诺可用 | 静态/review 已覆盖；可选手工（§4.1 S5） | 静态通过 |
| 01 验收 6 | 项目可正常构建 | `npm run build`（§4.2） | 通过 |
| T1 | resolve 规则、`args` 混合、`--*` 跳过 | 04-review 静态 | 静态通过 |
| T1 | HTTP 分支、`workspaceDir` 空边界 | 04-review 静态 | 静态通过 |
| T1 | 行数 ≤300 | 文件计数（140 行） | 通过 |
| T2 | AGENTS 文档与代码一致 | 04-review | 通过 |

## 4、场景摘要

### 4.1 手工验收清单

**前置（S1–S4 共用）**：Electron 应用已构建；绑定含 `.cursor/mcp.json` 的目标工作区；至少一条 stdio MCP 使用相对路径 command。

| 场景 | 前置 | 触发 | 期望 | 失败判责 |
|------|------|------|------|----------|
| **S1** 相对路径脚本 | mcp.json `command: "./scripts/…"`（或等价） | 发起 SDK Agent 会话，调用该 MCP 至少一个工具 | 工具可列出且调用成功；与 IDE 同工作区可用性一致 | MCP 配置/脚本本身错误 → 用户环境；resolve 仍相对 → 服务问题 |
| **S2** node_modules/.bin | mcp.json `command: "node_modules/.bin/…"` | 同上 | 无相对路径启动失败；工具可用 | 包未安装 → 用户环境；bare 名被误 resolve → 服务问题 |
| **S3** Settings vs SDK | Settings 已能列出某 stdio MCP 工具 | 同工作区发起 SDK Agent，使用同一 MCP | SDK 侧同样可用 | Settings 可用 SDK 不可用 → 服务问题；二者均不可用 → 配置/MCP 服务 |
| **S4** HTTP 无回归 | 保留至少一条 `url`/HTTP 型 MCP | Settings 列表 + SDK 会话各调用一次 | 与变更前行为一致 | HTTP 分支被改 → 服务问题 |
| **S5** 无 workspace | 解绑或未选工作区 | 尝试相对路径 stdio MCP（可选） | 不崩溃；相对路径不承诺可用（04 静态：输出与变更前一致） | 崩溃 → 服务问题 |

### 4.2 轻量编译

| 命令 | 期望 | 说明 |
|------|------|------|
| `npm run build` | exit 0，TypeScript 编译通过 | 项目根目录；无额外环境变量 |

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **auto_test/** | 无新增（仓库规范不写单测/E2E 脚手架） |
| **手工依赖** | 本地 Electron 构建产物、用户工作区路径、`.cursor/mcp.json`（勿提交密钥/token） |
| **环境变量** | 无专用变量；构建使用项目默认 `npm run build` |

## 6、输出与记录规范

会话与本文档均只记录结论性摘要（通过/失败/待验收）；禁止粘贴完整终端日志或凭据。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-28 | 本地 dev；kb-test 轮 | `npm run build` | 通过 | exit 0 |
| 2026-06-28 | — | S1 相对路径脚本 MCP | 待用户验收 | E2E |
| 2026-06-28 | — | S2 node_modules/.bin | 待用户验收 | E2E |
| 2026-06-28 | — | S3 Settings vs SDK | 待用户验收 | E2E |
| 2026-06-28 | — | S4 HTTP 无回归 | 静态/review 已覆盖 | 可选手工 |
| 2026-06-28 | — | S5 无 workspace 边界 | 静态/review 已覆盖 | 可选手工 |
