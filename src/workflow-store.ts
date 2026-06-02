import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowDefinition, WorkflowInstance } from "./shared/workflow-types.js";
import { loadBuiltinWorkflows } from "./builtin-workflows.js";
import {
  deleteDefinition as deleteDefinitionFile,
  getDefinition as getDefinitionFile,
  listDefinitions as listDefinitionsFiles,
  saveDefinition as saveDefinitionFile,
  seedBuiltinDefinitions,
} from "./shared/workflow-definition-store.js";

const APP_DATA_DIR = process.env.APP_DATA_DIR || "";
const WORKFLOW_DIR = path.join(APP_DATA_DIR, "workflows");
const INSTANCES_DIR = path.join(WORKFLOW_DIR, "instances");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    }
  } catch { /* ignore */ }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function seedBuiltins(): void {
  if (!APP_DATA_DIR) {
    return;
  }
  seedBuiltinDefinitions(WORKFLOW_DIR, loadBuiltinWorkflows());
}

if (APP_DATA_DIR) {
  seedBuiltins();
}

export function listDefinitions(): WorkflowDefinition[] {
  return listDefinitionsFiles(WORKFLOW_DIR);
}

export function getDefinition(id: string): WorkflowDefinition | undefined {
  return getDefinitionFile(WORKFLOW_DIR, id);
}

export function saveDefinition(def: WorkflowDefinition): void {
  saveDefinitionFile(WORKFLOW_DIR, def);
}

export function deleteDefinition(id: string): boolean {
  return deleteDefinitionFile(WORKFLOW_DIR, id);
}

function instancePath(id: string): string {
  return path.join(INSTANCES_DIR, `${id}.json`);
}

export function getInstance(id: string): WorkflowInstance | undefined {
  return readJsonSafe<WorkflowInstance | undefined>(instancePath(id), undefined);
}

export function saveInstance(inst: WorkflowInstance): void {
  ensureDir(INSTANCES_DIR);
  writeJson(instancePath(inst.id), inst);
}

export function deleteInstance(id: string): boolean {
  const fp = instancePath(id);
  if (!fs.existsSync(fp)) {
    return false;
  }
  fs.unlinkSync(fp);
  return true;
}

export function listInstances(): WorkflowInstance[] {
  ensureDir(INSTANCES_DIR);
  try {
    return fs.readdirSync(INSTANCES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJsonSafe<WorkflowInstance | null>(path.join(INSTANCES_DIR, f), null))
      .filter(Boolean) as WorkflowInstance[];
  } catch {
    return [];
  }
}

export function findActiveInstance(): WorkflowInstance | undefined {
  return listInstances().find((i) => i.status === "running" || i.status === "paused");
}
