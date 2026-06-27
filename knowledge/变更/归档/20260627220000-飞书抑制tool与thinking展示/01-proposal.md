# 飞书抑制 tool 与 thinking 展示轻量变更说明

> **变更 ID**：`20260627220000-飞书抑制tool与thinking展示`
> **来源**：kb-lite
> **类型**：体验优化
> **优先级**：P2
> **外部 PRD**：无
> **任务记录**：无
> **Figma 设计图**：无
> **lite 类型**：知识同步型 lite（实现后同步 `knowledge/业务域/消息桥接/02-飞书通道.md` 与 AGENTS）

---

## 背景

v1.6.1（变更 `20260627212713-群聊仅展示Shell工具卡片`）在**飞书群聊**对 Presentation 出站做了门控：抑制 read/grep/write 等非 shell 工具 CardKit，**保留** shell 工具 CardKit 与 thinking CardKit；主用户私聊仍展示全部 tool/thinking 卡片。

联调与产品反馈表明：即便仅保留 shell/thinking，飞书会话中的**过程类 CardKit** 仍干扰阅读；且群聊/私聊双策略增加认知与维护成本。用户期望飞书侧**只保留 assistant 流式正文**，过程信息改由桌面 SDK UI 日志承载。

进行中变更 `20260627210352-飞书Presentation展示时序编排` 原目标为「过程卡在上、结论卡在下」。在过程卡全面抑制后，该变更的**产品验收重心**须降级为 assistant 延迟首建与 Electron 本地闩锁，不再依赖飞书侧过程卡时间轴（详见彼变更 `07-prd-revisions.md` Rev1）。

## 变更说明

飞书**全通道**（群聊 + 主用户私聊）对 Presentation 出站统一调整：

| 出站类型 | 飞书 CardKit | SDK UI 日志 |
|----------|--------------|-------------|
| **tool**（含 shell / read / grep 等） | **不发送**（`presentation-event` 不渲染卡片） | **保留** `pushUiLog [tool]` |
| **thinking** | **不发送** | **保留** `appendSdkLog [thinking]` |
| **assistant 流式正文**（stream-text） | **不变**，CardKit 流式 PATCH 正常 | 不变 |

**微信**通道行为**不受影响**。

实现落点：`electron/agent-sdk.ts` 与 `src/daemon.ts` 双端 Presentation 出站路径，对飞书会话类型不再区分群聊/p2p 的过程卡策略，统一抑制 tool/thinking CardKit；移除 v1.6.1 引入的「群聊仅 shell」门控函数及其调用链（`isGroupChatPresentationEventAllowed`、`isGroupChatPresentationToolAllowed` 等）。不改 proto/DB/跨端 HTTP 契约。

### 与 1.6.1 / 群聊 shell 门控的替代关系

| 维度 | v1.6.1（已归档） | 本变更（取代） |
|------|------------------|----------------|
| 群聊 tool 卡 | 仅 shell 展示，非 shell 抑制 | **全部 tool 抑制** |
| 群聊 thinking 卡 | 保留 | **抑制** |
| 私聊 tool/thinking 卡 | 保留（时序编排仍依赖过程卡） | **抑制** |
| assistant stream-text | 不变 | 不变 |
| shell 命令 markdown 卡 | 群聊 shell 专用渲染 | **不再发往飞书**（日志仍可见 args/输出摘要） |

本变更** supersede** v1.6.1 的产品策略；archive 时须 bump 版本并更新 changelog，说明「飞书不再展示 tool/thinking 过程卡」。

### 对时序编排变更（20260627210352）的影响

| 原 scope | 调整后 |
|----------|--------|
| F1：过程卡整体先于 assistant 卡 | **降级**：飞书无过程卡；defer 链仍防止 preamble 抢先 POST，保证结论卡为唯一 assistant 出站 |
| E1/E3/E7：目检 tool/thinking 与 assistant 时间轴 | **改为**：仅验证 assistant 流式卡创建时机与 defer 释放；**不**再要求过程卡存在或顺序 |
| E5：过程+结论可读 | **改为**：飞书仅结论/失败说明；过程须在 SDK UI 日志可查 |
| T6 blocked 原因中的「过程卡在上」 | 归档门禁改为 assistant defer + 无过程卡刷屏 |

详细用例映射见 `20260627210352` 目录 `07-prd-revisions.md` Rev1。

### lite 判定

| 判定项 | 结论 |
|--------|------|
| 需求清晰度 | 产品反馈明确，验收可测 |
| 修改范围 | 双端 Presentation 门控扩展 + 移除旧门控 + 知识同步 |
| 接口契约 | 不变（+0） |
| 数据/权限 | 不变（+0） |
| 跨端联动 | Electron + Daemon 同仓双端（+2） |
| 知识库 | 单处业务域 + AGENTS（+2） |
| **总分** | **≤2** |

## 验收标准

1. 飞书**群聊** @ 触发含 shell/read/grep 等多工具 Run：**不出现**任何 tool CardKit（含 shell）。
2. 飞书**主用户私聊**同场景：**不出现**任何 tool CardKit。
3. 飞书群聊与私聊 Run 含 thinking：**不出现** thinking CardKit。
4. 飞书**assistant 流式正文**（stream-text CardKit）群聊与私聊均正常。
5. SDK UI：**仍出现** `pushUiLog [tool]` 与 `appendSdkLog [thinking]`，内容与改前等价或更清晰。
6. **微信**通道 tool/thinking/流式行为与改前一致（回归 smoke）。
7. v1.6.1 群聊 shell 门控代码路径已移除或恒 false，无双策略分支残留。
8. TypeScript 编译通过。

## 影响范围

| 范围 | 说明 |
|------|------|
| `electron/agent-sdk.ts` | `postPresentationEvent`：飞书全抑制 tool/thinking POST；保留 stream-text defer 链 |
| `src/daemon.ts` | `handleToolPresentationEvent` / `handleThinkingPresentationEvent`：飞书静默 `{ ok: true }`；移除群聊 shell 门控 |
| `src/shared/lark-core.ts` | 若仅 shell 卡渲染无其他引用，可精简 dead 路径（实现期 CodeGraph 确认） |
| `src/shared/tool-presentation.ts` | shell markdown 构建可保留供日志；飞书出站不再调用 |
| `knowledge/业务域/消息桥接/02-飞书通道.md` | 更新：飞书不展示 tool/thinking CardKit，过程见 SDK UI |
| `src/AGENTS.md`、`electron/AGENTS.md` | 移除群聊 shell 门控说明，补充全抑制规矩 |
| `package.json`、`changelog/` | archive 时 patch bump（用户可见策略变更） |

**不在范围**：微信通道、CardKit 视觉样式、MergeBatch 逻辑、PRESENTATION_ORDERING defer 算法删除（时序变更仍保留 assistant defer）、proto/DB。

## 与已有变更的关系

| 变更 | 关系 |
|------|------|
| `20260627212713-群聊仅展示Shell工具卡片`（已归档，v1.6.1） | **本变更取代**其群聊 shell 门控策略 |
| `20260627210352-飞书Presentation展示时序编排`（进行中） | **scope 降级**：挂靠 Rev1，E1–E7 过程卡用例调整 |
| `20260627162620-飞书作为Cursor展示与控制层`（已归档） | Presentation Pipeline 保留；仅 outbound 过程类事件对飞书 no-op |
| `20260627113111-消息通道即时响应与流式输出`（已归档） | stream-text / NF2 首段可见 SLA 仍适用 |
