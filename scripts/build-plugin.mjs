import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_FILES } from './install.mjs';
import { BUNDLE, VERSION, runtimeContent, assert, safePath, jsonFile, atomicWrite, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { digest } from './memory-store.mjs';

export const PLUGIN_FILES = [...new Set([...REQUIRED_FILES, ...['profiles','plugin-models','plugin','codex-workspaces','native-settings','settings-server','native-models','workspaces','session-start','install-plugin','ui-theme','workflow-graph'].map(name => 'scripts/'+name+'.mjs'), 'ui/agent-dashboard.html'])];
export function buildPlugin(output, options = {}) {
  const relative = output || 'dist/codex';
  const target = safePath(BUNDLE, relative);
  assert(relative === 'dist/codex' || relative.startsWith('.release/'), '输出仅允许 dist/codex 或 .release/ 下的验证目录，不能覆盖源代码');
  const text = file => runtimeContent(BUNDLE, file === 'ui/agent-dashboard.html' ? 'plugin/ui/agent-dashboard.html' : file);
  const planned = new Map(PLUGIN_FILES.map(file => [file, text(file)]));
  const manifest = JSON.parse(text('plugin/plugin.json').toString());
  assert(manifest.version === VERSION, '插件版本与核心不一致');
  planned.set('plugin.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  planned.set('ROUTING.md', text('plugin/ROUTING.md'));
  const compatibility = { name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author, skills: './skills/', hooks: './hooks/hooks.json', mcpServers: './.mcp.json', ...manifest.extensions['com.openai'] };
  planned.set('.codex-plugin/plugin.json', Buffer.from(JSON.stringify(compatibility, null, 2) + '\n'));
  for (const name of ['ai-loop', 'ai-loop-models']) planned.set(`skills/${name}/SKILL.md`, text(`plugin/skills/${name}/SKILL.md`));
  planned.set('mcp.json',text('plugin/mcp.json'));
  const mcp = JSON.parse(text('plugin/mcp.json'));
  delete mcp.$schema;
  for (const server of Object.values(mcp.mcpServers)) delete server.type;
  planned.set('.mcp.json',Buffer.from(JSON.stringify(mcp,null,2)+'\n'));
  planned.set('hooks/hooks.json',text('plugin/hooks/hooks.json'));
  planned.set('marketplace.json',text('plugin/marketplace.json'));
  planned.set('README.md',text('plugin/README.md'));
  const lock = { version: VERSION, files: [...planned].map(([file, content]) => ({ path: file, hash: digest(content) })).sort((a, b) => a.path.localeCompare(b.path)) };
  planned.set('bundle.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n'));
  const previousFile = path.join(target, 'bundle.json');
  const previous = fs.existsSync(previousFile) ? jsonFile(previousFile) : null;
  if (fs.existsSync(target) && !previous) assert(fs.readdirSync(target).length === 0, '输出目录已有未登记文件，停止覆盖');
  for (const item of previous?.files || []) {
    const file = safePath(target, item.path);
    assert(fs.existsSync(file) && digest(fs.readFileSync(file)) === item.hash, '旧插件产物被修改或缺失，停止覆盖：' + item.path);
  }
  const changed = [...planned].filter(([file, content]) => !fs.existsSync(safePath(target, file)) || !fs.readFileSync(safePath(target, file)).equals(content));
  if (options.check) assert(!changed.length, '插件产物与当前源包不一致，请重新构建');
  else for (const [file, content] of changed) atomicWrite(safePath(target, file), content);
  if (!options.check) for (const item of previous?.files || []) if (!planned.has(item.path)) fs.unlinkSync(safePath(target,item.path));
  return { status: options.check ? 'checked' : 'built', version: VERSION, output: target, files: planned.size, changed: changed.map(([file]) => file) };
}
export function cli(argv) {
  const options = args(argv); allowArgs(options, ['out', 'check', 'help']);
  assert(!options._.length && (options.check === undefined || options.check === true), '参数无效');
  if (options.help) return { usage: 'build-plugin.mjs [--out PROJECT_RELATIVE_DIRECTORY] [--check]' };
  return buildPlugin(options.out, options);
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
