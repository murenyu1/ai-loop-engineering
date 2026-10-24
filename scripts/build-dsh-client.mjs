import { createPlugin } from '../dsh/client/index.mjs';
import { UI_THEME } from '../core/scripts/ui-theme.mjs';
import { createWorkflowGraph } from '../core/scripts/workflow-graph.mjs';

/** Use the same lazy CommonJS module format as DSH 0.2.1-rc.2's own clients. */
export function buildDshClient() {
  return `window.__ModuleLoader__.load({\n  id: "dsh-plugin-ai-loop-engineering",\n  factory: function(require) { return (${createPlugin.toString()})(require, ${JSON.stringify(UI_THEME)}, ${createWorkflowGraph.toString()}); }\n});\n`;
}
