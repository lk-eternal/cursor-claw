# SDK MCP stdio 相对路径支持产品需求文档

> **变更 ID**：`20260628163004-SDK MCP stdio 相对路径支持`
> **来源**：kb-propose
> **类型**：待确认
> **优先级**：待确认
> **外部 PRD**：无
> **Figma 设计图**：无
> **任务记录**：无

## 背景与问题

Cursor Claw 用户常在项目 `.cursor/mcp.json` 中为 stdio 类型 MCP 配置**相对路径**启动命令，例如指向项目内脚本（`./scripts/...`）或本地依赖可执行文件（`node_modules/.bin/...`）。在 Cursor IDE 或 CLI 中，这类配置通常能按**当前工作区根目录**正确解析并启动 MCP 服务。

近期版本已打通 SDK Agent 会话对 stdio MCP 的调用能力；Settings 页对 MCP 工具列表的探测，在已绑定工作区时也可能表现正常。但在 **经 SDK 发起的 Agent 会话**中，若配置使用相对路径，MCP 仍可能无法启动或 Agent 无法调用其工具——表现为工具列表缺失、工具调用失败或会话内无 MCP 能力，与用户在 IDE/CLI 下的预期不一致。

用户希望：在已配置工作区的前提下，SDK 路径下的 stdio MCP 与 Cursor 产品侧一样，能正确识别并执行 mcp.json 中的相对路径命令，无需为 Claw 单独改写为绝对路径。

## 目标用户与场景

### 目标用户

- **项目开发者**：在仓库内维护 MCP 配置，习惯用相对路径引用脚本与本地工具。
- **日常使用者**：通过飞书等通道触发 SDK Agent 任务，期望 Agent 能使用与 IDE 相同的 MCP 能力（如代码图谱、自定义工具服务等）。

### 场景 A：项目内脚本型 MCP

用户在 mcp.json 中将 command 配置为 `./scripts/某-mcp-server` 或类似相对路径。打开 Cursor Claw 并绑定该仓库为工作区后，发起 SDK Agent 会话。用户期望 Agent 能正常列出并调用该 MCP 的工具，行为与在 Cursor IDE 中一致。

### 场景 B：node_modules 内可执行文件

用户配置 `node_modules/.bin/某包` 作为 stdio MCP 启动命令（常见于 monorepo 或本地安装的 MCP 包）。绑定工作区后，Settings 探测可能已能看到工具，但 SDK 会话中 Agent 仍无法使用。用户期望两条路径下相对路径解析结果一致、均可用。

### 场景 C：与 Settings 探测体验对齐

用户先在 Settings → MCP 确认 stdio 服务工具列表正常，再在同工作区发起 Agent 任务。用户期望：**同一套 mcp.json、同一工作区**下，Settings 可见的 stdio MCP 在 SDK 会话中同样可用，不因路径写法为相对路径而在会话侧失败。

### 场景 D：未绑定工作区

用户未配置或未选择工作区目录。相对路径本身缺乏解析基准，本变更**不承诺**在此情况下仍能启动相对路径 MCP；行为应与产品侧一致（失败或跳过应有可理解的表现，见边界）。

## 功能需求

### F1 工作区基准下的相对路径解析

- 当 Agent 会话已关联**有效工作区目录**时，stdio 类型 MCP 的启动命令与参数中的相对路径，应相对于该工作区根目录解析，与 Cursor IDE/CLI 行为对齐。
- 用户无需为 Claw 单独将 mcp.json 改为绝对路径即可在 SDK 会话中使用常见相对路径写法（如 `./` 前缀、`node_modules/.bin/` 等）。

### F2 SDK 会话内 MCP 可用性

- 满足 F1 的配置，在 SDK Agent 会话中应能成功启动对应 stdio MCP，Agent 可列出并调用其工具（与用户在该工作区使用 IDE 时的可用性一致）。
- 若某 MCP 在 IDE 下因配置错误本身不可用，本需求不扩大 IDE 能力边界；重点是**相对路径不应成为 Claw SDK 路径下的额外障碍**。

### F3 与既有 stdio MCP 能力协同

- 本需求是在既有「SDK 支持 stdio MCP」能力上的体验补全，**不得**削弱已可用的 HTTP 型 MCP、Settings 探测或其它通道行为。
- 全局与用户级 mcp.json 的合并与覆盖规则保持与现有一致，本变更仅解决相对路径在 SDK 路径下的解析与启动问题。

### F4 可感知的失败说明（可选但建议）

- 当工作区缺失导致相对路径无法解析时，用户或运维在 Settings 或会话相关反馈中应能区分「路径/工作区问题」与「MCP 服务本身异常」，避免 silent failure；具体呈现方式不在本 PRD 限定。

## 边界与不在范围

- **无工作区时**：不保证相对路径类 stdio MCP 可用；不要求 invent 虚拟工作区或静默猜测 cwd。
- **绝对路径与系统级命令**：已能正常工作的绝对路径、`npx`、全局安装命令等，本变更不应引入回归。
- **HTTP / SSE 等非 stdio MCP**：不在本变更范围。
- **mcp.json  schema 扩展**：不新增配置字段；不改变用户对 mcp.json 的编写方式。
- **界面改版**：无新增页面或视觉设计（Figma：无）。
- **飞书/微信等通道专属逻辑**：除非为下发同一 SDK 会话能力所必需，否则不单独立项改造通道层。

## 验收标准

1. **相对路径脚本 MCP（SDK 会话）**：在已绑定工作区的项目中，mcp.json 使用 `./scripts/...` 或等价相对路径配置 stdio MCP；发起 SDK Agent 会话后，Agent 能成功调用该 MCP 至少一个工具，结果与在同一工作区 Cursor IDE 中调用一致（可用性一致，不要求字节级相同）。
2. **node_modules/.bin 类 MCP（SDK 会话）**：同上，command 指向 `node_modules/.bin/...`；SDK 会话内工具可列出且可调用，无因相对路径导致的启动失败。
3. **Settings 与 SDK 一致**：同一工作区、同一 mcp.json；若 Settings → MCP 能列出某 stdio MCP 的工具，则 SDK Agent 会话中也应能使用该 MCP（相对路径配置下）。
4. **HTTP MCP 无回归**：保留至少一条 url/HTTP 型 MCP 配置，确认 Settings 列表与 SDK 调用行为与变更前一致。
5. **无工作区边界**：未绑定工作区时，相对路径 stdio MCP 不强制可用；系统不应崩溃，失败原因可区分或可在验收记录中说明预期行为。
6. **编译与发布**：实现完成后项目可正常构建；用户可见变更在 archive 阶段按团队规范更新版本与 changelog。
