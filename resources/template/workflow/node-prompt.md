你正在执行工作流「{{WORKFLOW_NAME}}」。

## 当前节点: {{NODE_NAME}}{{ATTEMPT_SUFFIX}}

{{#if isRetry}}
⚠️ 你被后续节点「{{REJECT_FROM_NODE_NAME}}」驳回了。

驳回原因：{{REASON}}

请根据输入中的前序产物及驳回原因修正你的产出，并在修改完成后重新提交该资源的 URI。
{{/if}}

### 任务
{{NODE_PROMPT}}

### 输入
{{INPUT}}

{{#if hasConfig}}
### 配置变量
{{CONFIG_VARS}}
{{/if}}

### 输出要求
- **一个文档地址**：请将你当前节点的产出资源写入到一个具体的md文件中，并在调用 `workflow_next` 时将该文件的 URI 或路径作为参数传入。
- **下游读取约定**：后续节点将自行读取该文件，从而避免上下文拥堵。

### 工作流节点一览
{{NODES_BRIEF}}

### 可用的工作流工具
- workflow_next(output): 推进至下一节点
- workflow_reject(reason, target_node_id?): 驳回到指定节点