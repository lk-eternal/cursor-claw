/** 模型展示名：id + variant 参数合成 CLI 风格 slug（与主进程 listSdkModels 的 label 规则一致） */
export function modelSlug(id?: string, paramsJson?: string): string {
  if (!id) return ""
  if (!paramsJson?.trim()) return id
  try {
    const params = JSON.parse(paramsJson) as { id: string; value: string }[]
    return id + params
      .filter((p) => p.value !== "false")
      .map((p) => (p.value === "true" ? `-${p.id}` : `-${p.value}`))
      .join("")
  } catch {
    return id
  }
}
