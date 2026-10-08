import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const { checkReportPath, evaluateHook, runHook } = require('../hooks/check-report-path.js');
let fixture;
let root;
let outside;

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-hook-'));
  root = path.join(fixture, 'project');
  outside = path.join(fixture, 'outside');
  fs.mkdirSync(path.join(root, 'test-reports'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.ai-loop', 'runs', 'run-1', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'test-reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-reports', 'existing.md'), '报告夹具');
  fs.symlinkSync(outside, path.join(root, 'test-reports', 'escape'), 'dir');
  fs.symlinkSync(path.join(outside, 'missing.md'), path.join(root, 'test-reports', 'dangling.md'));
});

after(() => fs.rmSync(fixture, { recursive: true, force: true }));

function input(filePath, extra = {}) {
  return { tool_name: 'Write', tool_input: { file_path: filePath }, cwd: root, ...extra };
}

function allowed(filePath, extra) {
  assert.equal(checkReportPath(input(filePath, extra)).allowed, true);
}

function denied(filePath, extra) {
  const result = checkReportPath(input(filePath, extra));
  assert.equal(result.allowed, false);
  assert.ok(result.reason);
}

test('允许旧报告、新 run 报告、绝对同项目路径与已有普通报告文件', () => {
  allowed('test-reports/task1-test.md');
  allowed(path.join(root, 'test-reports', 'task1-review.md'));
  allowed('test-reports/existing.md', { tool_name: 'Edit' });
  allowed('.ai-loop/runs/run-1/reports/task1-test.md');
});

test('允许尚未创建的报告目录，仍验证其最近真实父目录', () => {
  allowed('.ai-loop/runs/new_run/reports/nested/test.md');
  allowed('test-reports/new-directory/test.md');
});

test('拒绝目录穿越、项目外同名报告目录和非法 run_id', () => {
  denied('test-reports/../src/main.js');
  denied('test-reports/../../outside/test-reports/outside.md');
  denied(path.join(outside, 'test-reports', 'outside.md'));
  denied('.ai-loop/runs/../reports/test.md');
  denied('.ai-loop/runs/bad id/reports/test.md');
  denied(`.ai-loop/runs/${'a'.repeat(65)}/reports/test.md`);
});

test('拒绝符号链接逃逸和悬空符号链接', () => {
  denied('test-reports/escape/test-reports/outside.md');
  denied('test-reports/escape/../src/main.js');
  denied('test-reports/dangling.md');
});

test('拒绝目录、根目录、缺少文件名和非目录父路径', () => {
  denied('test-reports');
  denied('.ai-loop/runs/run-1/reports');
  denied(root);
  denied('test-reports/new-directory/');
  denied('test-reports/existing.md/child.md');
});

test('拒绝非法 JSON、非对象输入、空路径和非法路径类型', () => {
  assert.equal(evaluateHook('{').allowed, false);
  assert.equal(evaluateHook('null').allowed, false);
  assert.equal(evaluateHook('[]').allowed, false);
  denied('');
  denied('   ');
  denied(42);
  denied('test-reports/a\0.md');
  assert.equal(checkReportPath({ tool_name: 'Write', cwd: root }).allowed, false);
});

test('拒绝未知工具，明确不保护 Bash', () => {
  for (const tool_name of ['Bash', 'Shell', 'Delete', '', undefined]) {
    const result = checkReportPath(input('test-reports/test.md', { tool_name }));
    assert.equal(result.allowed, false);
    assert.match(result.reason, /仅检查 Write\/Edit/);
  }
});

test('项目根只使用明确输入，不猜测进程 cwd；冲突和无效根被拒绝', () => {
  const data = { tool_name: 'Write', tool_input: { file_path: 'test-reports/test.md' } };
  assert.equal(checkReportPath(data).allowed, false);
  assert.equal(checkReportPath(data, { CLAUDE_PROJECT_DIR: root }).allowed, true);
  assert.equal(checkReportPath(input('test-reports/test.md'), { CLAUDE_PROJECT_DIR: root }).allowed, true);
  assert.equal(checkReportPath(input('test-reports/test.md'), { CLAUDE_PROJECT_DIR: outside }).allowed, false);
  assert.equal(checkReportPath(data, { CLAUDE_PROJECT_DIR: 'relative/project' }).allowed, false);
  assert.equal(checkReportPath(data, { CLAUDE_PROJECT_DIR: path.join(fixture, 'missing') }).allowed, false);
  denied('test-reports/test.md', { cwd: null });
});

async function invoke(raw) {
  const runtime = { stdin: new PassThrough(), stdout: new PassThrough(), env: {}, exitCode: 0 };
  let output = '';
  runtime.stdout.setEncoding('utf8');
  runtime.stdout.on('data', (chunk) => { output += chunk; });
  const pending = runHook(runtime);
  runtime.stdin.end(raw);
  await pending;
  return { exitCode: runtime.exitCode, output };
}

test('同一 stdin 处理器拒绝时输出合法 PreToolUse JSON 并设置退出码 2', async () => {
  for (const raw of ['{', JSON.stringify(input('test-reports/../src/main.js')), JSON.stringify({ tool_name: 'Write', tool_input: {} })]) {
    const result = await invoke(raw);
    assert.equal(result.exitCode, 2);
    const output = JSON.parse(result.output);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput.permissionDecisionReason);
  }
  const result = await invoke(JSON.stringify(input('test-reports/test.md')));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '');
});

test('stdin 读取错误也返回合法拒绝 JSON', async () => {
  const runtime = { stdin: new PassThrough(), stdout: new PassThrough(), env: {}, exitCode: 0 };
  let output = '';
  runtime.stdout.on('data', (chunk) => { output += chunk; });
  const pending = runHook(runtime);
  runtime.stdin.destroy(new Error('输入流故障'));
  await pending;
  assert.equal(runtime.exitCode, 2);
  assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, 'deny');
});
