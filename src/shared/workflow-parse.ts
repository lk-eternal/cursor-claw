import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { WorkflowDefinition } from "./workflow-types.js";
import { normalizeWorkflowDefinition } from "./workflow-types.js";

function isJsonText(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

export function parseWorkflowDefinitionText(text: string, format?: "json" | "yaml"): WorkflowDefinition {
  const useJson = format === "json" || (format !== "yaml" && isJsonText(text));
  const raw = useJson
    ? (JSON.parse(text) as WorkflowDefinition)
    : (YAML.parse(text) as WorkflowDefinition);
  return normalizeWorkflowDefinition(raw);
}

export function parseWorkflowDefinitionFile(filePath: string): WorkflowDefinition {
  const text = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  const format = ext === ".yaml" || ext === ".yml" ? "yaml" : ext === ".json" ? "json" : undefined;
  return parseWorkflowDefinitionText(text, format);
}
