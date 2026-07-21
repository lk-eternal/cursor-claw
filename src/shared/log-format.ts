/**
 * 日志全文落盘排查；UI 仅展示时缩短 sessionKey（对齐飞书卡片标签风格）。
 * 单一入口，避免写入侧分叉维护。
 */

/** 从完整 sessionKey 生成 UI 短标签（无项目名时的兜底） */
export function shortenSessionKeyForUi(sessionKey: string): string {
  const sk = sessionKey.trim()
  const proj = sk.match(/::project_([a-f0-9]+)/i)
  if (proj) return `📦 ${proj[1].slice(0, 8)}`

  const sep = sk.indexOf("::")
  if (sep >= 0) {
    const suffix = sk.slice(sep + 2)
    if (/[\\/]/.test(suffix)) {
      const base = suffix.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || suffix
      return `📂 ${base}`
    }
    if (suffix.startsWith("temp_")) return `⏳ temp:${suffix.slice(5, 13)}`
    if (suffix.startsWith("wf_")) return `⏳ wf:${suffix.slice(3, 11)}`
  }

  const chatPart = sk.includes("|") ? sk.slice(sk.indexOf("|") + 1) : sk
  const chat = (chatPart.split("::")[0] || chatPart).slice(0, 14)
  return `💬 ${chat}`
}

/**
 * 把日志正文里的长 sessionKey 收成短标签（其它内容不动）。
 * @param resolveLabel 可选：用会话页签/项目信息解析成「📦 名」等文案
 */
export function formatLogLineForUi(
  line: string,
  resolveLabel?: (sessionKey: string) => string | undefined,
): string {
  // 飞书 oc_/ou_/on_；微信 wxid_/wx_/@im.wechat/@chatroom
  const re = /(?:ch_[a-zA-Z0-9]+\|)?(?:(?:oc_|ou_|on_)[a-zA-Z0-9]+|(?:wxid_|wx_)[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+@(?:im\.wechat|chatroom))(?:::project_[a-f0-9]+|::[^\s\]]+)/gi
  return line.replace(re, (sk) => resolveLabel?.(sk) || shortenSessionKeyForUi(sk))
}

/** 将 Dashboard sessionTabs 的 label/kind 转成紧凑标签（图标 + 名，不含分支） */
export function cardLabelFromSessionTab(tab: {
  kind: string
  label: string
}): string {
  if (tab.kind === "project") {
    const name = tab.label.split(" · ")[0]?.trim() || tab.label
    return `📦 ${name}`
  }
  if (tab.kind === "main" || tab.kind === "dir") {
    const name = tab.label.replace("（主）", "").split(" · ")[0]?.trim() || tab.label
    return `📂 ${name}`
  }
  if (tab.kind === "temp") return `⏳ ${tab.label}`
  return tab.label
}
