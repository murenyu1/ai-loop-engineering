import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_FILES } from './install.mjs';
import { BUNDLE, VERSION, assert, safePath, jsonFile, atomicWrite, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { digest } from './memory-store.mjs';

export const PLUGIN_FILES = [...new Set([...REQUIRED_FILES, 'scripts/profiles.mjs', 'scripts/plugin-models.mjs', 'scripts/plugin.mjs'])];
export function buildPlugin(output, options = {}) {
  const relative = output || 'plugins/ai-loop-engineering';
  const target = safePath(BUNDLE, relative);
  assert(!['scripts', 'agents', 'templates', 'plugin', 'tests'].some(name => relative === name || relative.startsWith(name + '/')), '输出不能覆盖源代码目录');
  const text = file => Buffer.from(fs.readFileSync(safePath(BUNDLE, file), 'utf8').replace(/\r\n/g, '\n'));
  const planned = new Map(PLUGIN_FILES.map(file => [file, text(file)]));
  const manifest = jsonFile(safePath(BUNDLE, 'plugin/plugin.json'));
  assert(manifest.version === VERSION, '插件版本与核心不一致');
  planned.set('plugin.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  planned.set('ROUTING.md', Buffer.from('# 插件原生代理调度\n\n模型与强度从 plugin-models.mjs status 读取；不在此复制个人配置。\n\n' + fs.readFileSync(safePath(BUNDLE, 'templates/routing.md'), 'utf8')));
  const compatibility = { name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author, skills: './skills/', ...manifest.extensions['com.openai'] };
  planned.set('.codex-plugin/plugin.json', Buffer.from(JSON.stringify(compatibility, null, 2) + '\n'));
  for (const name of ['ai-loop', 'ai-loop-models']) planned.set(`skills/${name}/SKILL.md`, text(`plugin/skills/${name}/SKILL.md`));
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
  return { status: options.check ? 'checked' : 'built', version: VERSION, output: target, files: planned.size, changed: changed.map(([file]) => file) };
}
export function cli(argv) {
  const options = args(argv); allowArgs(options, ['out', 'check', 'help']);
  assert(!options._.length && (options.check === undefined || options.check === true), '参数无效');
  if (options.help) return { usage: 'build-plugin.mjs [--out PROJECT_RELATIVE_DIRECTORY] [--check]' };
  return buildPlugin(options.out, options);
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
