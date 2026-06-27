/** 工具 Presentation：shell 命令解析与 CardKit markdown 渲染 */

export const TOOL_LOG_DETAIL_MAX = 400;
export const TOOL_CARD_SHELL_OUTPUT_MAX = 800;

export interface ShellToolDetail {
  command: string;
  cwd?: string;
  output?: string;
}

export interface ToolShellPresentationFields {
  tool_shell_command: string;
  tool_shell_cwd?: string;
  tool_shell_output?: string;
}

function truncateText(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)} …(+${compact.length - max} chars)`;
}

/** 解析 shell 工具 args 中的 command / working_directory */
export function parseShellToolArgs(args: unknown): Pick<ShellToolDetail, "command" | "cwd"> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  const command = typeof rec.command === "string" ? rec.command.trim() : "";
  if (!command) return undefined;
  const cwd = typeof rec.working_directory === "string" ? rec.working_directory.trim() : "";
  return { command, cwd: cwd || undefined };
}

/** 解析 shell 工具 result 中的 stdout/stderr/output */
export function parseShellToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") {
    const text = result.trim();
    return text || undefined;
  }
  if (typeof result === "object") {
    const rec = result as Record<string, unknown>;
    const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
    const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
    const output = typeof rec.output === "string" ? rec.output : "";
    const combined = [stdout, stderr, output].filter((part) => part.trim()).join("\n").trim();
    if (combined) return combined;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function escapeCodeFenceContent(text: string): string {
  return text.replace(/```/g, "\\`\\`\\`");
}

function escapeFeishuMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\");
}

/** shell 工具 CardKit 正文：命令用 ```shell，输出用普通代码块 */
export function buildShellToolCardMarkdown(
  status: "started" | "completed" | "failed",
  detail: ShellToolDetail,
): string {
  const statusLabel = status === "completed" ? "已完成" : status === "failed" ? "失败" : "执行中…";
  const parts = ["🔧 **shell**", `状态：${statusLabel}`];
  if (detail.cwd?.trim()) {
    parts.push(`目录：\`${detail.cwd.trim().replace(/`/g, "\\`")}\``);
  }
  parts.push(`\`\`\`shell\n${escapeCodeFenceContent(detail.command.trim())}\n\`\`\``);
  if (detail.output?.trim() && status !== "started") {
    const raw = detail.output.trim();
    const output = raw.length > TOOL_CARD_SHELL_OUTPUT_MAX
      ? `${raw.slice(0, TOOL_CARD_SHELL_OUTPUT_MAX)} …(+${raw.length - TOOL_CARD_SHELL_OUTPUT_MAX} chars)`
      : raw;
    parts.push(`\`\`\`\n${escapeCodeFenceContent(output)}\n\`\`\``);
  }
  return escapeFeishuMarkdown(parts.join("\n"));
}

/** SDK tool_call → presentation-event 的 shell 字段 */
export function extractShellPresentationFields(
  toolName: string,
  status: "running" | "completed" | "error",
  args?: unknown,
  result?: unknown,
): ToolShellPresentationFields | undefined {
  if (toolName !== "shell") return undefined;
  const parsed = parseShellToolArgs(args);
  if (!parsed?.command) return undefined;
  const fields: ToolShellPresentationFields = { tool_shell_command: parsed.command };
  if (parsed.cwd) fields.tool_shell_cwd = parsed.cwd;
  if (status !== "running") {
    const output = parseShellToolResult(result);
    if (output) fields.tool_shell_output = truncateText(output, TOOL_CARD_SHELL_OUTPUT_MAX);
  }
  return fields;
}

/** 日志单行：tool args/result 摘要 */
export function stringifyToolPayload(value: unknown, max = TOOL_LOG_DETAIL_MAX): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncateText(value, max);
  if (typeof value === "object") {
    const parsed = parseShellToolArgs(value);
    if (parsed) {
      const parts = [`command=${parsed.command}`];
      if (parsed.cwd) parts.push(`cwd=${parsed.cwd}`);
      return truncateText(parts.join(" "), max);
    }
    try {
      return truncateText(JSON.stringify(value), max);
    } catch {
      return truncateText(String(value), max);
    }
  }
  return truncateText(String(value), max);
}

export function formatToolCallLogSuffix(
  status: "running" | "completed" | "error",
  args?: unknown,
  result?: unknown,
  truncated?: { args?: boolean; result?: boolean },
): string {
  const parts: string[] = [];
  const argsText = stringifyToolPayload(args);
  if (argsText) parts.push(`args=${argsText}${truncated?.args ? " (truncated)" : ""}`);
  if (status !== "running") {
    const resultText = stringifyToolPayload(result);
    if (resultText) parts.push(`result=${resultText}${truncated?.result ? " (truncated)" : ""}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** 合并 event 与已缓存卡片的 shell 详情，供 PATCH 时使用 */
export function mergeShellToolDetail(
  event: ToolShellPresentationFields | undefined,
  cached?: Partial<Pick<ShellToolDetail, "command" | "cwd" | "output">>,
): ShellToolDetail | undefined {
  const command = event?.tool_shell_command?.trim() || cached?.command?.trim();
  if (!command) return undefined;
  return {
    command,
    cwd: event?.tool_shell_cwd?.trim() || cached?.cwd,
    output: event?.tool_shell_output?.trim() || cached?.output,
  };
}
