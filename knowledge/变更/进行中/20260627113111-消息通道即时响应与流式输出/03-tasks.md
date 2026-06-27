# 消息通道即时响应与流式输出 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 1、执行计划

### 1.1 依赖图

```
T1 ──→ T4 ──→ T5
T2 ──→ T4 ──→ T6 ──→ T7 ──→ T8
T3（独立，走既有 notifyChat → /api/send-text）

Rev1（验收打回修复）：
T-Rev1-01 ──→ T-Rev1-02
T-Rev1-03（可与 T-Rev1-01 并行，与 T-Rev1-02 联调）
```

**文件冲突说明**：T4/T5/T6/T8 均修改 `src/daemon.ts`，须严格按轮次串行，不得并行。Rev1 任务 T-Rev1-02 亦改 `src/daemon.ts`，须与 T-Rev1-01 串行后再联调 T-Rev1-03。

### 1.2 分组调度

- **第一轮（并行）**：T1、T2、T3
- **第二轮**：T4（入队确认 + SessionProgressState）
- **第三轮**：T5（poll Get 时序）
- **第四轮**：T6（stream-text 端点 + 飞书通道）
- **第五轮**：T7（SDK 流式桥接 + 错误 notify）
- **第六轮**：T8（完成/异常停止进行中指示）

**Rev1 修复轮（`/kb-revise-apply`）**：

- **Rev1-第一轮（可并行）**：T-Rev1-01、T-Rev1-03
- **Rev1-第二轮**：T-Rev1-02（依赖 T-Rev1-01 CardKit 封装；与 T-Rev1-03 联调验收）

## 2、任务清单

## T1: 队列会话待处理计数

### 背景

实现 S6「排队提示」的数据基础。`getQueueLength` 仅统计 `.qmsg`，无法反映已领取待 ack 的 `.claimed` 条数；需新增 `getSessionPendingCount` 供入队确认文案计算「前面还有 N 条待处理」。

### 上下文文件

- CodeGraph: `getQueueLength` `hasPendingMessages` `claimSessionMessages` — 理解 `.qmsg`/`.claimed` 语义
- 必读: `src/file-queue.ts` — `getSessionDir`、`hasPendingMessages`（L164–171）、`claimSessionMessages`（L181–214）
- 参考: `src/file-queue.ts:299` — `getQueueLength` 对比实现

### 实现范围

- 修改: `src/file-queue.ts` — 新增并导出 `getSessionPendingCount(sessionKey: string): number`
- 计数规则：指定 `sessionKey` 对应目录下 `.qmsg` + `.claimed` 文件数之和（与 `hasPendingMessages` 语义一致，但返回具体数字）
- 空目录、目录不存在、`queueDir` 未初始化时返回 `0`

### 接口契约

- `export function getSessionPendingCount(sessionKey: string): number` — 统计指定会话待处理（待领取 + 已领取待 ack）消息条数

### 验收标准

- [ ] 会话目录含 2 个 `.qmsg`、1 个 `.claimed` 时返回 `3`
- [ ] 仅 `.claimed` 或仅 `.qmsg` 时计数正确
- [ ] 空会话、`sessionKey` 无效时返回 `0`，不抛异常
- [ ] 行为与 `getQueueLength(filterSessionKey)` 在纯 `.qmsg` 场景下一致；含 `.claimed` 时大于等于后者
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T4

---

## T2: 微信 typing 生命周期解耦

### 背景

实现 S7/S12 的通道前置条件。当前 `WeChatManager.sendText` 在每次发送前后自动 `ensureTyping`/`cancelTyping`（L151–165），与「入队到任务完成持续进行中指示」冲突；需暴露独立 start/stop API，由 daemon 进度状态机统一驱动。

### 上下文文件

- CodeGraph: `WeChatManager sendText cancelTyping startTypingForUser` — typing ticket 生命周期
- 必读: `src/wechat-manager.ts` — `sendText`（L151–166）、`cancelTyping`（L201–211）、`startTypingForUser`（L214–225）、`typingTickets` Map
- 参考: `src/wechat/types.ts` — `MessageState.GENERATING` 常量

### 实现范围

- 修改: `src/wechat-manager.ts`
  - 新增公开方法 `startProgressTyping(userId: string): Promise<void>` — 获取 ticket 并发送 typing（可复用 `startTypingForUser` 逻辑）
  - 新增公开方法 `stopProgressTyping(userId: string): Promise<void>` — 复用 `cancelTyping` 逻辑并清除 ticket
  - `sendText`/`sendMedia`：移除发送前自动 `ensureTyping` 与发送后自动 `cancelTyping`；或增加可选参数 `{ skipTyping?: boolean }` 默认 true，确保普通 Agent 回复仍可按需 typing（与进度指示路径分离）
  - 收到用户消息时的 `startTypingForUser`（L267）保留或改为不自动触发，避免与 daemon 进度重复（以 daemon 统一控制为准）

### 接口契约

- `WeChatManager.startProgressTyping(userId: string): Promise<void>` — 开启会话级进行中指示
- `WeChatManager.stopProgressTyping(userId: string): Promise<void>` — 停止并清理 ticket
- `sendText(to, text, opts?)` — 不再隐式绑定 typing 生命周期（签名按最小改动扩展）

### 验收标准

- [ ] 调用 `startProgressTyping` 后微信侧可见「正在输入」；`stopProgressTyping` 后 5 秒内消失（对齐 01 验收 5、NF3）
- [ ] `sendText` 发送普通回复不再自动 cancel 由进度机管理的 typing
- [ ] 未连接时调用 start/stop 不抛未捕获异常，打 WARN 日志
- [ ] 确认 `MessageState.GENERATING` 与 typing ticket 独立管理（工程补充验收项 2）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T4、T6、T8

---

## T3: Agent 冷启动与处理中文案整合

### 背景

实现 S8/S9、F3.2/F3.3/F5.2。`_dispatchSessionAgentsInner` 在 L578 发送「正在启动Agent，请稍等...」，与入队确认语义重叠；Agent 真正进入处理后缺少统一的「Agent 处理中…」通知。本任务调整 session-dispatcher 与 SDK 启动成功路径的 notify 文案与时序。

### 上下文文件

- CodeGraph: `notifyChat launchSessionAgent launchSdkAgent _dispatchSessionAgentsInner` — 冷启动通知链
- 必读: `electron/session-dispatcher.ts` — `notifyChat`（L40–48）、`_dispatchSessionAgentsInner`（L544–595，重点 L578–588）
- 必读: `electron/agent-sdk.ts` — `launchSdkAgent`（L198+）Agent 创建成功后的入口
- 参考: `electron/session-dispatcher.ts:77` — `isMainUser`（F4.1  eligibility 参考）

### 实现范围

- 修改: `electron/session-dispatcher.ts`
  - L578：`notifyChat(sessionKey, "正在启动Agent，请稍等...")` 改为「正在启动」（或 01 标准文案等价短句）
  - `launchSessionAgent`/`launchAgent` 成功且 Agent 即将处理任务时：调用 `notifyChat(sessionKey, "Agent 处理中…")`（仅一次，不与入队确认重复刷屏）
  - 启动失败路径（L586–588）保留 `notifyChat` 失败说明，文案用户可理解、非技术堆栈
- 修改: `electron/agent-sdk.ts`
  - `launchSdkAgent` 内 Agent 创建成功、开始 `streamRunEvents` 前：对对应 `sessionKey` 发送「Agent 处理中…」（经 `notifyChat` 或等价 `httpPost` `/api/send-text`）
  - 若 session 已在运行（early return L203–207），不重复发送处理中通知

### 接口契约

- 无新增导出；沿用 `notifyChat(sessionKey, text)` → `POST /api/send-text`
- 文案常量（可内联）：冷启动「正在启动」；处理中「Agent 处理中…」

### 验收标准

- [ ] Agent 未运行发 1 条消息：3 秒内先有入队确认（T4），冷启动期间可见「正在启动」；进入处理后仅 **一条**「Agent 处理中…」，无与「已收到，正在处理」近义的双条通知（01 验收 3）
- [ ] SDK 与 CLI 两种 Agent 资源启动成功后均触发处理中通知（SDK 路径经 agent-sdk）
- [ ] 启动失败时用户收到可理解失败说明，无进程/路径泄露（01 验收 9 部分）
- [ ] 三态链路中处理阶段文案统一为「Agent 处理中…」（F3.3）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无（与 T4 可并行；验收联调时依赖 T4 入队确认）
- 后续任务: 无

---

## T4: 入队确认与会话进度状态

### 背景

实现 S5/S6/S7 核心：`pushMessage` 在 `pushToFileQueue` 成功且非去重拒绝时，≤3s 发送入队确认、附加排队提示，并初始化 daemon 进程级 `SessionProgressState` 驱动原生进行中指示（微信 typing、飞书表情）。

### 上下文文件

- CodeGraph: `pushMessage replyToMessage pushToFileQueue resolveChannel` — 入队与回复链
- 必读: `src/daemon.ts` — `pushMessage`（L493–520）、`replyToMessage`（L687+）
- 必读: `src/file-queue.ts` — `pushToFileQueue`（L45+）、T1 产出的 `getSessionPendingCount`
- 必读: `src/wechat-manager.ts` — T2 产出的 `startProgressTyping`/`stopProgressTyping`
- 参考: `src/daemon.ts:430` — `addReactionToMessages` 飞书表情

### 实现范围

- 修改: `src/daemon.ts`
  - 新增 `SessionProgressState` 接口与 `Map<sessionKey, SessionProgressState>`（字段：`typingActive`、`outboundMessageId?`、`streamId?`，见设计 §五）
  - 在 `pushMessage` 的 `written === true` 分支：
    - 跳过 `messageId` 缺失或以 `internal_` 开头的消息（F1.4 指令/internal 不适用）
    - `pending = getSessionPendingCount(routedId)`；组文案「已收到，正在处理」；若 `pending > 1` 附加「前面还有 {pending-1} 条待处理」（F1.3：计数含当前刚入队条，提示为前方等待数）
    - 异步调用 `replyToMessage(messageId, text, chatId)`（不触发 `ackOnReply`）
    - 初始化/更新 `SessionProgressState`；微信通道调用 `startProgressTyping`；飞书对原消息打 Get 或等价进行中表情（F2.1）
  - 新增内部 helper：`stopSessionProgress(sessionKey)` — 停止 typing/表情，清 Map 条目（供 T8 复用）

### 接口契约

- `interface SessionProgressState { typingActive: boolean; outboundMessageId?: string; streamId?: string }`
- `const sessionProgressMap = new Map<string, SessionProgressState>()`
- `function stopSessionProgress(sessionKey: string): void` — 停止会话进行中指示

### 验收标准

- [ ] 飞书/微信私聊各 10 次实测：成功入队后 100% 在 3 秒内收到「已收到，正在处理」（01 验收 1、NF1）
- [ ] 同会话连发 3 条：第 2、3 条确认含正确排队提示（01 验收 2）
- [ ] 去重拒绝入队（`written === false`）不发送确认（01 验收 10）
- [ ] 指令拦截路径不触发本逻辑（F1.4）
- [ ] 入队确认后微信可见 typing、飞书可见 Get 类表情（01 验收 5 前半）
- [ ] 每条用户消息仅一次入队确认（F1.2）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1、T2
- 后续任务: T5、T6、T8

---

## T5: poll Get 表情时序调整

### 背景

实现 S10、F5.3。Agent poll 领取时对 **新** 消息打 Get 表情（`collectFreshAndTrack` + `addReactionToMessages`）；入队确认已在 T4 触发进行中反馈，poll 时不应重复造成语义冲突。调整 Get 打标时机或条件，文本三态优先、表情为辅。

### 上下文文件

- CodeGraph: `poll-message addReactionToMessages collectFreshAndTrack flushPendingDone` — poll 与表情时序
- 必读: `src/daemon.ts` — `/api/poll-message`（L1564–1625）、`addReactionToMessages`（L430–437）、`collectFreshAndTrack`（L419–427）
- 参考: T4 的 `SessionProgressState` — 判断是否已在入队阶段打过 Get

### 实现范围

- 修改: `src/daemon.ts` — `/api/poll-message` 处理块（L1584–1624）
  - 评估 instant 与 blocking 两路径的 `addReactionToMessages(freshIds, ..., "Get")` 调用
  - 若 T4 入队已对原用户消息打 Get/进行中反馈，poll 时对 **同一 messageId** 跳过重复 Get，或延后至首次真正开始处理时
  - 保留 `flushPendingDone` 与 DONE 表情逻辑不变
  - 确保文本状态（「Agent 处理中…」）语义优先于表情（F5.3）

### 接口契约

- 无新增公开 API；行为变更仅影响 poll 副作用

### 验收标准

- [ ] 端到端成功任务中，飞书用户消息不出现异常双重 Get 或表情与文本矛盾（01 验收 5、F5.3）
- [ ] poll 仍正确投递 `.claimed` 消息，不影响 ack 与 DONE 延迟队列
- [ ] `collectFreshAndTrack` 仍正确追踪 messageId 归属会话
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T4
- 后续任务: 无

---

## T6: stream-text 端点与飞书流式通道

### 背景

实现 S11 服务端：`POST /api/stream-text` 承载 SDK 主用户私聊流式输出（F4.1–F4.3），支持同一条 outbound 持续更新；飞书 PATCH POC 不可行时段落分段 + 节流降级。更新 `SessionProgressState.outboundMessageId`/`streamId`。

### 上下文文件

- CodeGraph: `LarkSender sendMessage replyMessage` — 飞书发送与 reply 链
- 必读: `src/daemon.ts` — `/api/send-text`（L1461–1488）作发送模式参考；T4 的 `SessionProgressState`
- 必读: `src/shared/lark-core.ts` — `LarkSender.sendMessage`、`replyMessage`
- 必读: `src/wechat-manager.ts` — T2 typing API；流式分段发送时 **不** 每条触发 cancelTyping

### 实现范围

- 修改: `src/daemon.ts`
  - 新增 `POST /api/stream-text` 路由（入参/出参见设计 §四：`session_key`、`text`、`stream_id?`、`outbound_message_id?`、`final?`）
  - 首包：创建 outbound 消息（飞书 `sendMessage`/微信 `sendText`），记录 `outbound_message_id` 到 `SessionProgressState`
  - 后续包：飞书尝试 PATCH 更新 content；失败则按段落 + 节流（默认 500–1500ms 可配置，NF6）分段 `sendMessage`
  - `final: true` 时标记流结束（停止指示留给 T8 统一处理或与 T8 衔接）
- 修改: `src/shared/lark-core.ts`
  - 新增 `updateMessageContent(messageId, text)` 或等价 PATCH 封装；POC 验证限流与可行性（工程补充验收项 1）
  - PATCH 不可行时 documented fallback：分段发送

### 接口契约

- `POST /api/stream-text` 请求体：`{ session_key, text, stream_id?, outbound_message_id?, final? }`
- 响应：`{ ok, stream_id?, outbound_message_id?, error? }`；400 缺参；通道不可达 `{ ok: false, error }`
- `LarkSender.updateMessageContent(messageId: string, text: string): Promise<boolean>` — PATCH 或 false 触发降级

### 验收标准

- [ ] Feishu PATCH POC：验证单条消息 content 更新可行性；不可行则默认分段策略（工程补充验收项 1）
- [ ] SDK 主用户私聊场景：长回复首段 10 秒内可见（01 验收 6、NF2）
- [ ] 不支持单条更新时，10 秒内以分段呈现首段（01 验收 7、F4.3）
- [ ] 流式更新节流可配置，无明显刷屏（NF6、工程补充验收项 3）
- [ ] CLI/群聊调用 stream-text 可拒绝或 no-op，不破坏既有 `/api/send-text`（F4.4、01 验收 8）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2、T4
- 后续任务: T7、T8

---

## T7: SDK 流式桥接与错误 notify

### 背景

实现 S11 SDK 侧：`handleSdkEvent` 将 assistant text delta 桥接到 `/api/stream-text`；`streamRunEvents` 异常与 status ERROR 时 `notifyChat` 用户可见说明（S12 部分，对齐 `handleSessionClosed` 模式）。

### 上下文文件

- CodeGraph: `handleSdkEvent streamRunEvents launchSdkAgent appendSdkLog` — SDK 事件流
- 必读: `electron/agent-sdk.ts` — `handleSdkEvent`（L126–151）、`streamRunEvents`（L107–124）、`launchSdkAgent`（L198+）
- 必读: `electron/session-dispatcher.ts` — `notifyChat`（L40–48）、`handleSessionClosed`（L100+）错误 notify 模式
- 必读: `electron/session-dispatcher.ts:77` — `isMainUser`；launch 路径中的 `chatType`、`resource.type`

### 实现范围

- 修改: `electron/agent-sdk.ts`
  - 在 `SdkSessionAgent` 增加流式桥接状态：`streamBuffer`、`outboundMessageId?`、`streamId?`（或复用 session 级字段）
  - `handleSdkEvent` 的 `assistant`/`text` 分支：当 `f41Eligible`（`isMainUser && chatType==='p2p' && resource.type==='sdk'`）时，累积全文并节流 POST `http://127.0.0.1:{port}/api/stream-text`；首包不带 `outbound_message_id`，后续带上
  - `streamRunEvents` 正常结束：发送 `final: true` 的最后一包
  - `streamRunEvents` catch 与 `status` ERROR/EXPIRED/CANCELLED：调用 `notifyChat` 发送用户可理解失败说明（工程补充验收项 4）；不泄露 stack/tool 名
  - 非 f41Eligible（CLI、群聊）：保持现有 `appendSdkLog`/一次性 send-text 路径，不调用 stream-text（F4.4）

### 接口契约

- 内部：`postStreamText(session, payload)` — HTTP 调用 daemon `/api/stream-text`
- `f41Eligible(session): boolean` — 主用户私聊 SDK 判定（可内联）

### 验收标准

- [ ] 主用户私聊 SDK 至少 3 次长回复：10 秒内首段可见，终态无实质信息缺失（01 验收 6）
- [ ] CLI/群聊不走 stream-text，仍一次性回复（01 验收 8 不适用项明确）
- [ ] 模拟 stream 异常与 status ERROR：用户收到可理解说明（工程补充验收项 4）
- [ ] assistant delta 不在 UI 日志重复刷屏；tool/thinking 不泄露给用户（F3.4）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T6
- 后续任务: T8

---

## T8: 完成与异常路径停止进行中指示

### 背景

实现 S12：`ackOnReply`、`/api/stream-text` 的 `final: true`、SDK/Agent 失败时统一调用 `stopSessionProgress`，确保 typing/表情在任务完成或异常后 5 秒内停止（F2.2、NF3）。

### 上下文文件

- CodeGraph: `ackOnReply send-text stopSessionProgress` — 完成确认链
- 必读: `src/daemon.ts` — `ackOnReply`（L444–453）、`/api/send-text`（L1461–1488）、T4 的 `stopSessionProgress`
- 必读: `src/wechat-manager.ts` — T2 的 `stopProgressTyping`
- 参考: T6 `/api/stream-text` 的 `final` 分支；T7 SDK 错误路径

### 实现范围

- 修改: `src/daemon.ts`
  - `ackOnReply`：在 ack 成功后调用 `stopSessionProgress(sessionKey)`（保留 `enqueuePendingDone` 逻辑）
  - `/api/send-text`：Agent 最终回复发送成功后停止进行中指示（若 session_key 存在）
  - `/api/stream-text`：`final: true` 时调用 `stopSessionProgress`
  - 确保 `/api/send-image`、`/api/send-file` 等等价完成路径亦停止指示
  - 异常/超时兜底：会话 Map 条目泄漏防护（可选 TTL 或 ack 时强制 clear）

### 接口契约

- 沿用 T4 的 `stopSessionProgress(sessionKey: string): void`
- 完成路径：`ackOnReply` → `stopSessionProgress`；stream `final` → `stopSessionProgress`

### 验收标准

- [ ] 任务成功完成后 5 秒内微信 typing 消失、飞书进行中反馈停止（01 验收 5 后半、NF3）
- [ ] 模拟 Agent 启动失败或处理中断：5 秒内停止所有进行中指示 + 用户收到失败说明（01 验收 9）
- [ ] 流式 `final` 与 `ackOnReply` 均触发停止，不重复也不遗漏
- [ ] 微信 `sendText` 发送最终回复不再误杀由进度机管理的 typing（依赖 T2）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2、T4、T6、T7
- 后续任务: 无

---

## T-Rev1-01: 飞书 CardKit 流式 API 封装

### 背景

Rev1：验收第 1 轮飞书+SDK 流式出现多条半幅递增消息，根因 `im.message.patch` + 分段不稳定。改为飞书官方 CardKit 流式卡片（`streaming_mode` + `card_id` + 流式更新文本 API），在 `lark-core` 封装 OpenAPI 调用供 daemon 使用。

### 上下文文件

- 必读: `src/shared/lark-core.ts` — 现有 `LarkSender`、`updateMessageContent`（PATCH fallback 保留）
- 必读: `02-design.md` §四 CardKit 流式六步、`07-prd-revisions.md` Rev1
- 参考: 飞书 CardKit OpenAPI — 创建卡片、发 interactive 消息、流式更新元素、`cardkit:card:write` 权限

### 实现范围

- 修改: `src/shared/lark-core.ts`
  - `createStreamingCardEntity(): Promise<{ cardId: string; elementId: string } | null>` — 创建 `streaming_mode: true` 卡片，固定 `element_id`（如 `stream_content`）
  - `sendStreamingCardMessage(chatId, cardId): Promise<string | null>` — `im.message.create` 引用 `card_id`，返回 `message_id`
  - `updateStreamingCardText(cardId, elementId, text, sequence): Promise<boolean>` — 流式更新文本 API，`sequence` 递增
  - `closeStreamingCardMode(cardId): Promise<boolean>` — `final` 时关闭 `streaming_mode`
  - 经 `client.request` 直调 CardKit OpenAPI（SDK 可能无 cardkit 模块）
  - 任一步失败返回 `false`/`null`，供上层降级 PATCH/分段

### 接口契约

- `createStreamingCardEntity(): Promise<{ cardId: string; elementId: string } | null>`
- `sendStreamingCardMessage(chatId: string, cardId: string): Promise<string | null>` — outbound `message_id`
- `updateStreamingCardText(cardId: string, elementId: string, text: string, sequence: number): Promise<boolean>`
- `closeStreamingCardMode(cardId: string): Promise<boolean>`

### 验收标准

- [ ] 飞书应用已开通 `cardkit:card:write`；CardKit 四步 API 可独立调用
- [ ] 单条消息 + 打字机效果：创建→发消息→多次 sequence 更新→关闭 streaming 后内容完整
- [ ] 任一步 API 失败返回 false/null，不抛未捕获异常，便于 daemon 降级
- [ ] 无 `02`/`03` 未要求的抽象层或未批准的新依赖

### 依赖

- 前置任务: 无（Rev1 独立修复）
- 后续任务: T-Rev1-02

---

## T-Rev1-02: daemon stream-text 接入 CardKit

### 背景

Rev1：将 `/api/stream-text` 飞书路径从 PATCH 首选改为 CardKit 流式卡片首选；扩展 `SessionProgressState` 追踪 `cardId`/`elementId`/`cardSequence`；CardKit 失败降级现有 PATCH/分段；微信路径不变。

### 上下文文件

- 必读: `src/daemon.ts` — `handleStreamText`、`SessionProgressState`、`sessionProgressMap`
- 必读: T-Rev1-01 产出的 CardKit 四函数
- 必读: `src/AGENTS.md` — stream-text 与进度状态说明（须同步 CardKit 路径）
- 参考: `02-design.md` §四 CardKit 流式、`§五` SessionProgressState 扩展

### 实现范围

- 修改: `src/daemon.ts`
  - `SessionProgressState` 增 `cardId?`、`elementId?`、`cardSequence?`
  - 飞书首包：调用 `createStreamingCardEntity` → `sendStreamingCardMessage`，写入 state
  - 后续包：`updateStreamingCardText`，`cardSequence` 递增
  - `final: true`：`closeStreamingCardMode` + 停止进行中指示（与 T8 衔接）
  - CardKit 任一步失败 → fallback `updateMessageContent` PATCH 或 `sendStreamSegments` 分段
- 修改: `src/AGENTS.md` — 文档化 CardKit 首选与 fallback 行为

### 接口契约

- `SessionProgressState` 扩展字段见设计 §五
- `POST /api/stream-text` 行为不变（入参/出参契约不变）；飞书内部实现切换为 CardKit 首选

### 验收标准

- [ ] 飞书 SDK 主用户私聊长回复：单条消息持续更新，无多条半幅递增刷屏（复验 08-verify-issue 第 1 轮场景）
- [ ] CardKit 全链路打字机效果；`final` 后 streaming 关闭、内容完整（F4.2、F4.5）
- [ ] 模拟 CardKit 失败（如权限缺失）：正确降级 PATCH/分段，10 秒内首段可见（F4.3）
- [ ] 微信路径行为与 Rev1 前一致，无回归
- [ ] `src/AGENTS.md` 与实现一致

### 依赖

- 前置任务: T-Rev1-01
- 后续任务: 无（联调 T-Rev1-03）

---

## T-Rev1-03: SDK 流式推送串行化

### 背景

Rev1：验收归因指出 `flushStreamPost` 使用 `void flushStreamPost` 未串行，并发 stream-text 请求均命中 `isFirst` 导致多条 outbound。须 in-flight chain 串行 await，可选略调节流间隔。

### 上下文文件

- 必读: `electron/agent-sdk.ts` — `scheduleStreamPost`、`flushStreamPost`、`appendStreamDelta`
- 必读: `08-verify-issue.md` 第 1 轮「实现链路」归因
- 必读: `electron/AGENTS.md` — SDK 流式桥接说明（须同步串行化语义）

### 实现范围

- 修改: `electron/agent-sdk.ts`
  - `flushStreamPost` 改为 in-flight promise chain：每次 POST 前 await 上一包完成，避免并发首包
  - `scheduleStreamPost` 调度仍节流，但 flush 须串行；可选将默认间隔从 400ms 略调（如 500–800ms）配合 NF6
  - 确保 `final: true` 在 chain 末尾发出，不与其他包并发
- 修改: `electron/AGENTS.md` — 文档化串行推送与节流策略

### 接口契约

- 内部：`streamPostChain: Promise<void>` 或等价 in-flight 链；无新增公开 API

### 验收标准

- [ ] 快速 delta 场景下仅一条 outbound 首包（配合 T-Rev1-02 CardKit 或 PATCH fallback）
- [ ] `final` 包在最后一次更新之后发出，无乱序
- [ ] CLI/群聊非 f41Eligible 路径无行为变化
- [ ] `electron/AGENTS.md` 与实现一致

### 依赖

- 前置任务: 无（可与 T-Rev1-01 并行；验收联调依赖 T-Rev1-02）
- 后续任务: 无

