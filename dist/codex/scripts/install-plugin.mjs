import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUNDLE, assert, rootPath, safePath, jsonFile, atomicWrite, codexExecutable, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { userHome } from './profiles.mjs';
import { digest } from './memory-store.mjs';
import { inspectWindows } from './windows.mjs';

export function installPlugin(project, options = {}) {
  const root = rootPath(project), home = rootPath(options.home || userHome());
  const source = fs.existsSync(path.join(BUNDLE,'bundle.json')) ? BUNDLE : safePath(BUNDLE, 'dist/codex');
  const lock = jsonFile(safePath(source, 'bundle.json'));
  const marketplace = 'plugins/local/ai-loop-engineering';
  const location = `${marketplace}/plugins/ai-loop-engineering`;
  const previousLock = safePath(home, `${location}/bundle.json`);
  const previous = fs.existsSync(previousLock) ? jsonFile(previousLock) : null;
  if (!previous && fs.existsSync(safePath(home, location))) assert(fs.readdirSync(safePath(home, location)).length === 0, '本地插件目录已有未登记内容，停止覆盖');
  for (const item of previous?.files || []) {
    const target = safePath(home, `${location}/${item.path}`);
    assert(fs.existsSync(target) && digest(fs.readFileSync(target)) === item.hash, '已安装本地插件被修改或丢失，停止覆盖：' + item.path);
  }
  const changes = [];
  const owned = new Set([...lock.files.map(item => item.path), 'bundle.json']);
  const removed = (previous?.files || []).filter(item => !owned.has(item.path)).map(item => safePath(home, `${location}/${item.path}`));
  const stage = (relative, content) => {
    const target = safePath(home, relative);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) changes.push({ path: target, content });
  };
  for (const item of [...lock.files, { path: 'bundle.json' }]) {
    const content = fs.readFileSync(safePath(source, item.path));
    assert(!item.hash || digest(content) === item.hash, '插件产物摘要不符：' + item.path);
    stage(`${location}/${item.path}`, content);
  }
  const marketplaceFile = `${marketplace}/.agents/plugins/marketplace.json`;
  const metadata = jsonFile(fs.existsSync(path.join(BUNDLE,'marketplace.json')) ? path.join(BUNDLE,'marketplace.json') : safePath(BUNDLE,'codex/marketplace.json'));
  metadata.plugins[0].source.path = './plugins/ai-loop-engineering';
  const marketplaceContent = Buffer.from(JSON.stringify(metadata, null, 2)+'\n');
  const existing = safePath(home, marketplaceFile);
  if(fs.existsSync(existing)) {
    const before = jsonFile(existing);
    const expected = structuredClone(metadata);
    if (previous && before.plugins?.length === 1 && before.plugins[0].version === previous.version) expected.plugins[0].version = previous.version;
    assert(JSON.stringify(before) === JSON.stringify(expected), '本地市场内容被修改，先合并，不覆盖');
  }
  stage(marketplaceFile, marketplaceContent);
  if (!options.apply) return { status: 'dry-run', changes: changes.map(item => item.path), removed, native_commands: ['codex plugin marketplace add LOCAL_MARKETPLACE --json', 'codex plugin add ai-loop-engineering@ai-loop-engineering --json'], scope: 'global-user', settings_json: 'unchanged' };
  const owners = inspectWindows(root, { home, purpose: 'configure' });
  assert(['ready', 'not-windows'].includes(owners.status), '所有者预检未通过；请在正常用户宿主进程安装插件，不在沙箱账户下写入受保护配置');
  for (const item of changes) atomicWrite(item.path, item.content);
  for (const file of removed) fs.unlinkSync(file);
  const run = argv => {
    const result = spawnSync(codexExecutable(), ['plugin', ...argv, '--json'], { cwd: root, encoding: 'utf8', timeout: 60000, shell: false, windowsHide: true });
    assert(result.status === 0, 'Codex 原生插件安装失败：' + (result.error?.message || result.stderr?.trim() || result.stdout?.trim()));
    return JSON.parse(result.stdout);
  };
  const registered = run(['marketplace', 'add', safePath(home, marketplace)]);
  const installed = run(['add', 'ai-loop-engineering@ai-loop-engineering']);
  return { status: 'native-install-returned', version: lock.version, marketplace: registered, installed, loading: 'unverified-until-new-session', settings_json: 'unchanged', next: '新会话核对 ai-loop / ai-loop-models 技能发现；按实际插件路径配置全局原生角色' };
}
export function cli(argv) {
  const options = args(argv); allowArgs(options, ['project', 'apply', 'help']);
  assert(!options._.length && (options.apply === undefined || options.apply === true), '参数无效');
  if (options.help) return { usage: 'install-plugin.mjs --project ROOT [--apply]', note: '先 build-plugin；默认预演。实际安装调用原生 CLI 注册用户级本地市场并安装，不编辑安装缓存或 settings.json。' };
  return installPlugin(options.project, options);
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
