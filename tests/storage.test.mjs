import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as loop from '../scripts/loop.mjs';
import { runPaths, newRunBase } from '../scripts/storage.mjs';
import { recordActivity, activityStatus, dispatchCheck } from '../scripts/activity.mjs';
import { bootstrap, checkpoint, readHandoff, save, inspect } from '../scripts/memory.mjs';
import { chatHistory } from '../scripts/dashboard.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['one', 'two', 'nested/app']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'code.txt'), name);
  }
  return root;
}
const spec = project_path => ({ goal: '项目边界验收', project_path, tasks: [{ id: 't', title: '任务', review: 'none', acceptance: ['隔离'], checks: [{ id: 'c', command: 'fixture' }] }] });

test('同名运行的写入、信箱、事件、状态及CLI均按项目隔离', t => {
  const root = fixture(t);
  for (const project_path of ['one', 'two']) {
    const options = { project_path };
    loop.create(root, spec(project_path), 'same');
    loop.cli(['begin', '--project', root, '--run', 'same', '--project-path', project_path, '--task', 't', '--phase', 'development']);
    loop.event(root, 'same', { type: 'decision', summary: project_path }, options);
    loop.mail(root, 'same', { task_id: 't', from_role: 'dev', to_role: 'tester', type: 'handoff', subject: project_path, payload: {} }, options);
    assert.equal(loop.inbox(root, 'same', { role: 'tester' }, options).messages[0].subject, project_path);
    assert.equal(loop.events(root, 'same', 0, 100, options).events.find(e => e.type === 'decision').summary, project_path);
    assert.equal(loop.status(root, 'same', options).project_path, project_path);
    loop.finish(root, 'same', 't', options);
  }
  assert.throws(() => loop.status(root, 'same'), /多个项目/);
  assert.equal(loop.listRuns(root).length, 2);
  assert.ok(fs.existsSync(path.join(root, 'one/.ai-loop/runs/same/state.json')));
  assert.ok(!fs.existsSync(path.join(root, '.ai-loop/runs/same/state.json')));
});

test('同名运行的交接可独立保存恢复，启动分页不漏项目', t => {
  const root = fixture(t);
  for (const project_path of ['one', 'two']) {
    loop.create(root, spec(project_path), 'same');
    const boot = bootstrap(root, { project_path, intent: 'continue' });
    const info = boot.runs[0].checkpoint;
    checkpoint(root, 'same', { base_cursor: info.event_cursor, expected_session_hash: info.expected_hash, event_cursor: info.event_head, intent: project_path, constraints: [], decisions: [], open_questions: [], next_steps: ['继续核对代码'], references: [], changes: [] }, { project_path });
    assert.match(readHandoff(root, 'same', { project_path }).content, new RegExp(project_path));
  }
  const first = bootstrap(root, { intent: 'continue', limit: 1 });
  const second = bootstrap(root, { intent: 'continue', limit: 1, after: first.next_after });
  assert.equal(first.needs_choice, true);
  assert.ok(first.next_after);
  assert.deepEqual(new Set([...first.runs, ...second.runs].map(r => r.project_path)), new Set(['one', 'two']));
  assert.equal(second.next_after, null);
});

test('同名运行的独立执行证据与整体验收始终归属正确项目', t => {
  const root = fixture(t);
  for (const project_path of ['one', 'two']) {
    const options = { project_path };
    loop.create(root, spec(project_path), 'same');
    loop.begin(root, 'same', 't', 'development', options);
    loop.begin(root, 'same', 't', 'verification', options);
    const files = runPaths(root, 'same', project_path);
    fs.writeFileSync(path.join(files.directory, 'reports/test.log'), project_path);
    const revision = loop.snapshot(root, [], undefined, [project_path]);
    recordActivity(root, 'same', { id: 'test', task: 't', role: 'tester', harness: 'fixture', attempt: 0, state: 'requested', native_id: project_path + '-native', context: { mode: 'independent', id: project_path + '-child', parent_id: 'parent' }, revision, summary: '证据夹具' }, options);
    recordActivity(root, 'same', { id: 'test', state: 'completed', evidence: { source: 'native-log', path: 'reports/test.log' }, summary: '完成' }, options);
    assert.equal(activityStatus(root, 'same', options).agents[0].native_id, project_path + '-native');
    const report = { role: 'tester', task_id: 't', status: 'PASS', execution: 'independent', execution_id: 'test', revision, issues: [], checks: [{ id: 'c', command: 'fixture', environment: '隔离测试夹具', exit_code: 0, log: 'reports/test.log' }] };
    loop.record(root, 'same', report, options);
    loop.complete(root, 'same', { verification: { ...report, execution: 'self' } }, options);
    assert.equal(loop.status(root, 'same', options).status, 'complete');
  }
});

test('同时间同编号的聊天历史可跨项目分页并过滤', t => {
  const root = fixture(t);
  for (const project_path of ['one', 'two']) {
    loop.create(root, spec(project_path), 'same');
    loop.begin(root, 'same', 't', 'development', { project_path });
    const file = runPaths(root, 'same', project_path).state;
    const state = JSON.parse(fs.readFileSync(file)); state.created_at = '2026-10-26T00:00:00.000Z'; fs.writeFileSync(file, JSON.stringify(state));
    recordActivity(root, 'same', { id: 'dev', task: 't', role: 'dev', harness: 'codex', state: 'requested', context: { mode: 'independent', id: project_path, parent_id: 'chat' }, summary: project_path }, { project_path });
  }
  const first = chatHistory(root, { session_id: 'chat', harness: 'codex', limit: 1 });
  const second = chatHistory(root, { session_id: 'chat', harness: 'codex', limit: 1, after: first.next_after });
  assert.deepEqual(new Set([...first.rounds, ...second.rounds].map(r => r.run.project_path)), new Set(['one', 'two']));
  assert.equal(chatHistory(root, { session_id: 'chat', harness: 'codex', project_path: 'one' }).rounds.length, 1);
});

test('多个本项目快照目录仍本地存储，跨项目才集中，嵌套项目可发现', t => {
  const root = fixture(t);
  assert.equal(newRunBase(root, { project_path: 'one', snapshot_paths: ['one/src', 'one/tests'] }), path.join(root, 'one'));
  assert.equal(newRunBase(root, { project_path: 'one', snapshot_paths: ['one', 'two'] }), root);
  loop.create(root, spec('nested/app'), 'nested');
  assert.equal(loop.listRuns(root).find(r => r.run_id === 'nested').project_path, 'nested/app');
  assert.throws(() => loop.create(root, spec('nested/app'), 'nested'), /已存在/);
});

test('旧集中记录不迁移且子项目元数据不改变代码快照', t => {
  const root = fixture(t);
  loop.create(root, { ...spec('one'), snapshot_paths: ['one', 'two'] }, 'legacy');
  const before = loop.snapshot(root, [], undefined, ['one']);
  const workspaceBefore = loop.snapshot(root);
  loop.create(root, spec('one'), 'local');
  assert.deepEqual(loop.snapshot(root, [], undefined, ['one']), before);
  assert.deepEqual(loop.snapshot(root), workspaceBefore);
  assert.equal(runPaths(root, 'legacy', 'one').base, root);
  assert.equal(runPaths(root, 'local', 'one').base, path.join(root, 'one'));
  assert.throws(() => loop.create(root, spec('one'), 'legacy'), /已存在/);
});

test('planner和scribe不能借正式任务run同名绕过角色边界', t => {
  const root = fixture(t), input = spec('.'); input.tasks[0].id = 'run';
  loop.create(root, input, 'legacy'); loop.begin(root, 'legacy', 'run', 'development');
  for (const role of ['planner', 'scribe']) assert.throws(() => dispatchCheck(root, 'legacy', 'run', role), /不能挂到正式任务/);
});

test('子目录独立工作区的旧本地记录不归父工作区，原根可继续读取且不改记录', t => {
  const root = fixture(t), child = path.join(root, 'one');
  loop.create(child, spec('.'), 'standalone');
  const files = runPaths(child, 'standalone');
  const before = [files.spec, files.state, files.events].map(file => fs.readFileSync(file));
  loop.create(root, spec('two'), 'workspace');
  assert.deepEqual(loop.listRuns(root).map(run => run.run_id), ['workspace']);
  assert.equal(bootstrap(root, { intent: 'continue' }).selected.run_id, 'workspace');
  assert.throws(() => loop.status(root, 'standalone'), /运行不存在/);
  assert.equal(loop.status(child, 'standalone').run_id, 'standalone');
  assert.equal(bootstrap(child, { intent: 'continue' }).selected.run_id, 'standalone');
  for (const [index, file] of [files.spec, files.state, files.events].entries()) assert.deepEqual(fs.readFileSync(file), before[index]);
});

test('集中存储拒绝跨项目覆盖且保留状态、事件、报告和中断目录', t => {
  const root = fixture(t);
  loop.create(root, { ...spec('one'), snapshot_paths: ['one', 'two'] }, 'same');
  loop.event(root, 'same', { type: 'decision', summary: '必须保留' }, { project_path: 'one' });
  const files = runPaths(root, 'same', 'one');
  fs.writeFileSync(path.join(files.directory, 'reports/evidence.log'), '原始证据');
  const state = fs.readFileSync(files.state), events = fs.readFileSync(files.events);
  assert.throws(() => loop.create(root, { ...spec('two'), snapshot_paths: ['one', 'two'] }, 'same'), /目标运行目录已存在/);
  assert.deepEqual(fs.readFileSync(files.state), state);
  assert.deepEqual(fs.readFileSync(files.events), events);
  assert.equal(fs.readFileSync(path.join(files.directory, 'reports/evidence.log'), 'utf8'), '原始证据');
  assert.equal(loop.status(root, 'same', { project_path: 'one' }).project_path, 'one');
  fs.mkdirSync(path.join(root, 'one/.ai-loop/runs/interrupted/reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'one/.ai-loop/runs/interrupted/reports/partial.log'), '中断现场');
  assert.throws(() => loop.create(root, spec('one'), 'interrupted'), /中断现场/);
  assert.equal(fs.readFileSync(path.join(root, 'one/.ai-loop/runs/interrupted/reports/partial.log'), 'utf8'), '中断现场');
});

test('事件来源的项目边界贯穿知识保存、完整性检查与恢复', t => {
  const root = fixture(t);
  for (const project_path of ['one', 'two']) loop.create(root, spec(project_path), 'same');
  save(root, { base_revision: 0, documents: [{ name: 'index', summary: '事件来源', expected_hash: null, entries: [{ id: 'fact', title: '事实', text: '项目一事件', scope: 'one', status: 'observed', sources: [{ type: 'event', run: 'same', seq: 1, project_path: 'one' }] }] }] });
  assert.equal(inspect(root).status, 'ready');
  assert.equal(bootstrap(root, { project_path: 'one', intent: 'continue' }).selected.run_id, 'same');
});

test('并发本地与集中创建共用工作区锁，不产生同项目重复运行', { timeout: 15000 }, async t => {
  const root = fixture(t), release = path.join(root, '.ai-loop/release-create');
  const module = new URL('../core/scripts/loop.mjs', import.meta.url).href;
  const firstScript = `import fs from 'node:fs';import {create} from ${JSON.stringify(module)};
    const original=fs.mkdirSync;
    fs.mkdirSync=function(target,...args){if(String(target).replaceAll('\\\\','/').endsWith('/runs/same/reports')){
      fs.writeSync(1,'READY\\n');const end=Date.now()+8000;
      while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('屏障超时');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
    }return original.call(fs,target,...args);};
    create(${JSON.stringify(root)},${JSON.stringify(spec('one'))},'same');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', firstScript], { windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', ready;
  const started = new Promise((resolve, reject) => { ready = resolve; child.on('error', reject); });
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) ready(); });
  child.stderr.on('data', chunk => { output += chunk; });
  const finished = new Promise(resolve => child.on('close', code => resolve(code)));
  await Promise.race([started, finished.then(code => { throw new Error(`首个创建进程提前退出 ${code}: ${output}`); })]);
  let second;
  try {
    second = spawnSync(process.execPath, ['--input-type=module', '-e', `import {create} from ${JSON.stringify(module)};create(${JSON.stringify(root)},${JSON.stringify({ ...spec('one'), snapshot_paths: ['one', 'two'] })},'same');`], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  } finally { fs.writeFileSync(release, '继续'); }
  assert.equal(await finished, 0, output);
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /持有锁/);
  assert.equal(loop.listRuns(root).length, 1);
  assert.equal(loop.status(root, 'same', { project_path: 'one' }).project_path, 'one');
});
