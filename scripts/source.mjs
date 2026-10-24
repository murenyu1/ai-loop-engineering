import fs from 'node:fs';
import path from 'node:path';
import {safePath} from './lib.mjs';
const common = new Set(['lib','loop','memory','memory-store','roles','activity','execution','dashboard','ui-theme','workflow-graph']);
const codex = new Set(['profiles','plugin','plugin-models','install-plugin','windows','codex-workspaces','native-settings','settings-server','native-models','workspaces','session-start','executable']);
const legacy = new Set(['install','models','routing','agents','doctor','adapters','toml','codex-models']);
export function sourceRelative(root, relative) {
  if (!fs.existsSync(path.join(root, 'core/scripts/lib.mjs'))) return relative;
  if (relative.startsWith('ui/')) return 'codex/' + relative;
  if (['WORKFLOW.md','MEMORY.md'].includes(relative) || relative.startsWith('agents/') || relative.startsWith('templates/')) return 'core/' + relative;
  const match = /^scripts\/([a-z-]+)\.mjs$/.exec(relative);
  if (match) {
    const name = match[1], prefix = common.has(name) ? 'core' : codex.has(name) ? 'codex' : legacy.has(name) ? 'adapters/project' : null;
    if (prefix) return prefix + '/' + relative;
  }
  return relative.startsWith('plugin/') ? 'codex/' + relative.slice(7) : relative;
}
export function runtimeContent(root, relative) {
  const source = sourceRelative(root, relative);
  let text = fs.readFileSync(safePath(root, source), 'utf8').replace(/\r\n/g, '\n');
  if (source !== relative && relative.endsWith('.mjs')) text = text.replace(/from '\.\.\/(?:\.\.\/){1,2}scripts\//g, "from './");
  if (relative === 'scripts/lib.mjs' && source !== relative) text += "\nexport { codexExecutable } from './executable.mjs';\nexport { sourceRelative, runtimeContent } from './source.mjs';\n";
  if (relative === 'scripts/workflow-graph.mjs' && source !== relative) text = text.replace(/from '\.\/workflow-graph\.mjs'/g, "from './workflow-graph.mjs'");
  return Buffer.from(text);
}
