import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rolesStatus, roleEnabled, effectiveRoles, configureRoles, cli as rolesCli } from '../scripts/roles.mjs';
import { disabledProfile, balanced, upgradeProfile, validateProfile, routeHash, nativeAgent } from '../scripts/routing.mjs';
import { create, begin, finish, status, stop } from '../scripts/loop.mjs';
import { dispatchCheck, recordActivity, activityStatus, cli as activityCli } from '../scripts/activity.mjs';

function fixture(t, role_policy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = { goal: '角色控制', ...(role_policy ? { role_policy } : {}), tasks: [{ id: 't1', title: '修改', managed_execution: true, acceptance: ['可验证'], review: 'independent', checks: [{ id: 'c', command: 'node --version' }] }] };
  create(root, spec, 'r1');
  return root;
}
test('无配置默认关闭；项目显式 false 优先于全局模型，旧显式模型保留', t => {
  const root = fixture(t);
  assert.ok(Object.values(rolesStatus(root).roles).every(role => !role.enabled));
  assert.equal(roleEnabled({}), false);
  assert.equal(roleEnabled({ model: 'existing' }), true);
  assert.equal(roleEnabled({ enabled: false, model: 'existing' }), false);
  assert.equal(effectiveRoles({ dev: { enabled: false } }, { dev: { enabled: true, model: 'm' } }).dev.enabled, false);
  assert.throws(() => activityCli(['check', '--project', root, '--run', 'r1', '--task', 't1', '--role', 'dev']), /默认关闭/);
});
test('关闭不要求模型可用，保存草稿及乐观并发校验有效', t => {
  const root = fixture(t);
  const input = { schema_version: 2, roles: { dev: { enabled: false, model: 'old-unavailable-model' } } };
  assert.equal(configureRoles(root, input).status, 'dry-run');
  assert.equal(rolesStatus(root).hash, null);
  configureRoles(root, input, { apply: true, expected_hash: null });
  assert.equal(rolesStatus(root).roles.dev.model, 'old-unavailable-model');
  assert.throws(() => configureRoles(root, input, { apply: true, expected_hash: null }), /已变化/);
  assert.throws(() => configureRoles(root, { schema_version: 2, roles: { dev: { enabled: true } } }), /明确选择模型/);
  const before = rolesStatus(root).hash;
  rolesCli(['set', '--project', root, '--role', 'dev', '--enabled', 'true', '--model', 'chosen', '--apply']);
  assert.notEqual(rolesStatus(root).hash, before);
  assert.equal(rolesStatus(root).roles.dev.enabled, true);
});
test('Codex schema1 摘要保留，schema2 关闭策略旧校验器会拒绝', () => {
  const legacy = balanced('codex'), hash = routeHash(legacy);
  assert.equal(routeHash(validateProfile(legacy, 'codex')), hash);
  const off = disabledProfile('codex');
  assert.equal(off.schema_version, 2);
  assert.ok(Object.values(off.roles).every(role => !role.enabled && role.model === null));
  assert.throws(() => nativeAgent(off, 'dev'), /已关闭/);
  const migrated = upgradeProfile(legacy);
  assert.ok(Object.values(migrated.roles).every(role => role.enabled));
  migrated.roles.dev.enabled = false;
  assert.equal(validateProfile(migrated, 'codex').roles.dev.model, legacy.roles.dev.model);
});
test('带角色策略的新运行使用 schema3，开发和finish可写，关闭策略不能篡改为旧格式', t => {
  const root = fixture(t, { dev: { enabled: true, model: 'm' }, reviewer: { enabled: false } });
  const file = path.join(root, '.ai-loop/runs/r1/state.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).schema_version, 3);
  begin(root, 'r1', 't1', 'development');
  assert.equal(dispatchCheck(root, 'r1', 't1', 'dev').task.phase, 'developing');
  assert.throws(() => dispatchCheck(root, 'r1', 't1', 'reviewer'), /已关闭/);
  finish(root, 'r1', 't1');
  assert.equal(status(root, 'r1').tasks[0].phase, 'developed');
  const state = JSON.parse(fs.readFileSync(file)); state.schema_version = 2;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => status(root, 'r1'), /schema 3/);
});
test('派发检查拒绝错误阶段及旧 attempt，终止运行不能新派发', t => {
  const root = fixture(t);
  assert.throws(() => dispatchCheck(root, 'r1', 't1', 'dev'), /阶段/);
  begin(root, 'r1', 't1', 'development');
  begin(root, 'r1', 't1', 'verification');
  assert.throws(() => dispatchCheck(root, 'r1', 't1', 'tester'), /attempt/);
  assert.throws(() => dispatchCheck(root, 'r1', 't1', 'tester', 0), /attempt/);
  assert.equal(dispatchCheck(root, 'r1', 't1', 'tester', 1).attempt, 1);
  stop(root, 'r1', '测试已完成');
  assert.throws(() => dispatchCheck(root, 'r1', 't1', 'tester', 1), /关闭或停止/);
});
test('观察关联真实ID、阻止重复执行、待停止不冒充停止，completed不改任务结果', t => {
  const root = fixture(t);
  begin(root, 'r1', 't1', 'development');
  const request = { id: 'a1', task: 't1', role: 'dev', harness: 'test-fixture', state: 'requested', summary: '确定性夹具，非真实代理' };
  recordActivity(root, 'r1', request);
  assert.throws(() => recordActivity(root, 'r1', { ...request, id: 'a2' }), /未确认停止/);
  assert.throws(() => recordActivity(root, 'r1', { id: 'a1', state: 'running', summary: '无ID' }), /真实原生/);
  recordActivity(root, 'r1', { id: 'a1', native_id: 'fixture-child', state: 'running', summary: '夹具状态' });
  recordActivity(root, 'r1', { id: 'a1', state: 'stop_requested', summary: '请求停止但未确认' });
  assert.equal(activityStatus(root, 'r1').agents[0].state, 'stop_requested');
  assert.equal(activityStatus(root, 'r1').agents[0].observation.summary, '请求停止但未确认');
  assert.equal(activityStatus(root, 'r1').agents[0].usage, null);
  recordActivity(root, 'r1', { id: 'a1', state: 'completed', summary: '夹具结束' });
  assert.equal(status(root, 'r1').tasks[0].phase, 'developing');
  assert.throws(() => recordActivity(root, 'r1', { id: 'a1', state: 'running', summary: '非法重开' }), /终态/);
  assert.equal(activityStatus(root, 'r1').agents[0].live, false);
});
test('观察不接受伪造token估计，外部ID和路径受限，已有权限策略关闭会阻断', t => {
  const root = fixture(t);
  begin(root, 'r1', 't1', 'development');
  const input = { id: 'a1', task: 't1', role: 'dev', harness: 'fixture', state: 'requested', summary: '夹具' };
  assert.throws(() => recordActivity(root, '../escape', input), /编号/);
  assert.throws(() => recordActivity(root, 'r1', { ...input, usage: { estimated_tokens: 12 } }), /实际计数/);
  configureRoles(root, { schema_version: 2, roles: {} }, { apply: true });
  assert.throws(() => recordActivity(root, 'r1', input), /已关闭/);
});
test('停止运行后允许已有原生执行者确认终态，不允许重开或新增', t => {
  const root = fixture(t);
  begin(root, 'r1', 't1', 'development');
  recordActivity(root, 'r1', { id: 'a1', task: 't1', role: 'dev', harness: 'fixture', state: 'requested', summary: '夹具' });
  recordActivity(root, 'r1', { id: 'a1', state: 'running', native_id: 'fixture-native', summary: '夹具' });
  stop(root, 'r1', '用户停止');
  assert.throws(() => recordActivity(root, 'r1', { id: 'a2', task: 't1', role: 'dev', harness: 'fixture', state: 'requested', summary: '不应启动' }), /关闭运行/);
  recordActivity(root, 'r1', { id: 'a1', state: 'stopped', summary: '原生已确认停止' });
  assert.equal(activityStatus(root, 'r1').agents[0].state, 'stopped');
  assert.equal(status(root, 'r1').status, 'stopped');
});
test('旧台账不确定执行者也阻止迁移后重复派发', t => {
  const root = fixture(t);
  begin(root, 'r1', 't1', 'development');
  fs.writeFileSync(path.join(root, '.ai-loop/runs/r1/agents.json'), JSON.stringify({ schema_version: 1, agents: [{ id: 'legacy', task: 't1', role: 'dev', state: 'requested', native_id: null }] }));
  assert.throws(() => recordActivity(root, 'r1', { id: 'new', task: 't1', role: 'dev', harness: 'fixture', state: 'requested', summary: '未知旧执行者不能重派' }), /未确认停止/);
});
