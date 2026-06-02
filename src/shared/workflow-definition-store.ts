import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { WorkflowDefinition } from "./workflow-types.js";
import { normalizeWorkflowDefinition } from "./workflow-types.js";
import { parseWorkflowDefinitionFile, parseWorkflowDefinitionText } from "./workflow-parse.js";

const DEFINITIONS_SUBDIR = "definitions";
const LEGACY_DEFINITIONS_FILE = "definitions.json";

function definitionsDir(workflowDir: string): string {
  return path.join(workflowDir, DEFINITIONS_SUBDIR);
}

function definitionFilePath(workflowDir: string, id: string): string {
  return path.join(definitionsDir(workflowDir), `${id}.yaml`);
}

function ensureDefinitionsDir(workflowDir: string): void {
  const dir = definitionsDir(workflowDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function serializeDefinition(def: WorkflowDefinition): string {
  const payload = {
    id: def.id,
    name: def.name,
    description: def.description,
    workingDirectory: def.workingDirectory,
    config: def.config,
    nodes: def.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      prompt: n.prompt,
      maxRetries: n.maxRetries,
      ...(n.model ? { model: n.model } : {}),
      ...(n.isolated ? { isolated: n.isolated } : {}),
    })),
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
  return YAML.stringify(payload, { lineWidth: 0 });
}

function readDefinitionFile(filePath: string): WorkflowDefinition | null {
  try {
    return parseWorkflowDefinitionFile(filePath);
  } catch {
    return null;
  }
}

export function migrateLegacyDefinitionsJson(workflowDir: string): number {
  const legacyPath = path.join(workflowDir, LEGACY_DEFINITIONS_FILE);
  if (!fs.existsSync(legacyPath)) {
    return 0;
  }

  let migrated = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(legacyPath, "utf-8")) as WorkflowDefinition[];
    if (!Array.isArray(raw)) {
      return 0;
    }
    ensureDefinitionsDir(workflowDir);
    const now = Date.now();
    for (const item of raw) {
      const def = normalizeWorkflowDefinition({
        ...item,
        createdAt: item.createdAt || now,
        updatedAt: item.updatedAt || now,
      });
      const fp = definitionFilePath(workflowDir, def.id);
      if (!fs.existsSync(fp)) {
        fs.writeFileSync(fp, serializeDefinition(def), "utf-8");
        migrated++;
      }
    }
    const backup = `${legacyPath}.migrated`;
    if (!fs.existsSync(backup)) {
      fs.renameSync(legacyPath, backup);
    }
  } catch {
    return migrated;
  }
  return migrated;
}

export function listDefinitions(workflowDir: string): WorkflowDefinition[] {
  migrateLegacyDefinitionsJson(workflowDir);
  ensureDefinitionsDir(workflowDir);
  const dir = definitionsDir(workflowDir);
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => readDefinitionFile(path.join(dir, f)))
      .filter((d): d is WorkflowDefinition => d != null)
      .map((d) => normalizeWorkflowDefinition(d));
  } catch {
    return [];
  }
}

export function getDefinition(workflowDir: string, id: string): WorkflowDefinition | undefined {
  migrateLegacyDefinitionsJson(workflowDir);
  const fp = definitionFilePath(workflowDir, id);
  if (!fs.existsSync(fp)) {
    return undefined;
  }
  const def = readDefinitionFile(fp);
  return def ? normalizeWorkflowDefinition(def) : undefined;
}

export function saveDefinition(workflowDir: string, def: WorkflowDefinition): void {
  ensureDefinitionsDir(workflowDir);
  const normalized = normalizeWorkflowDefinition({
    ...def,
    updatedAt: Date.now(),
    createdAt: def.createdAt || Date.now(),
  });
  fs.writeFileSync(definitionFilePath(workflowDir, normalized.id), serializeDefinition(normalized), "utf-8");
}

export function deleteDefinition(workflowDir: string, id: string): boolean {
  const fp = definitionFilePath(workflowDir, id);
  if (!fs.existsSync(fp)) {
    return false;
  }
  fs.unlinkSync(fp);
  return true;
}

export function seedBuiltinDefinitions(
  workflowDir: string,
  builtins: WorkflowDefinition[],
): void {
  migrateLegacyDefinitionsJson(workflowDir);
  ensureDefinitionsDir(workflowDir);
  const now = Date.now();
  for (const b of builtins) {
    if (!getDefinition(workflowDir, b.id)) {
      saveDefinition(workflowDir, {
        ...b,
        createdAt: b.createdAt || now,
        updatedAt: b.updatedAt || now,
      });
    }
  }
}

export { parseWorkflowDefinitionText, parseWorkflowDefinitionFile };
