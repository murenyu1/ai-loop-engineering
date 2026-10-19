import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROLES, validateProfile, nativeAgent, routeHash } from '../../../scripts/routing.mjs';
import { assert, rootPath, safePath, jsonFile, atomicWrite, locked, BUNDLE, sourceRelative } from '../../../scripts/lib.mjs';
import { inspectWindows } from '../../../scripts/windows.mjs';
import { rootString } from '../../../scripts/toml.mjs';

export const userHome = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function profileFile(project, scope, home) {
  const root = scope === 'global' ? rootPath(home) : rootPath(project);
  return { root, relative: scope === 'global' ? 'ai-loop/models.json' : '.ai-loop/models.json' };
}
export function resolveProfile(project, options = {}) {
  const home = options.home || userHome();
  const scopes = options.scope ? [options.scope] : ['project', 'global'];
  for (const scope of scopes) {
    assert(['project', 'global'].includes(scope), 'scope 须为 project / global');
    const location = profileFile(project, scope, home), target = safePath(location.root, location.relative);
    if (!fs.existsSync(target)) continue;
    const record = jsonFile(target);
    const profile = validateProfile(record.profile, 'codex');
    assert(record.schema_version === 1 && record.profile_hash === routeHash(profile), '模型配置摘要损坏，停止使用');
    const prefix = scope === 'global' ? 'agents' : '.codex/agents';
    const keys = Object.keys(ROLES).map(role => `${prefix}/loop-${role}.toml`);
    assert(record.native && Object.keys(record.native).length === keys.length && keys.every(key => /^[a-f0-9]{64}$/.test(record.native[key])), '原生模型文件登记格式无效，停止使用');
    return { ...record, profile, scope, path: target, effective_model: 'unverified' };
  }
  return { profile: null, scope: null, path: null, effective_model: 'unverified' };
}
export function configureProfile(project, profile, options = {}) {
  const scope = options.scope || 'global', home = options.home || userHome();
  assert(['project', 'global'].includes(scope), 'scope 须为 project / global');
  const location = profileFile(project, scope, home), root = location.root;
  profile = validateProfile(profile, 'codex');
  const target = safePath(root, location.relative);
  const previous = fs.existsSync(target) ? jsonFile(target) : null;
  if (previous) assert(previous.profile_hash === routeHash(validateProfile(previous.profile, 'codex')), '现有模型配置损坏，停止覆盖');
  const agentRoot = scope === 'global' ? 'agents' : '.codex/agents';
  const deployment = path.resolve(options.bundle || BUNDLE).split(path.sep).join('/');
  assert(fs.existsSync(safePath(deployment, sourceRelative(deployment, 'agents/loop-dev.md'))), '插件角色资料不存在');
  const instructionsRoot = sourceRelative(deployment, 'agents/loop-dev.md').startsWith('core/') ? deployment + '/core' : deployment;
  const changes = [], native = {};
  const nativeDirectory = safePath(root, agentRoot);
  if (fs.existsSync(nativeDirectory)) for (const name of fs.readdirSync(nativeDirectory).filter(name => name.endsWith('.toml'))) {
    const relative = `${agentRoot}/${name}`, target = safePath(root, relative);
    const role = rootString(fs.readFileSync(target, 'utf8'), 'name')?.value;
    if (role?.startsWith('loop-') && Object.hasOwn(ROLES, role.slice(5))) assert(name === `${role}.toml`, '角色名称被其他原生文件占用，先合并：' + relative);
  }
  const stage = (relative, content) => {
    const file = safePath(root, relative), before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (before !== content) changes.push({ file, relative, before, content });
  };
  for (const role of Object.keys(ROLES)) {
    const relative = `${agentRoot}/loop-${role}.toml`, file = safePath(root, relative);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const owned = previous?.native?.[relative];
    assert(before === null ? !owned : owned && hash(before) === owned, '原生角色未登记、被修改或缺失，停止覆盖：' + relative);
    const content = nativeAgent(profile, role, instructionsRoot);
    native[relative] = hash(content); stage(relative, content);
  }
  const record = { schema_version: 1, profile, profile_hash: routeHash(profile), native, bundle: deployment };
  stage(location.relative, JSON.stringify(record, null, 2) + '\n');
  if (options.apply && changes.length) {
    const info = inspectWindows(project, { home });
    assert(info.status === 'ready' || info.status === 'not-windows', 'Windows 所有者预检未通过，先修复后写入；不能在沙箱账户中创建受保护目录');
    locked(root, scope === 'global' ? 'global-models' : 'models', () => {
      for (const change of changes) assert((fs.existsSync(change.file) ? fs.readFileSync(change.file, 'utf8') : null) === change.before, '模型配置在预演期间变化，停止覆盖');
      const applied = [];
      try {
        for (const change of changes) {
          if (change.before !== null) atomicWrite(safePath(root, `${scope === 'global' ? 'ai-loop' : '.ai-loop'}/model-history/${crypto.randomUUID()}/${path.basename(change.file)}`), change.before);
          atomicWrite(change.file, change.content); applied.push(change);
        }
      } catch (error) {
        for (const change of applied.reverse()) if (change.before === null) fs.unlinkSync(change.file); else atomicWrite(change.file, change.before);
        throw error;
      }
    });
  }
  return { status: options.apply ? 'configured' : 'dry-run', scope, changes: changes.map(change => change.file), profile, effective_model: 'unverified', applies_to: 'next-dispatch-after-native-reload', current_agents: 'unchanged', main_session: '主代理通过原生模型选择器设置；本命令不改 config.toml 或 settings.json', concurrency: '调度约束；不改全局平台并发限制' };
}
export function resetProjectProfile(project, options = {}) {
  const root = rootPath(project), record = resolveProfile(root, { ...options, scope: 'project' });
  if (!record.profile) return { status: 'unchanged', scope: 'project' };
  const metadataHash = hash(fs.readFileSync(record.path));
  const files = [...Object.entries(record.native), ['.ai-loop/models.json', null]];
  for (const [relative, expected] of files) {
    const target = safePath(root, relative);
    assert(fs.existsSync(target) && (expected === null || hash(fs.readFileSync(target)) === expected), '项目模型配置被修改或丢失；停止恢复默认：' + relative);
  }
  if (options.apply) {
    const owners = inspectWindows(root, { home: options.home || userHome() });
    assert(['ready', 'not-windows'].includes(owners.status), 'Windows 所有者检查未通过，先处理再撤销原生项目配置');
    locked(root, 'models', () => {
    // 只撤销本工具拥有的项目覆盖；先备份所有文件，再删除。
    const folder = `.ai-loop/model-history/reset-${crypto.randomUUID()}`;
    const originals = files.map(([relative, expected]) => {
      const target = safePath(root, relative), content = fs.readFileSync(target);
      assert(hash(content) === (expected === null ? metadataHash : expected), '撤销前配置变化，停止覆盖');
      atomicWrite(safePath(root, `${folder}/${path.basename(relative)}`), content);
      return { target, content };
    });
    const removed = [];
    try {
      for (const item of originals) { fs.unlinkSync(item.target); removed.push(item); }
    } catch (error) {
      for (const item of removed) atomicWrite(item.target, item.content);
      throw error;
    }
    });
  }
  return { status: options.apply ? 'reset' : 'dry-run', changes: files.map(([relative]) => relative), fallback: resolveProfile(root, { ...options, scope: 'global' }).profile, applies_to: 'next-dispatch-after-native-reload' };
}
