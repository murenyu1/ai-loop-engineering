import { createPlugin } from '../dsh/client/index.mjs';

/** Use the same lazy CommonJS module format as DSH 0.2.1-rc.2's own clients. */
export function buildDshClient() {
  return `window.__ModuleLoader__.load({\n  id: "dsh-plugin-ai-loop-engineering",\n  factory: ${createPlugin.toString()}\n});\n`;
}
