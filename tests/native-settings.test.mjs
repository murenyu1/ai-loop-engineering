import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsManager } from '../plugins/codex/scripts/native-settings.mjs';
import { balanced } from '../scripts/routing.mjs';
import { configureProfile, resetProjectProfile, resolveProfile } from '../plugins/codex/scripts/profiles.mjs';
import { listWorkspaces } from '../scripts/workspaces.mjs';
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
  assert.deepEqual(result.schema.properties['model.dev'].enum, ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.equal(result.values['model.dev'], 'gpt-6-luna');
  assert.ok(result.layout.some(group => group.items.some(item => item.tool === 'ai_loop.settings.apply')));
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false, 'read 不应创建持久化目录');
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
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6-luna', '全局草稿不带入项目');
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
    assert.deepEqual(manager.getSelection(), { scope: 'global', selectedRoot: '' });
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
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6-luna', 'B沿用global/default，没有继承A草稿');
  await manager.update({ workspace_root: fs.realpathSync(projectA) });
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6.1-sol', 'A草稿仍绑定A');
});

test('project scope 可显式应用并安全恢复到全局继承', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  await selectWorkspace(manager, home, project);
  await manager.update({ scope: 'global' });
  await manager.action('ai_loop.settings.apply');
  await manager.update({ scope: 'project', 'model.dev': 'gpt-6.1-sol' });
  await manager.action('ai_loop.settings.apply');
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile.roles.dev.model, 'gpt-6.1-sol');
  await manager.update({ scope: 'project' });
  manager.action('ai_loop.settings.reset_project');
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile, null);
  assert.equal(resolveProfile(project, { home }).scope, 'global');
  assert.deepEqual(listWorkspaces(home), [], '保存模型和恢复继承不登记或启用工作区');
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

test('模型保存保留独立的开关草稿，模型应用本身不会启用工作区', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  await selectWorkspace(manager, home, project);
  await manager.update({ scope: 'project', workspace_enabled: true });
  await manager.action('ai_loop.settings.apply');
  assert.deepEqual(listWorkspaces(home), []);
  assert.equal((await manager.read()).values.workspace_enabled, true, '保留尚未应用的开关草稿');
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, true);
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
