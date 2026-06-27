# 工作流

> 多节点 Agent 流水线：YAML 定义有序节点链，MCP 工具驱动流转，支持驳回重跑与独立 Agent。

## 文件清单

| 编号 | 文件 | 职责 |
|------|------|------|
| 00 | [00-README.md](./00-README.md) | 领域局部索引（本文件） |
| 01 | [01-概览.md](./01-概览.md) | 模块总图、术语、依赖 |
| 02 | [02-定义与实例.md](./02-定义与实例.md) | YAML 结构、Definition/Instance 模型与存储 |
| 03 | [03-节点执行与流转.md](./03-节点执行与流转.md) | workflow_next/reject、isolated、上下文传递 |
| 04 | [04-触发与管理入口.md](./04-触发与管理入口.md) | 设置页、/workflow 指令、manage_workflows MCP |

## 职责边界

**负责**：工作流蓝图 CRUD、实例状态机、节点 Prompt 组装、MCP 流转工具、Electron 启动与通知。

**不负责**：Agent 进程生命周期细节（见 [Agent调度](../Agent调度/00-README.md)）、消息通道连接（见 [消息桥接](../消息桥接/00-README.md)）。

## 源码锚点

| 模块 | 路径 |
|------|------|
| 引擎 | `src/workflow-engine.ts` |
| Daemon 存储 | `src/workflow-store.ts` |
| Electron 存储 | `electron/workflow-file.ts` |
| 类型 | `src/shared/workflow-types.ts` |
| 定义解析 | `src/shared/workflow-parse.ts`、`workflow-definition-store.ts` |
| MCP | `src/server-workflow.ts` |
| 启动 | `electron/workflow-runner.ts` |
| 内置示例 | `src/builtin-workflows.ts`、`resources/template/workflow/` |
| UI | `src/renderer/components/WorkflowPanel.tsx` |
| 飞书指令 | `electron/command-handler.ts` |

## 推荐阅读路径

1. **01-概览** — 建立全局认知
2. **02-定义与实例** — 编写或导入 YAML
3. **03-节点执行与流转** — 理解 Agent 侧行为
4. **04-触发与管理入口** — 从 UI / 指令 / MCP 启动

## 变更记录

2026-06-27：kb-sync 初始建立
