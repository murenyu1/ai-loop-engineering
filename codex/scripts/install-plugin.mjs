import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUNDLE, assert, rootPath, safePath, jsonFile, atomicWrite, codexExecutable, args, allowArgs, mainModule, printResult } from '../../scripts/lib.mjs';
import { userHome } from '../../scripts/profiles.mjs';
import { digest } from '../../scripts/memory-store.mjs';
import { inspectWindows } from '../../scripts/windows.mjs';

const HASH = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function validateBundle(lock, label) {
  assert(lock && typeof lock === 'object' && !Array.isArray(lock), `${label}清单格式无效`);
  assert(typeof lock.version === 'string' && lock.version.trim(), `${label}版本无效`);
  assert(Array.isArray(lock.files), `${label}文件清单无效`);
  const paths = new Set();
  const files = [];
  for (const item of lock.files) {
    assert(item && typeof item === 'object' && !Array.isArray(item), `${label}文件项格式无效`);
    assert(typeof item.path === 'string', `${label}文件路径无效`);
    const relative = item.path;
    const parts = relative.split('/');
    assert(parts.every(part => !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !WINDOWS_RESERVED.test(part)), `${label}文件路径含有不安全名称：${relative}`);
    safePath(BUNDLE, relative);
    assert(relative.toLowerCase() !== 'bundle.json', `${label}不能登记 bundle.json`);
    assert(HASH.test(item.hash), `${label}摘要无效：${relative}`);
    const key = relative.toLowerCase();
    assert(!paths.has(key), `${label}有重复路径：${relative}`);
    paths.add(key);
    files.push({ path: relative, hash: item.hash });
  }
  for (const relative of paths) {
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      assert(!paths.has(parts.slice(0, i).join('/')), `${label}文件路径互相冲突：${relative}`);
    }
  }
  return { version: lock.version, files };
}

function inspectParent(home, target, relative, label) {
  let parent = home;
  for (const part of path.relative(home, path.dirname(target)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    assert(!fs.existsSync(parent) || fs.statSync(parent).isDirectory(), `${label}父路径不是目录：${relative}`);
  }
}

function inspectTarget(home, relative, owned, label) {
  const target = safePath(home, relative);
  inspectParent(home, target, relative, label);
  if (fs.existsSync(target)) {
    assert(fs.statSync(target).isFile(), `${label}目标不是普通文件：${relative}`);
    assert(owned.has(relative.toLowerCase()), `${label}目标已有未登记文件，停止覆盖：${relative}`);
  }
  return target;
}

export function installPlugin(project, options = {}) {
  const root = rootPath(project), home = rootPath(options.home || userHome());
  const source = options.source ? rootPath(options.source) : fs.existsSync(path.join(BUNDLE, 'bundle.json')) ? BUNDLE : safePath(BUNDLE, 'dist/codex');
  const sourceLockPath = safePath(source, 'bundle.json');
  const lock = validateBundle(jsonFile(sourceLockPath), '插件包');
  const marketplace = 'plugins/local/ai-loop-engineering';
  const location = `${marketplace}/plugins/ai-loop-engineering`;
  const previousLock = safePath(home, `${location}/bundle.json`);
  const previous = fs.existsSync(previousLock) ? validateBundle(jsonFile(previousLock), '已安装插件') : null;
  const previousOwned = new Set([...(previous?.files || []).map(item => `${location}/${item.path}`.toLowerCase()), ...(previous ? [`${location}/bundle.json`] : [])]);
  const previousDirectory = safePath(home, location);
  if (!previous && fs.existsSync(previousDirectory)) assert(fs.readdirSync(previousDirectory).length === 0, '本地插件目录已有未登记内容，停止覆盖');
  for (const item of previous?.files || []) {
    const target = safePath(home, `${location}/${item.path}`);
    assert(fs.existsSync(target) && fs.statSync(target).isFile() && digest(fs.readFileSync(target)) === item.hash, '已安装本地插件被修改或丢失，停止覆盖：' + item.path);
  }

  const bundleContent = fs.readFileSync(sourceLockPath);
  const contents = new Map();
  for (const item of lock.files) {
    const content = fs.readFileSync(safePath(source, item.path));
    assert(digest(content) === item.hash, '插件产物摘要不符：' + item.path);
    contents.set(item.path, content);
  }
  const metadataPath = options.marketplaceMetadata
    ? path.resolve(options.marketplaceMetadata)
    : safePath(BUNDLE, fs.existsSync(path.join(BUNDLE, 'bundle.json')) ? 'marketplace.json' : 'codex/marketplace.json');
  const metadata = jsonFile(metadataPath);
  assert(Array.isArray(metadata.plugins) && metadata.plugins[0] && metadata.plugins[0].source, '本地市场清单无效');
  assert(metadata.plugins[0].version === lock.version, '插件包与本地市场版本不一致');
  metadata.plugins[0].source.path = './plugins/ai-loop-engineering';
  const marketplaceContent = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');

  const writes = [];
  const removals = (previous?.files || []).filter(item => !lock.files.some(next => next.path.toLowerCase() === item.path.toLowerCase())).map(item => `${location}/${item.path}`);
  for (const item of [...lock.files.map(file => ({ path: file.path, content: contents.get(file.path) })), { path: 'bundle.json', content: bundleContent }]) {
    const relative = `${location}/${item.path}`;
    const target = inspectTarget(home, relative, previousOwned, '本地插件');
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(item.content)) writes.push({ path: target, content: item.content });
  }
  for (const relative of removals) {
    const target = safePath(home, relative);
    assert(fs.existsSync(target) && fs.statSync(target).isFile(), '已登记旧文件缺失或不是普通文件，停止升级：' + relative);
  }
  const marketplaceFile = `${marketplace}/.agents/plugins/marketplace.json`;
  const existing = safePath(home, marketplaceFile);
  inspectParent(home, existing, marketplaceFile, '本地市场');
  if (fs.existsSync(existing)) {
    assert(fs.statSync(existing).isFile(), '本地市场目标不是普通文件，停止覆盖');
    const before = jsonFile(existing);
    const expected = structuredClone(metadata);
    if (previous && before.plugins?.length === 1 && before.plugins[0].version === previous.version) expected.plugins[0].version = previous.version;
    assert(JSON.stringify(before) === JSON.stringify(expected), '本地市场内容被修改，先合并，不覆盖');
  }
  if (!fs.existsSync(existing) || !fs.readFileSync(existing).equals(marketplaceContent)) writes.push({ path: existing, content: marketplaceContent });

  if (!options.apply) return { status: 'dry-run', changes: writes.map(item => item.path), removed: removals.map(relative => safePath(home, relative)), native_commands: ['codex plugin marketplace add LOCAL_MARKETPLACE --json', 'codex plugin add ai-loop-engineering@ai-loop-engineering --json'], scope: 'global-user', settings_json: 'unchanged' };
  const owners = inspectWindows(root, { home, purpose: 'configure' });
  assert(['ready', 'not-windows'].includes(owners.status), '所有者预检未通过；请在正常用户宿主进程安装插件，不在沙箱账户下写入受保护配置');
  for (const item of writes) atomicWrite(item.path, item.content);
  for (const file of removals) fs.unlinkSync(safePath(home, file));
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
