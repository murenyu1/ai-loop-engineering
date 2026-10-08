import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VERSION, BUNDLE, assert, validId, inside, rootPath, safePath, jsonFile, atomicWrite, writeJson, locked, args, allowArgs, mainModule, printResult } from './lib.mjs';

const now = () => new Date().toISOString();
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validRevision = value => value?.algorithm === 'sha256' && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) && Number.isInteger(value.files) && value.files >= 0;
const sameRevision = (a, b) => a?.algorithm === 'sha256' && b?.algorithm === 'sha256' && a.digest === b.digest && a.files === b.files;

export function validateSpec(input) {
  assert(input && nonempty(input.goal), '运行须有明确 goal');
  assert(Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 100, 'tasks 须包含 1–100 个任务');
  const identifiers = new Set();
  const commands = new Map();
  for (const task of input.tasks) {
    validId(task.id);
    assert(!identifiers.has(task.id), '任务编号重复');
    identifiers.add(task.id);
    assert(nonempty(task.title) && Array.isArray(task.acceptance) && task.acceptance.length && task.acceptance.every(nonempty), '每个任务需要 title 和非空 acceptance');
    assert(['none', 'self', 'independent'].includes(task.review), '每个任务必须明确 review：none / self / independent');
    assert(Array.isArray(task.checks) && task.checks.length, '每个任务至少声明一项必需检查；不能空检查通过');
    const checks = new Set();
    for (const check of task.checks) {
      validId(check.id);
      assert(!checks.has(check.id), '任务检查编号重复');
      checks.add(check.id);
      assert(nonempty(check.command), '必需检查须有明确 command');
      const expected = check.expected_exit ?? 0;
      assert(Number.isInteger(expected) && expected >= 0 && expected <= 255, 'expected_exit 须为 0–255 的退出码');
      if (commands.has(check.id)) assert(commands.get(check.id) === JSON.stringify([check.command, expected]), '共享检查编号须对应相同命令和退出码');
      commands.set(check.id, JSON.stringify([check.command, expected]));
    }
  }
  for (const task of input.tasks) {
    assert(!task.depends_on || Array.isArray(task.depends_on), 'depends_on 须为编号数组');
    for (const dependency of task.depends_on || []) assert(identifiers.has(dependency) && dependency !== task.id, '依赖须引用其他任务');
  }
  const visited = new Set();
  const pending = new Set();
  const visit = id => {
    assert(!pending.has(id), '任务依赖包含循环');
    if (visited.has(id)) return;
    pending.add(id);
    for (const dependency of input.tasks.find(task => task.id === id).depends_on || []) visit(dependency);
    pending.delete(id); visited.add(id);
  };
  for (const id of identifiers) visit(id);
  const maxFixes = input.max_fixes ?? 3;
  assert(Number.isInteger(maxFixes) && maxFixes >= 0 && maxFixes <= 3, 'max_fixes 须为 0–3，不允许静默放宽上限');
  const ignore = input.ignore_paths || [];
  assert(Array.isArray(ignore), 'ignore_paths 须为明确的生成产物相对路径数组');
  for (const prefix of ignore) {
    assert(nonempty(prefix) && !path.isAbsolute(prefix) && !prefix.includes('\\') && !prefix.split('/').some(part => !part || part === '.' || part === '..'), '排除项须为规范的项目内相对路径');
    assert(prefix !== '.git' && prefix !== '.ai-loop', '工具已经排除元数据目录，无须再次声明');
  }
  return { goal: input.goal, tasks: input.tasks, max_fixes: maxFixes, ignore_paths: ignore };
}

export function snapshot(project, ignore = [], bundle = BUNDLE) {
  const root = rootPath(project);
  const manifestPath = safePath(root, '.ai-loop/install.json');
  const manifest = fs.existsSync(manifestPath) ? jsonFile(manifestPath) : null;
  const excluded = ['.git', '.ai-loop', ...ignore];
  if (manifest?.source) {
    const source = safePath(root, manifest.source);
    assert(fs.existsSync(source) && fs.statSync(source).isDirectory(), '安装源包路径已失效；先修复安装');
    excluded.push(manifest.source);
  }
  if (manifest?.schema_version === 2) {
    assert(manifest.harnesses && typeof manifest.harnesses === 'object' && !Array.isArray(manifest.harnesses), '安装清单平台注册表无效');
    for (const record of Object.values(manifest.harnesses)) {
      assert(typeof record.home === 'string' && /^\.[A-Za-z][A-Za-z0-9_-]{0,31}\/ai-loop$/.test(record.home) && !['.git/ai-loop', '.ai-loop/ai-loop', '.agents/ai-loop'].includes(record.home), '工作流部署排除路径无效');
      safePath(root, record.home);
      excluded.push(record.home);
    }
  }
  const realBundle = fs.realpathSync(bundle);
  if (inside(root, realBundle) && realBundle !== root) excluded.push(path.relative(root, realBundle).split(path.sep).join('/'));
  const excludedPath = relative => excluded.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
  const hash = crypto.createHash('sha256');
  let count = 0;
  function walk(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const item = relative ? `${relative}/${name}` : name;
      if (excludedPath(item)) continue;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      assert(!stat.isSymbolicLink(), `快照范围含符号链接：${item}；先明确其验证范围，不自动忽略或跟随`);
      if (stat.isDirectory()) walk(target, item);
      else {
        assert(stat.isFile(), `快照范围含非普通文件：${item}`);
        assert(++count <= 100000, '快照文件超过 100000 个；先明确生成目录排除范围');
        hash.update(JSON.stringify([item, stat.mode & 0o111, stat.size]));
        const descriptor = fs.openSync(target, 'r');
        try {
          const buffer = Buffer.allocUnsafe(65536);
          let bytes;
          while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
          const after = fs.fstatSync(descriptor);
          assert(after.size === stat.size && after.mtimeMs === stat.mtimeMs, `快照期间文件变化：${item}`);
        } finally { fs.closeSync(descriptor); }
      }
    }
  }
  walk(root);
  hash.update(JSON.stringify([...new Set(excluded)].sort()));
  return { algorithm: 'sha256', digest: hash.digest('hex'), files: count };
}

function paths(root, run) {
  validId(run);
  const directory = safePath(root, `.ai-loop/runs/${run}`);
  return { directory, state: safePath(root, `.ai-loop/runs/${run}/state.json`), spec: safePath(root, `.ai-loop/runs/${run}/spec.json`), events: safePath(root, `.ai-loop/runs/${run}/events.jsonl`) };
}
function load(root, run) {
  const files = paths(root, run);
  const state = jsonFile(files.state);
  assert(state.schema_version === 1 && state.run_id === run && Array.isArray(state.tasks), '运行状态格式错误');
  const spec = validateSpec(jsonFile(files.spec));
  assert(state.spec_hash === crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), '运行方案已被直接改写；先批准新方案并创建新运行');
  assert(state.max_fixes === spec.max_fixes && state.goal === spec.goal && state.tasks.length === spec.tasks.length, '状态与批准方案不一致');
  const phases = ['pending', 'developing', 'verifying', 'tested', 'reviewing', 'done', 'needs_fix', 'blocked'];
  for (const [index, task] of state.tasks.entries()) {
    assert(task.id === spec.tasks[index].id && task.review === spec.tasks[index].review && Number.isInteger(task.fixes) && task.fixes >= 0 && task.fixes <= spec.max_fixes && phases.includes(task.phase), '任务状态或修复计数无效');
  }
  return { files, state, spec };
}
function summary(state) {
  return { run_id: state.run_id, goal: state.goal, status: state.status, stop_reason: state.stop_reason, event_seq: state.event_seq, tasks: state.tasks.map(task => ({ id: task.id, title: task.title, phase: task.phase, fixes: task.fixes, review: task.review, verification: task.verification, assessment: task.assessment, reason: task.reason })) };
}
function persist(root, files, state, type, detail) {
  state.updated_at = now();
  state.event_seq++;
  const event = { seq: state.event_seq, time: state.updated_at, type, ...detail };
  // state 是权威；事件先追加。中途失败则下次检查拒绝不一致记录，不悄悄重置计数。
  fs.appendFileSync(files.events, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  writeJson(files.state, state);
}
function mutable(root, run, action) {
  return locked(root, `run-${validId(run)}`, () => {
    const loaded = load(root, run);
    assert(loaded.state.status === 'active', '运行已完成或已停止；不能继续修改状态');
    const lines = fs.readFileSync(loaded.files.events, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines.length ? JSON.parse(lines.at(-1)).seq : 0;
    assert(last === loaded.state.event_seq, '事件与状态不一致；停止并人工恢复，不重置轮数');
    return action(loaded);
  });
}
function taskOf(state, id) {
  validId(id);
  const task = state.tasks.find(item => item.id === id);
  assert(task, '任务编号不存在');
  return task;
}
function checkEvidence(report, required, runDirectory) {
  assert(Array.isArray(report.checks) && report.checks.length, '通过结果须有检查证据');
  const checks = new Map();
  for (const check of report.checks) {
    assert(!checks.has(check.id), '报告检查编号重复');
    checks.set(check.id, check);
  }
  for (const expected of required) {
    const check = checks.get(expected.id);
    assert(check && check.command === expected.command && check.exit_code === (expected.expected_exit ?? 0), `缺少成功证据或命令不一致：${expected.id}`);
    assert(nonempty(check.environment) && nonempty(check.log), `检查须有 environment 和 log：${expected.id}`);
    const log = safePath(runDirectory, check.log);
    assert(check.log.startsWith('reports/') && fs.existsSync(log) && fs.statSync(log).isFile(), '检查日志须位于本次运行的 reports/ 内且实际存在');
  }
}
function checkReview(report, requiredMode) {
  assert(Array.isArray(report.findings), '评审须返回 findings 数组');
  assert(!report.findings.some(item => item.severity === 'BLOCKER'), '有 BLOCKER 的结果不能 APPROVED');
  assert(requiredMode !== 'independent' || report.execution === 'independent', '本任务需要真实独立评审，自检不能替代');
}
function validateReport(report, expectedRevision) {
  assert(report && ['self', 'independent'].includes(report.execution), '报告须明确 execution：self / independent');
  assert(report.permission_denied === undefined || typeof report.permission_denied === 'boolean', 'permission_denied 须为布尔值');
  assert(report.permission_denied !== true || report.status === 'BLOCKED', '权限拒绝必须返回 BLOCKED，不能作为通过证据');
  if (expectedRevision) assert(sameRevision(report.revision, expectedRevision), '报告代码快照已过期或格式不符，先重新验证');
  else assert(report.revision === null || validRevision(report.revision), '阻塞报告的 revision 须为上一已知完整快照或 null');
  assert(Array.isArray(report.issues), '报告须有 issues 数组');
}
function saveReport(root, files, state, report) {
  const name = `${report.task_id || 'final'}-${report.role}-${state.event_seq + 1}-${crypto.randomUUID().slice(0, 8)}.json`;
  const target = safePath(root, `.ai-loop/runs/${state.run_id}/reports/${name}`);
  writeJson(target, report);
  return `reports/${name}`;
}

export function create(project, input, requestedId) {
  const root = rootPath(project);
  const spec = validateSpec(input);
  const run = validId(requestedId || `run-${crypto.randomUUID()}`);
  return locked(root, 'runs', () => {
    const files = paths(root, run);
    assert(!fs.existsSync(files.directory), '运行编号已存在，不能覆盖或重置');
    const revision = snapshot(root, spec.ignore_paths);
    fs.mkdirSync(safePath(root, `.ai-loop/runs/${run}/reports`), { recursive: true });
    const state = { schema_version: 1, version: VERSION, run_id: run, goal: spec.goal, status: 'active', created_at: now(), updated_at: now(), event_seq: 0,
      spec_hash: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), max_fixes: spec.max_fixes, base_revision: revision,
      tasks: spec.tasks.map(task => ({ id: task.id, title: task.title, review: task.review, phase: 'pending', fixes: 0, verification: null, assessment: null, reason: null })) };
    writeJson(files.spec, spec);
    writeJson(files.state, state);
    atomicWrite(files.events, '');
    atomicWrite(safePath(root, `.ai-loop/runs/${run}/plan.md`), `# ${spec.goal}\n\n本文件记录方案；执行状态以 state.json 为准。创建运行前由 AI 核对用户批准范围。\n\n${spec.tasks.map(task => `## ${task.id}：${task.title}\n\n- 验收：${task.acceptance.join('；')}\n- 依赖：${(task.depends_on || []).join(', ') || '无'}\n- 评审：${task.review}\n- 检查：${task.checks.map(check => check.id).join(', ')}\n`).join('\n')}`);
    atomicWrite(safePath(root, `.ai-loop/runs/${run}/session.md`), '# 会话交接\n\n- 用户意图：见 spec.json 的 goal\n- 当前进度：运行 status 命令获取，不在此复制计数\n- 已确认决策：由 AI 按需补充\n- 未决问题：无\n- 下一步：开始首个无依赖任务\n');
    persist(root, files, state, 'created', { revision });
    return summary(state);
  });
}

export function begin(project, run, id, phase) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    const task = taskOf(state, id);
    const definition = spec.tasks.find(item => item.id === id);
    assert(['development', 'verification', 'review'].includes(phase), '阶段须为 development / verification / review');
    assert(state.tasks.every(item => item.id === id || !['developing', 'verifying', 'reviewing'].includes(item.phase)), '默认串行：已有任务正在执行');
    if (phase === 'development') {
      assert(task.phase === 'pending', '修复须使用 fix 命令，不能通过 begin 重置轮数');
      assert((definition.depends_on || []).every(dependency => taskOf(state, dependency).phase === 'done'), '依赖任务尚未通过');
      task.phase = 'developing';
    } else if (phase === 'verification') {
      assert(['developing', 'tested', 'done'].includes(task.phase), '只能验证正在开发、已测或已完成的任务；FAIL 后须先 fix');
      task.phase = 'verifying'; task.verification = null; task.assessment = null;
    } else {
      assert(task.phase === 'tested' && task.review !== 'none', '评审需要有效测试结果且任务声明需要评审');
      assert(sameRevision(task.verification?.revision, snapshot(root, spec.ignore_paths)), '测试证据已过期，请先重新验证');
      task.phase = 'reviewing';
    }
    task.reason = null;
    persist(root, files, state, 'begin', { task_id: id, phase });
    return summary(state);
  });
}

export function record(project, run, report) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    assert(report && (report.role === 'tester' || report.role === 'reviewer'), '报告 role 须为 tester / reviewer');
    const task = taskOf(state, report.task_id);
    assert(task.phase === (report.role === 'tester' ? 'verifying' : 'reviewing'), '报告与当前任务阶段不符');
    const statuses = report.role === 'tester' ? ['PASS', 'FAIL', 'BLOCKED'] : ['APPROVED', 'REJECTED', 'BLOCKED'];
    assert(statuses.includes(report.status), '报告判定无效');
    const blocked = report.status === 'BLOCKED';
    const revision = blocked ? report.revision : snapshot(root, spec.ignore_paths);
    validateReport(report, blocked ? null : revision);
    const definition = spec.tasks.find(item => item.id === task.id);
    if (report.status === 'PASS') checkEvidence(report, definition.checks, files.directory);
    if (report.status === 'APPROVED') {
      assert(sameRevision(task.verification?.revision, revision), '评审对应的测试已过期');
      checkReview(report, task.review);
    }
    if (['FAIL', 'REJECTED', 'BLOCKED'].includes(report.status)) assert(report.issues.length || report.findings?.length, '失败或阻塞结果须说明问题');
    const reportPath = saveReport(root, files, state, report);
    const result = { status: report.status, execution: report.execution, revision, revision_confirmed: !blocked, report: reportPath };
    if (report.role === 'tester') task.verification = result;
    else task.assessment = result;
    if (report.status === 'PASS') task.phase = task.review === 'none' ? 'done' : 'tested';
    else if (report.status === 'APPROVED') task.phase = 'done';
    else if (report.status === 'BLOCKED') task.phase = 'blocked';
    else task.phase = 'needs_fix';
    task.reason = task.phase === 'blocked' ? report.issues.join('; ') : null;
    if (report.permission_denied === true) {
      state.status = 'stopped'; task.reason = '权限拒绝：停止，不得换工具或平台绕过';
      state.stop_reason = report.issues.join('; ') || task.reason;
    }
    persist(root, files, state, 'report', { task_id: task.id, role: report.role, status: report.status, report: reportPath });
    return summary(state);
  });
}

export function fix(project, run, id) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state }) => {
    const task = taskOf(state, id);
    assert(task.phase === 'needs_fix', '只能修复被测试或评审拒绝的任务；阻塞需先解决条件');
    assert(task.fixes < state.max_fixes, '修复已达上限，停止并向用户报告，不能重置或静默新开运行');
    assert(state.tasks.every(item => item.id === id || !['developing', 'verifying', 'reviewing'].includes(item.phase)), '默认串行：其他任务正在执行');
    task.fixes++; task.phase = 'developing'; task.verification = null; task.assessment = null;
    persist(root, files, state, 'fix', { task_id: id, fixes: task.fixes });
    return summary(state);
  });
}

export function resume(project, run, id, reason) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state }) => {
    const task = taskOf(state, id);
    assert(task.phase === 'blocked' && nonempty(reason), '仅可在明确解决阻塞条件后恢复，并提供 reason');
    assert(state.tasks.every(item => item.id === id || !['developing', 'verifying', 'reviewing'].includes(item.phase)), '默认串行：其他任务正在执行');
    task.phase = 'developing'; task.verification = null; task.assessment = null; task.reason = null;
    persist(root, files, state, 'resumed', { task_id: id, reason });
    return summary(state);
  });
}

export function stop(project, run, reason) {
  const root = rootPath(project);
  assert(nonempty(reason), '停止运行须提供明确 reason');
  return mutable(root, run, ({ files, state }) => {
    state.status = 'stopped'; state.stop_reason = reason;
    for (const task of state.tasks) {
      if (['developing', 'verifying', 'reviewing'].includes(task.phase)) {
        task.phase = 'blocked'; task.reason = reason;
      }
    }
    persist(root, files, state, 'stopped', { reason });
    return summary(state);
  });
}

export function complete(project, run, input) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    assert(state.tasks.every(task => task.phase === 'done'), '仍有未通过任务，不能交付');
    const revision = snapshot(root, spec.ignore_paths);
    const report = input.verification;
    validateReport(report, revision);
    assert(report.role === 'tester' && report.status === 'PASS', '交付需要最终快照的完整验证报告');
    const checks = [...new Map(spec.tasks.flatMap(task => task.checks).map(check => [check.id, check])).values()];
    checkEvidence(report, checks, files.directory);
    const requiresReview = spec.tasks.some(task => task.review !== 'none');
    if (requiresReview) {
      validateReport(input.review, revision);
      assert(input.review.role === 'reviewer' && input.review.status === 'APPROVED', '交付需要最终快照的整体评审');
      checkReview(input.review, spec.tasks.some(task => task.review === 'independent') ? 'independent' : 'self');
    }
    const verification = saveReport(root, files, state, { ...report, task_id: undefined });
    const review = requiresReview ? saveReport(root, files, state, { ...input.review, task_id: undefined }) : null;
    state.status = 'complete'; state.delivery = { revision, verification, review };
    persist(root, files, state, 'complete', { revision, verification, review });
    return summary(state);
  });
}

export function event(project, run, input) {
  const root = rootPath(project);
  assert(input && ['requirement', 'decision', 'rejected', 'question', 'handoff'].includes(input.type) && nonempty(input.summary) && input.summary.length <= 2000, '事件需合法 type 和不超过 2000 字的 summary');
  return mutable(root, run, ({ files, state }) => {
    persist(root, files, state, input.type, { summary: input.summary }); return { run_id: run, event_seq: state.event_seq };
  });
}
export function events(project, run, after = 0, limit = 50) {
  const root = rootPath(project);
  assert(Number.isInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 100, '事件游标与数量无效');
  const { files } = load(root, run);
  // 日志只在进程内部扫描；返回模型的是游标之后的有限事件。
  const result = fs.readFileSync(files.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.seq > after).slice(0, limit);
  return { events: result, next_cursor: result.at(-1)?.seq ?? after };
}
export function status(project, run) {
  return summary(load(rootPath(project), run).state);
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'run', 'task', 'phase', 'input', 'reason', 'after', 'limit', 'help']);
  const [command] = options._;
  assert(options._.length <= 1, '只能指定一个命令');
  if (options.help || !command) return { commands: 'create / begin / snapshot / record / fix / resume / stop / status / event / events / complete', usage: 'node scripts/loop.mjs COMMAND --project ROOT [--run ID] [--task ID] [--input FILE]' };
  const input = () => { assert(typeof options.input === 'string', '此命令需要 --input JSON文件'); return jsonFile(path.resolve(options.input)); };
  if (command === 'create') return create(options.project, input(), options.run);
  if (command === 'begin') return begin(options.project, options.run, options.task, options.phase);
  if (command === 'snapshot') {
    const root = rootPath(options.project);
    return snapshot(root, options.run ? load(root, options.run).spec.ignore_paths : []);
  }
  if (command === 'record') return record(options.project, options.run, input());
  if (command === 'fix') return fix(options.project, options.run, options.task);
  if (command === 'resume') return resume(options.project, options.run, options.task, options.reason);
  if (command === 'stop') return stop(options.project, options.run, options.reason);
  if (command === 'status') return status(options.project, options.run);
  if (command === 'event') return event(options.project, options.run, input());
  if (command === 'events') return events(options.project, options.run, Number(options.after || 0), Number(options.limit || 50));
  if (command === 'complete') return complete(options.project, options.run, input());
  throw new Error('未知命令，运行 --help 查看用法');
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
