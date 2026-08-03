export function parseHubRepoUrl(url: string): { host: string; projectPath: string } | null {
  const t = (url || "").trim().replace(/\/+$/, "")
  if (!t) return null
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`)
    const projectPath = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "")
    if (!projectPath) return null
    return { host: u.origin, projectPath }
  } catch {
    return null
  }
}

function formatCommitError(status: number, body: string): string {
  if (status === 403) {
    try {
      const msg = JSON.parse(body).message as string | undefined
      if (msg?.includes("not allowed to push")) {
        return "无权限推送到 main 分支。请填写 Flow Hub 专用 Token（需 Maintainer 及以上权限），或联系管理员调整分支保护规则"
      }
    } catch { /* ignore */ }
    return `提交失败 (${status})：无权限，请检查 Hub Token 权限`
  }
  if (status === 404) {
    return `提交失败 (${status})：GitLab API 不存在，请更新到最新版本`
  }
  const snippet = body ? `: ${body.slice(0, 200)}` : ""
  return `提交失败 (${status})${snippet}`
}

export class GitLabFlowHubClient {
  defaultBranch = "main"

  constructor(
    private host: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json",
    }
  }

  async resolveProjectId(projectPath: string): Promise<number> {
    const enc = encodeURIComponent(projectPath)
    const res = await fetch(`${this.host}/api/v4/projects/${enc}`, { headers: this.headers() })
    if (!res.ok) throw new Error(`GitLab 项目不存在或无权限 (${res.status})`)
    const data = await res.json() as { id: number; default_branch?: string }
    if (data.default_branch?.trim()) this.defaultBranch = data.default_branch.trim()
    return data.id
  }

  async readRawFile(projectId: number, filePath: string): Promise<string | null> {
    const enc = encodeURIComponent(filePath)
    const res = await fetch(
      `${this.host}/api/v4/projects/${projectId}/repository/files/${enc}/raw?ref=${encodeURIComponent(this.defaultBranch)}`,
      { headers: this.headers() },
    )
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`读取 ${filePath} 失败 (${res.status})`)
    return res.text()
  }

  async commitFiles(
    projectId: number,
    message: string,
    files: { path: string; content: string; exists?: boolean }[],
  ): Promise<void> {
    const actions = files.map((f) => ({
      action: f.exists ? "update" as const : "create" as const,
      file_path: f.path,
      content: f.content,
    }))
    const res = await fetch(`${this.host}/api/v4/projects/${projectId}/repository/commits`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ branch: this.defaultBranch, commit_message: message, actions }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(formatCommitError(res.status, body))
    }
  }

  async fileExists(projectId: number, filePath: string): Promise<boolean> {
    const enc = encodeURIComponent(filePath)
    const res = await fetch(
      `${this.host}/api/v4/projects/${projectId}/repository/files/${enc}?ref=${encodeURIComponent(this.defaultBranch)}`,
      { headers: this.headers() },
    )
    return res.ok
  }
}
