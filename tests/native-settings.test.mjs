import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsManager } from '../codex/scripts/native-settings.mjs';
import { balanced, routeHash } from '../scripts/routing.mjs';
import { configureProfile, configureWorkspaceProfile, resetProjectProfile, resolveProfile, resolveWorkspaceProfile } from '../codex/scripts/profiles.mjs';
import { listWorkspaces, setWorkspaceEnabled, workspaceEntry, restoreWorkspaceEntry, setWorkspaceRecordById, workspaceEntryById } from '../scripts/workspaces.mjs';
import { link } from './support.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-native-settings-'));
const modelList = async () => ({ models: [
  { id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_effort: 'medium' },
  { id: 'gpt-6-luna', name: 'Luna', efforts: ['low', 'medium', 'high'], default_effort: 'medium' },
] });


function addCodexProject(home, project, name = '示例项目') {
  const file = path.join(home, '.codex-global-state.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { 'local-projects': {} };
  state['local-projects'][project] = { name, rootPaths: [project] };
  fs.writeFileSync(file, JSON.stringify(state));
}
function setCodexWorkspaceEnabled(home, project, enabled, revision) {
  const previous = workspaceEntryById(home, project);
  return setWorkspaceRecordById(home, { ...(previous || {}), id: project, roots: [fs.realpathSync(project)], enabled }, { revision });
}
async function selectWorkspace(manager, home, project) {
  addCodexProject(home, project);
  await manager.update({ workspace_root: project });
}

test('原生读取返回schema、当前值和动作布局，构造阶段不探测模型也不写注册表', async t => {
  const home = temp(), project = temp();
  let calls = 0;
  const manager = createSettingsManager({ home, project, modelsProvider: async root => { calls++; assert.equal(root, fs.realpathSync(project)); return modelList(); } });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false);
  const result = await manager.read();
  assert.equal(calls, 1);
  assert.equal(result.schema.properties['model.dev'].type, 'string');
  assert.deepEqual(result.schema.properties['model.dev'].enum, ['关闭', 'gpt-6.1-sol', 'gpt-6-luna']);
  assert.equal(result.values['model.dev'], '关闭', '无配置时角色默认关闭');
  assert.ok(result.layout.some(group => group.items.some(item => item.tool === 'ai_loop.settings.apply')));
  assert.ok(result.layout.every(group => !group.items.some(item => item.tool === 'ai_loop.workspace.toggle')), '工作区不再显示独立应用按钮');
  assert.equal(result.schema.properties['model.planner'].enum[0], '关闭');
  assert.equal(result.schema.properties['model.reviewer'].enum[0], '关闭');
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false, 'read 不应创建持久化目录');
});

test('显式工作区只在首次读取定位，用户切换后保持其选择且不写启用状态', async t => {
  const home = temp(), project = temp(), other = temp();
  t.after(() => { for (const root of [home, project, other]) fs.rmSync(root, { recursive: true, force: true }); });
  addCodexProject(home, project, '当前'); addCodexProject(home, other, '其他');
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  const first = await manager.read();
  assert.equal(first.values.scope, '仅当前工作区');
  assert.ok(first.values.workspace_root.includes(fs.realpathSync(project)));
  assert.equal(first.values.workspace_enabled, false);
  await manager.update({ workspace_root: other });
  assert.ok((await manager.read()).values.workspace_root.includes(fs.realpathSync(other)));
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false);
  const direct = createSettingsManager({ home, project, modelsProvider: modelList });
  await direct.update({ workspace_root: other });
  assert.ok((await direct.read()).values.workspace_root.includes(fs.realpathSync(other)), '首次显式选择不能被默认定位覆盖');
});

test('设置面板按工作区ID选择并返回完整成员、状态和脏标记', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  const stateFile = path.join(home, '.codex-global-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ 'local-projects': { workspace: { name: '多根项目', rootPaths: [a, b] } } }));
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  const before = await manager.read();
  assert.deepEqual(before.workspaces[0].roots, [a, b]);
  assert.equal(before.selection.workspaceId, '');
  const selected = await manager.update({ workspace_id: 'workspace' });
  assert.equal(selected.selection.workspaceId, 'workspace');
  assert.equal(manager.getSelection().selectedWorkspaceId, 'workspace');
  assert.equal(selected.dirty, false);
  const draft = await manager.update({ workspace_enabled: true });
  assert.equal(draft.dirty, true);
  assert.equal(draft.workspaces[0].enabled, false, '未保存草稿不能改变工作区状态点');
  assert.match(draft.status, /停用|配置来源/);
});

test('同一根目录的不同宿主ID按ID读取profile，切换身份仍进入项目范围', async t => {
  const home = temp(), root = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const profileA = balanced('codex'); profileA.concurrency = 2;
  const profileB = balanced('codex'); profileB.concurrency = 6;
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': {
    first: { name: '同名', rootPaths: [root] }, second: { name: '同名', rootPaths: [root] },
  } }));
  fs.mkdirSync(path.join(home, 'ai-loop'), { recursive: true });
  fs.writeFileSync(path.join(home, 'ai-loop', 'workspaces.json'), JSON.stringify({ schema_version: 2, workspaces: [
    { id: 'first', roots: [root], enabled: false, profile: profileA, profile_hash: routeHash(profileA), inherits_global: false },
    { id: 'second', roots: [root], enabled: false, profile: profileB, profile_hash: routeHash(profileB), inherits_global: false },
  ] }));
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'first' });
  assert.equal((await manager.read()).values.concurrency, 2);
  const second = await manager.update({ workspace_id: 'second' });
  assert.equal(second.selection.workspaceId, 'second');
  assert.equal(second.values.scope, '仅当前工作区');
  assert.equal(second.values.concurrency, 6);
});

test('旧根启用状态冲突时模型保存要求显式选择工作区开关', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
  setWorkspaceEnabled(home, a, true, { create: true });
  setWorkspaceEnabled(home, b, false, { create: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'w' });
  assert.equal((await manager.read()).workspaces[0].settings_conflict, true);
  await manager.update({ concurrency: 3 });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /明确选择启用或停用/);
});

test('成员根旧模型冲突会显式显示，选择迁移来源后按来源读取草稿', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
  for (const [root, concurrency] of [[a, 2], [b, 5]]) {
    const profile = balanced('codex');
    profile.concurrency = concurrency;
    const native = Object.fromEntries(Object.keys(profile.roles).map(role => [`.codex/agents/loop-${role}.toml`, 'a'.repeat(64)]));
    const dir = path.join(root, '.ai-loop'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ schema_version: 2, profile, profile_hash: routeHash(profile), native }));
  }
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'w' });
  const conflicted = await manager.read();
  assert.match(conflicted.status, /不一致/);
  assert.deepEqual(conflicted.schema.properties.workspace_profile_source_id.enum, ['', a, b]);
  assert.ok(conflicted.layout[0].items.some(item => item.property === 'workspace_profile_source_id'));
  const chosen = await manager.update({ workspace_profile_source_id: b });
  assert.equal(chosen.values.concurrency, 5);
  assert.match(chosen.status, /迁移/);
  assert.deepEqual(chosen.schema.properties.workspace_profile_source_id.enum, ['', a, b], '冲突只会在保存迁移后消失');
});

test('首次迁移期间已有成员配置被外部更新时阻止保存', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
  const oldA = balanced('codex'); oldA.concurrency = 2;
  const oldB = balanced('codex'); oldB.concurrency = 3;
  configureProfile(a, oldA, { home, scope: 'project', apply: true });
  configureProfile(b, oldB, { home, scope: 'project', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'w' });
  await manager.update({ workspace_profile_source_id: fs.realpathSync(a), 'model.dev': 'gpt-6-luna' });
  const beforeA = fs.readFileSync(path.join(a, '.ai-loop', 'models.json'));
  const newB = balanced('codex'); newB.concurrency = 6;
  configureProfile(b, newB, { home, scope: 'project', apply: true });

  await assert.rejects(manager.action('ai_loop.settings.apply'), /配置在编辑期间发生变化/);
  assert.deepEqual(fs.readFileSync(path.join(a, '.ai-loop', 'models.json')), beforeA);
  assert.equal(resolveProfile(b, { home, scope: 'project' }).profile.concurrency, 6);
  assert.equal(workspaceEntryById(home, 'w'), null);
});

test('首次迁移时空成员后来创建配置会拒绝覆盖并保留该配置', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
  const oldA = balanced('codex'); oldA.concurrency = 2;
  configureProfile(a, oldA, { home, scope: 'project', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'w' });
  await manager.update({ workspace_profile_source_id: fs.realpathSync(a), 'model.dev': 'gpt-6-luna' });
  const beforeA = fs.readFileSync(path.join(a, '.ai-loop', 'models.json'));
  const newB = balanced('codex'); newB.concurrency = 6;
  configureProfile(b, newB, { home, scope: 'project', apply: true });

  await assert.rejects(manager.action('ai_loop.settings.apply'), /配置在编辑期间发生变化/);
  assert.deepEqual(fs.readFileSync(path.join(a, '.ai-loop', 'models.json')), beforeA);
  assert.equal(resolveProfile(b, { home, scope: 'project' }).profile.concurrency, 6);
  assert.equal(workspaceEntryById(home, 'w'), null);
});

test('仅选择迁移来源后read保留全成员基线并拒绝外部配置变化', async t => {
  for (const createExternalProfile of [false, true]) {
    const home = temp(), a = temp(), b = temp();
    t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
    const source = balanced('codex'); source.concurrency = 2;
    const other = balanced('codex'); other.concurrency = 5;
    configureProfile(a, source, { home, scope: 'project', apply: true });
    if (!createExternalProfile) configureProfile(b, other, { home, scope: 'project', apply: true });
    const manager = createSettingsManager({ home, modelsProvider: modelList });
    await manager.update({ workspace_id: 'w' });
    await manager.read();
    await manager.update(createExternalProfile
      ? { workspace_profile_source_id: fs.realpathSync(a), workspace_enabled: true }
      : { workspace_profile_source_id: fs.realpathSync(a) });
    const beforeA = fs.readFileSync(path.join(a, '.ai-loop', 'models.json'));
    const beforeB = fs.existsSync(path.join(b, '.ai-loop', 'models.json')) ? fs.readFileSync(path.join(b, '.ai-loop', 'models.json')) : null;
    if (createExternalProfile) configureProfile(b, other, { home, scope: 'project', apply: true });
    else {
      const changed = balanced('codex'); changed.concurrency = 7;
      configureProfile(b, changed, { home, scope: 'project', apply: true });
    }
    const externalB = fs.readFileSync(path.join(b, '.ai-loop', 'models.json'));
    await manager.read();

    await assert.rejects(manager.action('ai_loop.settings.apply'), /配置在编辑期间发生变化/);
    assert.deepEqual(fs.readFileSync(path.join(a, '.ai-loop', 'models.json')), beforeA, '来源成员不得被部分改写');
    assert.deepEqual(fs.readFileSync(path.join(b, '.ai-loop', 'models.json')), externalB, '外部成员字节必须保留');
    assert.notDeepEqual(externalB, beforeB, '外部变化必须发生在保存尝试前');
    assert.equal(workspaceEntryById(home, 'w'), null, '拒绝保存时不得提交工作区注册记录');
    assert.equal(resolveProfile(b, { home, scope: 'project' }).profile.concurrency, createExternalProfile ? 5 : 7);
  }
});

test('仅选择迁移来源且成员未变化时read后可保存迁移', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
  const source = balanced('codex'); source.concurrency = 2;
  const other = balanced('codex'); other.concurrency = 5;
  configureProfile(a, source, { home, scope: 'project', apply: true });
  configureProfile(b, other, { home, scope: 'project', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'w' });
  await manager.read();
  await manager.update({ workspace_profile_source_id: fs.realpathSync(a) });
  await manager.read();

  await manager.action('ai_loop.settings.apply');
  const saved = workspaceEntryById(home, 'w');
  assert.equal(saved.profile.concurrency, 2);
  assert.equal(resolveProfile(a, { home, scope: 'project' }).profile.concurrency, 2);
  assert.equal(resolveProfile(b, { home, scope: 'project' }).profile.concurrency, 2);
});

test('恢复全局继承后可重新保存工作区模型、并发和思考深度', async t => {
  for (const rootCount of [1, 2]) for (const hasGlobal of [false, true]) {
    const home = temp(), roots = Array.from({ length: rootCount }, temp);
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '工作区', rootPaths: roots } } }));
    if (hasGlobal) {
      const global = balanced('codex'); global.roles.dev.model = 'gpt-6.1-sol';
      configureProfile(home, global, { home, scope: 'global', apply: true });
    }
    const manager = createSettingsManager({ home, modelsProvider: modelList });
    await manager.update({ workspace_id: 'w' });
    const initial = await manager.read();
    assert.equal(initial.values.scope, '仅当前工作区');
    await manager.action('ai_loop.settings.reset_project');

    for (const [field, value, check] of [
      ['model.dev', 'gpt-6-luna', profile => profile.roles.dev.model],
      ['concurrency', 4, profile => profile.concurrency],
      ['effort.dev', 'high', profile => profile.roles.dev.effort],
    ]) {
      await manager.update({ [field]: value });
      await manager.read();
      await manager.action('ai_loop.settings.apply');
      for (const root of roots) assert.equal(check(resolveProfile(root, { home, scope: 'project' }).profile), value);
    }
    assert.equal(workspaceEntryById(home, 'w').inherits_global, false);
  }
});

test('全局仅保存工作区开关后仅选择来源仍会迁移并物化所有成员', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
  const source = balanced('codex'); source.concurrency = 2;
  const other = balanced('codex'); other.concurrency = 5;
  configureProfile(a, source, { home, scope: 'project', apply: true });
  configureProfile(b, other, { home, scope: 'project', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'w' });
  await manager.update({ scope: 'global', workspace_enabled: true });
  await manager.action('ai_loop.settings.apply');
  const stateOnly = workspaceEntryById(home, 'w');
  assert.equal(stateOnly.enabled, true);
  assert.equal(stateOnly.profile, undefined);

  await manager.update({ scope: 'project' });
  await manager.read();
  const selected = await manager.update({ workspace_profile_source_id: fs.realpathSync(a) });
  assert.equal(selected.dirty, true);
  await manager.read();
  await manager.action('ai_loop.settings.apply');

  const saved = workspaceEntryById(home, 'w');
  assert.equal(saved.enabled, true);
  assert.ok(saved.profile, '仅状态登记不能让旧根模型迁移被当作已完成');
  assert.equal(saved.profile.concurrency, 2);
  assert.equal(saved.inherits_global, false);
  for (const root of [a, b]) assert.equal(resolveProfile(root, { home, scope: 'project' }).profile.concurrency, 2);
});

test('仅状态登记后的选源迁移在read后拒绝已有成员外部更新和空成员新建配置', async t => {
  for (const externalCreate of [false, true]) {
    const home = temp(), a = temp(), b = temp();
    t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
    const source = balanced('codex'); source.concurrency = 2;
    const oldB = balanced('codex'); oldB.concurrency = 5;
    configureProfile(a, source, { home, scope: 'project', apply: true });
    if (!externalCreate) configureProfile(b, oldB, { home, scope: 'project', apply: true });
    const manager = createSettingsManager({ home, modelsProvider: modelList });
    await manager.update({ workspace_id: 'w' });
    await manager.update({ scope: 'global', workspace_enabled: true });
    await manager.action('ai_loop.settings.apply');
    await manager.update({ scope: 'project' });
    await manager.read();
    await manager.update({ workspace_profile_source_id: fs.realpathSync(a) });
    await manager.read();
    const beforeA = fs.readFileSync(path.join(a, '.ai-loop', 'models.json'));
    const external = balanced('codex'); external.concurrency = 7;
    configureProfile(b, external, { home, scope: 'project', apply: true });
    const externalBytes = fs.readFileSync(path.join(b, '.ai-loop', 'models.json'));
    await manager.read();

    await assert.rejects(manager.action('ai_loop.settings.apply'), /配置在编辑期间发生变化/);
    assert.deepEqual(fs.readFileSync(path.join(a, '.ai-loop', 'models.json')), beforeA, '来源成员不得被部分覆盖');
    assert.deepEqual(fs.readFileSync(path.join(b, '.ai-loop', 'models.json')), externalBytes, '外部成员字节必须保留');
    const saved = workspaceEntryById(home, 'w');
    assert.equal(saved.enabled, true);
    assert.equal(saved.profile, undefined, '失败迁移不得提交集中profile');
  }
});

test('已有集中profile和明确继承全局的工作区不会重复迁移', async t => {
  for (const inheritance of [false, true]) {
    const home = temp(), a = temp(), b = temp();
    t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根', rootPaths: [a, b] } } }));
    const profile = balanced('codex'); profile.concurrency = 4;
    if (inheritance) {
      configureProfile(home, profile, { home, scope: 'global', apply: true });
      setWorkspaceRecordById(home, { id: 'w', roots: [a, b], enabled: false, inherits_global: true });
    } else configureWorkspaceProfile(home, { id: 'w', roots: [a, b] }, profile, { apply: true, enabled: false });
    const before = [a, b].map(root => fs.existsSync(path.join(root, '.ai-loop', 'models.json')) ? fs.readFileSync(path.join(root, '.ai-loop', 'models.json')) : null);
    const manager = createSettingsManager({ home, modelsProvider: modelList });
    await manager.update({ workspace_id: 'w' });
    await manager.read();
    assert.equal(resolveWorkspaceProfile(home, { id: 'w', roots: [a, b], root: a }).migration, null);
    await manager.update({ workspace_enabled: true });
    await manager.action('ai_loop.settings.apply');
    const saved = workspaceEntryById(home, 'w');
    assert.equal(saved.enabled, true);
    assert.equal(Boolean(saved.inherits_global), inheritance);
    for (const [index, root] of [a, b].entries()) {
      const current = fs.existsSync(path.join(root, '.ai-loop', 'models.json')) ? fs.readFileSync(path.join(root, '.ai-loop', 'models.json')) : null;
      if (before[index] === null) assert.equal(current, null);
      else assert.deepEqual(current, before[index]);
    }
  }
});

test('hasDrafts同步汇总所有范围且不触发模型读取', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  let modelReads = 0;
  const manager = createSettingsManager({ home, modelsProvider: async () => { modelReads++; return modelList(); } });
  assert.equal(manager.hasDrafts(), false);
  await selectWorkspace(manager, home, a);
  await manager.update({ 'model.dev': 'gpt-6-luna' });
  assert.equal(manager.hasDrafts(), true);
  const readsBeforeProbe = modelReads;
  assert.equal(manager.hasDrafts(), true);
  assert.equal(modelReads, readsBeforeProbe, 'hasDrafts 不得调用模型提供器');
  await selectWorkspace(manager, home, b);
  assert.equal(manager.hasDrafts(), true, '切换工作区不能隐藏其他范围草稿');
  await manager.update({ scope: 'global', concurrency: 3 });
  assert.equal(manager.hasDrafts(), true, '切换配置范围不能隐藏其他草稿');
  const readsBeforeFinalProbe = modelReads;
  assert.equal(manager.hasDrafts(), true);
  assert.equal(modelReads, readsBeforeFinalProbe);
});

test('没有显式工作区时使用global配置，绝不把插件进程cwd当项目', async t => {
  const home = temp(), project = temp();
  const previousProject = process.env.AI_LOOP_PROJECT;
  delete process.env.AI_LOOP_PROJECT;
  const global = balanced('codex'); global.roles.dev.model = 'gpt-6.1-sol';
  configureProfile(project, global, { home, scope: 'global', apply: true });
  let calls = 0;
  const manager = createSettingsManager({ home, modelsProvider: async () => { calls++; return modelList(); } });
  t.after(() => { if (previousProject === undefined) delete process.env.AI_LOOP_PROJECT; else process.env.AI_LOOP_PROJECT = previousProject; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const result = await manager.read();
  assert.equal(result.values.scope, '全局默认');
  assert.equal(result.values['model.dev'], 'gpt-6.1-sol');
  assert.equal(result.values.workspace_root, '');
  assert.deepEqual(result.schema.properties.workspace_root.enum, ['']);
  assert.equal(calls, 0, '未选择工作区时不可在插件cwd探测模型');
  assert.match(result.layout.at(-1).title, /全局配置/);
});

test('Codex 工作区直接选择，只读且不登记，开关默认停用', async t => {
  const home = temp(), project = temp();
  addCodexProject(home, project, '我的项目');
  const stateFile = path.join(home, '.codex-global-state.json');
  const before = fs.readFileSync(stateFile);
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const initial = await manager.read();
  const choice = initial.schema.properties.workspace_root.enum[1];
  assert.ok(choice.includes('我的项目') && choice.includes(fs.realpathSync(project)));
  assert.equal(initial.schema.properties.workspace_path, undefined);
  assert.equal(initial.schema.properties.workspace_candidate, undefined);
  assert.equal(initial.values.workspace_root, '');
  await manager.update({ workspace_root: choice, scope: 'project' });
  const view = await manager.read();
  assert.equal(view.values.workspace_root, choice);
  assert.equal(view.values.workspace_enabled, false);
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false, '读取和选择不写登记');
  assert.equal(fs.existsSync(path.join(project, '.ai-loop')), false, '选择不写项目');
  assert.deepEqual(fs.readFileSync(stateFile), before, '不写回 Codex 状态');
  assert.throws(() => manager.action('ai_loop.workspace.register'), /未知设置动作/);
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, false, '应用默认开关不会启用');
  await manager.update({ workspace_enabled: true });
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, true);
});

test('范围中文显示，切换工作区默认项目；明确选择全局时保留', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  addCodexProject(home, a, '甲'); addCodexProject(home, b, '乙');
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  assert.deepEqual((await manager.read()).schema.properties.scope.enum, ['全局默认', '仅当前工作区']);
  await manager.update({ 'model.dev': 'gpt-6.1-sol' });
  await manager.update({ workspace_root: a });
  assert.equal(manager.getSelection().scope, 'project');
  assert.equal((await manager.read()).values['model.dev'], '关闭', '全局草稿不带入项目，未配置时默认关闭');
  await manager.update({ scope: '全局默认' });
  await manager.update({ workspace_root: a });
  assert.equal((await manager.read()).values.scope, '全局默认', '相同工作区刷新不重置显式范围');
  await manager.update({ workspace_root: b });
  assert.equal((await manager.read()).values.scope, '仅当前工作区');
  await manager.update({ workspace_root: a, scope: '全局默认' });
  assert.equal(manager.getSelection().scope, 'global', '同时明确指定范围时尊重选择');
  await manager.update({ workspace_root: '' });
  assert.equal((await manager.read()).values.scope, '全局默认');
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6.1-sol', '未选工作区的全局草稿仍保留');
});

test('settings.update 切换范围时直接返回新范围的有效值和草稿', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  addCodexProject(home, a, '甲'); addCodexProject(home, b, '乙');
  const global = balanced('codex');
  global.roles.dev.model = 'gpt-6.1-sol';
  global.roles.dev.effort = 'high';
  global.concurrency = 5;
  const projectA = balanced('codex');
  projectA.roles.dev.model = 'gpt-6.1-sol';
  projectA.roles.dev.effort = 'xhigh';
  projectA.concurrency = 3;
  const projectB = balanced('codex');
  projectB.roles.dev.model = 'gpt-6-luna';
  projectB.roles.dev.effort = null;
  projectB.concurrency = 2;
  configureProfile(a, global, { home, scope: 'global', apply: true });
  configureProfile(a, projectA, { home, scope: 'project', apply: true });
  configureProfile(b, projectB, { home, scope: 'project', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  const assertMatchesRead = async values => {
    const expected = (await manager.read()).values;
    for (const field of ['scope', 'workspace_root', 'workspace_enabled', 'concurrency', ...Object.keys(expected).filter(name => name.startsWith('model.') || name.startsWith('effort.'))]) {
      assert.equal(values[field], expected[field], `update 返回的 ${field} 必须匹配当前选择`);
    }
  };

  await assertMatchesRead((await manager.update({ workspace_root: a })).values);

  await manager.update({ 'effort.dev': 'low' });
  await assertMatchesRead((await manager.update({ workspace_root: b })).values);

  await assertMatchesRead((await manager.update({ workspace_root: a })).values);
  assert.equal(manager.getSelection().selectedRoot, fs.realpathSync(a));
  assert.equal(manager.getSelection().scope, 'project');
});

test('settings.update 首次选择及范围切换返回当前原生默认和完整schema', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  addCodexProject(home, a, '甲'); addCodexProject(home, b, '乙');
  const global = balanced('codex');
  global.roles.dev.model = 'gpt-6.1-sol'; global.roles.dev.effort = null;
  const profileA = balanced('codex');
  profileA.roles.dev.model = 'gpt-6-luna'; profileA.roles.dev.effort = null; profileA.concurrency = 3;
  const profileB = balanced('codex');
  profileB.roles.dev.model = 'gpt-6.1-sol'; profileB.roles.dev.effort = null; profileB.concurrency = 2;
  configureProfile(a, global, { home, scope: 'global', apply: true });
  configureProfile(a, profileA, { home, scope: 'project', apply: true });
  configureProfile(b, profileB, { home, scope: 'project', apply: true });
  const defaults = new Map([[fs.realpathSync(a), 'high'], [fs.realpathSync(b), 'high']]);
  const manager = createSettingsManager({ home, modelsProvider: async root => ({ models: [
    { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_effort: defaults.get(root) },
    { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'], default_effort: defaults.get(root) },
  ] }) });
  const updateMatchesRead = async set => {
    const result = await manager.update(set);
    const expected = await manager.read();
    assert.deepEqual(result.values, expected.values);
    assert.deepEqual(result.schema, expected.schema);
    assert.deepEqual(result.layout, expected.layout);
    return result;
  };

  const first = await updateMatchesRead({ workspace_root: b });
  assert.equal(first.values['effort.dev'], 'high', '无先前 read 时也按新工作区原生默认值返回');
  defaults.set(fs.realpathSync(b), 'low');
  const changed = await updateMatchesRead({ workspace_enabled: true });
  assert.equal(changed.values['effort.dev'], 'low', '每次 update 反映已变化的原生默认值');
  assert.equal(changed.values.workspace_enabled, true);
  assert.ok(changed.schema.properties['effort.dev'].enum.includes('low'));

  await updateMatchesRead({ 'effort.dev': 'xhigh' });
  const globalResult = await updateMatchesRead({ scope: 'global' });
  assert.equal(globalResult.values['effort.dev'], 'low', '显式切换范围读取全局配置和当前默认值');
  assert.equal(globalResult.values.workspace_enabled, false, '开关草稿按范围隔离');
  const projectResult = await updateMatchesRead({ scope: 'project' });
  assert.equal(projectResult.values['effort.dev'], 'xhigh', '返回项目范围自己的强度草稿');
  assert.equal(projectResult.values.workspace_enabled, true, '返回项目范围自己的开关草稿');

  await updateMatchesRead({ workspace_root: a });
  defaults.set(fs.realpathSync(a), 'ultra');
  const refreshed = await updateMatchesRead({ concurrency: 4 });
  assert.equal(refreshed.values['effort.dev'], 'ultra', '同一工作区的模型默认变化不使用过期缓存');
  assert.equal(refreshed.values.concurrency, 4);
});

test('默认项目范围保存不修改全局默认，中文范围仍支持分别保存', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  await manager.update({ 'model.dev': 'gpt-6.1-sol' });
  const local = await manager.action('ai_loop.settings.apply');
  assert.match(local.message, /仅当前工作区/);
  assert.equal(resolveProfile(project, { home, scope: 'global' }).profile, null);
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile.roles.dev.model, 'gpt-6.1-sol');
  await manager.update({ scope: '全局默认', concurrency: 4 });
  assert.match((await manager.action('ai_loop.settings.apply')).message, /全局默认/);
  assert.equal(resolveProfile(project, { home, scope: 'global' }).profile.concurrency, 4);
  await manager.update({ scope: '仅当前工作区' });
  assert.equal((await manager.read()).values.concurrency, 3, '项目覆盖仍独立');
});

test('工作区选择、开关和模型草稿仅在显式应用时写入', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  await selectWorkspace(manager, home, project);
  assert.deepEqual(listWorkspaces(home), []);
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, false, '无草稿时应用当前停用状态');
  await manager.update({ workspace_enabled: false });
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, false);
  await manager.update({ workspace_enabled: true });
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, true);
  await manager.update({ scope: 'global', 'model.dev': 'gpt-6.1-sol', 'effort.dev': 'high', concurrency: 4 });
  assert.equal(resolveProfile(project, { home, scope: 'global' }).profile, null, '字段更新只改草稿');
  const applied = await manager.action('ai_loop.settings.apply');
  assert.equal(applied.status, 'configured');
  const saved = resolveProfile(project, { home, scope: 'global' }).profile;
  assert.equal(saved.roles.dev.model, 'gpt-6.1-sol');
  assert.equal(saved.roles.dev.effort, 'high');
  assert.equal(saved.concurrency, 4);
});

test('apply 重新校验模型和思考深度，并拒绝并发外部修改', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  await selectWorkspace(manager, home, project);
  await manager.update({ scope: 'global', 'model.dev': 'missing-model' });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /不在当前本机模型列表/);
  await manager.update({ 'model.dev': 'gpt-6-luna', 'effort.dev': 'ultra' });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /不支持思考深度/);

  const concurrent = createSettingsManager({ home, project, modelsProvider: modelList });
  await concurrent.read();
  await concurrent.update({ workspace_root: fs.realpathSync(project), scope: 'global', concurrency: 4 });
  const external = balanced('codex'); external.concurrency = 5;
  configureProfile(project, external, { home, scope: 'global', apply: true });
  await assert.rejects(concurrent.action('ai_loop.settings.apply'), /发生变化/);
});

test('换模型后按新模型刷新思考深度；原深度不支持时明确展示并拒绝应用', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  await selectWorkspace(manager, home, project);
  await manager.update({ 'effort.dev': 'xhigh' });
  await manager.update({ 'model.dev': 'gpt-6-luna' });
  const view = await manager.read();
  assert.deepEqual(view.schema.properties['effort.dev'].enum, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(view.values['effort.dev'], 'xhigh', '保留原始草稿，显式提示用户改选');
  assert.match(view.schema.properties['effort.dev'].description, /不受支持/);
  assert.match(view.layout.at(-1).title, /需修正思考深度：dev/);
  await assert.rejects(manager.action('ai_loop.settings.apply'), /不支持思考深度 xhigh/);
  await manager.update({ 'effort.dev': 'medium' });
  const corrected = await manager.read();
  assert.ok(corrected.schema.properties['effort.dev'].enum.includes('medium'));
  assert.equal(corrected.values['effort.dev'], 'medium');
  assert.equal((await manager.action('ai_loop.settings.apply')).status, 'configured');
});

test('损坏的工作区注册表对原生设置可见并阻止继续操作', async t => {
  const home = temp(), project = temp();
  fs.mkdirSync(path.join(home, 'ai-loop'), { recursive: true });
  fs.writeFileSync(path.join(home, 'ai-loop', 'workspaces.json'), '{broken');
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  await assert.rejects(manager.read(), SyntaxError);
});

test('update 全量预检后再改状态；非法partial set不会部分切换scope', async () => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  try {
    await assert.rejects(manager.update({ scope: 'project', concurrency: 9 }), /并发值须为 1–8/);
    assert.deepEqual(manager.getSelection(), { scope: 'global', selectedRoot: '', selectedWorkspaceId: '' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); }
});

test('Codex工作区列表拒绝链接路径，不用realpath绕过精确根目录', async t => {
  const home = temp(), parent = temp(), project = path.join(parent, 'actual'), alias = path.join(parent, 'alias');
  fs.mkdirSync(project);
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(parent, { recursive: true, force: true }); });
  if (!link(t, project, alias, 'junction')) return;
  addCodexProject(home, alias);
  await assert.rejects(manager.update({ workspace_root: alias }), /只能选择/);
});

test('project切换不会把A的模型草稿带到B，切回A仍保留A草稿', async t => {
  const home = temp(), projectA = temp(), projectB = temp();
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(projectA, { recursive: true, force: true }); fs.rmSync(projectB, { recursive: true, force: true }); });
  await selectWorkspace(manager, home, projectA);
  await manager.update({ scope: 'project', 'model.dev': 'gpt-6.1-sol' });
  await selectWorkspace(manager, home, projectB);
  assert.equal(manager.getSelection().selectedRoot, fs.realpathSync(projectB));
  assert.equal((await manager.read()).values['model.dev'], '关闭', '未配置的B默认关闭，没有继承A草稿');
  await manager.update({ workspace_root: fs.realpathSync(projectA) });
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6.1-sol', 'A草稿仍绑定A');
});

test('project scope 可显式应用并安全恢复到全局继承', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  await selectWorkspace(manager, home, project);
  await manager.update({ scope: 'global', 'model.dev': 'gpt-6-luna' });
  await manager.action('ai_loop.settings.apply');
  await manager.update({ scope: 'project', 'model.dev': 'gpt-6.1-sol' });
  await manager.action('ai_loop.settings.apply');
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile.roles.dev.model, 'gpt-6.1-sol');
  await manager.update({ scope: 'project' });
  manager.action('ai_loop.settings.reset_project');
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile, null);
  assert.equal(resolveProfile(project, { home }).scope, 'global');
  const workspace = workspaceEntryById(home, project);
  assert.equal(workspace.enabled, false, '模型保存不应自动启用工作区');
  assert.equal(workspace.inherits_global, true, '恢复项目配置后由工作区身份继承全局');
});

test('恢复工作区默认校验读取时的全部成员配置并保留外部改动', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { w: { name: '多根工作区', rootPaths: [a, b] } } }));
  const original = balanced('codex'); original.roles.dev.model = 'gpt-6-luna';
  configureWorkspaceProfile(home, { id: 'w', roots: [a, b] }, original, { apply: true, enabled: false });

  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await manager.update({ workspace_id: 'w' });
  await manager.read();

  const external = balanced('codex'); external.roles.dev.model = 'gpt-6.1-sol';
  configureProfile(a, external, { home, scope: 'project', apply: true });
  const changedRecord = resolveProfile(a, { home, scope: 'project' });
  const changedFiles = [...Object.keys(changedRecord.native), '.ai-loop/models.json'];
  const externalBytes = new Map(changedFiles.map(relative => [relative, fs.readFileSync(path.join(a, relative))]));
  assert.throws(() => manager.action('ai_loop.settings.reset_project'), /成员配置|编辑期间发生变化/);
  for (const [relative, content] of externalBytes) assert.deepEqual(fs.readFileSync(path.join(a, relative)), content, `${relative} 外部内容必须保留`);

  configureProfile(a, original, { home, scope: 'project', apply: true });
  await manager.read();
  assert.equal(manager.action('ai_loop.settings.reset_project').status, 'reset', '成员恢复到读取基线后仍可正常恢复默认');
  assert.equal(resolveProfile(a, { home, scope: 'project' }).profile, null);
  assert.equal(resolveProfile(b, { home, scope: 'project' }).profile, null);
  assert.equal(workspaceEntryById(home, 'w').inherits_global, true);
});

test('恢复项目配置后开关草稿仍拒绝外部revision变化', async t => {
  for (const hasProjectOverride of [false, true]) {
    const home = temp(), project = temp();
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
    const global = balanced('codex'); global.roles.dev.model = 'gpt-6-luna';
    configureProfile(project, global, { home, scope: 'global', apply: true });
    if (hasProjectOverride) {
      const local = balanced('codex'); local.roles.dev.model = 'gpt-6.1-sol';
      configureProfile(project, local, { home, scope: 'project', apply: true });
    }
    const manager = createSettingsManager({ home, modelsProvider: modelList });
    await selectWorkspace(manager, home, project);
    setCodexWorkspaceEnabled(home, project, false, 'initial');
    await manager.read();
    await manager.update({ workspace_enabled: true });

    manager.action('ai_loop.settings.reset_project');
    setCodexWorkspaceEnabled(home, project, false, 'external');
    await manager.read();
    await assert.rejects(manager.action('ai_loop.settings.apply'), /工作区配置在编辑期间变化|工作区开关在编辑期间变化/);
    assert.equal(workspaceEntryById(home, project).enabled, false);
    assert.equal(workspaceEntryById(home, project).revision, 'external');
    assert.equal(Boolean(resolveProfile(project, { home, scope: 'project' }).profile), false);
  }
});

test('恢复项目配置后没有开关草稿时可读取新基线并新建保存', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const local = balanced('codex'); local.roles.dev.model = 'gpt-6.1-sol';
  configureProfile(project, local, { home, scope: 'project', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  setCodexWorkspaceEnabled(home, project, false, 'initial');
  await manager.read();
  await manager.update({ 'model.dev': 'gpt-6-luna' });

  manager.action('ai_loop.settings.reset_project');
  setCodexWorkspaceEnabled(home, project, false, 'external');
  assert.equal((await manager.read()).values.workspace_enabled, false);
  await manager.update({ workspace_enabled: true });

  await manager.action('ai_loop.settings.apply');
  assert.equal(workspaceEntryById(home, project).enabled, true);
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile, null);
});

test('损坏全局fallback时恢复项目默认失败且项目配置保持原样', t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  configureProfile(project, balanced('codex'), { home, scope: 'global', apply: true });
  const local = balanced('codex'); local.roles.dev.model = 'gpt-6.1-sol';
  configureProfile(project, local, { home, scope: 'project', apply: true });

  const record = resolveProfile(project, { home, scope: 'project' });
  const files = [...Object.keys(record.native), '.ai-loop/models.json'];
  const before = new Map(files.map(relative => [relative, fs.readFileSync(path.join(project, relative))]));
  fs.writeFileSync(path.join(home, 'ai-loop/models.json'), '{broken');

  assert.throws(() => resetProjectProfile(project, { home, apply: true }), SyntaxError);
  for (const [relative, content] of before) {
    assert.deepEqual(fs.readFileSync(path.join(project, relative)), content, `${relative} 必须保持原样`);
  }
});

test('有项目模型草稿时，全局继承变化仍拒绝覆盖', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  await manager.update({ 'model.dev': 'gpt-6.1-sol' });
  await manager.update({ scope: '全局默认', concurrency: 4 });
  await manager.action('ai_loop.settings.apply');
  await manager.update({ scope: '仅当前工作区' });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /发生变化/);
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile, null);
});

test('全局模型和并发草稿迁移到其他工作区时保留来源基线', async t => {
  for (const field of ['model.dev', 'concurrency']) {
    const home = temp(), first = temp(), second = temp();
    t.after(() => { for (const root of [home, first, second]) fs.rmSync(root, { recursive: true, force: true }); });
    const initial = balanced('codex'); initial.roles.dev.model = 'gpt-6-luna';
    configureProfile(first, initial, { home, scope: 'global', apply: true });
    const manager = createSettingsManager({ home, modelsProvider: modelList });
    await selectWorkspace(manager, home, first);
    addCodexProject(home, second, '目标工作区');
    await manager.update({ scope: 'global' });
    await manager.read();
    await manager.update({ [field]: field === 'model.dev' ? 'gpt-6.1-sol' : 4 });

    const external = balanced('codex');
    external.roles.dev.model = 'gpt-6-luna';
    external.concurrency = 5;
    configureProfile(first, external, { home, scope: 'global', apply: true });
    await manager.update({ workspace_root: second, scope: 'global' });

    await assert.rejects(manager.action('ai_loop.settings.apply'), /配置在编辑期间发生变化/, `${field} 草稿迁移后须保留原模型基线`);
    const saved = resolveProfile(second, { home, scope: 'global' }).profile;
    assert.equal(saved.roles.dev.model, 'gpt-6-luna');
    assert.equal(saved.concurrency, 5);
  }
});

test('没有外部变化时迁移全局草稿仍可保存', async t => {
  const home = temp(), first = temp(), second = temp();
  t.after(() => { for (const root of [home, first, second]) fs.rmSync(root, { recursive: true, force: true }); });
  const initial = balanced('codex'); initial.roles.dev.model = 'gpt-6-luna';
  configureProfile(first, initial, { home, scope: 'global', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, first);
  addCodexProject(home, second, '目标工作区');
  await manager.update({ scope: 'global' });
  await manager.update({ concurrency: 4 });
  await manager.update({ workspace_root: second, scope: 'global' });

  await manager.action('ai_loop.settings.apply');
  assert.equal(resolveProfile(second, { home, scope: 'global' }).profile.concurrency, 4);
});

test('全局草稿迁移保留目标工作区开关基线', async t => {
  const home = temp(), first = temp(), second = temp();
  t.after(() => { for (const root of [home, first, second]) fs.rmSync(root, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, first);
  addCodexProject(home, second, '目标工作区');
  setCodexWorkspaceEnabled(home, first, false, 'first');
  setCodexWorkspaceEnabled(home, second, false, 'second');
  await manager.update({ scope: 'global' });
  await manager.update({ workspace_enabled: true });
  await manager.update({ workspace_root: second, scope: 'global' });
  await manager.update({ workspace_enabled: true });
  await manager.update({ workspace_root: first, scope: 'global' });
  await manager.update({ concurrency: 4 });

  await manager.update({ workspace_root: second, scope: 'global' });
  setCodexWorkspaceEnabled(home, second, false, 'external-second');
  await assert.rejects(manager.action('ai_loop.settings.apply'), /工作区配置在编辑期间变化|工作区开关在编辑期间变化/);
  assert.equal(workspaceEntryById(home, second).revision, 'external-second');
  assert.equal(workspaceEntryById(home, second).enabled, false);
});

test('全局迁移遇到目标模型草稿时保留目标草稿和基线', async t => {
  const home = temp(), first = temp(), second = temp();
  t.after(() => { for (const root of [home, first, second]) fs.rmSync(root, { recursive: true, force: true }); });
  const initial = balanced('codex'); initial.roles.dev.model = 'gpt-6-luna';
  configureProfile(first, initial, { home, scope: 'global', apply: true });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, second);
  addCodexProject(home, first, '来源工作区');
  await manager.update({ scope: 'global', 'model.dev': 'gpt-6.1-sol' });
  await manager.update({ workspace_root: first, scope: 'global' });
  await manager.update({ concurrency: 4 });
  await manager.update({ workspace_root: second, scope: 'global' });

  const view = await manager.read();
  assert.equal(view.values['model.dev'], 'gpt-6.1-sol', '目标模型草稿保留');
  assert.equal(view.values.concurrency, initial.concurrency, '来源并发草稿不混入已有目标模型草稿');
  await manager.action('ai_loop.settings.apply');
  const saved = resolveProfile(second, { home, scope: 'global' }).profile;
  assert.equal(saved.roles.dev.model, 'gpt-6.1-sol');
  assert.equal(saved.concurrency, initial.concurrency);
});

test('外部模型配置变化后读取刷新模型基线，仅保存工作区开关成功', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  await manager.read();

  const external = balanced('codex');
  external.concurrency = 5;
  configureProfile(project, external, { home, scope: 'global', apply: true });
  await manager.read();
  await manager.update({ workspace_enabled: true });

  const applied = await manager.action('ai_loop.settings.apply');
  assert.equal(applied.status, 'unchanged');
  assert.deepEqual(listWorkspaces(home).map(item => [item.root, item.enabled]), [[fs.realpathSync(project), true]]);
});

test('工作区开关草稿跨范围和工作区切换仍检测revision变化', async t => {
  for (const departure of ['scope', 'workspace']) {
    const home = temp(), project = temp(), other = temp();
    t.after(() => { for (const root of [home, project, other]) fs.rmSync(root, { recursive: true, force: true }); });
    const manager = createSettingsManager({ home, modelsProvider: modelList });
    await selectWorkspace(manager, home, project);
    addCodexProject(home, other, '另一个项目');
    setCodexWorkspaceEnabled(home, project, false, 'initial');
    await manager.read();
    await manager.update({ workspace_enabled: true });

    if (departure === 'scope') await manager.update({ scope: 'global' });
    else await manager.update({ workspace_root: other });

    const external = balanced('codex');
    external.concurrency = 5;
    configureProfile(project, external, { home, scope: 'global', apply: true });
    setCodexWorkspaceEnabled(home, project, false, 'external');
    await manager.read();

    if (departure === 'scope') await manager.update({ scope: 'project' });
    else await manager.update({ workspace_root: project });

    await assert.rejects(manager.action('ai_loop.settings.apply'), /工作区配置在编辑期间变化|工作区开关在编辑期间变化/, `${departure}切换返回后仍须发现开关revision变化`);
    assert.equal(workspaceEntryById(home, project).enabled, false);
    assert.equal(workspaceEntryById(home, project).revision, 'external', '拒绝保存后保留外部revision');
  }
});

test('无工作区草稿时读取外部开关后新草稿使用最新基线', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  setCodexWorkspaceEnabled(home, project, false, 'initial');
  await manager.read();

  setCodexWorkspaceEnabled(home, project, false, 'external');
  assert.equal((await manager.read()).values.workspace_enabled, false);
  await manager.update({ workspace_enabled: true });

  const applied = await manager.action('ai_loop.settings.apply');
  assert.equal(applied.status, 'unchanged');
  assert.equal(workspaceEntryById(home, project).enabled, true);
});

test('统一应用同时保存工作区开关，关闭或开启都不需要无故查询模型', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  await manager.update({ scope: 'project', workspace_enabled: true });
  await manager.action('ai_loop.settings.apply');
  assert.deepEqual(listWorkspaces(home).map(item => [item.root, item.enabled]), [[fs.realpathSync(project), true]]);
  assert.equal((await manager.read()).values.workspace_enabled, true, '统一应用后刷新到已保存开关');
  setCodexWorkspaceEnabled(home, project, false, 'external');
  assert.equal((await manager.read()).values.workspace_enabled, false, '已保存开关草稿不遮盖后续外部变更');
  await manager.update({ concurrency: 2 });
  await manager.action('ai_loop.settings.apply');
  assert.equal(workspaceEntryById(home, project).enabled, false, '仅保存模型或并发不覆写外部开关');
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, false);
});

test('全局模型和工作区启用联合应用时注册表冲突保留外部ID记录与模型文件', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  setCodexWorkspaceEnabled(home, project, false, 'initial');
  await manager.update({ scope: 'global', 'model.dev': 'gpt-6-luna', workspace_enabled: true });
  const before = resolveProfile(project, { home, scope: 'global' }).profile;

  const external = workspaceEntryById(home, project);
  setWorkspaceRecordById(home, { ...external, enabled: false }, { revision: 'external' });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /工作区配置在编辑期间变化/);

  assert.equal(resolveProfile(project, { home, scope: 'global' }).profile, before, '并发冲突不得留下全局模型写入');
  assert.equal(workspaceEntryById(home, project).enabled, false);
  assert.equal(workspaceEntryById(home, project).revision, 'external');
});

test('全局模型已写入但工作区ID登记提交失败时按原字节回滚', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  await manager.update({ scope: 'global', 'model.dev': 'gpt-6-luna', workspace_enabled: true });
  const modelFile = path.join(home, 'ai-loop', 'models.json');
  const agentFile = path.join(home, 'agents', 'loop-dev.toml');
  assert.equal(fs.existsSync(modelFile), false);
  assert.equal(fs.existsSync(agentFile), false);
  fs.mkdirSync(path.join(home, 'ai-loop'), { recursive: true });
  fs.writeFileSync(path.join(home, 'ai-loop', 'workspaces.lock'), 'external lock');

  await assert.rejects(manager.action('ai_loop.settings.apply'), /已有操作持锁/);
  assert.equal(fs.existsSync(modelFile), false);
  assert.equal(fs.existsSync(agentFile), false);
  assert.equal(workspaceEntryById(home, project), null);
});
test('工作区回滚仅允许撤销自己的写入，外部变更保留', t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  setWorkspaceEnabled(home, project, false, { create: true });
  const previous = workspaceEntry(home, project);
  setWorkspaceEnabled(home, project, true, { revision: 'own-write' });
  setWorkspaceEnabled(home, project, false);
  assert.throws(() => restoreWorkspaceEntry(home, project, previous, { expectedRevision: 'own-write', expectedEnabled: true }), /其他进程|外部修改/);
  assert.equal(workspaceEntry(home, project).enabled, false);
});

test('探测子进程模式不查询模型、不允许任何配置写入', async t => {
  const home = temp(), project = temp(), previous = process.env.AI_LOOP_NATIVE_MODEL_PROBE;
  process.env.AI_LOOP_NATIVE_MODEL_PROBE = '1';
  t.after(() => { if (previous === undefined) delete process.env.AI_LOOP_NATIVE_MODEL_PROBE; else process.env.AI_LOOP_NATIVE_MODEL_PROBE = previous; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  let calls = 0;
  const manager = createSettingsManager({ home, project, modelsProvider: async () => { calls++; return modelList(); } });
  await manager.read();
  assert.equal(calls, 0);
  await selectWorkspace(manager, home, project);
  assert.throws(() => manager.action('ai_loop.workspace.toggle'), /禁止写入/);
  await assert.rejects(manager.action('ai_loop.settings.apply'), /禁止写入/);
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false);
});
