import fs from "node:fs";
import path from "node:path";
import type { WorkflowDefinition, WorkflowNode } from "./shared/workflow-types.js";
import { getTemplateRoot } from "./shared/template-utils.js";

export const BUILTIN_WORKFLOW_ID = "builtin_feishu_dev_pipeline";

const EXAMPLE_DIR = path.join("workflow", "example");

interface WorkflowTemplateNode extends Omit<WorkflowNode, "prompt"> {
  prompt?: string;
  promptFile?: string;
}

interface WorkflowTemplateFile extends Omit<WorkflowDefinition, "nodes" | "createdAt" | "updatedAt"> {
  nodes: WorkflowTemplateNode[];
}

function loadExampleWorkflow(): WorkflowDefinition | null {
  const root = path.join(getTemplateRoot(), EXAMPLE_DIR);
  const manifestPath = path.join(root, "workflow.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as WorkflowTemplateFile;
  const nodes: WorkflowNode[] = raw.nodes.map((n) => {
    let prompt = n.prompt ?? "";
    if (n.promptFile) {
      const promptPath = path.join(root, n.promptFile);
      if (fs.existsSync(promptPath)) {
        prompt = fs.readFileSync(promptPath, "utf-8").trim();
      }
    }
    const { promptFile: _pf, prompt: _p, ...rest } = n;
    return { ...rest, prompt, maxRetries: rest.maxRetries ?? 2 };
  });

  return {
    id: raw.id || BUILTIN_WORKFLOW_ID,
    name: raw.name,
    description: raw.description,
    workingDirectory: raw.workingDirectory,
    config: raw.config,
    nodes,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function loadBuiltinWorkflows(): WorkflowDefinition[] {
  const example = loadExampleWorkflow();
  return example ? [example] : [];
}
