import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { link } from './support.mjs';
import os from 'node:os';
import path from 'node:path';
import { create, begin, snapshot, record, fix, resume, stop, complete, event, events, status, validateSpec, mail, inbox } from '../scripts/loop.mjs';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.txt'), '代码版本1');
  const spec = { goal: '完成行为', tasks: [{ id: 'task1', title: '实现', acceptance: ['行为成立'], review: 'self', checks: [{ id: 'test', command: '真实验证命令' }] }], ...overrides };
  const run = create(root, spec, 'run1').run_id;
  fs.writeFileSync(path.join(root, `.ai-loop/runs/${run}/reports/test.log`), '实际工具输出');
  return { root, run, spec };
}
function verification(root, run, overrides = {}) {
  return { role: 'tester', task_id: 'task1', status: 'PASS', execution: 'self', revision: snapshot(root), checks: [{ id: 'test', command: '真实验证命令', environment: '测试环境', exit_code: 0, log: 'reports/test.log' }], issues: [], ...overrides };
}
function review(root, overrides = {}) {
  return { role: 'reviewer', task_id: 'task1', status: 'APPROVED', execution: 'self', revision: snapshot(root), findings: [], issues: [], ...overrides };
}
function developAndTest(root, run) {
  begin(root, run, 'task1', 'development');
  begin(root, run, 'task1', 'verification');
  record(root, run, verification(root, run));
}

test('无Git的完整流程与新会话读取，运行和报告不会污染代码摘要', t => {
  const { root, run } = fixture(t);
  const before = snapshot(root);
  developAndTest(root, run);
  assert.equal(status(root, run).tasks[0].phase, 'tested');
  assert.deepEqual(snapshot(root), before);
  begin(root, run, 'task1', 'review');
  record(root, run, review(root));
  complete(root, run, { verification: verification(root, run), review: review(root) });
  assert.equal(status(root, run).status, 'complete');
  assert.throws(() => fix(root, run, 'task1'), /已完成/);
  assert.throws(() => create(root, { goal: '新需求', tasks: fixtureSpec() }, run), /已存在/);
});
function fixtureSpec() { return [{ id: 'task1', title: '实现', acceptance: ['验收'], review: 'none', checks: [{ id: 'test', command: '真实验证命令' }] }]; }

test('源码变化拒绝旧PASS，缺少检查和日志不能通过', t => {
  const { root, run } = fixture(t);
  begin(root, run, 'task1', 'development'); begin(root, run, 'task1', 'verification');
  const old = verification(root, run);
  fs.writeFileSync(path.join(root, 'main.txt'), '代码版本2');
  assert.throws(() => record(root, run, old), /快照/);
  assert.throws(() => record(root, run, verification(root, run, { checks: [] })), /证据/);
  const missingLog = verification(root, run);
  missingLog.checks[0].log = 'reports/not-present.log';
  assert.throws(() => record(root, run, missingLog), /日志/);
  const outsideLog = verification(root, run);
  outsideLog.checks[0].log = '../main.txt';
  assert.throws(() => record(root, run, outsideLog), /路径/);
  record(root, run, verification(root, run));
});

test('修复次数跨读取保留，预算耗尽后不能重新begin绕过', t => {
  const { root, run } = fixture(t, { max_fixes: 1 });
  begin(root, run, 'task1', 'development'); begin(root, run, 'task1', 'verification');
  const failed = () => verification(root, run, { status: 'FAIL', issues: ['行为错误'] });
  record(root, run, failed());
  fix(root, run, 'task1');
  assert.equal(status(root, run).tasks[0].fixes, 1);
  begin(root, run, 'task1', 'verification'); record(root, run, failed());
  assert.throws(() => fix(root, run, 'task1'), /上限/);
  assert.throws(() => begin(root, run, 'task1', 'development'), /重置轮数/);
});

test('评审拒绝的修复须重新验证，自检不能替代独立评审', t => {
  const tasks = fixtureSpec(); tasks[0].review = 'independent';
  const { root, run } = fixture(t, { tasks });
  developAndTest(root, run); begin(root, run, 'task1', 'review');
  assert.throws(() => record(root, run, review(root)), /独立评审/);
  record(root, run, review(root, { status: 'REJECTED', execution: 'independent', findings: [{ severity: 'BLOCKER', location: 'main.txt:1', scenario: '失败场景' }], issues: ['缺陷'] }));
  fix(root, run, 'task1');
  assert.throws(() => begin(root, run, 'task1', 'review'), /有效测试/);
  begin(root, run, 'task1', 'verification'); record(root, run, verification(root, run));
  begin(root, run, 'task1', 'review'); record(root, run, review(root, { execution: 'independent' }));
  assert.throws(() => complete(root, run, { verification: verification(root, run), review: review(root) }), /独立评审/);
});

test('普通阻塞可恢复，权限拒绝停止运行且不能恢复', t => {
  const { root, run } = fixture(t);
  begin(root, run, 'task1', 'development'); begin(root, run, 'task1', 'verification');
  record(root, run, verification(root, run, { status: 'BLOCKED', issues: ['缺少环境'] }));
  resume(root, run, 'task1', '环境已经准备');
  assert.equal(status(root, run).tasks[0].fixes, 0);
  begin(root, run, 'task1', 'verification');
  record(root, run, verification(root, run, { status: 'BLOCKED', permission_denied: true, issues: ['配置deny'] }));
  assert.equal(status(root, run).status, 'stopped');
  assert.throws(() => resume(root, run, 'task1', '换工具'), /已停止/);
});

test('快照已变化或不可读取时仍可持久化阻塞与权限停止', t => {
  const { root, run } = fixture(t);
  begin(root, run, 'task1', 'development'); begin(root, run, 'task1', 'verification');
  const old = verification(root, run, { status: 'BLOCKED', issues: ['验证时源码变化'] });
  fs.writeFileSync(path.join(root, 'main.txt'), '验证期间变化');
  record(root, run, old);
  assert.equal(status(root, run).tasks[0].verification.revision_confirmed, false);
  resume(root, run, 'task1', '已确认源码变化');
  begin(root, run, 'task1', 'verification');
  if (!link(t, path.join(root, 'main.txt'), path.join(root, 'alias'))) return;
  record(root, run, { role: 'tester', task_id: 'task1', status: 'BLOCKED', execution: 'self', revision: null, permission_denied: true, issues: ['验证权限被拒绝，当前快照不可确认'] });
  assert.equal(status(root, run).status, 'stopped');
});

test('开发阶段可以直接停止，无需伪造验证报告或读取源码', t => {
  const { root, run } = fixture(t);
  begin(root, run, 'task1', 'development');
  if (!link(t, path.join(root, 'main.txt'), path.join(root, 'alias'))) return;
  assert.throws(() => stop(root, run, ''), /reason/);
  stop(root, run, '开发工具权限被拒绝');
  assert.equal(status(root, run).status, 'stopped');
  assert.equal(status(root, run).stop_reason, '开发工具权限被拒绝');
  assert.equal(status(root, run).tasks[0].phase, 'blocked');
  assert.throws(() => resume(root, run, 'task1', '换工具'), /已停止/);
});

test('依赖与同工作区串行约束', t => {
  const tasks = fixtureSpec(); tasks[0].review = 'none';
  tasks.push({ ...tasks[0], id: 'task2', depends_on: ['task1'] });
  const { root, run } = fixture(t, { tasks });
  assert.throws(() => begin(root, run, 'task2', 'development'), /依赖/);
  developAndTest(root, run);
  begin(root, run, 'task2', 'development');
  assert.equal(status(root, run).tasks[1].phase, 'developing');
});

test('无依赖关系的独立任务允许在开发阶段并发 developing', t => {
  const tasks = fixtureSpec(); tasks[0].review = 'none';
  tasks.push({ ...tasks[0], id: 'task2' }); // 无依赖任务
  const { root, run } = fixture(t, { tasks });
  begin(root, run, 'task1', 'development');
  assert.equal(status(root, run).tasks[0].phase, 'developing');
  // task2 同样无依赖，允许并发进入开发阶段
  begin(root, run, 'task2', 'development');
  assert.equal(status(root, run).tasks[1].phase, 'developing');
  // 但当 task1 进入验证时，必须等待环境串行收敛
  assert.throws(() => begin(root, run, 'task1', 'verification'), /其他任务正在执行/);
});

test('其他任务正在开发时不能并发评审；过期任务可以重新验证但不清零计数', t => {
  const tasks = fixtureSpec(); tasks[0].review = 'self'; tasks.push({ ...tasks[0], id: 'task2' });
  const { root, run } = fixture(t, { tasks });
  developAndTest(root, run);
  begin(root, run, 'task2', 'development');
  assert.throws(() => begin(root, run, 'task1', 'review'), /串行/);
  begin(root, run, 'task2', 'verification');
  record(root, run, verification(root, run, { task_id: 'task2' }));
  fs.writeFileSync(path.join(root, 'main.txt'), '集成修改');
  assert.throws(() => begin(root, run, 'task1', 'review'), /过期/);
  begin(root, run, 'task1', 'verification');
  record(root, run, verification(root, run));
  assert.equal(status(root, run).tasks[0].fixes, 0);
});

test('完成任务后改动代码仍需要最终快照的整体验证', t => {
  const { root, run } = fixture(t);
  developAndTest(root, run); begin(root, run, 'task1', 'review'); record(root, run, review(root));
  const old = { verification: verification(root, run), review: review(root) };
  fs.writeFileSync(path.join(root, 'main.txt'), '新的集成修改');
  assert.throws(() => complete(root, run, old), /快照/);
  complete(root, run, { verification: verification(root, run), review: review(root) });
});

test('最终报告标记权限拒绝时不能用PASS或APPROVED交付', t => {
  const { root, run } = fixture(t);
  developAndTest(root, run); begin(root, run, 'task1', 'review'); record(root, run, review(root));
  assert.throws(() => complete(root, run, { verification: verification(root, run, { permission_denied: true }), review: review(root) }), /权限拒绝/);
  assert.throws(() => complete(root, run, { verification: verification(root, run), review: review(root, { permission_denied: true }) }), /权限拒绝/);
  assert.equal(status(root, run).status, 'active');
  complete(root, run, { verification: verification(root, run), review: review(root) });
});

test('事件按游标返回，不要求模型读取全历史', t => {
  const { root, run } = fixture(t);
  for (let index = 0; index < 5; index++) event(root, run, { type: 'decision', summary: `决策${index}` });
  const first = events(root, run, 1, 2);
  assert.equal(first.events.length, 2);
  const second = events(root, run, first.next_cursor, 2);
  assert.ok(second.events[0].seq > first.next_cursor);
});

test('结构化角色信箱投递与定向过滤', t => {
  const { root, run } = fixture(t);
  // dev 向 tester 投递 handoff 邮件
  const sent1 = mail(root, run, {
    task_id: 'task1',
    from_role: 'dev',
    to_role: 'tester',
    type: 'handoff',
    subject: 'task1 完成开发，已通过单元自测',
    payload: { changed_files: ['main.txt'] },
  });
  assert.equal(sent1.ok, true);
  assert.ok(sent1.mail_id);

  // reviewer 此时查收自己的信箱，应为空
  const reviewerBox = inbox(root, run, { role: 'reviewer' });
  assert.equal(reviewerBox.count, 0);

  // tester 查收针对 task1 的信箱，能获取到该邮件
  const testerBox = inbox(root, run, { role: 'tester', task_id: 'task1' });
  assert.equal(testerBox.count, 1);
  assert.equal(testerBox.messages[0].subject, 'task1 完成开发，已通过单元自测');
  assert.deepEqual(testerBox.messages[0].payload, { changed_files: ['main.txt'] });

  // tester 发现问题回发 defect 邮件给 dev
  mail(root, run, {
    task_id: 'task1',
    from_role: 'tester',
    to_role: 'dev',
    type: 'defect',
    subject: '边界断言失败',
    payload: { failure: 'expected 200 got 500' },
  });

  // dev 查收信箱
  const devBox = inbox(root, run, { role: 'dev', task_id: 'task1' });
  // 包含作为 from_role 或 to_role 的 2 封交互邮件
  assert.equal(devBox.count, 2);
  assert.equal(devBox.messages[1].type, 'defect');
});

test('方案直接修改、循环依赖和目录逃逸都拒绝', t => {
  const { root, run } = fixture(t);
  const file = path.join(root, `.ai-loop/runs/${run}/spec.json`);
  const spec = JSON.parse(fs.readFileSync(file)); spec.max_fixes = 0; fs.writeFileSync(file, JSON.stringify(spec));
  assert.throws(() => status(root, run), /直接改写/);
  assert.throws(() => validateSpec({ goal: '任务', tasks: fixtureSpec(), ignore_paths: ['../outside'] }), /排除/);
  const tasks = fixtureSpec(); tasks[0].depends_on = ['task2']; tasks.push({ ...tasks[0], id: 'task2', depends_on: ['task1'] });
  assert.throws(() => validateSpec({ goal: '循环', tasks }), /循环/);
  assert.throws(() => create(root, { goal: '任务', tasks: fixtureSpec() }, '../bad'), /编号/);
});

test('符号链接源码与报告都不能隐式越界', t => {
  const { root, run } = fixture(t);
  if (!link(t, path.join(root, 'main.txt'), path.join(root, 'alias'))) return;
  assert.throws(() => snapshot(root), /符号链接/);
  fs.unlinkSync(path.join(root, 'alias'));
  begin(root, run, 'task1', 'development'); begin(root, run, 'task1', 'verification');
  if (!link(t, path.join(root, 'main.txt'), path.join(root, `.ai-loop/runs/${run}/reports/alias.log`))) return;
  const report = verification(root, run); report.checks[0].log = 'reports/alias.log';
  assert.throws(() => record(root, run, report), /符号链接/);
});
