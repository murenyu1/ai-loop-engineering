import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootstrap, inspect, save, checkpoint, search } from '../scripts/memory.mjs';
import { create, begin, event, status, record, fix, stop, snapshot, complete } from '../scripts/loop.mjs';
import { install, REQUIRED_FILES } from '../scripts/install.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.txt'), '实际项目资料：数据接口必须兼容。');
  const bundle = path.join(root, 'bundle');
  for (const name of REQUIRED_FILES) {
    const target = path.join(bundle, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(new URL('../' + name, import.meta.url), target);
  }
  const options = { project: root, bundle, harness: 'codex', env: { HOME: path.join(root, 'personal') } };
  return { root, options };
}
function task(root, run = 'run1') {
  create(root, { goal: '保持数据接口兼容', tasks: [{ id: 'task1', title: '实现接口', review: 'none', acceptance: ['接口行为正确'], checks: [{ id: 'check', command: '检查命令' }] }] }, run);
  return run;
}
function fact(overrides = {}) {
  return { id: 'api', title: '数据接口兼容', text: '保留已有数据接口；变更须核对兼容要求。', scope: '接口模块', status: 'observed', sources: [{ type: 'file', path: 'main.txt' }], ...overrides };
}
function saveIndex(root, entries = [fact()]) {
  const info = inspect(root);
  return save(root, { base_revision: info.revision, documents: [{ name: 'index', summary: '当前项目的重要约束与资料入口。', expected_hash: info.documents.find(doc => doc.name === 'index')?.hash ?? null, entries }] });
}
function handoff(root, run = 'run1', changes = {}) {
  const current = bootstrap(root, { run });
  const info = current.selected.run.checkpoint;
  return { expected_session_hash: info.expected_hash, base_cursor: info.event_cursor, event_cursor: status(root, run).event_seq, intent: '继续实现已确认的数据接口', constraints: ['保留兼容行为'], decisions: ['沿用原有接口，原因是兼容现有调用者'], open_questions: [], next_steps: ['核对实际差异，再继续 task1'], references: ['main.txt', `.ai-loop/runs/${run}/spec.json`], ...changes };
}

test('启动只读、索引按需初始化；没有记录不伪造项目知识', t => {
  const { root, options } = fixture(t);
  const before = fs.readdirSync(root);
  const first = bootstrap(root);
  assert.equal(first.memory.status, 'uninitialized');
  assert.deepEqual(fs.readdirSync(root), before);
  install({ ...options, apply: true });
  assert.match(fs.readFileSync(path.join(root, '.ai-loop/memory/index.md'), 'utf8'), /尚未整理/);
  assert.equal(fs.existsSync(path.join(root, '.ai-loop/memory/architecture.md')), false);
  assert.equal(bootstrap(root).memory.status, 'uninitialized');
});

test('知识增量合并、可核对来源与撤销状态；重复保存不增加版本', t => {
  const { root, options } = fixture(t); install({ ...options, apply: true });
  assert.equal(saveIndex(root).revision, 1);
  assert.equal(inspect(root).status, 'ready');
  assert.equal(saveIndex(root).status, 'unchanged');
  saveIndex(root, [fact({ id: 'stack', title: '项目语言', text: '仍需确认语言与构建工具。', status: 'unverified', sources: [] })]);
  assert.equal(search(root, '兼容').matches[0].id, 'api');
  const index = fs.readFileSync(path.join(root, '.ai-loop/memory/index.md'), 'utf8');
  assert.match(index, /api/); assert.match(index, /stack/);
  saveIndex(root, [fact({ status: 'superseded' })]);
  assert.equal(search(root, '兼容').matches.length, 0);
  assert.ok(fs.readdirSync(path.join(root, '.ai-loop/memory/history')).length >= 3);
});

test('来源变更、删除与手工编辑被发现，过期基线不能覆盖', t => {
  const { root } = fixture(t); saveIndex(root);
  const old = inspect(root);
  fs.appendFileSync(path.join(root, 'main.txt'), '\n接口版本变化');
  assert.equal(inspect(root).documents[0].issues[0].type, 'changed-reference');
  fs.unlinkSync(path.join(root, 'main.txt'));
  assert.equal(inspect(root).documents[0].issues[0].type, 'missing-reference');
  fs.appendFileSync(path.join(root, '.ai-loop/memory/index.md'), '\n人工补充');
  assert.ok(inspect(root).documents[0].issues.some(issue => issue.type === 'edited-document'));
  assert.throws(() => save(root, { base_revision: old.revision, documents: [{ name: 'index', expected_hash: old.documents[0].hash, entries: [] }] }), /正文已更新/);
  assert.throws(() => search(root, '接口'), /先合并/);
});

test('启动区分继续、新需求、多个候选、阻塞与已关闭任务，不修改状态', t => {
  const { root } = fixture(t); task(root);
  const before = fs.readFileSync(path.join(root, '.ai-loop/runs/run1/state.json'), 'utf8');
  assert.equal(bootstrap(root, { intent: 'continue' }).selected.run_id, 'run1');
  assert.equal(bootstrap(root, { intent: 'new' }).selected, null);
  assert.equal(bootstrap(root).selected, null);
  task(root, 'run2');
  assert.equal(bootstrap(root, { intent: 'continue' }).needs_choice, true);
  assert.equal(bootstrap(root, { intent: 'continue' }).selected, null);
  assert.equal(bootstrap(root, { intent: 'continue', limit: 1 }).next_after, 'run1');
  stop(root, 'run2', '用户要求停止');
  assert.equal(bootstrap(root, { intent: 'continue' }).active_count, 1);
  assert.equal(bootstrap(root, { run: 'run2' }).selected.action, 'do-not-resume');
  assert.equal(fs.readFileSync(path.join(root, '.ai-loop/runs/run1/state.json'), 'utf8'), before);
  begin(root, 'run1', 'task1', 'development'); begin(root, 'run1', 'task1', 'verification');
  record(root, 'run1', { role: 'tester', task_id: 'task1', status: 'BLOCKED', execution: 'self', revision: null, checks: [], issues: ['缺少工具链'] });
  assert.equal(bootstrap(root, { intent: 'continue' }).selected.action, 'resolve-blocker');
});

test('旧交接保留备份，记录游标检测落后，断开旧会话后按文件恢复', t => {
  const { root } = fixture(t); task(root); saveIndex(root);
  const legacy = fs.readFileSync(path.join(root, '.ai-loop/runs/run1/session.md'), 'utf8');
  assert.equal(bootstrap(root, { intent: 'continue' }).runs[0].checkpoint.issues[0].type, 'missing-checkpoint');
  const result = checkpoint(root, 'run1', handoff(root));
  assert.equal(result.status, 'saved');
  assert.equal(fs.readFileSync(path.join(root, result.history[0]), 'utf8'), legacy);
  const restored = bootstrap(root, { intent: 'continue' });
  assert.equal(restored.selected.action, 'check-project-before-continuing');
  assert.equal(restored.runs[0].checkpoint.status, 'ready');
  assert.equal(restored.snapshot_status, 'unchecked');
  assert.match(fs.readFileSync(path.join(root, restored.runs[0].checkpoint.path), 'utf8'), /沿用原有接口/);
  assert.equal(search(root, '兼容').matches[0].id, 'api');
  assert.equal(checkpoint(root, 'run1', handoff(root)).status, 'unchanged');
  event(root, 'run1', { type: 'decision', summary: '新增已确认的兼容限制' });
  const stale = bootstrap(root, { intent: 'continue' });
  assert.equal(stale.selected.action, 'refresh-handoff-before-continuing');
  assert.equal(stale.runs[0].checkpoint.issues[0].count, 1);
  checkpoint(root, 'run1', handoff(root, 'run1', { decisions: ['新增兼容限制已核对并保留'] }));
  assert.equal(bootstrap(root).runs[0].checkpoint.status, 'ready');
});

test('交接结构、并发基线、游标范围与缺失引用校验，不重置修复次数', t => {
  const { root } = fixture(t); task(root);
  begin(root, 'run1', 'task1', 'development'); begin(root, 'run1', 'task1', 'verification');
  record(root, 'run1', { role: 'tester', task_id: 'task1', status: 'FAIL', execution: 'self', revision: snapshot(root), checks: [], issues: ['失败'] });
  fix(root, 'run1', 'task1');
  const stateFile = path.join(root, '.ai-loop/runs/run1/state.json');
  const before = fs.readFileSync(stateFile, 'utf8');
  const input = handoff(root);
  assert.throws(() => checkpoint(root, 'run1', { ...input, next_steps: [] }), /下一步/);
  assert.throws(() => checkpoint(root, 'run1', { ...input, event_cursor: 100 }), /游标/);
  assert.throws(() => checkpoint(root, 'run1', { ...input, references: ['not-found.md'] }), /引用文件不存在/);
  checkpoint(root, 'run1', input);
  assert.equal(status(root, 'run1').tasks[0].fixes, 1);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.throws(() => checkpoint(root, 'run1', input), /交接已变化/);
  fs.appendFileSync(path.join(root, '.ai-loop/runs/run1/session.md'), '\n人工补充');
  assert.equal(bootstrap(root).runs[0].checkpoint.issues[0].type, 'edited-session');
  fs.unlinkSync(path.join(root, 'main.txt'));
  assert.ok(bootstrap(root).runs[0].checkpoint.issues.some(issue => issue.type === 'missing-reference'));
});

test('知识来源可引用用户和真实事件；预算、未知状态与循环引用拒绝', t => {
  const { root } = fixture(t); task(root);
  saveIndex(root, [fact({ status: 'confirmed', sources: [{ type: 'user', text: '用户确认兼容要求' }, { type: 'event', run: 'run1', seq: 1 }] })]);
  assert.equal(inspect(root).status, 'ready');
  const info = inspect(root);
  const update = entry => save(root, { base_revision: info.revision, documents: [{ name: 'index', expected_hash: info.documents[0].hash, entries: [entry] }] });
  assert.throws(() => update(fact({ status: 'fake' })), /有效状态/);
  assert.throws(() => update(fact({ sources: [{ type: 'event', run: 'run1', seq: 100 }] })), /事件不存在/);
  assert.throws(() => update(fact({ sources: [{ type: 'file', path: '.ai-loop/memory/index.md' }] })), /循环引用/);
  assert.throws(() => update(fact({ sources: [{ type: 'file', path: '../secret' }] })), /规范相对路径/);
  assert.throws(() => update(fact({ sources: [{ type: 'url', url: 'file:///tmp/test' }] })), /HTTP/);
});

test('迁移旧经验不丢内容，新旧不同则停止；知识库不按 harness 复制', t => {
  const { root, options } = fixture(t);
  fs.mkdirSync(path.join(root, '.ai-loop')); fs.writeFileSync(path.join(root, '.ai-loop/lessons.md'), '# 已有经验\n真实经验。');
  const preview = install(options);
  assert.equal(fs.existsSync(path.join(root, '.ai-loop/memory')), false);
  assert.ok(preview.changes.includes('.ai-loop/lessons.md'));
  const applied = install({ ...options, apply: true });
  assert.equal(fs.readFileSync(path.join(root, applied.lessons_migration.backup), 'utf8'), '# 已有经验\n真实经验。');
  assert.equal(fs.existsSync(path.join(root, '.ai-loop/lessons.md')), false);
  assert.equal(inspect(root).documents.find(doc => doc.name === 'lessons').indexed, false);
  saveIndex(root);
  const before = fs.readFileSync(path.join(root, '.ai-loop/memory/index.md'), 'utf8');
  install({ ...options, harness: 'claude-code', apply: true });
  assert.equal(fs.readFileSync(path.join(root, '.ai-loop/memory/index.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, '.claude/ai-loop/.ai-loop/memory')), false);
  fs.writeFileSync(path.join(root, '.ai-loop/lessons.md'), '不同的旧内容');
  assert.throws(() => install({ ...options, apply: true }), /新旧经验文档内容不同/);
  assert.equal(fs.readFileSync(path.join(root, '.ai-loop/lessons.md'), 'utf8'), '不同的旧内容');
});

test('未索引资料必须显式导入并备份，已保存索引丢失不重置', t => {
  const { root, options } = fixture(t);
  fs.mkdirSync(path.join(root, '.ai-loop/memory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai-loop/memory/index.md'), '# 人工历史\n必须保留的重要知识');
  assert.throws(() => saveIndex(root), /import_existing/);
  const hash = inspect(root).documents[0].hash;
  const result = save(root, { base_revision: 0, documents: [{ name: 'index', expected_hash: hash, import_existing: true, summary: '已整理人工历史', entries: [fact()] }] });
  assert.match(fs.readFileSync(path.join(root, result.history[0]), 'utf8'), /必须保留/);
  fs.unlinkSync(path.join(root, '.ai-loop/memory/index.md'));
  assert.throws(() => install({ ...options, apply: true }), /知识索引缺失/);
});

test('运行与知识路径符号链接停止，不写链接目标；输出不回灌长历史', t => {
  const { root } = fixture(t); task(root); saveIndex(root);
  const linked = path.join(root, '.ai-loop/memory/index.md'); fs.unlinkSync(linked); fs.symlinkSync(path.join(root, 'main.txt'), linked);
  assert.throws(() => inspect(root), /符号链接/);
  assert.equal(fs.readFileSync(path.join(root, 'main.txt'), 'utf8'), '实际项目资料：数据接口必须兼容。');
  fs.unlinkSync(linked);
  const index = JSON.parse(fs.readFileSync(path.join(root, '.ai-loop/memory/catalog.json'))).documents.index;
  // 恢复正文后启动应只提供索引路径，不返回知识全文。
  fs.writeFileSync(linked, '# 非原文');
  const startup = bootstrap(root);
  assert.ok(startup.memory.documents[0].issues.some(issue => issue.type === 'edited-document'));
  assert.equal(JSON.stringify(startup).includes(index.entries[0].text), false);
});


test('完成运行不会自动恢复，归档交接不重开或修改权威状态', t => {
  const { root } = fixture(t); task(root);
  begin(root, 'run1', 'task1', 'development'); begin(root, 'run1', 'task1', 'verification');
  fs.writeFileSync(path.join(root, '.ai-loop/runs/run1/reports/check.log'), '单元测试合成日志');
  const report = { role: 'tester', task_id: 'task1', status: 'PASS', execution: 'self', revision: snapshot(root), checks: [{ id: 'check', command: '检查命令', environment: '单元测试构造环境', exit_code: 0, log: 'reports/check.log' }], issues: [] };
  record(root, 'run1', report);
  complete(root, 'run1', { verification: { ...report, task_id: undefined } });
  const before = fs.readFileSync(path.join(root, '.ai-loop/runs/run1/state.json'), 'utf8');
  assert.equal(bootstrap(root, { intent: 'continue' }).selected, null);
  assert.equal(bootstrap(root, { intent: 'continue', run: 'run1' }).selected.action, 'do-not-resume');
  checkpoint(root, 'run1', handoff(root, 'run1', { next_steps: ['已交付；新增需求使用新运行'] }));
  assert.equal(fs.readFileSync(path.join(root, '.ai-loop/runs/run1/state.json'), 'utf8'), before);
  assert.throws(() => bootstrap(root, { intent: 'new', run: 'run1' }), /新需求不能指定/);
});

test('记录预算、事件不一致及活跃写锁不被绕过', t => {
  const { root } = fixture(t); task(root);
  assert.throws(() => saveIndex(root, [fact({ id: 'a', text: '约束'.repeat(2000) }), fact({ id: 'b', text: '知识'.repeat(2000) })]), /字符预算/);
  assert.equal(fs.existsSync(path.join(root, '.ai-loop/memory/catalog.json')), false);
  const input = handoff(root);
  fs.writeFileSync(path.join(root, '.ai-loop/run-run1.lock'), '活跃');
  assert.throws(() => checkpoint(root, 'run1', input), /持有锁/);
  assert.equal(fs.readFileSync(path.join(root, '.ai-loop/run-run1.lock'), 'utf8'), '活跃');
  fs.appendFileSync(path.join(root, '.ai-loop/runs/run1/events.jsonl'), JSON.stringify({ seq: 100, type: 'decision', summary: '不一致事件' }) + '\n');
  assert.throws(() => bootstrap(root), /状态与事件不一致/);
});


test('检索合并完全相同的知识并保留文档指针，输出受总字符预算限制', t => {
  const { root } = fixture(t);
  save(root, { base_revision: 0, documents: ['index', 'decisions'].map(name => ({ name, expected_hash: null, summary: '接口约束', entries: [fact()] })) });
  const result = search(root, '兼容');
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].also_in, [{ document: 'decisions', id: 'api' }]);
  const info = inspect(root);
  const entries = Array.from({ length: 10 }, (_, index) => fact({ id: 'item' + index, title: '约束' + index, text: '兼容要求。'.repeat(500) }));
  save(root, { base_revision: info.revision, documents: [{ name: 'architecture', expected_hash: null, summary: '详细接口约束', entries }] });
  const bounded = search(root, '兼容', 20);
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded.matches).length <= 8100);
});


test('非 UTF-8 历史正文不被误解码或覆盖', t => {
  const { root } = fixture(t);
  const target = path.join(root, '.ai-loop/memory/index.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = Buffer.from([0xff, 0xfe, 0x41, 0x00]);
  fs.writeFileSync(target, original);
  assert.throws(() => inspect(root), /须为 UTF-8/);
  assert.deepEqual(fs.readFileSync(target), original);
});


test('读取最新 hash 仍不能无意重建人工补充，明确合并后保留事实和备份', t => {
  const { root } = fixture(t); saveIndex(root);
  const target = path.join(root, '.ai-loop/memory/index.md');
  fs.appendFileSync(target, '\n人工新增的重要约束：禁止变更接口字段。\n');
  const info = inspect(root);
  const patch = { name: 'index', expected_hash: info.documents[0].hash, entries: [] };
  assert.throws(() => save(root, { base_revision: info.revision, documents: [patch] }), /正文含人工修改/);
  const result = save(root, { base_revision: info.revision, documents: [{ ...patch, import_existing: true, entries: [fact({ id: 'manual', title: '保留字段', text: '人工补充要求禁止变更接口字段。', status: 'confirmed', sources: [{ type: 'user', text: '测试人工补充：禁止变更接口字段' }] })] }] });
  assert.match(fs.readFileSync(target, 'utf8'), /api/);
  assert.match(fs.readFileSync(target, 'utf8'), /禁止变更接口字段/);
  assert.match(fs.readFileSync(path.join(root, result.history[0]), 'utf8'), /人工新增/);
});
