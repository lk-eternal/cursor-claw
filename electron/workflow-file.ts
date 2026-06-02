import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import type { WorkflowDefinition, WorkflowInstance } from "../src/shared/workflow-types"
import { loadBuiltinWorkflows } from "../src/builtin-workflows"
import {
  deleteDefinition as deleteDefinitionFile,
  getDefinition as getDefinitionFile,
  listDefinitions as listDefinitionsFiles,
  saveDefinition as saveDefinitionFile,
  seedBuiltinDefinitions,
} from "../src/shared/workflow-definition-store"

function workflowDir(): string {
  return path.join(app.getPath("userData"), "workflows")
}

function instancesDir(): string {
  return path.join(workflowDir(), "instances")
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
    }
  } catch { /* ignore */ }
  return fallback
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")
}

export function seedBuiltins(): void {
  seedBuiltinDefinitions(workflowDir(), loadBuiltinWorkflows())
}

export function listDefinitions(): WorkflowDefinition[] {
  return listDefinitionsFiles(workflowDir())
}

export function getDefinition(id: string): WorkflowDefinition | undefined {
  return getDefinitionFile(workflowDir(), id)
}

export function saveDefinition(def: WorkflowDefinition): void {
  saveDefinitionFile(workflowDir(), def)
}

export function deleteDefinition(id: string): boolean {
  return deleteDefinitionFile(workflowDir(), id)
}

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
  } catch {
    return []
  }
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
  if (!fs.existsSync(fp)) {
    return false
  }
  fs.unlinkSync(fp)
  return true
}
