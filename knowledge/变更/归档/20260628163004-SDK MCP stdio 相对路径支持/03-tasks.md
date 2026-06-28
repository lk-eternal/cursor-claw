# SDK MCP stdio 相对路径支持 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 一、执行计划

### （一）依赖图

```
T1 ──→ T2
```

### （二）分组调度

- **第一轮**：T1（`electron/mcp-sdk-loader.ts` 相对路径 resolve 实现）
- **第二轮**：T2（`electron/AGENTS.md` 知识沉淀，依赖 T1 落地规则）

## 二、任务清单

## T1: 实现 mcp-sdk-loader stdio 相对路径 resolve

### 背景

SDK Agent 会话经 `loadInlineMcpServers` → `toStdioInlineConfig` 注入 stdio MCP 时，当前仅设置 `cwd`，`command`/`args` 原样传入 `@cursor/sdk`；无 shell 的 spawn 无法解析 `./scripts/...`、`node_modules/.bin/...` 等相对路径，导致 MCP 启动失败。本任务在 loader 内将路径型相对 segment 解析为绝对路径，对应设计步骤 S3/F1/S5/S6，是唯一代码改动落点。

### 上下文文件

- CodeGraph: `toStdioInlineConfig`、`loadInlineMcpServers`、`resolvePathLikeSegment` — 定位 stdio inline 转换链与影响面
- 必读: `electron/mcp-sdk-loader.ts` — 当前 `toStdioInlineConfig`（约 48–63 行）及 `loadInlineMcpServers` 调用链
- 必读: `knowledge/变更/进行中/20260628163004-SDK MCP stdio 相对路径支持/02-design.md` — §五路径型判定、§六实现步骤 1–4、§八·（二）工程补充验收项
- 参考: `electron/mcp-manager.ts` — Settings Path B 的 `shell:true` + `cwd` 参考行为（本任务不改此文件）
- 参考: `electron/agent-sdk.ts` — 确认 `workspaceDir` 已传入 `loadInlineMcpServers` / `appendInlineMcpToSendOptions`（本任务不改）

### 实现范围

- 修改: `electron/mcp-sdk-loader.ts` — 新增私有函数 `resolvePathLikeSegment(workspaceDir: string, segment: string): string`：
  - `path.isAbsolute(segment)` → 返回原值
  - bare 命令名（无 `/`、`\`，且不以 `./`、`../` 开头，如 `npx`、`node`、`python3`）→ 返回原值
  - 路径型（含 `/` 或 `\`，或以 `./`、`../` 开头）→ `path.resolve(workspaceDir, segment)`
- 修改: `electron/mcp-sdk-loader.ts` — `toStdioInlineConfig`：
  - 当 `workspaceDir.trim()` 非空：对 `command` 调用 `resolvePathLikeSegment`；对 `args` 逐元素 resolve，**跳过**以 `--` 开头的 flag
  - 保持 `cfg.cwd = workspaceDir`（非空时）
  - 当 `workspaceDir.trim()` 为空：不 resolve、`command`/`args` 与变更前一致、不设置 `cwd`（S5 边界）
- 不改: 同文件 `toHttpInlineConfig`、`loadInlineMcpServers` 分支逻辑；不改 `agent-sdk.ts`、`mcp-manager.ts`

### 接口契约

- `resolvePathLikeSegment(workspaceDir: string, segment: string): string` — 私有 helper；路径型相对 segment → 绝对路径，绝对路径/bare 名 → 原值
- `toStdioInlineConfig(raw: RawMcpEntry, workspaceDir: string): McpServerConfig | null` — 签名不变；有效 workspace 下输出的 `command`/`args` 中路径型 segment 为绝对路径
- `loadInlineMcpServers(workspaceDir: string): Record<string, McpServerConfig>` — 签名与导出不变；stdio 条目经更新后的 `toStdioInlineConfig` 生成

### 验收标准

- [ ] **01 验收 1（相对路径脚本 MCP）**：给定非空 `workspaceDir` 与 `command: "./scripts/foo"`（或等价相对路径），`toStdioInlineConfig` 输出 `command` 为 `path.resolve(workspaceDir, "./scripts/foo")` 的绝对路径；`cwd` 仍为 `workspaceDir`（为 SDK 会话内 MCP 可启动提供代码基础，端到端在 `/kb-test` 验证）
- [ ] **01 验收 2（node_modules/.bin）**：`command: "node_modules/.bin/bar"` 被 resolve 为绝对路径；bare 名 `npx`/`node` 不被 resolve
- [ ] **01 验收 3（Settings 与 SDK 一致）**：resolve 语义与 02 §二「相对工作区根」一致；与 Settings Path B 行为对齐（代码侧，不修改 `mcp-manager.ts`）
- [ ] **01 验收 4（HTTP MCP 无回归）**：`toHttpInlineConfig` 及 `loadInlineMcpServers` 中 `raw.url` 分支逻辑未改动；HTTP/sse 条目输出与变更前一致
- [ ] **01 验收 5（无工作区边界）**：`workspaceDir === ""` 或仅空白时，`toStdioInlineConfig` 输出与变更前字节级一致（无 `cwd`、command/args 原样）
- [ ] **02 §八·（二）- resolve 规则**：给定 workspace + `./scripts/foo`、`node_modules/.bin/bar`、绝对路径 command、`npx` command，输出符合路径型判定与 resolve 规则
- [ ] **02 §八·（二）- args 混合**：`args` 含 `--config`、`./path/to/config.json` 时，仅路径型 arg 被 resolve，`--*` flag 保持原样
- [ ] **02 §八·（二）- 编译与行数**：`npm run build`（或项目标准构建命令）TypeScript 编译通过；`mcp-sdk-loader.ts` 行数仍 ≤300
- [ ] **01 验收 6（编译）**：本任务完成后项目可正常构建；版本 bump 与 changelog 在 `/kb-archive` 阶段执行，本任务不修改 `package.json` / `changelog/`
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径；不新建 resolver 模块/包，仅用 Node 内置 `path`）

### 依赖

- 前置任务: 无
- 后续任务: T2

## T2: 更新 electron/AGENTS.md「SDK MCP 内联」段

### 背景

`02-design.md` §十·（一）要求 archive 前沉淀 loader 行为：`toStdioInlineConfig` 在有效 workspace 下对路径型相对 `command`/`args` 做 resolve，与 Settings Path B 对齐；无 workspace 时不 resolve、不设 `cwd`。本任务在 T1 实现落地后更新工程约定文档，供后续维护与 CodeGraph 检索。

### 上下文文件

- CodeGraph: `loadInlineMcpServers`、`toStdioInlineConfig` — 确认 T1 实现与文档描述一致
- 必读: `electron/AGENTS.md` — 当前「SDK MCP 内联」 bullet（约第 19 行）
- 必读: `electron/mcp-sdk-loader.ts` — T1 完成后的 `resolvePathLikeSegment` 与 `toStdioInlineConfig` 实际逻辑
- 参考: `knowledge/变更/进行中/20260628163004-SDK MCP stdio 相对路径支持/02-design.md` — §五数据结构、§八·（一）影响范围

### 实现范围

- 修改: `electron/AGENTS.md` — 扩展「**SDK MCP 内联**」段，补充：
  - stdio：`toStdioInlineConfig` 在 `workspaceDir` 非空时将路径型相对 `command`/`args` resolve 为绝对路径（规则：含 `/`/`\` 或 `./`/`../` 前缀；bare 名与 `--flag` 不 resolve）；仍设置 `cwd = workspaceDir`
  - 边界：`workspaceDir` 为空时不 resolve、不设 `cwd`，相对路径 stdio MCP 不承诺可用
  - 不变：HTTP/sse 仍经 `toHttpInlineConfig`；`agent-sdk` 每次 `Agent.create` / `agent.send` 须传 `mcpServers`；Settings Path B（`mcp-manager`）未改

### 接口契约

- 无新增代码接口；文档约定与 T1 实现的 `resolvePathLikeSegment` / `toStdioInlineConfig` 行为一致，供 kb-builder / 后续变更检索

### 验收标准

- [ ] `electron/AGENTS.md`「SDK MCP 内联」段明确写出 stdio 相对路径 resolve 规则、路径型判定、无 workspace 边界，且与 T1 代码行为一致
- [ ] 文档未错误声称修改了 `mcp-manager.ts` 或 HTTP MCP 逻辑
- [ ] **01 验收 3**：文档说明 SDK inline resolve 与 Settings 探测（CLI cwd + stdio 回退 cwd）语义对齐
- [ ] **01 验收 5**：文档写明无工作区时不 resolve、不承诺相对路径 stdio 可用
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径；仅更新既有 AGENTS 段落，不新建知识文件）

### 依赖

- 前置任务: T1
- 后续任务: 无（实现完成后运行 `/kb-test` 做 01 验收 1–5 端到端验证；`/kb-archive` 处理 01 验收 6 与 changelog）
