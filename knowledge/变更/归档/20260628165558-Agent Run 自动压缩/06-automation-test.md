# Agent Run 自动压缩 - 验收记录

> **变更 ID**：`20260628165558-Agent Run 自动压缩`  
> **来源**：`/kb-test`  
> **前置**：`04-review.md` 已通过，无阻断项

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | 构建冒烟（`npm run build`）+ 静态追溯（对照 `04-review.md` 代码路径）+ **E2E/IM 手工**（飞书连续多轮 Run） |
| **目标** | 确认 apply 代码可编译打包；T1～T5 与 01/02 验收项有明确证据类型；E2E 项标注待人工 |
| **与验收关系** | 01 验收 1～8、02 §八·（二）六项、03 T1～T5 各条验收标准为本表追溯来源 |
| **默认不跑** | 单元/集成测试脚手架；全量飞书 IM 链路；破坏性 Stop/Reset 回归 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| 同会话连续三轮 IM Run + 压缩触发时序 | 需真实飞书通道、长上下文累积与 SDK harness；副作用高、不可 CI 轻量复现 |
| IM「正在压缩上下文…」notify 条数 | 依赖 `summary-started` 与 CardKit/notify 下发；仅日志无法等价证明用户可见 |
| 上下文耗尽 / 超时 / 会话异常失败文案 E2E | 需 mock 或复现特定 SDK error 形状与 peak/limit 组合 |
| footer / 超时 finalizer / 主动 Stop 全路径回归 | 01 验收 7 要求抽样；非本变更核心 diff 路径 |
| DDL / 持久化 | 无 schema 变更 |

## 3、验收追溯表

| 来源 | 验收摘要 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **01-1** | 连续三轮 Run 优先压缩完成；失败时非仅「请稍后重试」 | E2E 飞书 + UI 日志 | IM 文案 + `[compression]` 日志 | 待人工/E2E |
| **01-2** | Run 失败前可观测自动压缩 | E2E 或高 peak mock | `[compression] pre-send` / `上下文压缩开始` / `high-watermark` | 待人工/E2E |
| **01-3** | IM 压缩进行中提示，同 Run ≤1 条 | E2E 飞书 | IM notify 计数 | 待人工/E2E |
| **01-4** | 压缩后 Run 继续，无需 Stop+Reset | E2E 飞书 | 终态回复 + session idle | 待人工/E2E |
| **01-5** | 上下文耗尽失败含「上下文」类建议 | 代码路径 + E2E | `formatUserSdkFailureMessage` / IM | 代码✅；E2E 待人工 |
| **01-6** | 不可读 message 映射可理解类别 | 代码路径 + E2E | `sdk-failure-messages.ts` 兜底分支 | 代码✅；E2E 待人工 |
| **01-7** | footer / 日志 / 超时 / Stop 无回归 | 04-review 静态 + 抽样 E2E | 未改 finalizer/footer 实现 | 静态✅；E2E 抽样待人工 |
| **01-8** | 失败 notify 无 stack/路径；≤1 条 | 04-review + E2E | `isUnsafeSdkMessage` + `errorNotified` 闩 | 静态✅；E2E 待人工 |
| **02·八·（二）-1** | 三轮 resident dispatch 见 pre-send 或压缩开始日志 | E2E + UI 日志 | 同 01-2 | 待人工/E2E |
| **02·八·（二）-2** | peak≥95% + 不安全 message → 含「上下文」建议 | 代码路径 | T1 `isContextExhaustedByUsage` | 代码✅ |
| **02·八·（二）-3** | 超时类仍走 finalizer 文案，非上下文类 | 04-review 调用序 | `isRunTimeoutFailure` 先于分类器 | 静态✅ |
| **02·八·（二）-4** | 同 Run 压缩 IM ≤1；completed 无第二条进行中 | 04-review | `compressionNotified` 闩 | 静态✅；IM 待人工 |
| **02·八·（二）-5** | footer / `[compression]` / `[context-usage]` 格式一致 | 04-review diff 范围 | 未改 footer 与 summary 日志分支 | 静态✅ |
| **02·八·（二）-6** | 文件 ≤300 行；中文注释；build 通过 | 行数扫描 + build | wc + `npm run build` exit 0 | **通过** |
| **T1** | 失败分类器导出与优先级 | 04-review §5 | `sdk-failure-messages.ts` 134 行 | 静态✅ |
| **T2** | pre-send / high-watermark；limit 缺失 no-op | 04-review §5 | `context-usage-pressure.ts` + 278 行封装 | 静态✅ |
| **T3** | launch/dispatch 两处 send 前挂接 | 04-review §5 | `agent-sdk.ts` L977、L1024 | 静态✅ |
| **T4** | 失败归因挂接 + 压缩 IM 回归 | 04-review §5 | `formatSdkStreamFailure` 委托分类器 | 静态✅ |
| **T5** | AGENTS.md 三节约定 | 04-review §5 | `electron/AGENTS.md` | 静态✅ |

## 4、场景摘要

### 4.1 构建冒烟

| 场景 | 前置 | 步骤 | 期望 | 判责 |
|------|------|------|------|------|
| 全量生产构建 | Node 环境、依赖已安装 | 仓库根目录 `npm run build` | exit 0；main/preload/renderer 产物生成 | 失败→阻断 archive；查 TS/打包错误 |

### 4.2 E2E 手工清单（待人工）

| 场景 ID | 名称 | 前置 | 期望现象 | 对应验收 |
|---------|------|------|----------|----------|
| E2E-A | 连续三轮 IM 追问 | 飞书已绑定；工具密集型或长对话 | 第三轮 Run 结束前 UI 日志见 `[compression] pre-send` 或「上下文压缩开始」；尽量正常回复 | 01-1/2；02·（二）-1 |
| E2E-B | 压缩 IM 可感知 | 上下文接近上限 | IM 收到「正在压缩上下文…」；同 Run 仅 1 条；completed 后无重复进行中 | 01-3；02·（二）-4 |
| E2E-C | 压缩后继续 | 接 E2E-B | Run 继续产出回复；同会话可发下一条，无需 Stop+Reset | 01-4 |
| E2E-D | 上下文耗尽失败 | 可复现 peak 极高且 Run error | IM 含「上下文」类建议，非仅「请稍后重试」 | 01-5；02·（二）-2 |
| E2E-E | 超时 vs 上下文归因 | 触发超时类 error | 超时专用文案（finalizer 路径）；不出现上下文类文案 | 02·（二）-3 |
| E2E-F | 回归抽样 | 成功 Run、超时 Stop、主动 Stop 各 1 次 | footer 仍 append；`[compression]`/`[context-usage]` 前缀正常 | 01-7 |

**观测入口**：Electron UI 日志（`[compression]`、`[context-usage]`）；飞书 IM 消息；开发者工具无 stack 泄露至 IM。

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **auto_test/** | 本变更未新增脚本（IM/SDK 链路不适合默认自动化） |
| **构建命令** | 仓库根目录 `npm run build` |
| **环境变量** | 无新增；飞书 E2E 依赖既有 Daemon/通道配置（不写密钥） |
| **可选 mock** | 本地可调 `formatUserSdkFailureMessage` 入参验证文案（非本记录执行项） |

## 6、输出与记录规范

- 会话与本文档**禁止**粘贴完整终端日志或含 token 的输出。
- §7 执行记录每行一次执行，备注仅结论性短语。
- 详情见 `commands/kb-test.md`「输出规范」。

## 7、执行记录

| 日期 | 环境 | 命令/动作 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-28 | macOS；Node；未提交 apply 工作区 | `npm run build`（仓库根） | **通过** | main/preload/renderer 均 built；exit 0 |
| 2026-06-28 | 同上 | 改动文件行数扫描（T5/02·（二）-6） | **通过** | sdk-failure-messages 134；context-usage-pressure 54；context-usage 278；均 ≤300 |
| 2026-06-28 | 同上 | 04-review 静态验收对照 T1～T5 | **通过** | 无阻断；E2E 项未执行 |
| 2026-06-28 | 待配置飞书 | E2E-A～F 手工清单 | **待人工/E2E** | 见 §4.2 |
