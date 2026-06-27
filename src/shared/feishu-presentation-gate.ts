/**
 * 飞书全通道（私聊 + 群聊）抑制 tool/thinking 过程 CardKit；
 * assistant stream-text 不受影响，微信通道不适用本门控。
 */
export function isFeishuProcessPresentationSuppressed(
  channelType: string | undefined,
  eventKind: string,
): boolean {
  if (channelType !== "feishu") return false;
  return eventKind === "tool" || eventKind === "thinking";
}
