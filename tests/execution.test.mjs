import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as loop from '../core/scripts/loop.mjs';
import { recordActivity, dispatchCheck } from '../core/scripts/activity.mjs';
import { bootstrap } from '../core/scripts/memory.mjs';

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'one')); fs.mkdirSync(path.join(root, 'two'));
  fs.writeFileSync(path.join(root, 'one/code.txt'), 'one'); fs.writeFileSync(path.join(root, 'two/code.txt'), 'two');
  loop.create(root, { goal: '原生证据', tasks: [{ id: 't1', title: '独立评审', acceptance: ['证据绑定'], review: 'independent', checks: [{ id: 'c1', command: 'fixture-check' }] }], ...extra }, 'r1');
  const revision = () => loop.cli(['snapshot', '--project', root, '--run', 'r1']);
  const runDir = loop.paths(root, 'r1', extra.project_path).directory;
  const log = path.relative(root, path.join(runDir, 'reports/native.json')).split(path.sep).join('/');
  fs.mkdirSync(path.join(runDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'reports/native.json'), '{"native_id":"child"}');
  const verify = { role: 'tester', task_id: 't1', status: 'PASS', attempt: 1, execution: 'self', revision: revision(), checks: [{ id: 'c1', command: 'fixture-check', exit_code: 0, environment: 'fixture', log: 'reports/native.json' }], issues: [] };
  loop.begin(root, 'r1', 't1', 'development'); loop.begin(root, 'r1', 't1', 'verification'); loop.record(root, 'r1', verify); loop.begin(root, 'r1', 't1', 'review');
  const report = { role: 'reviewer', task_id: 't1', status: 'APPROVED', attempt: 1, execution: 'independent', execution_id: 'exec1', revision: revision(), findings: [], issues: [] };
  const register = (patch = {}, completed = true) => {
    recordActivity(root, 'r1', { id: 'exec1', task: 't1', role: 'reviewer', attempt: 1, harness: 'fixture-only', state: 'requested', native_id: 'child', context: { mode: 'independent', id: 'child-context', parent_id: 'main-context' }, revision: revision(), summary: '隔离夹具调用', ...patch });
    if (completed) recordActivity(root, 'r1', { id: 'exec1', state: 'completed', evidence: { source: 'native-log', path: 'reports/native.json' }, summary: '隔离夹具结束' });
  };
  return { root, report, verify, revision, register, log };
}

test('新建独立任务拒绝零调用、错误执行ID及未结束调用，旧核心会拒绝schema4', t => {
  const f = fixture(t);
  assert.equal(loop.status(f.root, 'r1').schema_version, 4);
  assert.throws(() => loop.record(f.root, 'r1', f.report), /缺少原生执行台账/);
  f.register({}, false);
  assert.throws(() => loop.record(f.root, 'r1', { ...f.report, execution_id: 'missing' }), /不匹配/);
  assert.throws(() => loop.record(f.root, 'r1', f.report), /完成观察/);
});
test('独立任务拒绝不同角色、批次和继承上下文', t => {
  for (const patch of [{ context: { mode: 'inherited', id: 'child', parent_id: 'main' } }, { revision: { algorithm: 'sha256', digest: '0'.repeat(64), files: 0 } }]) {
    const f = fixture(t); f.register(patch);
    assert.throws(() => loop.record(f.root, 'r1', f.report), /父子上下文|快照已过期/);
  }
  const f = fixture(t); f.register();
  assert.throws(() => loop.record(f.root, 'r1', { ...f.report, attempt: 0 }), /attempt/);
});
test('原生证据被改写后拒收；有效报告通过后不能冒充最终整体评审', t => {
  const f = fixture(t); f.register(); fs.appendFileSync(path.join(f.root, f.log), 'tampered');
  assert.throws(() => loop.record(f.root, 'r1', f.report), /证据已变化/);
  const valid = fixture(t); valid.register(); loop.record(valid.root, 'r1', valid.report);
  assert.throws(() => loop.complete(valid.root, 'r1', { verification: valid.verify, review: valid.report }), /任务、角色或 attempt/);
  const attempt = loop.status(valid.root, 'r1').event_seq;
  assert.equal(dispatchCheck(valid.root, 'r1', 'final', 'reviewer', attempt).task.id, 'final');
  recordActivity(valid.root, 'r1', { id: 'final-exec', task: 'final', role: 'reviewer', attempt, harness: 'fixture-only', state: 'requested', native_id: 'final-child', context: { mode: 'independent', id: 'final-context', parent_id: 'main' }, revision: valid.revision(), summary: '整体评审夹具' });
  recordActivity(valid.root, 'r1', { id: 'final-exec', state: 'completed', evidence: { source: 'native-log', path: 'reports/native.json' }, summary: '整体评审结束' });
  loop.complete(valid.root, 'r1', { verification: valid.verify, review: { ...valid.report, task_id: 'final', attempt, execution_id: 'final-exec' } });
  assert.equal(loop.status(valid.root, 'r1').status, 'complete');
});
test('同一代码快照重测会递增批次，旧独立执行不得复用', t => {
  const f = fixture(t); f.register(); loop.record(f.root, 'r1', f.report);
  loop.begin(f.root, 'r1', 't1', 'verification'); loop.record(f.root, 'r1', { ...f.verify, attempt: 2 }); loop.begin(f.root, 'r1', 't1', 'review');
  assert.throws(() => loop.record(f.root, 'r1', { ...f.report, attempt: 2 }), /attempt 不匹配/);
});
test('子项目快照隔离兄弟修改，显式共享依赖参与快照；恢复支持子项目筛选', t => {
  const f = fixture(t, { project_path: 'one' }); const before = f.revision();
  fs.appendFileSync(path.join(f.root, 'two/code.txt'), 'changed'); assert.deepEqual(f.revision(), before);
  fs.appendFileSync(path.join(f.root, 'one/code.txt'), 'changed'); assert.notDeepEqual(f.revision(), before);
  assert.equal(bootstrap(f.root, { intent: 'continue', project_path: 'one' }).selected.run_id, 'r1');
  assert.equal(bootstrap(f.root, { intent: 'continue', project_path: 'two' }).active_count, 0);
  assert.equal(loop.listRuns(f.root, { project_path: 'one' })[0].project_path, 'one');
  const shared = fixture(t, { project_path: 'one', snapshot_paths: ['one', 'two'] }); const revision = shared.revision();
  fs.appendFileSync(path.join(shared.root, 'two/code.txt'), 'shared'); assert.notDeepEqual(shared.revision(), revision);
  assert.throws(() => loop.validateSpec({ goal: '拒绝元数据', tasks: [{ id: 't', title: 't', acceptance: ['a'], review: 'none', checks: [{ id: 'c', command: 'c' }] }], project_path: '.ai-loop' }), /元数据/);
  if (process.platform === 'win32') {
    const upper = fixture(t, { project_path: 'ONE' }); const original = upper.revision();
    fs.appendFileSync(path.join(upper.root, 'one/code.txt'), 'case'); assert.notDeepEqual(upper.revision(), original);
  }
});
