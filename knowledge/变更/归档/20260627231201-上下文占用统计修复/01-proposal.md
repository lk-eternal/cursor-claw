# 上下文占用统计修复轻量变更说明

> **变更 ID**：`20260627231201-上下文占用统计修复`
> **来源**：kb-lite
> **lite 类型**：hotfix-lite / 记录型 lite
> **类型**：Bug
> **优先级**：P2
> **外部 PRD**：无
> **任务记录**：无
> **Figma 设计图**：无
> **关联变更**：`knowledge/变更/归档/20260627215516-Agent自动压缩与上下文占用展示/`

---

## 背景

飞书 Agent 终态回复 footer 展示上下文占用，例如 `上下文：100% (468.7k/200k)`。用户仅对话两句即显示 100%，且 **used 远超 limit**，与真实上下文占用不符，误导用户判断会话是否接近上限。

该 footer 由已归档变更「Agent 自动压缩与上下文占用展示」引入；本 hotfix 修正统计口径与 Run 内累加逻辑，不改动 footer 展示格式与通道下发路径。

## 根因

1. **`mergeTurnUsage` 在 Run 内累加**：`electron/context-usage.ts` 在每次 `turn-ended` 事件时对 usage 做 merge 累加，同一 Run 内多 turn 导致 used 被重复叠加。
2. **`totalContextTokens` 口径过重**：当前计算含 **output** token，展示侧把「已用上下文」放大，短对话也可能轻易触顶 100%。

## 变更说明

### LITE-01：修正 `electron/context-usage.ts`

- **`turn-ended` 处理**：收到最新 usage 时 **replace**（覆盖为当前 turn 快照），**不再**在同一 Run 内 merge 累加。
- **`totalContextTokens` 收窄**：仅统计 prompt 侧 —— `input + cacheRead + cacheWrite`，**不含 output**。
- 保持与 `agent-sdk.ts` 现有订阅/append footer 契约兼容；**不修改** `electron/mcp-manager.ts` 及其他 MCP 相关文件。

### lite 判定

| 判定项 | 结论 |
|--------|------|
| 需求清晰度 | 现象、根因、修复方向已明确 |
| 修改范围 | 单文件 `electron/context-usage.ts` |
| 接口契约 | 内部统计 helper，无 proto/HTTP 变更（+0） |
| 数据/权限 | 不变（+0） |
| 跨端联动 | Electron 单端展示口径（+0） |
| 知识库 | 记录型，05-summary 说明即可（+0） |
| **总分** | **≤2**，可走 hotfix-lite |

## 验收标准

1. **短对话**：飞书私聊/群聊仅 1～2 轮简单问答后，footer 百分比与 `(used/limit)` 合理（used 不应远超 limit，不应无故 100%）。
2. **多 turn Run**：同一 Run 内多次 `turn-ended` 后，占用反映**最新 turn** 快照，不因 merge 重复累加。
3. **口径一致**：`totalContextTokens` 不含 output；与 footer 展示的 used 含义一致。
4. **回归**：自动压缩与 footer 附加行为仍正常（关联归档变更能力不退化）。
5. **TypeScript 编译通过**。

## 影响范围

| 范围 | 说明 |
|------|------|
| `electron/context-usage.ts` | **唯一代码改动**：turn-ended replace + totalContextTokens 口径 |
| `electron/agent-sdk.ts` | 只读依赖方，本变更不修改（footer append 逻辑不变） |
| 飞书通道 | 用户可见 footer 数字修正，无 CardKit/协议变更 |

**不在范围**：`electron/mcp-manager.ts`、proto/DB、changelog（archive 阶段再定是否 patch bump）。

## 待 builder 事项

- 实现 LITE-01 后更新 manifest：`tasks[0].status = done`，`files[]` 写入实际变更路径
- 完成后由 kb-scribe 补写 `05-summary.md`；hotfix-lite 可与实现同轮归档
