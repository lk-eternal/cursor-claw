# PRD 修订记录

> 变更 ID：`20260627132014-飞书临时会话工作目录可选`

## Rev1（2026-06-27）

| 字段 | 内容 |
|------|------|
| **轮次编号** | Rev1 |
| **日期** | 2026-06-27 |
| **变更摘要** | 桌面端通道配置页须说明主用户 `/chat new -dir`；「允许其他人使用」区可配置他人/群聊工作目录模式（临时目录按会话隔离 vs 指定目录，留空等同主会话目录）。 |
| **动因/来源** | 验收打回（08 第 1 轮，reason=code）：配置页未体现 `-dir` 说明；产品补充：区分临时/指定两种模式及留空默认规则。 |
| **与上一版差异要点** | ① 非目标调整：他人/群聊目录不再固定「仅隔离临时目录」，改由通道配置选择模式。② 新增配置页交互：主用户区 `-dir` 说明；允许其他人使用区模式切换 + 可选路径。③ 验收标准扩展：配置页可见、可切换、留空默认行为可验证。④ 实现范围从「仅 Daemon 帮助文案」扩展到 `ChannelPanel` + `launchAgent` 他人分支 + 配置持久化。 |
| **影响范围** | `src/renderer/components/ChannelPanel.tsx`；`src/shared/channel-types.ts`、`electron/preload.ts`、`src/renderer/env.d.ts`；`electron/config-store.ts`（`getChannels` 迁移兜底）；`electron/session-dispatcher.ts` `launchAgent` 他人目录分支 |
| **关联 03 任务** | T-Rev1-01、T-Rev1-02、T-Rev1-03 |
| **实现状态** | 未开始 |
