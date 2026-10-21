import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexWorkspaces } from '../plugins/codex/scripts/codex-workspaces.mjs';
import { registerWorkspace } from '../scripts/workspaces.mjs';
import { createSettingsManager } from '../plugins/codex/scripts/native-settings.mjs';

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-picker-'));
  const home = path.join(parent, 'home'), a = path.join(parent, 'a'), b = path.join(parent, 'b');
  for (const root of [home, a, b]) fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const stateFile = path.join(home, '.codex-global-state.json');
  return { parent, home, a, b, stateFile, save: state => fs.writeFileSync(stateFile, JSON.stringify(state)) };
}

test('读取 Codex 项目名称、多根目录及旧根列表，去重并保留启用状态', t => {
  const f = fixture(t);
  f.save({ 'local-projects': { a: { name: '项目甲', rootPaths: [f.a, f.b] } }, 'electron-saved-workspace-roots': [f.a, 'relative', path.join(f.parent, 'missing')], 'active-workspace-roots': [f.b] });
  registerWorkspace(f.home, f.a);
  const before = fs.readFileSync(f.stateFile);
  const result = readCodexWorkspaces(f.home);
  assert.equal(result.error, '');
  assert.deepEqual(result.workspaces.map(item => [item.label, item.root, item.enabled]), [['项目甲', f.a, true], ['项目甲', f.b, false]]);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('状态缺失、损坏或格式变化明确提示，保留旧登记且不修写文件', t => {
  const f = fixture(t);
  registerWorkspace(f.home, f.a, { enabled: false });
  assert.match(readCodexWorkspaces(f.home).error, /不存在/);
  for (const content of ['{broken', '{"local-projects":[]}', '{"local-projects":{"id":{"name":"a"}}}', '{}']) {
    fs.writeFileSync(f.stateFile, content);
    const result = readCodexWorkspaces(f.home);
    assert.match(result.error, /无法读取 Codex 工作区列表/);
    assert.equal(result.workspaces.length, 1);
    assert.equal(result.workspaces[0].root, f.a);
    assert.equal(result.workspaces[0].enabled, false);
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), content);
  }
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
