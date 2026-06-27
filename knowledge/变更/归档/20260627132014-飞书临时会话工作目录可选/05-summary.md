# 飞书临时会话工作目录可选 - 变更总结

## 1、实际变更

### 初版（T1–T5）

| 文件 | 关键改动 |
|------|----------|
| `electron/session-dispatcher.ts` | 新增 `parseChatNewArgs`、`validateWorkspacePath`；`launchIndependentAgent` 增可选 `workingDirectory` 并透传 `launchAgent`；temp 显式目录跳过 `mkdirSync`；`handleChatCommand` `/chat new` 分支：解析→校验→启动→成功反馈含任务摘要与完整工作目录路径；底部用法补充 `-dir` |
| `src/daemon.ts` | `COMMANDS["/chat"]` 帮助文案补充可选 `-dir`、默认主会话目录、无效目录不创建 |
| `electron/daemon-manager.ts` | `/help` 管理员指令列表中 `/chat` 一行补充 `-dir` 说明 |

### Rev1（T-Rev1-01~03）

| 文件 | 关键改动 |
|------|----------|
| `electron/session-dispatcher.ts` | 新增 `resolveOthersWorkspaceDir`；`launchAgent` 他人/群聊分支按 `othersWorkspaceMode`/`othersWorkspaceDir` 三分支解析 |
| `electron/config-store.ts` | `getChannels` 读时兜底 `othersWorkspaceMode: "isolated"`、`othersWorkspaceDir: ""` |
| `src/shared/channel-types.ts` | `MessageChannel` 增 `othersWorkspaceMode`、`othersWorkspaceDir` |
| `electron/preload.ts`、`src/renderer/env.d.ts` | 类型与 `MessageChannel` 对齐 |
| `src/renderer/components/ChannelPanel.tsx` | 主用户区 `/chat new -dir` 说明；`allowOthers` 下工作目录模式 segmented + 指定路径选择；高级「通道工作目录」helper 补充回退关系 |

### 知识库（archive）

| 文件 | 关键改动 |
|------|----------|
| `knowledge/业务域/Agent调度/02-多会话模型.md` | temp `-dir` 规则；他人/群聊 isolated vs specified 三分支；配置字段 |
| `knowledge/业务域/Agent调度/04-远程指令.md` | `/chat new` 语法、默认目录、校验失败不创建 |
| `knowledge/业务域/Agent调度/01-概览.md` | 关键约束与术语表补充 `othersWorkspaceMode`、temp `-dir` |

### 版本与 changelog

| 文件 | 关键改动 |
|------|----------|
| `package.json` | `1.4.2` → `1.4.3`（Rev1 用户可见 patch） |
| `changelog/1.4.3.json` | Rev1：配置页 `-dir` 说明、他人目录模式、指定目录校验 |

**变更文档**（本目录）：`01`～`04`、`06`～`08`、`07-prd-revisions.md`（Rev1 focused-review passed）。

**统计**：初版 3 实现文件约 +90 / −10 行；Rev1 7 代码文件约 +130 行（工作区口径）。

## 2、与设计的差异

1. **`-dir` 置首时含空格路径仅取首 token**（04-review §7）：workaround 将 `-dir` 置于任务描述之后。评分 50，不阻断 archive。
2. **MCP/Daemon `action=launch` 未扩展 `-dir`**：与 `02-design` §四/§八 本期范围外一致。
3. **指定目录模式未显式提示多人/多群并发写风险**（Rev1 §3）：UI helper 未补一句；评分 55，不阻断 archive。

其余与 `02-design.md`（含 Rev1 节）/ `03-tasks.md` 一致。

## 3、影响范围

- **指令契约**：管理员私聊 `/chat new <任务描述> [-dir <工作目录路径>]`（`-dir` 与任务描述顺序可互换，见 §2 边缘解析）。
- **调度层**：temp 经 `launchIndependentAgent(..., workingDirectory?)`；他人/群聊经 `resolveOthersWorkspaceDir`。
- **通道配置**：`othersWorkspaceMode`（isolated / specified）、`othersWorkspaceDir`（留空回退 `effectiveWorkspaceDir`）。
- **反馈**：temp 成功创建展示任务摘要、完整 `workspaceDir`、`SessionKey`；目录校验失败早返回。
- **数据**：`electron-store` 通道数组增两字段，读时兜底；运行时 `SessionAgent.workspaceDir` 为快照。
- **范围外**：主会话 `/workspace set`、`__IND_LAUNCH__`/MCP launch 入口、全局 Settings 主工作目录页结构不变。

### 3.1 Ponytail 技术债

diff 中无 `ponytail:` 注释。04-review 结论：解析/校验/他人目录均为单文件内联函数，复用 `validateWorkspacePath`，无新依赖/服务层。**Lean already. Ship.**

| 位置 | 注释摘要 | 升级路径 |
|------|----------|----------|
| 无 | — | — |

**非 Ponytail 遗留**（04-review §7）：§2 所列三项 — 不阻断 archive，可 post-archive 迭代。

## 4、知识库影响清单

- [x] `knowledge/业务域/Agent调度/02-多会话模型.md` — §三 ChatType 表 temp 与他人/群聊目录；§六 配置字段
- [x] `knowledge/业务域/Agent调度/04-远程指令.md` — `/chat new` 语法与 §四 临时会话描述
- [x] `knowledge/业务域/Agent调度/01-概览.md` — 关键约束、术语表、已知限制
- [x] `knowledge/业务域/Agent调度/00-README.md` — 未摘录 `/chat new`，无需改
- [x] `knowledge/知识索引.md` — 总入口未变化，无需更新
- [x] `knowledge/工程平台/` — 无 UI/打包结构性文档变更，无需更新
- [x] 群聊、微信、工作流等业务域子模块 — 行为边界外，无需更新
