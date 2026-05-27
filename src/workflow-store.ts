import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowDefinition, WorkflowInstance } from "./shared/workflow-types.js";

const APP_DATA_DIR = process.env.APP_DATA_DIR || "";
const WORKFLOW_DIR = path.join(APP_DATA_DIR, "workflows");
const DEFINITIONS_FILE = path.join(WORKFLOW_DIR, "definitions.json");
const INSTANCES_DIR = path.join(WORKFLOW_DIR, "instances");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch { /* ignore */ }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Definitions CRUD ─────────────────────────────────────

export function listDefinitions(): WorkflowDefinition[] {
  return readJsonSafe<WorkflowDefinition[]>(DEFINITIONS_FILE, []);
}

export function getDefinition(id: string): WorkflowDefinition | undefined {
  return listDefinitions().find((d) => d.id === id);
}

export function saveDefinition(def: WorkflowDefinition): void {
  const defs = listDefinitions();
  const idx = defs.findIndex((d) => d.id === def.id);
  if (idx >= 0) defs[idx] = def; else defs.push(def);
  writeJson(DEFINITIONS_FILE, defs);
}

export function deleteDefinition(id: string): boolean {
  const defs = listDefinitions();
  const idx = defs.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  defs.splice(idx, 1);
  writeJson(DEFINITIONS_FILE, defs);
  return true;
}

// ── Instances CRUD ───────────────────────────────────────

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
  if (!fs.existsSync(fp)) return false;
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
  } catch { return []; }
}

export function findActiveInstance(): WorkflowInstance | undefined {
  return listInstances().find((i) => i.status === "running" || i.status === "paused");
}
