# 群聊仅展示 Shell 工具卡片轻量变更说明

> **变更 ID**：`20260627212713-群聊仅展示Shell工具卡片`
> **来源**：kb-lite
> **类型**：Bug
> **优先级**：P2
> **外部 PRD**：无
> **任务记录**：无
> **Figma 设计图**：无
> **lite 类型**：知识同步型 lite（实现后同步 `knowledge/业务域/消息桥接/02-飞书通道.md` 与/或 `src/AGENTS.md`）

---

## 变更说明

飞书**群聊**中 Agent 执行多工具任务时，Presentation 会为 read/grep/write/thinking 等逐一发送 CardKit 工具/思考卡片，造成会话「卡片轰炸」，干扰阅读。

本变更在**群聊**场景对 Presentation 出站做门控：

- **抑制**非 shell 工具 CardKit（started/completed PATCH 均不发）
- **抑制** thinking CardKit（与 tool 非 shell 同策略，admin 已确认）
- **保留** shell 工具 CardKit（started/completed PATCH 正常）
- **保留** assistant 流式正文（stream-text CardKit）
- **主用户私聊（p2p）**行为不变，仍展示全部 tool/thinking 卡片

实现落点：`electron/agent-sdk.ts` 与 `src/daemon.ts` 双端 Presentation 出站路径，按会话类型（群聊 vs p2p）分支门控；不改 proto/DB/跨端契约。

### lite 判定

| 判定项 | 结论 |
|--------|------|
| 需求清晰度 | 产品反馈明确，验收可测 |
| 修改范围 | 双端 Presentation 门控 + 知识同步 |
| 接口契约 | 不变（+0） |
| 数据/权限 | 不变（+0） |
| 跨端联动 | Electron + Daemon 同仓双端（+2） |
| 知识库 | 单处业务域说明 + 可选 AGENTS（+2） |
| **总分** | **≤2**（未命中 proto/DB/权限/资金强制升级项） |

与进行中变更 `20260627210352-飞书Presentation展示时序编排` **独立**：彼变更聚焦私聊时序编排；本变更聚焦群聊卡片降噪，不挂靠、不共用任务。

## 验收标准

1. 飞书群聊 @ 触发含 read/grep/write 等多工具 Run：群聊**不出现**非 shell 工具 CardKit。
2. 同 Run 含 shell：群聊**仍出现** shell 工具 CardKit（started/completed PATCH）。
3. 主用户私聊 tool/thinking 卡片行为与改前一致。
4. 群聊 assistant 流式回复（stream-text）正常。
5. TypeScript 编译通过。

## 影响范围

| 范围 | 说明 |
|------|------|
| `electron/agent-sdk.ts` | SDK 路径 Presentation 出站：群聊门控非 shell tool/thinking CardKit |
| `src/daemon.ts` | Daemon 路径 Presentation 出站：同上双端一致门控 |
| `knowledge/业务域/消息桥接/02-飞书通道.md` | 补充群聊 Presentation 仅 shell/thinking 抑制说明（知识同步型 lite） |
| `src/AGENTS.md` | 可选：沉淀群聊 Presentation 门控规矩 |

**不在范围**：私聊 Presentation 时序编排（`20260627210352`）、CardKit 视觉样式、合并批次/MergeBatch 逻辑、proto/DB。
