import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROLES, validateProfile, nativeAgent, routeHash } from './routing.mjs';
import { roleEnabled } from './roles.mjs';
import { assert, rootPath, safePath, jsonFile, atomicWrite, locked, BUNDLE, sourceRelative } from './lib.mjs';
import { inspectWindows } from './windows.mjs';
import { rootString } from './toml.mjs';
import { workspaceEntryById, setWorkspaceRecordById, restoreWorkspaceRecordById } from './workspaces.mjs';
import { readCodexWorkspaces } from './codex-workspaces.mjs';

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
    assert([1, 2].includes(record.schema_version) && record.profile_hash === routeHash(profile), '模型配置摘要损坏，停止使用');
    const prefix = scope === 'global' ? 'agents' : '.codex/agents';
    const keys = Object.keys(ROLES).map(role => `${prefix}/loop-${role}.toml`);
    const active = Object.keys(ROLES).filter(role => roleEnabled(profile.roles[role])).map(role => `${prefix}/loop-${role}.toml`);
    const allowed = new Set(keys);
    assert(record.native && Object.keys(record.native).every(key => allowed.has(key) && /^[a-f0-9]{64}$/.test(record.native[key])) && active.every(key => record.native[key]), '原生模型文件登记格式无效，停止使用');
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
  if (previous) assert([1, 2].includes(previous.schema_version) && previous.profile_hash === routeHash(validateProfile(previous.profile, 'codex')), '现有模型配置损坏，停止覆盖');
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
    if (!roleEnabled(profile.roles[role])) {
      if (owned) {
        assert(before !== null && hash(before) === owned, '已登记的原生角色被修改或缺失，停止覆盖：' + relative);
        native[relative] = owned;
      }
      continue;
    }
    assert(before === null ? !owned : owned && hash(before) === owned, '原生角色未登记、被修改或缺失，停止覆盖：' + relative);
    const content = nativeAgent(profile, role, instructionsRoot);
    native[relative] = hash(content); stage(relative, content);
  }
  const record = { schema_version: 2, profile, profile_hash: routeHash(profile), native, bundle: deployment };
  stage(location.relative, JSON.stringify(record, null, 2) + '\n');
  if (options.apply && changes.length) {
    const info = inspectWindows(project, { home, purpose: 'configure' });
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
  const fallback = resolveProfile(root, { ...options, scope: 'global' }).profile;
  const metadataHash = hash(fs.readFileSync(record.path));
  const files = [...Object.entries(record.native), ['.ai-loop/models.json', null]];
  for (const [relative, expected] of files) {
    const target = safePath(root, relative);
    assert(fs.existsSync(target) && (expected === null || hash(fs.readFileSync(target)) === expected), '项目模型配置被修改或丢失；停止恢复默认：' + relative);
  }
  if (options.apply) {
    const owners = inspectWindows(root, { home: options.home || userHome(), purpose: 'configure' });
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
  return { status: options.apply ? 'reset' : 'dry-run', changes: files.map(([relative]) => relative), fallback, applies_to: 'next-dispatch-after-native-reload' };
}

export function resolveWorkspaceProfile(home, workspace) {
  const readMembers = () => workspace.roots.map(root => ({ root, profile_hash: resolveProfile(root, { home, scope: 'project' }).profile_hash ?? null }));
  const saved = workspaceEntryById(home, workspace.id);
  if (saved?.inherits_global === true) {
    const profile = resolveProfile(workspace.root, { home, scope: 'global' }).profile;
    const memberProfiles = readMembers();
    if (!profile) return { ...saved, profile: null, profile_hash: null, scope: 'global', workspace_id: workspace.id, migration: null, materialization_conflict: false, member_profiles: memberProfiles, actual_members: memberProfiles };
    const valid = validateProfile(profile, 'codex');
    return { ...saved, profile: valid, profile_hash: routeHash(valid), scope: 'global', workspace_id: workspace.id, migration: null, materialization_conflict: false, member_profiles: memberProfiles, actual_members: memberProfiles };
  }
  if (saved?.profile) {
    const valid = validateProfile(saved.profile, 'codex');
    assert(saved.profile_hash === routeHash(valid), '工作区模型配置摘要损坏，停止使用');
    const actualMembers = readMembers();
    const materializationConflict = !saved.inherits_global && saved.materialized_profiles && actualMembers.some(item => saved.materialized_profiles[item.root] !== item.profile_hash);
    return { ...saved, profile: valid, profile_hash: routeHash(valid), scope: 'project', workspace_id: workspace.id, materialization_conflict: Boolean(materializationConflict), actual_members: actualMembers, member_profiles: actualMembers, migration: null };
  }
  const members = readMembers().map(item => ({ ...item, ...resolveProfile(item.root, { home, scope: 'project' }) }));
  const hashes = [...new Set(members.map(item => item.profile_hash ?? null))];
  const conflict = hashes.length > 1;
  const sources = members.map((item, index) => ({ root: workspace.roots[index], profile: item.profile, profile_hash: item.profile_hash ?? null }));
  return {
    profile: conflict ? null : members[0]?.profile ?? null,
    profile_hash: conflict ? null : hashes[0] ?? null,
    scope: 'project', workspace_id: workspace.id,
    member_profiles: members.map(item => ({ root: item.root, profile_hash: item.profile_hash ?? null })),
    migration: { needed: !saved?.profile && members.some(item => item.profile), conflict, sources },
    materialization_conflict: false,
  };
}

function workspaceCurrent(home, expected) {
  const workspace = readCodexWorkspaces(home).workspaces.find(item => item.id === expected.id);
  assert(workspace, 'Codex 工作区已删除，停止保存配置');
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const roots = value => value.map(normalize).sort();
  assert(JSON.stringify(roots(workspace.roots)) === JSON.stringify(roots(expected.roots)), 'Codex 工作区成员目录已变化，停止保存配置');
  assert(!workspace.shared_roots?.length, '成员目录同时属于多个 Codex 工作区，停止保存配置');
  return workspace;
}

function workspaceMemberProfiles(home, workspace) {
  return workspace.roots.map(root => ({ root, profile_hash: resolveProfile(root, { home, scope: 'project' }).profile_hash ?? null }));
}

function memberProfilesHash(profiles) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return JSON.stringify(profiles.map(item => [normalize(item.root), item.profile_hash ?? null]).sort(([left], [right]) => left.localeCompare(right)));
}

function assertMemberProfiles(home, workspace, expected) {
  if (expected !== undefined) {
    assert(Array.isArray(expected) && expected.length === workspace.roots.length && expected.every(item => item && typeof item.root === 'string' && (item.profile_hash === null || /^[a-f0-9]{64}$/.test(item.profile_hash))), '工作区成员配置基线无效');
  }
  const baseline = expected ?? workspaceMemberProfiles(home, workspace);
  const expectedRoots = workspace.roots.map(root => process.platform === 'win32' ? root.toLowerCase() : root).sort();
  assert(JSON.stringify(baseline.map(item => process.platform === 'win32' ? item.root.toLowerCase() : item.root).sort()) === JSON.stringify(expectedRoots), '工作区成员配置基线与当前目录不一致');
  const actual = workspaceMemberProfiles(home, workspace);
  assert(memberProfilesHash(actual) === memberProfilesHash(baseline), '工作区成员配置在编辑期间发生变化，请重新读取后迁移');
  return baseline;
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function sameBytes(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

export function resetWorkspaceProfile(home, workspace, options = {}) {
  return locked(home, 'workspace-profile-reset', () => resetWorkspaceProfileTransaction(home, workspace, options));
}

function resetWorkspaceProfileTransaction(home, workspace, options = {}) {
  workspace = workspaceCurrent(home, workspace);
  if (options.expectedHash !== undefined) assert(workspace.registry_hash === options.expectedHash, '工作区配置在编辑期间变化，请重新读取后保存');
  const previous = workspaceEntryById(home, workspace.id);
  const backups = new Map(), after = new Map();
  for (const root of workspace.roots) {
    const current = resolveProfile(root, { home, scope: 'project' });
    resetProjectProfile(root, { ...options, home, apply: false });
    for (const relative of [...Object.keys(current.native || {}), ...(current.profile ? ['.ai-loop/models.json'] : [])]) {
      const file = safePath(root, relative);
      backups.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
    }
  }
  const applied = [];
  try {
    for (const root of workspace.roots) {
      resetProjectProfile(root, { ...options, home, apply: true });
      for (const file of backups.keys()) if (within(root, file)) after.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
      applied.push(root);
      options.onAfterMemberReset?.(root, applied.length - 1);
    }
    workspaceCurrent(home, workspace);
    const global = resolveProfile(workspace.root, { home, scope: 'global' }).profile;
    const next = { ...previous, id: workspace.id, roots: workspace.roots, enabled: previous?.enabled ?? workspace.enabled ?? false, inherits_global: true };
    if (global) { next.profile = global; next.profile_hash = routeHash(global); }
    else { delete next.profile; delete next.profile_hash; }
    delete next.materialized;
    delete next.materialized_profiles;
    options.onBeforeRegistryCommit?.();
    workspaceCurrent(home, workspace);
    const registry = setWorkspaceRecordById(home, next, { expectedHash: options.expectedHash ?? workspace.registry_hash });
    try { workspaceCurrent(home, workspace); }
    catch (error) {
      restoreWorkspaceRecordById(home, workspace.id, previous, { expectedRevision: registry.revision });
      throw error;
    }
    return { status: 'reset', workspace_id: workspace.id, roots: workspace.roots, registry, applies_to: 'next-dispatch-after-native-reload' };
  } catch (error) {
    const rollbackErrors = [];
    for (const root of applied.reverse()) for (const [file, content] of backups) {
      if (!within(root, file)) continue;
      try {
        const current = fs.existsSync(file) ? fs.readFileSync(file) : null, expected = after.get(file);
        if (!after.has(file) || !sameBytes(current, expected)) throw new Error(`并发改动，保留文件：${file}`);
        if (content === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
        else atomicWrite(file, content);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) throw new Error(`${error.message}；回滚未完整：${rollbackErrors.join('；')}`, { cause: error });
    throw error;
  }
}

export function configureWorkspaceProfile(home, workspace, profile, options = {}) {
  return locked(home, 'workspace-profile-save', () => configureWorkspaceProfileTransaction(home, workspace, profile, options));
}

function configureWorkspaceProfileTransaction(home, workspace, profile, options = {}) {
  workspace = workspaceCurrent(home, workspace);
  if (options.expectedHash !== undefined) assert(workspace.registry_hash === options.expectedHash, '工作区配置在编辑期间变化，请重新读取后保存');
  const memberBaseline = assertMemberProfiles(home, workspace, options.expectedMemberProfiles);
  const scope = options.scope || 'project';
  assert(scope === 'project', '工作区配置只能保存到当前工作区范围');
  assert(workspace && typeof workspace.id === 'string' && Array.isArray(workspace.roots) && workspace.roots.length > 0, 'Codex 工作区无效');
  profile = validateProfile(profile, 'codex');
  const previous = workspaceEntryById(home, workspace.id);
  const before = new Map(), after = new Map();
  const previews = workspace.roots.map(root => configureProfile(root, profile, { ...options, home, scope: 'project', apply: false }));
  for (const root of workspace.roots) {
    const record = resolveProfile(root, { home, scope: 'project' });
    if (record.profile && previous?.profile_hash && !previous.inherits_global && record.profile_hash !== previous.profile_hash) assert(false, `成员目录 ${root} 的配置与工作区配置不一致，需先解决冲突`);
  }
  workspaceCurrent(home, workspace);
  for (const preview of previews) for (const file of preview.changes) {
    if (!before.has(file)) before.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  for (const root of workspace.roots) {
    const existing = resolveProfile(root, { home, scope: 'project' });
    for (const relative of [...Object.keys(existing.native || {}), ...(existing.profile ? ['.ai-loop/models.json'] : [])]) {
      const file = safePath(root, relative);
      if (!before.has(file)) before.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
    }
  }
  const applied = [], memberProfiles = {}, writtenMembers = new Set();
  try {
    for (let index = 0; index < workspace.roots.length; index++) {
      const root = workspace.roots[index];
      options.onBeforeMemberWrite?.(root, index);
      const expectedNow = memberBaseline.map(item => writtenMembers.has(item.root) ? { root: item.root, profile_hash: routeHash(profile) } : item);
      assertMemberProfiles(home, workspace, expectedNow);
      configureProfile(root, profile, { ...options, home, scope: 'project', apply: true });
      const rootRecord = resolveProfile(workspace.roots[index], { home, scope: 'project' });
      memberProfiles[workspace.roots[index]] = rootRecord.profile_hash ?? null;
      const materialized = {};
      for (const [relative, expected] of Object.entries(rootRecord.native || {})) {
        const file = safePath(workspace.roots[index], relative);
        materialized[`${workspace.roots[index]}\n${relative}`] = expected;
        after.set(file, fs.readFileSync(file));
      }
      const profileFilePath = safePath(workspace.roots[index], '.ai-loop/models.json');
      after.set(profileFilePath, fs.readFileSync(profileFilePath));
      applied.push({ root: workspace.roots[index], materialized });
      writtenMembers.add(root);
    }
    const enabled = options.enabled ?? previous?.enabled ?? workspace.enabled ?? false;
    options.onBeforeRegistryCommit?.();
    workspaceCurrent(home, workspace);
    assertMemberProfiles(home, workspace, workspace.roots.map(root => ({ root, profile_hash: routeHash(profile) })));
    const saved = setWorkspaceRecordById(home, {
      ...(previous || {}), id: workspace.id, roots: workspace.roots, enabled,
      profile, profile_hash: routeHash(profile), inherits_global: false,
      materialized: Object.assign({}, ...applied.map(item => item.materialized)),
      materialized_profiles: memberProfiles,
    }, { expectedHash: options.expectedHash ?? workspace.registry_hash, revision: options.revision });
    try { workspaceCurrent(home, workspace); }
    catch (error) {
      restoreWorkspaceRecordById(home, workspace.id, previous, { expectedRevision: saved.revision });
      throw error;
    }
    return { status: 'configured', scope, workspace_id: workspace.id, roots: workspace.roots, registry: saved, changes: [...before.keys()], effective_model: 'unverified', applies_to: 'next-dispatch-after-native-reload', current_agents: 'unchanged' };
  } catch (error) {
    const rollbackErrors = [];
    for (const [file, content] of [...after.entries()].reverse()) {
      try {
        const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (current === null || !current.equals(content)) throw new Error(`并发改动，保留文件：${file}`);
        const old = before.get(file);
        if (old === undefined || old === null) fs.unlinkSync(file);
        else atomicWrite(file, old);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) throw new Error(`${error.message}；回滚未完整：${rollbackErrors.join('；')}`, { cause: error });
    throw error;
  }
}
