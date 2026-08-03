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
      throw new Error(`提交失败 (${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`)
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
