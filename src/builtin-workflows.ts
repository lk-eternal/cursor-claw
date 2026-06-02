import fs from "node:fs";
import path from "node:path";
import type { WorkflowDefinition } from "./shared/workflow-types.js";
import { getTemplateRoot } from "./shared/template-utils.js";
import { parseWorkflowDefinitionFile } from "./shared/workflow-parse.js";

export const BUILTIN_WORKFLOW_ID = "builtin_feishu_dev_pipeline";

const EXAMPLE_DIR = path.join("workflow", "example");

function loadExampleWorkflow(): WorkflowDefinition | null {
  const root = path.join(getTemplateRoot(), EXAMPLE_DIR);
  const yamlPath = path.join(root, "workflow.yaml");
  const jsonPath = path.join(root, "workflow.json");
  const filePath = fs.existsSync(yamlPath) ? yamlPath : fs.existsSync(jsonPath) ? jsonPath : null;
  if (!filePath) {
    return null;
  }

  const def = parseWorkflowDefinitionFile(filePath);
  return {
    ...def,
    id: def.id || BUILTIN_WORKFLOW_ID,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function loadBuiltinWorkflows(): WorkflowDefinition[] {
  const example = loadExampleWorkflow();
  return example ? [example] : [];
}
