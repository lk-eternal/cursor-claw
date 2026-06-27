# PRD 需求变更记录

> **变更 ID**：`20260627113111-消息通道即时响应与流式输出`
> **说明**：按轮次追加；实现由 `/kb-revise-apply` 执行，完成后更新「实现状态」。

## Rev1

| 字段 | 内容 |
|------|------|
| 轮次编号 | Rev1 |
| 日期 | 2026-06-27 |
| 变更摘要 | 飞书 SDK 流式输出由 `im.message.patch` + 分段降级改为飞书官方 CardKit 流式卡片（`streaming_mode` + `card_id` + 流式更新文本 API） |
| 动因/来源 | `08-verify-issue` 第 1 轮验收打回（飞书+SDK 主用户私聊出现多条半幅递增消息，违反 F4.2/NF6）；飞书 CardKit 官方流式能力 |
| 与上一版差异要点 | ① 飞书首包改为创建 CardKit 卡片实体并发消息引用 `card_id`，不再依赖 PATCH 更新 text 消息；② 流式更新走 CardKit 流式更新文本 API（`sequence` 递增）；③ `final` 时关闭 `streaming_mode`；④ 现有 PATCH/分段方案降为 CardKit 失败时的 fallback；⑤ SDK 侧 `flushStreamPost` 须串行化，避免并发首包；⑥ 需应用开通 `cardkit:card:write` 权限 |
| 影响范围 | 飞书通道、`src/shared/lark-core.ts`、`src/daemon.ts`（`/api/stream-text`）、`electron/agent-sdk.ts`；微信路径不变 |
| 关联 03 任务 | T-Rev1-01、T-Rev1-02、T-Rev1-03 |
| 实现状态 | **未开始** |
