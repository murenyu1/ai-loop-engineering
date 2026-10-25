import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexWorkspaces, resolveChatWorkspace } from '../codex/scripts/codex-workspaces.mjs';
import { registerWorkspace, setWorkspaceRecordById, workspaceEntryById } from '../scripts/workspaces.mjs';
import { createSettingsManager } from '../codex/scripts/native-settings.mjs';
import { startupContext } from '../codex/scripts/session-start.mjs';
import { resolveWorkspaceProfile, configureWorkspaceProfile, configureProfile, resetWorkspaceProfile, resolveProfile } from '../codex/scripts/profiles.mjs';
import { balanced, disabledProfile, routeHash } from '../scripts/routing.mjs';
import { createRequire } from 'node:module';

test('启用优先，各组按真实聊天最近活动排序且读取不写宿主状态', t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); }
  catch { t.skip('当前Node没有内置只读SQLite支持'); return; }
  const f = fixture(t);
  const c = path.join(f.parent, 'c'), d = path.join(f.parent, 'd');
  fs.mkdirSync(c); fs.mkdirSync(d);
  f.save({ 'project-order': ['b', 'a', 'd', 'c'], 'local-projects': {
    a: { rootPaths: [f.a], updatedAt: 999999 }, b: { rootPaths: [f.b] }, c: { rootPaths: [c] }, d: { rootPaths: [d] },
  }, 'thread-project-assignments': { moved: { projectKind: 'local', projectId: 'b' }, remote: { projectKind: 'remote', projectId: 'a' } } });
  registerWorkspace(f.home, f.a); registerWorkspace(f.home, f.b);
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, updated_at INTEGER, recency_at_ms INTEGER, archived INTEGER, has_user_event INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('a', f.a, 10, null, 0, 1); insert.run('b', f.b, 20, null, 0, 1);
  insert.run('c', c, 40, null, 0, 1); insert.run('d', d, 30, null, 0, 1);
  insert.run('archived', f.a, 9999, null, 1, 1); insert.run('agent', f.a, 8888, null, 0, 0);
  insert.run('remote', f.a, 7777, null, 0, 1);
  insert.run('moved', f.a, 50, 60000, 0, 1); db.close();
  const before = fs.readFileSync(f.stateFile);
  assert.deepEqual(readCodexWorkspaces(f.home).workspaces.map(row => [row.id, row.last_used_at]), [['b', 60000], ['a', 10000], ['c', 40000], ['d', 30000]]);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('无最近使用数据或数据库损坏时仍启用优先，组内保持宿主稳定顺序', t => {
  const f = fixture(t);
  f.save({ 'project-order': ['b', 'a'], 'local-projects': { a: { rootPaths: [f.a], updatedAt: 99999 }, b: { rootPaths: [f.b] } } });
  registerWorkspace(f.home, f.a);
  for (const broken of [false, true]) {
    if (broken) fs.writeFileSync(path.join(f.home, 'state_5.sqlite'), 'broken');
    assert.deepEqual(readCodexWorkspaces(f.home).workspaces.map(row => [row.id, row.last_used_at]), [['a', null], ['b', null]]);
  }
});

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-picker-'));
  const home = path.join(parent, 'home'), a = path.join(parent, 'a'), b = path.join(parent, 'b');
  for (const root of [home, a, b]) fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const stateFile = path.join(home, '.codex-global-state.json');
  return { parent, home, a, b, stateFile, save: state => fs.writeFileSync(stateFile, JSON.stringify(state)) };
}

test('按宿主项目 ID 合并全部目录，忽略旧活动根列表并保留启用状态', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } }, 'electron-saved-workspace-roots': [f.a, 'relative', path.join(f.parent, 'missing')], 'active-workspace-roots': [f.b] });
  registerWorkspace(f.home, f.a);
  const before = fs.readFileSync(f.stateFile);
  const result = readCodexWorkspaces(f.home);
  assert.equal(result.error, '');
  assert.equal(result.workspaces.length, 1);
  assert.deepEqual([result.workspaces[0].id, result.workspaces[0].label, result.workspaces[0].roots, result.workspaces[0].enabled], ['a', '项目甲', [f.a, f.b], true]);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('状态缺失、损坏或格式变化明确提示，不把历史登记冒充当前工作区', t => {
  const f = fixture(t);
  registerWorkspace(f.home, f.a, { enabled: false });
  assert.match(readCodexWorkspaces(f.home).error, /不存在/);
  for (const content of ['{broken', '{"local-projects":[]}', '{"local-projects":{"id":{"name":"a"}}}', '{}']) {
    fs.writeFileSync(f.stateFile, content);
    const result = readCodexWorkspaces(f.home);
    assert.match(result.error, /无法读取 Codex 工作区列表/);
    assert.equal(result.workspaces.length, 0);
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), content);
  }
});

test('空的local-projects是权威空列表，同名工作区按ID保留', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '同名', rootPaths: [f.a, f.b] }, b: { name: '同名', rootPaths: [f.b] } } });
  const result = readCodexWorkspaces(f.home);
  assert.deepEqual(result.workspaces.map(row => [row.id, row.label, row.roots.length]), [['a', '同名', 2], ['b', '同名', 1]]);
  f.save({ 'local-projects': {}, 'electron-saved-workspace-roots': [f.a] });
  assert.deepEqual(readCodexWorkspaces(f.home).workspaces, []);
});

test('聊天归属只使用真实thread-project-assignments', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a] } }, 'selected-project': 'a', 'thread-project-assignments': { thread: { projectKind: 'local', projectId: 'a' }, remote: { projectKind: 'remote', projectId: 'a' } } });
  assert.equal(resolveChatWorkspace(f.home, 'thread').id, 'a');
  assert.equal(resolveChatWorkspace(f.home, 'remote'), null);
  assert.equal(resolveChatWorkspace(f.home, 'unknown'), null);
});

test('启用状态按宿主工作区ID保存并包含全部成员根目录', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { id: { name: '甲', rootPaths: [f.a, f.b] } } });
  const saved = setWorkspaceRecordById(f.home, { id: 'id', roots: [f.a, f.b], enabled: true });
  assert.equal(saved.id, 'id');
  assert.deepEqual(workspaceEntryById(f.home, 'id').roots, [f.a, f.b]);
  const workspace = readCodexWorkspaces(f.home).workspaces[0];
  assert.equal(workspace.enabled, true);
  assert.deepEqual(workspace.roots, [f.a, f.b]);
});

test('不同工作区共享同一物理目录时阻止保存', t => {
  const f = fixture(t);
  setWorkspaceRecordById(f.home, { id: 'a', roots: [f.a], enabled: false });
  f.save({ 'local-projects': { a: { name: '甲', rootPaths: [f.a] }, b: { name: '乙', rootPaths: [f.a] } } });
  assert.throws(() => setWorkspaceRecordById(f.home, { id: 'b', roots: [f.a], enabled: true }), /同时属于多个/);
});

test('SessionStart按工作区ID读取集中profile，启用状态仍按成员目录校验', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } } });
  const oldProfile = disabledProfile('codex');
  fs.mkdirSync(path.join(f.a, '.ai-loop'));
  fs.writeFileSync(path.join(f.a, '.ai-loop', 'models.json'), JSON.stringify({ schema_version: 2, profile: oldProfile, profile_hash: routeHash(oldProfile), native: {} }));
  const profile = balanced('codex');
  setWorkspaceRecordById(f.home, { id: 'a', roots: [f.a, f.b], enabled: true, profile, profile_hash: routeHash(profile), inherits_global: false, materialized_profiles: { [f.a]: routeHash(oldProfile), [f.b]: null } });
  const output = startupContext({ hook_event_name: 'SessionStart', cwd: f.a, session_id: 'parent' }, { home: f.home });
  assert.match(output.hookSpecificOutput.additionalContext, /已开启角色：planner、reviewer、dev、tester、scribe/);
});

test('SessionStart严格跟随当前宿主ID与成员集合，删除或移除后不再注入', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } } });
  setWorkspaceRecordById(f.home, { id: 'a', roots: [f.a, f.b], enabled: true, profile: balanced('codex'), profile_hash: routeHash(balanced('codex')) });
  assert.ok(startupContext({ hook_event_name: 'SessionStart', cwd: f.a }, { home: f.home }));
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.b] } } });
  assert.equal(startupContext({ hook_event_name: 'SessionStart', cwd: f.a }, { home: f.home }), null);
  f.save({ 'local-projects': {} });
  assert.equal(startupContext({ hook_event_name: 'SessionStart', cwd: f.b }, { home: f.home }), null);
});

test('inherits_global即使全局缺失也忽略旧根配置，之后动态继承全局', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } } });
  const old = balanced('codex'); old.concurrency = 2;
  configureProfile(f.a, old, { home: f.home, scope: 'project', apply: true });
  setWorkspaceRecordById(f.home, { id: 'a', roots: [f.a, f.b], enabled: true, inherits_global: true });
  const workspace = readCodexWorkspaces(f.home).workspaces[0];
  const inheritedWithoutGlobal = resolveWorkspaceProfile(f.home, workspace);
  assert.equal(inheritedWithoutGlobal.profile, null);
  assert.deepEqual(inheritedWithoutGlobal.member_profiles, [{ root: f.a, profile_hash: routeHash(old) }, { root: f.b, profile_hash: null }]);
  const global = balanced('codex'); global.concurrency = 7;
  configureProfile(f.a, global, { home: f.home, scope: 'global', apply: true });
  const inheritedGlobal = resolveWorkspaceProfile(f.home, workspace);
  assert.equal(inheritedGlobal.profile.concurrency, 7);
  assert.deepEqual(inheritedGlobal.member_profiles, [{ root: f.a, profile_hash: routeHash(old) }, { root: f.b, profile_hash: null }]);
});

test('设置面板对inherits_global工作区忽略残留成员配置并准确显示来源', async t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a] } } });
  const stale = balanced('codex'); stale.concurrency = 2;
  configureProfile(f.a, stale, { home: f.home, scope: 'project', apply: true });
  const global = balanced('codex'); global.concurrency = 7;
  configureProfile(f.a, global, { home: f.home, scope: 'global', apply: true });
  setWorkspaceRecordById(f.home, { id: 'a', roots: [f.a], enabled: true, inherits_global: true });

  const manager = createSettingsManager({ home: f.home, modelsProvider: async () => ({ models: [] }) });
  const panel = await manager.update({ workspace_id: 'a' });
  assert.equal(panel.values.concurrency, 7, '保存的工作区身份决定当前有效配置');
  assert.match(panel.layout.find(group => group.title.startsWith('状态：')).title, /项目继承全局/);
  assert.doesNotMatch(panel.status, /项目专属覆盖/);
});

test('已删除ID的旧注册不阻止新宿主ID复用相同根目录', t => {
  const f = fixture(t);
  setWorkspaceRecordById(f.home, { id: 'old', roots: [f.a], enabled: false });
  f.save({ 'local-projects': { fresh: { name: '新项目', rootPaths: [f.a] } } });
  const saved = setWorkspaceRecordById(f.home, { id: 'fresh', roots: [f.a], enabled: true });
  assert.equal(saved.id, 'fresh');
  assert.equal(readCodexWorkspaces(f.home).workspaces[0].enabled, true);
});

test('多成员预演任一失败时不写入前置成员', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } } });
  const profile = balanced('codex');
  fs.mkdirSync(path.join(f.b, '.codex', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(f.b, '.codex', 'agents', 'occupied.toml'), 'name = "loop-dev"\n');
  assert.throws(() => configureWorkspaceProfile(f.home, readCodexWorkspaces(f.home).workspaces[0], profile, { apply: true }), /角色名称被其他原生文件占用/);
  assert.equal(fs.existsSync(path.join(f.a, '.ai-loop', 'models.json')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'ai-loop', 'workspaces.json')), false);
});

test('事务在首个成员写入前复核完整的旧配置迁移基线', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } } });
  const oldA = balanced('codex'); oldA.concurrency = 2;
  configureProfile(f.a, oldA, { home: f.home, scope: 'project', apply: true });
  const workspace = readCodexWorkspaces(f.home).workspaces[0];
  const initial = resolveWorkspaceProfile(f.home, workspace);
  assert.deepEqual(initial.member_profiles.map(item => item.profile_hash), [routeHash(oldA), null]);
  const beforeA = fs.readFileSync(path.join(f.a, '.ai-loop', 'models.json'));
  const newB = balanced('codex'); newB.concurrency = 6;

  assert.throws(() => configureWorkspaceProfile(f.home, workspace, balanced('codex'), {
    apply: true,
    expectedMemberProfiles: initial.member_profiles,
    onBeforeMemberWrite(root, index) {
      if (index === 0) configureProfile(f.b, newB, { home: f.home, scope: 'project', apply: true });
    },
  }), /成员配置在编辑期间发生变化/);

  assert.deepEqual(fs.readFileSync(path.join(f.a, '.ai-loop', 'models.json')), beforeA);
  assert.equal(resolveProfile(f.b, { home: f.home, scope: 'project' }).profile.concurrency, 6);
  assert.equal(workspaceEntryById(f.home, 'a'), null);
});

test('成员物化后宿主根集合改变时拒绝提交并回滚文件', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } } });
  const workspace = readCodexWorkspaces(f.home).workspaces[0];
  assert.throws(() => configureWorkspaceProfile(f.home, workspace, balanced('codex'), {
    apply: true,
    onBeforeRegistryCommit() { f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a] } } }); },
  }), /成员目录已变化/);
  assert.equal(fs.existsSync(path.join(f.a, '.ai-loop', 'models.json')), false);
  assert.equal(fs.existsSync(path.join(f.b, '.ai-loop', 'models.json')), false);
});

test('提交阶段注册表失败时恢复之前的成员文件字节', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a] } } });
  const oldProfile = balanced('codex'); configureProfile(f.a, oldProfile, { home: f.home, scope: 'project', apply: true });
  const beforeFile = path.join(f.a, '.ai-loop', 'models.json');
  const before = fs.readFileSync(beforeFile);
  fs.mkdirSync(path.join(f.home, 'ai-loop'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'ai-loop', 'workspaces.lock'), 'external lock');
  const changed = balanced('codex'); changed.concurrency = 6;
  assert.throws(() => configureWorkspaceProfile(f.home, readCodexWorkspaces(f.home).workspaces[0], changed, { apply: true }), /已有操作持锁/);
  assert.deepEqual(fs.readFileSync(beforeFile), before);
  assert.deepEqual(fs.readFileSync(beforeFile), before);
});

test('reset回滚检测被外部创建的已删除文件并保留外部内容', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } } });
  const workspace = readCodexWorkspaces(f.home).workspaces[0];
  const profile = balanced('codex');
  configureWorkspaceProfile(f.home, workspace, profile, { apply: true });
  const external = path.join(f.a, '.codex', 'agents', 'loop-dev.toml');
  assert.throws(() => resetWorkspaceProfile(f.home, readCodexWorkspaces(f.home).workspaces[0], {
    apply: true,
    onAfterMemberReset(root, index) {
      if (index === 0) fs.writeFileSync(external, 'external edit');
      if (index === 1) throw new Error('forced reset failure');
    },
  }), /回滚未完整/);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external edit');
});

test('设置读取刷新 Codex 列表；移除项目后拒绝保存，不能伪造任意目录', async t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '甲', rootPaths: [f.a] } } });
  const manager = createSettingsManager({ home: f.home, modelsProvider: async () => ({ models: [] }) });
  const first = await manager.read();
  await manager.update({ workspace_root: first.schema.properties.workspace_root.enum[1] });
  await assert.rejects(manager.update({ workspace_root: f.b }), /只能选择/);
  f.save({ 'local-projects': { b: { name: '乙', rootPaths: [f.b] } } });
  assert.throws(() => manager.action('ai_loop.workspace.toggle'), /已不可用/);
  await assert.rejects(manager.action('ai_loop.settings.apply'), /已不可用/);
  const second = await manager.read();
  assert.equal(second.values.workspace_root, '');
  assert.equal(second.schema.properties.workspace_root.enum.length, 2);
  assert.ok(second.schema.properties.workspace_root.enum[1].includes('乙'));
  assert.equal(fs.existsSync(path.join(f.home, 'ai-loop')), false);
});

test('旧版根目录列表仍可直接选择；状态读取失败在设置页显示', async t => {
  const f = fixture(t);
  f.save({ 'electron-saved-workspace-roots': [f.a] });
  const manager = createSettingsManager({ home: f.home });
  assert.equal((await manager.read()).schema.properties.workspace_root.enum.length, 2);
  fs.writeFileSync(f.stateFile, 'not-json');
  assert.match((await manager.read()).layout.at(-1).title, /无法读取 Codex 工作区列表/);
});


test('真实桌面默认用户标志为0时按顶层来源排序，拒绝无角色代理与exec污染', t => {
  let DatabaseSync; try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { t.skip('无内置SQLite'); return; }
  const f = fixture(t);
  f.save({ 'project-order': ['b', 'a'], 'local-projects': { a: { rootPaths: [f.a] }, b: { rootPaths: [f.b] } } });
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, has_user_event INTEGER, source TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('a-user', f.a, 70000, 0, 0, 0, 'vscode');
  insert.run('b-user', f.b, 10000, 20000, 0, 0, '"cli"');
  for (const source of ['{"subagent":{"thread_spawn":{}}}', '{"subagent":{"other":"guardian"}}', 'exec', '{bad-json', 'unknown']) insert.run(source, f.b, 999999, 999999, 0, 1, source);
  insert.run('archived', f.b, 999999, 999999, 1, 0, 'vscode');
  db.close();
  const result = readCodexWorkspaces(f.home);
  assert.deepEqual(result.workspaces.map(row => [row.id, row.last_used_at]), [['a', 70000], ['b', 20000]]);
  assert.equal(result.recency.status, 'available');
});

test('无数据库或未知来源时最近使用明确降级而不虚报活动', t => {
  let DatabaseSync; try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { t.skip('无内置SQLite'); return; }
  const f = fixture(t); f.save({ 'local-projects': { a: { rootPaths: [f.a] } } });
  assert.equal(readCodexWorkspaces(f.home).recency.status, 'unavailable');
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, updated_at INTEGER, source TEXT, has_user_event INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('unknown', f.a, 99999, 'exec', 1); db.close();
  const result = readCodexWorkspaces(f.home);
  assert.equal(result.recency.status, 'empty'); assert.match(result.recency.reason, /尚无/);
  assert.equal(result.workspaces[0].last_used_at, null);
});

test('恢复事务在最后成员清理后及提交前拒绝外部新配置，保留外部字节', t => {
  for (const stage of ['last-member', 'before-commit']) {
    const f = fixture(t);
    f.save({ 'local-projects': { a: { rootPaths: [f.a, f.b] } } });
    const profile = balanced('codex');
    configureWorkspaceProfile(f.home, readCodexWorkspaces(f.home).workspaces[0], profile, { scope: 'project', apply: true });
    const external = disabledProfile('codex');
    let bytes;
    const change = () => { configureProfile(f.b, external, { home: f.home, scope: 'project', apply: true }); bytes = fs.readFileSync(path.join(f.b, '.ai-loop/models.json')); };
    assert.throws(() => resetWorkspaceProfile(f.home, readCodexWorkspaces(f.home).workspaces[0], {
      ...(stage === 'last-member' ? { onAfterMemberReset(root, index) { if (index === 1) change(); } } : { onBeforeRegistryCommit: change }),
    }), /成员配置|并发改动|成员目录/);
    assert.deepEqual(fs.readFileSync(path.join(f.b, '.ai-loop/models.json')), bytes);
    assert.notEqual(workspaceEntryById(f.home, 'a').inherits_global, true);
  }
});
