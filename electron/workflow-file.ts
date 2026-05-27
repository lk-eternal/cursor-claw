import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import type { WorkflowDefinition, WorkflowInstance } from "../src/shared/workflow-types"
import { builtinWorkflows } from "../src/builtin-workflows"

function workflowDir(): string {
  return path.join(app.getPath("userData"), "workflows")
}
function definitionsFile(): string {
  return path.join(workflowDir(), "definitions.json")
}
function instancesDir(): string {
  return path.join(workflowDir(), "instances")
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
  } catch { /* ignore */ }
  return fallback
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")
}

// ── Built-in seed ────────────────────────────────────────

export function seedBuiltins(): void {
  const defs = readJsonSafe<WorkflowDefinition[]>(definitionsFile(), [])
  const now = Date.now()
  let changed = false
  for (const b of builtinWorkflows) {
    if (!defs.some((d) => d.id === b.id)) {
      defs.push({ ...b, createdAt: b.createdAt || now, updatedAt: b.updatedAt || now })
      changed = true
    }
  }
  if (changed) writeJson(definitionsFile(), defs)
}

// ── Definitions ──────────────────────────────────────────

export function listDefinitions(): WorkflowDefinition[] {
  return readJsonSafe<WorkflowDefinition[]>(definitionsFile(), [])
}

export function getDefinition(id: string): WorkflowDefinition | undefined {
  return listDefinitions().find((d) => d.id === id)
}

export function saveDefinition(def: WorkflowDefinition): void {
  const defs = listDefinitions()
  const idx = defs.findIndex((d) => d.id === def.id)
  if (idx >= 0) defs[idx] = def; else defs.push(def)
  writeJson(definitionsFile(), defs)
}

export function deleteDefinition(id: string): boolean {
  const defs = listDefinitions()
  const idx = defs.findIndex((d) => d.id === id)
  if (idx < 0) return false
  defs.splice(idx, 1)
  writeJson(definitionsFile(), defs)
  return true
}

// ── Instances ────────────────────────────────────────────

function instancePath(id: string): string {
  return path.join(instancesDir(), `${id}.json`)
}

export function listInstances(): WorkflowInstance[] {
  ensureDir(instancesDir())
  try {
    return fs.readdirSync(instancesDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJsonSafe<WorkflowInstance | null>(path.join(instancesDir(), f), null))
      .filter(Boolean) as WorkflowInstance[]
  } catch { return [] }
}

export function getInstance(id: string): WorkflowInstance | undefined {
  return readJsonSafe<WorkflowInstance | undefined>(instancePath(id), undefined)
}

export function saveInstance(inst: WorkflowInstance): void {
  ensureDir(instancesDir())
  writeJson(instancePath(inst.id), inst)
}

export function deleteInstance(id: string): boolean {
  const fp = instancePath(id)
  if (!fs.existsSync(fp)) return false
  fs.unlinkSync(fp)
  return true
}
