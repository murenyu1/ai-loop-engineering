// 手动可选验收；不由 all.mjs 调用。会调用已登录的原生 CLI，遵守其权限和信任。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectNative } from '../scripts/doctor.mjs';
import { fileURLToPath } from 'node:url';
import { install, REQUIRED_FILES } from '../scripts/install.mjs';
import { args, allowArgs, assert } from '../scripts/lib.mjs';

const options = args(process.argv.slice(2));
allowArgs(options, ['harness', 'inspect']);
assert(options.inspect === undefined || options.inspect === true, '--inspect 不接受值');
assert(!options._.length && ['codex', 'claude-code'].includes(options.harness), '需要 --harness codex|claude-code');
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(source, '.validation');
fs.mkdirSync(directory, { recursive: true });
const project = fs.mkdtempSync(path.join(directory, options.harness + '-'));
const bundle = path.join(project, 'bundle');
for (const file of REQUIRED_FILES) {
  fs.mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
  fs.copyFileSync(path.join(source, file), path.join(bundle, file));
}
fs.mkdirSync(path.join(project, 'reports'));
fs.writeFileSync(path.join(project, 'smoke.txt'), 'AI_LOOP_NATIVE_SMOKE_20261018\n');
install({ project, bundle, harness: options.harness, 'model-routing': 'balanced', apply: true });
if (options.inspect) {
  assert(options.harness === 'codex', '--inspect 仅用于 Codex 的只读本地协议检查');
  const summary = { project, harness: 'codex', execution: 'unverified', effective_model: 'unverified', ui_visibility: 'unverified' };
  try {
    summary.native = await inspectNative(project, 'codex');
  } catch (error) { summary.error = error.message; process.exitCode = 1; }
  fs.writeFileSync(path.join(project, 'reports', 'inspection.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(process.exitCode || 0);
}
if (options.harness === 'codex') {
  const native = await inspectNative(project, 'codex');
  if (native.dispatch_blocked) {
    const summary = { project, harness: 'codex', status: 'preflight-blocked', native, execution: 'not-started', effective_model: 'unverified', ui_visibility: 'unverified', note: '原生项目配置被禁用；验收停止于派发前，不修改信任或启动模型请求。' };
    fs.writeFileSync(path.join(project, 'reports', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
    process.exit(2);
  }
}
const prompt = '主人，执行原生子代理只读验收：只允许读取，不修改文件，不执行 shell，不启动独立 CLI，不安装依赖，不创建开发运行。必须用当前会话原生子代理工具调用已发现的 loop-dev 自定义角色，让它读取项目根 smoke.txt 并返回内容，然后等待它完成。把项目绝对路径、角色文件路径和这些限制作为完整任务包。缺少原生工具或 loop-dev 时直接报告缺失，不能改用 default/worker 角色或仅口头扮演。返回原生代理 ID、工具调用是否成功和读取内容；不要把模型自述当作模型证据。';
const codex = options.harness === 'codex';
const executable = codex ? 'codex' : 'claude';
const argv = codex ? ['--no-daemon', '--strict-config', '-a', 'never', 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--json', '-C', project, prompt]
  : ['-p', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--tools', 'Agent,Read', '--permission-mode', 'manual', '--max-budget-usd', '0.5', prompt];
const stdout = fs.createWriteStream(path.join(project, 'reports', 'stdout.jsonl'));
const stderr = fs.createWriteStream(path.join(project, 'reports', 'stderr.log'));
const child = spawn(executable, argv, { cwd: project, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ exit_code: null, error: error.message }));
  child.once('close', (exit_code, signal) => resolve({ exit_code, signal }));
});
clearTimeout(timeout);
await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
const summary = { harness: options.harness, project, ...result, timed_out: timedOut,
  native_discovery: 'inspect-raw-evidence', execution: 'inspect-raw-evidence', effective_model: 'unverified', ui_visibility: 'unverified',
  note: '退出码或模型自述不能证明原生角色、模型或 UI；须人工检查 stdout 中的真实原生调用与返回。未更改信任、权限配置、settings.json 或个人模型设置。' };
fs.writeFileSync(path.join(project, 'reports', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (result.exit_code !== 0 || timedOut) process.exitCode = 1;
