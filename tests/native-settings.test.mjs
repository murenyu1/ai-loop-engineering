import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsManager } from '../plugins/codex/scripts/native-settings.mjs';
import { balanced } from '../scripts/routing.mjs';
import { configureProfile, resolveProfile } from '../plugins/codex/scripts/profiles.mjs';
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
function selectWorkspace(manager, home, project) {
  addCodexProject(home, project);
  manager.update({ workspace_root: project });
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
  manager.update({ workspace_root: choice, scope: 'project' });
  const view = await manager.read();
  assert.equal(view.values.workspace_root, choice);
  assert.equal(view.values.workspace_enabled, false);
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false, '读取和选择不写登记');
  assert.equal(fs.existsSync(path.join(project, '.ai-loop')), false, '选择不写项目');
  assert.deepEqual(fs.readFileSync(stateFile), before, '不写回 Codex 状态');
  assert.throws(() => manager.action('ai_loop.workspace.register'), /未知设置动作/);
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, false, '应用默认开关不会启用');
  manager.update({ workspace_enabled: true });
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, true);
});

test('范围中文显示，切换工作区默认项目；明确选择全局时保留', async t => {
  const home = temp(), a = temp(), b = temp();
  t.after(() => { for (const root of [home, a, b]) fs.rmSync(root, { recursive: true, force: true }); });
  addCodexProject(home, a, '甲'); addCodexProject(home, b, '乙');
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  assert.deepEqual((await manager.read()).schema.properties.scope.enum, ['全局默认', '仅当前工作区']);
  manager.update({ 'model.dev': 'gpt-6.1-sol' });
  manager.update({ workspace_root: a });
  assert.equal(manager.getSelection().scope, 'project');
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6-luna', '全局草稿不带入项目');
  manager.update({ scope: '全局默认' });
  manager.update({ workspace_root: a });
  assert.equal((await manager.read()).values.scope, '全局默认', '相同工作区刷新不重置显式范围');
  manager.update({ workspace_root: b });
  assert.equal((await manager.read()).values.scope, '仅当前工作区');
  manager.update({ workspace_root: a, scope: '全局默认' });
  assert.equal(manager.getSelection().scope, 'global', '同时明确指定范围时尊重选择');
  manager.update({ workspace_root: '' });
  assert.equal((await manager.read()).values.scope, '全局默认');
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6.1-sol', '未选工作区的全局草稿仍保留');
});

test('默认项目范围保存不修改全局默认，中文范围仍支持分别保存', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  selectWorkspace(manager, home, project);
  manager.update({ 'model.dev': 'gpt-6.1-sol' });
  const local = await manager.action('ai_loop.settings.apply');
  assert.match(local.message, /仅当前工作区/);
  assert.equal(resolveProfile(project, { home, scope: 'global' }).profile, null);
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile.roles.dev.model, 'gpt-6.1-sol');
  manager.update({ scope: '全局默认', concurrency: 4 });
  assert.match((await manager.action('ai_loop.settings.apply')).message, /全局默认/);
  assert.equal(resolveProfile(project, { home, scope: 'global' }).profile.concurrency, 4);
  manager.update({ scope: '仅当前工作区' });
  assert.equal((await manager.read()).values.concurrency, 3, '项目覆盖仍独立');
});

test('工作区选择、开关和模型草稿仅在显式应用时写入', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  selectWorkspace(manager, home, project);
  assert.deepEqual(listWorkspaces(home), []);
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, false, '无草稿时应用当前停用状态');
  manager.update({ workspace_enabled: false });
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, false);
  manager.update({ workspace_enabled: true });
  assert.equal(manager.action('ai_loop.workspace.toggle').enabled, true);
  manager.update({ scope: 'global', 'model.dev': 'gpt-6.1-sol', 'effort.dev': 'high', concurrency: 4 });
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
  selectWorkspace(manager, home, project);
  manager.update({ scope: 'global', 'model.dev': 'missing-model' });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /不在当前本机模型列表/);
  manager.update({ 'model.dev': 'gpt-6-luna', 'effort.dev': 'ultra' });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /不支持思考深度/);

  const concurrent = createSettingsManager({ home, project, modelsProvider: modelList });
  await concurrent.read();
  concurrent.update({ workspace_root: fs.realpathSync(project), scope: 'global', concurrency: 4 });
  const external = balanced('codex'); external.concurrency = 5;
  configureProfile(project, external, { home, scope: 'global', apply: true });
  await assert.rejects(concurrent.action('ai_loop.settings.apply'), /发生变化/);
});

test('换模型后按新模型刷新思考深度；原深度不支持时明确展示并拒绝应用', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  selectWorkspace(manager, home, project);
  manager.update({ 'effort.dev': 'xhigh' });
  manager.update({ 'model.dev': 'gpt-6-luna' });
  const view = await manager.read();
  assert.deepEqual(view.schema.properties['effort.dev'].enum, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(view.values['effort.dev'], 'xhigh', '保留原始草稿，显式提示用户改选');
  assert.match(view.schema.properties['effort.dev'].description, /不受支持/);
  assert.match(view.layout.at(-1).title, /需修正思考深度：dev/);
  await assert.rejects(manager.action('ai_loop.settings.apply'), /不支持思考深度 xhigh/);
  manager.update({ 'effort.dev': 'medium' });
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

test('update 全量预检后再改状态；非法partial set不会部分切换scope', () => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  try {
    assert.throws(() => manager.update({ scope: 'project', concurrency: 9 }), /并发值须为 1–8/);
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
  assert.throws(() => manager.update({ workspace_root: alias }), /只能选择/);
});

test('project切换不会把A的模型草稿带到B，切回A仍保留A草稿', async t => {
  const home = temp(), projectA = temp(), projectB = temp();
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(projectA, { recursive: true, force: true }); fs.rmSync(projectB, { recursive: true, force: true }); });
  selectWorkspace(manager, home, projectA);
  manager.update({ scope: 'project', 'model.dev': 'gpt-6.1-sol' });
  selectWorkspace(manager, home, projectB);
  assert.equal(manager.getSelection().selectedRoot, fs.realpathSync(projectB));
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6-luna', 'B沿用global/default，没有继承A草稿');
  manager.update({ workspace_root: fs.realpathSync(projectA) });
  assert.equal((await manager.read()).values['model.dev'], 'gpt-6.1-sol', 'A草稿仍绑定A');
});

test('project scope 可显式应用并安全恢复到全局继承', async t => {
  const home = temp(), project = temp();
  const manager = createSettingsManager({ home, project, modelsProvider: modelList });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  selectWorkspace(manager, home, project);
  manager.update({ scope: 'global' });
  await manager.action('ai_loop.settings.apply');
  manager.update({ scope: 'project', 'model.dev': 'gpt-6.1-sol' });
  await manager.action('ai_loop.settings.apply');
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile.roles.dev.model, 'gpt-6.1-sol');
  manager.update({ scope: 'project' });
  manager.action('ai_loop.settings.reset_project');
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile, null);
  assert.equal(resolveProfile(project, { home }).scope, 'global');
  assert.deepEqual(listWorkspaces(home), [], '保存模型和恢复继承不登记或启用工作区');
});

test('有项目模型草稿时，全局继承变化仍拒绝覆盖', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  selectWorkspace(manager, home, project);
  manager.update({ 'model.dev': 'gpt-6.1-sol' });
  manager.update({ scope: '全局默认', concurrency: 4 });
  await manager.action('ai_loop.settings.apply');
  manager.update({ scope: '仅当前工作区' });
  await assert.rejects(manager.action('ai_loop.settings.apply'), /发生变化/);
  assert.equal(resolveProfile(project, { home, scope: 'project' }).profile, null);
});

test('模型保存保留独立的开关草稿，模型应用本身不会启用工作区', async t => {
  const home = temp(), project = temp();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const manager = createSettingsManager({ home, modelsProvider: modelList });
  selectWorkspace(manager, home, project);
  manager.update({ scope: 'project', workspace_enabled: true });
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
  selectWorkspace(manager, home, project);
  assert.throws(() => manager.action('ai_loop.workspace.toggle'), /禁止写入/);
  await assert.rejects(manager.action('ai_loop.settings.apply'), /禁止写入/);
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false);
});
