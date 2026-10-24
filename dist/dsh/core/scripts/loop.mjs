import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VERSION, BUNDLE, assert, validId, inside, rootPath, safePath, jsonFile, atomicWrite, writeJson, locked, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { validateRoles } from './roles.mjs';
import { checkExecution } from './execution.mjs';

const now = () => new Date().toISOString();
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const scopePath = value => value.replace(/\/+$/, '').toLowerCase();
const validRelativeScope = value => nonempty(value) && !path.isAbsolute(value) && !/^[a-z]:\//i.test(value) && !value.includes('\\') && !value.replace(/\/+$/, '').split('/').some(part => !part || part === '.' || part === '..');
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
    if (task.owner !== undefined) assert(nonempty(task.owner), 'owner 须为非空字符串');
    for (const field of ['in_scope', 'out_of_scope']) if (task[field] !== undefined) {
      assert(Array.isArray(task[field]) && task[field].length > 0, `${field} 须为非空相对路径数组`);
      for (const item of task[field]) assert(validRelativeScope(item), `${field} 路径须为规范项目相对路径`);
      assert(new Set(task[field].map(scopePath)).size === task[field].length, `${field} 路径不能重复`);
    }
    assert(task.managed_execution === undefined || typeof task.managed_execution === 'boolean', 'managed_execution 须为布尔值');
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
  let workflow;
  if (input.workflow !== undefined) {
    const value = input.workflow;
    assert(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.nodes) && value.nodes.length > 0 && value.nodes.length <= 500 && Array.isArray(value.edges) && value.edges.length <= 1000, 'workflow 须含有限的 nodes 与 edges');
    assert(Object.keys(value).every(key => ['nodes', 'edges'].includes(key)), 'workflow 仅支持 nodes 与 edges');
    assert(!identifiers.has('run') && !identifiers.has('final'), '含 workflow 的运行保留 run 与 final，不能作为正式 task id');
    const nodeIds = new Set(), bindings = new Set(), taskIds = new Set(identifiers);
    for (const node of value.nodes) {
      assert(node && typeof node === 'object' && !Array.isArray(node), 'workflow node 格式无效');
      validId(node.id); assert(!nodeIds.has(node.id), 'workflow node id 重复'); nodeIds.add(node.id);
      assert(typeof node.task === 'string' && (taskIds.has(node.task) || ['run', 'final'].includes(node.task)), 'workflow node task 不存在');
      assert(['planner', 'dev', 'tester', 'reviewer', 'scribe'].includes(node.role), 'workflow node role 无效');
      if (node.task === 'run') assert(['planner', 'scribe'].includes(node.role), 'run 级节点只允许 planner 或 scribe');
      else if (node.task === 'final') assert(['tester', 'reviewer'].includes(node.role), 'final 节点只允许 tester 或 reviewer');
      else assert(node.role !== 'scribe', 'scribe 使用 run 级节点共享记录');
      const binding = `${node.task}:${node.role}`; assert(!bindings.has(binding), 'workflow 的 task+role 绑定重复'); bindings.add(binding);
      if (node.label !== undefined) assert(nonempty(node.label) && node.label.length <= 120, 'workflow node label 无效');
    }
    const adjacency = new Map([...nodeIds].map(id => [id, []])), edgePairs = new Set();
    for (const link of value.edges) {
      assert(link && typeof link === 'object' && !Array.isArray(link) && Object.keys(link).every(key => ['from', 'to'].includes(key)), 'workflow edge 字段无效');
      assert(typeof link.from === 'string' && typeof link.to === 'string' && nodeIds.has(link.from) && nodeIds.has(link.to) && link.from !== link.to, 'workflow edge 引用无效');
      const pair = `${link.from}\0${link.to}`; assert(!edgePairs.has(pair), 'workflow edge 重复'); edgePairs.add(pair); adjacency.get(link.from).push(link.to);
    }
    const seen = new Set(), stack = new Set();
    const checkGraph = id => { assert(!stack.has(id), 'workflow 拓扑包含循环'); if (seen.has(id)) return; stack.add(id); for (const to of adjacency.get(id)) checkGraph(to); stack.delete(id); seen.add(id); };
    for (const id of nodeIds) checkGraph(id);
    workflow = { nodes: value.nodes.map(({ id, task, role, label }) => ({ id, task, role, ...(label === undefined ? {} : { label }) })), edges: value.edges.map(({ from, to }) => ({ from, to })) };
  }
  const maxFixes = input.max_fixes ?? 3;
  assert(Number.isInteger(maxFixes) && maxFixes >= 0 && maxFixes <= 3, 'max_fixes 须为 0–3，不允许静默放宽上限');
  const ignore = input.ignore_paths || [];
  assert(Array.isArray(ignore), 'ignore_paths 须为明确的生成产物相对路径数组');
  for (const prefix of ignore) {
    assert(nonempty(prefix) && !path.isAbsolute(prefix) && !prefix.includes('\\') && !prefix.split('/').some(part => !part || part === '.' || part === '..'), '排除项须为规范的项目内相对路径');
    assert(prefix !== '.git' && prefix !== '.ai-loop', '工具已经排除元数据目录，无须再次声明');
  }
  if (input.execution_evidence !== undefined) assert(input.execution_evidence === 'required', 'execution_evidence 只支持 required');
  const projectScope = value => validRelativeScope(value) && !['.git', '.ai-loop'].includes(value.split('/')[0].toLowerCase());
  if (input.project_path !== undefined) assert(input.project_path === '.' || projectScope(input.project_path) && !input.project_path.endsWith('/'), 'project_path 须为工作区内相对目录，不能是元数据');
  if (input.snapshot_paths !== undefined) assert(Array.isArray(input.snapshot_paths) && input.snapshot_paths.length > 0 && input.snapshot_paths.every(projectScope), 'snapshot_paths 须为非空工作区相对路径数组，不能是元数据');
  return { goal: input.goal, tasks: input.tasks, max_fixes: maxFixes, ignore_paths: ignore, ...(workflow ? { workflow } : {}), ...(input.role_policy !== undefined ? { role_policy: validateRoles(input.role_policy) } : {}), ...Object.fromEntries(['execution_evidence', 'project_path', 'snapshot_paths'].filter(key => input[key] !== undefined).map(key => [key, input[key]])) };
}

export function snapshot(project, ignore = [], bundle = BUNDLE, scopes) {
  const root = rootPath(project);
  const manifestPath = safePath(root, '.ai-loop/install.json');
  const manifest = fs.existsSync(manifestPath) ? jsonFile(manifestPath) : null;
  const excluded = ['.git', '.ai-loop', ...ignore];
  if (manifest?.source) {
    const source = safePath(root, manifest.source);
    const markerPath = safePath(root, '.ai-loop/plugin.json');
    const pluginMode = fs.existsSync(markerPath) && jsonFile(markerPath).plugin === 'ai-loop-engineering';
    assert(pluginMode || fs.existsSync(source) && fs.statSync(source).isDirectory(), '安装源包路径已失效；先修复安装');
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
  if (scopes) {
    assert(Array.isArray(scopes) && scopes.length && scopes.every(validRelativeScope), '快照范围无效');
    for (const scope of scopes) assert(fs.existsSync(safePath(root, scope.replace(/\/+$/, ''))), '快照范围不存在：' + scope);
    hash.update(JSON.stringify({ snapshot_paths: scopes }));
  }
  const normalizeScope = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const selected = raw => !scopes || scopes.some(scope => { const relative = normalizeScope(raw), prefix = normalizeScope(scope.replace(/\/+$/, '')); return relative === prefix || relative.startsWith(prefix + '/') || prefix.startsWith(relative + '/'); });
  let count = 0;
  function walk(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const item = relative ? `${relative}/${name}` : name;
      if (excludedPath(item) || !selected(item)) continue;
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
  return { directory, state: safePath(root, `.ai-loop/runs/${run}/state.json`), spec: safePath(root, `.ai-loop/runs/${run}/spec.json`), events: safePath(root, `.ai-loop/runs/${run}/events.jsonl`), mailbox: safePath(root, `.ai-loop/runs/${run}/mailbox`) };
}
function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) return null;
  return value.split(/[+-]/, 1)[0].split('.').map(Number);
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
function load(root, run) {
  const files = paths(root, run);
  const state = jsonFile(files.state);
  assert([1, 2, 3, 4].includes(state.schema_version) && state.run_id === run && Array.isArray(state.tasks), '运行状态格式错误');
  const versionOrder = compareVersions(state.version, VERSION);
  assert(versionOrder !== null && versionOrder <= 0, '运行由较新核心创建；请先升级当前核心');
  const spec = validateSpec(jsonFile(files.spec));
  if (spec.role_policy) assert([3, 4].includes(state.schema_version), '角色关闭策略须使用 schema 3 或 4，禁止旧核心忽略策略');
  if (spec.execution_evidence || spec.project_path !== undefined || spec.snapshot_paths) assert(state.schema_version === 4, '原生执行证据与子项目范围须使用 schema 4');
  if (state.schema_version === 4) assert(compareVersions(state.version, '4.6.0') >= 0, 'schema 4 运行版本不匹配');
  if (state.schema_version === 3) assert(spec.role_policy && compareVersions(state.version, '4.5.0') >= 0, 'schema 3 角色策略或核心版本不匹配');
  if (state.schema_version === 2) assert(compareVersions(state.version, '4.4.0') >= 0, 'schema 2 运行版本不匹配');
  assert(state.spec_hash === crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), '运行方案已被直接改写；先批准新方案并创建新运行');
  assert(state.max_fixes === spec.max_fixes && state.goal === spec.goal && state.tasks.length === spec.tasks.length, '状态与批准方案不一致');
  const phases = ['pending', 'developing', 'developed', 'verifying', 'tested', 'reviewing', 'done', 'needs_fix', 'blocked'];
  for (const [index, task] of state.tasks.entries()) {
    assert(task.id === spec.tasks[index].id && task.review === spec.tasks[index].review && Number.isInteger(task.fixes) && task.fixes >= 0 && task.fixes <= spec.max_fixes && phases.includes(task.phase), '任务状态或修复计数无效');
  }
  return { files, state, spec };
}
function overlaps(a, b) {
  return a.some(rawLeft => b.some(rawRight => {
    const left = scopePath(rawLeft), right = scopePath(rawRight);
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }));
}
function canDevelopTogether(a, b, definitions) {
  const left = definitions.find(item => item.id === a.id), right = definitions.find(item => item.id === b.id);
  return Array.isArray(left?.in_scope) && left.in_scope.length > 0 && Array.isArray(right?.in_scope) && right.in_scope.length > 0 && !overlaps(left.in_scope, right.in_scope);
}
function summary(state, definitions = [], workflow = null) {
  const tasks = state.tasks.map(task => {
    const definition = definitions.find(item => item.id === task.id) || {};
    const dependencies = definition.depends_on || [];
    const unfinished = dependencies.filter(id => state.tasks.find(item => item.id === id)?.phase !== 'done');
    const active = state.tasks.filter(item => item.id !== task.id && ['developing', 'verifying', 'reviewing'].includes(item.phase));
    const activeBlocker = active.find(item => item.phase !== 'developing' || !canDevelopTogether(task, item, definitions));
    const blockedReason = task.phase === 'pending' && unfinished.length ? `依赖任务尚未通过：${unfinished.join(', ')}` : task.phase === 'pending' && activeBlocker ? `任务 ${activeBlocker.id} 正在执行且范围未确认互斥` : task.phase === 'blocked' || task.phase === 'needs_fix' ? task.reason || task.phase : null;
    const ready = state.status === 'active' && task.phase === 'pending' && unfinished.length === 0 && !activeBlocker;
    const closedReason = task.phase === 'pending' && state.status !== 'active' ? `运行状态为 ${state.status}` : blockedReason;
    return { id: task.id, title: task.title, owner: definition.owner, in_scope: definition.in_scope, out_of_scope: definition.out_of_scope, managed_execution: definition.managed_execution === true, attempts: task.attempts || null, dependencies, ready, blocked_reason: closedReason, phase: task.phase, fixes: task.fixes, review: task.review, verification: task.verification, assessment: task.assessment, reason: task.reason };
  });
  return { run_id: state.run_id, goal: state.goal, status: state.status, stop_reason: state.stop_reason, event_seq: state.event_seq, schema_version: state.schema_version, project_path: state.project_path ?? '.', snapshot_paths: state.snapshot_paths ?? null, workflow, execution_evidence: state.schema_version === 4 ? 'required-for-independent' : 'legacy-unverified', tasks };
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
    assert([2, 3, 4].includes(loaded.state.schema_version) || compareVersions(loaded.state.version, '4.4.0') < 0 &&
      !loaded.spec.tasks.some(task => ['owner', 'in_scope', 'out_of_scope', 'managed_execution'].some(field => Object.hasOwn(task, field))) &&
      !loaded.state.tasks.some(task => task.phase === 'developed' || Object.hasOwn(task, 'attempts')),
    'schema 1 运行须先迁移才能由当前核心写入');
    const lines = fs.readFileSync(loaded.files.events, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines.length ? JSON.parse(lines.at(-1)).seq : 0;
    assert(last === loaded.state.event_seq, '事件与状态不一致；停止并人工恢复，不重置轮数');
    return action(loaded);
  });
}
export function migrate(project, run, confirmNoActiveExecutors = false) {
  const root = rootPath(project);
  assert(confirmNoActiveExecutors === true, '迁移前必须确认没有仍在写入的旧执行者；传入 true 后重试');
  return locked(root, `run-${validId(run)}`, () => {
    const { files, state, spec } = load(root, run);
    assert(state.schema_version === 1, '仅 schema 1 运行需要迁移');
    const originalEvents = fs.readFileSync(files.events, 'utf8');
    const lines = originalEvents.trim().split('\n').filter(Boolean);
    const last = lines.length ? JSON.parse(lines.at(-1)).seq : 0;
    assert(last === state.event_seq, '事件与状态不一致；停止并人工恢复，不重置计数');
    const backup = safePath(files.directory, 'state.schema1.backup.json');
    fs.writeFileSync(backup, fs.readFileSync(files.state), { flag: 'wx', mode: 0o600 });
    const migrated = { ...state, schema_version: 2, version: VERSION, updated_at: now(), event_seq: state.event_seq + 1 };
    const event = { seq: migrated.event_seq, time: migrated.updated_at, type: 'migrated', from_schema: 1, to_schema: 2, from_version: state.version };
    try {
      atomicWrite(files.events, `${originalEvents}${JSON.stringify(event)}\n`);
      writeJson(files.state, migrated);
    } catch (error) {
      try { atomicWrite(files.events, originalEvents); fs.unlinkSync(backup); }
      catch (rollbackError) { throw new Error(`迁移失败且事件回滚也失败；原状态备份保留在 ${backup}。原错误：${error.message}；回滚错误：${rollbackError.message}`); }
      throw error;
    }
    return summary(migrated, spec.tasks, spec.workflow ?? null);
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
  const spec = validateSpec({ ...input, ...(input?.tasks?.some(task => task.review === 'independent') ? { execution_evidence: 'required' } : {}) });
  if (spec.project_path && spec.project_path !== '.') assert(fs.statSync(safePath(root, spec.project_path)).isDirectory(), '子项目目录不存在');
  if (spec.project_path && spec.project_path !== '.' && !spec.snapshot_paths) spec.snapshot_paths = [spec.project_path];
  const run = validId(requestedId || `run-${crypto.randomUUID()}`);
  return locked(root, 'runs', () => {
    const files = paths(root, run);
    assert(!fs.existsSync(files.directory), '运行编号已存在，不能覆盖或重置');
    const revision = snapshot(root, spec.ignore_paths, BUNDLE, spec.snapshot_paths);
    fs.mkdirSync(safePath(root, `.ai-loop/runs/${run}/reports`), { recursive: true });
    fs.mkdirSync(safePath(root, `.ai-loop/runs/${run}/mailbox`), { recursive: true });
    const state = { schema_version: spec.execution_evidence || spec.project_path !== undefined || spec.snapshot_paths ? 4 : spec.role_policy ? 3 : 2, version: VERSION, run_id: run, goal: spec.goal, status: 'active', created_at: now(), updated_at: now(), event_seq: 0,
      ...(spec.project_path !== undefined ? { project_path: spec.project_path } : {}), ...(spec.snapshot_paths ? { snapshot_paths: spec.snapshot_paths } : {}),
      spec_hash: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'), max_fixes: spec.max_fixes, base_revision: revision,
      tasks: spec.tasks.map(task => ({ id: task.id, title: task.title, review: task.review, phase: 'pending', fixes: 0, verification: null, assessment: null, reason: null })) };
    writeJson(files.spec, spec);
    writeJson(files.state, state);
    atomicWrite(files.events, '');
    atomicWrite(safePath(root, `.ai-loop/runs/${run}/plan.md`), `# ${spec.goal}\n\n本文件记录方案；执行状态以 state.json 为准。创建运行前由 AI 核对用户批准范围。\n\n${spec.tasks.map(task => `## ${task.id}：${task.title}\n\n- 验收：${task.acceptance.join('；')}\n- 依赖：${(task.depends_on || []).join(', ') || '无'}\n- 评审：${task.review}\n- 检查：${task.checks.map(check => check.id).join(', ')}\n`).join('\n')}`);
    atomicWrite(safePath(root, `.ai-loop/runs/${run}/session.md`), '# 会话交接\n\n- 用户意图：见 spec.json 的 goal\n- 当前进度：运行 status 命令获取，不在此复制计数\n- 已确认决策：由 AI 按需补充\n- 未决问题：无\n- 下一步：开始首个无依赖任务\n');
    persist(root, files, state, 'created', { revision });
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function begin(project, run, id, phase) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    const task = taskOf(state, id);
    const definition = spec.tasks.find(item => item.id === id);
    assert(['development', 'verification', 'review'].includes(phase), '阶段须为 development / verification / review');
    if (phase === 'development') {
      assert(task.phase === 'pending', '修复须使用 fix 命令，不能通过 begin 重置轮数');
      assert((definition.depends_on || []).every(dependency => taskOf(state, dependency).phase === 'done'), '依赖任务尚未通过');
      assert(state.tasks.every(item => item.id === id || !['verifying', 'reviewing'].includes(item.phase)), '已有任务正在验证或评审，开发须等待证据收敛');
      for (const other of state.tasks.filter(item => item.id !== id && item.phase === 'developing')) assert(canDevelopTogether(task, other, spec.tasks), '并行开发须声明互不重叠的 in_scope；未知范围默认串行');
      if (definition.managed_execution || spec.execution_evidence) task.attempts ||= { tester: 0, reviewer: 0 };
      task.phase = 'developing';
    } else if (phase === 'verification') {
      assert(['developing', 'developed', 'tested', 'done'].includes(task.phase), '只能验证已完成开发、已测或已完成的任务；FAIL 后须先 fix');
      assert(state.tasks.every(item => item.id === id || !['developing', 'verifying', 'reviewing'].includes(item.phase)), '快照证据须保证环境稳定串行：其他任务正在执行');
      task.phase = 'verifying'; task.verification = null; task.assessment = null;
      if (definition.managed_execution || spec.execution_evidence) { task.attempts ||= { tester: 0, reviewer: 0 }; task.attempts.tester++; }
    } else {
      assert(task.phase === 'tested' && task.review !== 'none', '评审需要有效测试结果且任务声明需要评审');
      assert(state.tasks.every(item => item.id === id || !['developing', 'verifying', 'reviewing'].includes(item.phase)), '评审证据须保证环境稳定串行：其他任务正在执行');
      assert(sameRevision(task.verification?.revision, snapshot(root, spec.ignore_paths, BUNDLE, spec.snapshot_paths)), '测试证据已过期，请先重新验证');
      task.phase = 'reviewing';
      if (definition.managed_execution || spec.execution_evidence) { task.attempts ||= { tester: 0, reviewer: 0 }; task.attempts.reviewer++; }
    }
    task.reason = null;
    persist(root, files, state, 'begin', { task_id: id, phase });
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function finish(project, run, id) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    assert([2, 3, 4].includes(state.schema_version), 'schema 1 运行须先显式迁移，再使用 developed 阶段');
    const task = taskOf(state, id);
    assert(task.phase === 'developing', 'finish 仅适用于正在开发的任务');
    task.phase = 'developed';
    persist(root, files, state, 'finish', { task_id: id });
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function record(project, run, report) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    assert(report && (report.role === 'tester' || report.role === 'reviewer'), '报告 role 须为 tester / reviewer');
    const task = taskOf(state, report.task_id);
    const definition = spec.tasks.find(item => item.id === task.id);
    assert(task.phase === (report.role === 'tester' ? 'verifying' : 'reviewing'), '报告与当前任务阶段不符');
    if (definition.managed_execution || spec.execution_evidence) assert(Number.isInteger(report.attempt) && report.attempt === task.attempts?.[report.role], '托管任务报告缺少当前 attempt 或已过期');
    const statuses = report.role === 'tester' ? ['PASS', 'FAIL', 'BLOCKED'] : ['APPROVED', 'REJECTED', 'BLOCKED'];
    assert(statuses.includes(report.status), '报告判定无效');
    const blocked = report.status === 'BLOCKED';
    const revision = blocked ? report.revision : snapshot(root, spec.ignore_paths, BUNDLE, spec.snapshot_paths);
    validateReport(report, blocked ? null : revision);
    if (report.status === 'PASS') checkEvidence(report, definition.checks, files.directory);
    if (report.status === 'APPROVED') {
      assert(sameRevision(task.verification?.revision, revision), '评审对应的测试已过期');
      checkReview(report, task.review);
    }
    if (report.execution === 'independent' && ['PASS', 'APPROVED'].includes(report.status)) checkExecution(root, run, report, revision, task.id, task.attempts?.[report.role] ?? 0);
    if (['FAIL', 'REJECTED', 'BLOCKED'].includes(report.status)) assert(report.issues.length || report.findings?.length, '失败或阻塞结果须说明问题');
    const reportPath = saveReport(root, files, state, report);
    const result = { status: report.status, execution: report.execution, attempt: report.attempt, revision, revision_confirmed: !blocked, report: reportPath };
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
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function fix(project, run, id) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    const task = taskOf(state, id);
    assert(task.phase === 'needs_fix', '只能修复被测试或评审拒绝的任务；阻塞需先解决条件');
    assert(task.fixes < state.max_fixes, '修复已达上限，停止并向用户报告，不能重置或静默新开运行');
    assert(state.tasks.every(item => item.id === id || !['developing', 'verifying', 'reviewing'].includes(item.phase) || item.phase === 'developing' && canDevelopTogether(task, item, spec.tasks)), '默认串行：其他任务正在执行或范围未知');
    task.fixes++; task.phase = 'developing'; task.verification = null; task.assessment = null;
    persist(root, files, state, 'fix', { task_id: id, fixes: task.fixes });
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function resume(project, run, id, reason) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    const task = taskOf(state, id);
    assert(task.phase === 'blocked' && nonempty(reason), '仅可在明确解决阻塞条件后恢复，并提供 reason');
    assert(state.tasks.every(item => item.id === id || !['developing', 'verifying', 'reviewing'].includes(item.phase) || item.phase === 'developing' && canDevelopTogether(task, item, spec.tasks)), '默认串行：其他任务正在执行或范围未知');
    task.phase = 'developing'; task.verification = null; task.assessment = null; task.reason = null;
    persist(root, files, state, 'resumed', { task_id: id, reason });
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function stop(project, run, reason) {
  const root = rootPath(project);
  assert(nonempty(reason), '停止运行须提供明确 reason');
  return mutable(root, run, ({ files, state, spec }) => {
    state.status = 'stopped'; state.stop_reason = reason;
    for (const task of state.tasks) {
      if (['developing', 'developed', 'verifying', 'reviewing'].includes(task.phase)) {
        task.phase = 'blocked'; task.reason = reason;
      }
    }
    persist(root, files, state, 'stopped', { reason });
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function complete(project, run, input) {
  const root = rootPath(project);
  return mutable(root, run, ({ files, state, spec }) => {
    assert(state.tasks.every(task => task.phase === 'done'), '仍有未通过任务，不能交付');
    const revision = snapshot(root, spec.ignore_paths, BUNDLE, spec.snapshot_paths);
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
      if (input.review.execution === 'independent') checkExecution(root, run, input.review, revision, 'final', state.event_seq);
    }
    if (report.execution === 'independent') checkExecution(root, run, report, revision, 'final', state.event_seq);
    const verification = saveReport(root, files, state, { ...report, task_id: undefined });
    const review = requiresReview ? saveReport(root, files, state, { ...input.review, task_id: undefined }) : null;
    state.status = 'complete'; state.delivery = { revision, verification, review };
    persist(root, files, state, 'complete', { revision, verification, review });
    return summary(state, spec.tasks, spec.workflow ?? null);
  });
}

export function event(project, run, input) {
  const root = rootPath(project);
  assert(input && ['requirement', 'decision', 'rejected', 'question', 'handoff'].includes(input.type) && nonempty(input.summary) && input.summary.length <= 2000, '事件需合法 type 和不超过 2000 字的 summary');
  return mutable(root, run, ({ files, state }) => {
    persist(root, files, state, input.type, { summary: input.summary }); return { run_id: run, event_seq: state.event_seq };
  });
}
export function progress(project, run, input) {
  const root = rootPath(project);
  assert(input && ['planned', 'done', 'blocked'].includes(input.stage) && nonempty(input.summary) && input.summary.length <= 2000, '进度须有 planned / done / blocked 阶段及简短摘要');
  validId(input.unit); validId(input.task);
  assert(Array.isArray(input.files) && input.files.length <= 100 && input.files.every(item => typeof item === 'string'), '进度 files 须为项目相对路径数组');
  const hashes = input.files.map(relative => {
    const target = safePath(root, relative);
    assert(!fs.existsSync(target) || fs.statSync(target).isFile(), '进度引用须为普通文件');
    return { path: relative, hash: fs.existsSync(target) ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null };
  });
  return mutable(root, run, ({ files, state }) => {
    taskOf(state, input.task);
    const previous = fs.readFileSync(files.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.type === 'progress' && item.unit === input.unit).at(-1);
    assert(input.stage === 'planned' ? !previous : previous?.stage === 'planned' && previous.task_id === input.task, '工作单元须先 planned 再 done / blocked；已关闭单元使用新编号');
    persist(root, files, state, 'progress', { unit: input.unit, task_id: input.task, stage: input.stage, summary: input.summary, files: hashes });
    return { run_id: run, event_seq: state.event_seq, unit: input.unit, stage: input.stage, verification: 'unchecked' };
  });
}
export function mail(project, run, message) {
  const root = rootPath(project);
  assert(message && typeof message === 'object', '邮件内容须为对象');
  const roles = ['dev', 'tester', 'reviewer', 'planner', 'scribe', 'user'];
  assert(roles.includes(message.from_role), `from_role 须为有效角色 (${roles.join('/')})`);
  assert(roles.includes(message.to_role) || message.to_role === 'all', `to_role 须为有效角色或 all`);
  assert(typeof message.subject === 'string' && message.subject.trim(), '邮件需要明确的 subject 主题');
  const validTypes = ['handoff', 'defect', 'review', 'query', 'announcement'];
  assert(!message.type || validTypes.includes(message.type), `type 须为 ${validTypes.join('/')}`);
  return mutable(root, run, ({ files, state }) => {
    if (message.task_id) taskOf(state, message.task_id);
    fs.mkdirSync(files.mailbox, { recursive: true });
    const mailId = `mail-${String(state.event_seq + 1).padStart(5, '0')}`;
    const payload = {
      id: mailId,
      time: now(),
      task_id: message.task_id || null,
      from_role: message.from_role,
      to_role: message.to_role,
      type: message.type || 'handoff',
      subject: message.subject.trim(),
      payload: message.payload ?? null,
    };
    const mailPath = safePath(files.mailbox, `${mailId}.json`);
    writeJson(mailPath, payload);
    persist(root, files, state, 'mail', { mail_id: mailId, ...payload });
    return { ok: true, mail_id: mailId, event_seq: state.event_seq };
  });
}

export function inbox(project, run, query = {}) {
  const root = rootPath(project);
  const { files } = load(root, run);
  if (!fs.existsSync(files.mailbox)) return { messages: [], count: 0 };
  const role = query.role;
  const taskId = query.task_id;
  const afterId = query.after_id;
  const filesList = fs.readdirSync(files.mailbox).filter(f => f.startsWith('mail-') && f.endsWith('.json')).sort();
  const messages = [];
  for (const file of filesList) {
    const id = file.replace(/\.json$/, '');
    if (afterId && id <= afterId) continue;
    const msg = jsonFile(safePath(files.mailbox, file));
    if (role && msg.to_role !== 'all' && msg.to_role !== role && msg.from_role !== role) continue;
    if (taskId && msg.task_id && msg.task_id !== taskId) continue;
    messages.push(msg);
  }
  return { messages, count: messages.length };
}

export function events(project, run, after = 0, limit = 50) {
  const root = rootPath(project);
  assert(Number.isInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 100, '事件游标与数量无效');
  const { files } = load(root, run);
  // 日志只在进程内部扫描；返回模型的是游标之后的有限事件。
  const result = fs.readFileSync(files.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.seq > after).slice(0, limit);
  return { events: result, next_cursor: result.at(-1)?.seq ?? after };
}
export function listRuns(project, options = {}) {
  const root = rootPath(project);
  if (options.project_path !== undefined) assert(options.project_path === '.' || validRelativeScope(options.project_path), '子项目筛选路径无效');
  const runsDir = safePath(root, '.ai-loop/runs');
  if (!fs.existsSync(runsDir)) return [];
  const entries = fs.readdirSync(runsDir).sort();
  const list = [];
  for (const entry of entries) {
    const stateFile = path.join(runsDir, entry, 'state.json');
    if (fs.existsSync(stateFile)) {
      try {
        const state = jsonFile(stateFile);
        list.push({ run_id: entry, status: state.status, goal: state.goal, updated_at: state.updated_at, project_path: state.project_path ?? '.', snapshot_paths: state.snapshot_paths ?? null });
      } catch {
        list.push({ run_id: entry, status: 'unknown' });
      }
    }
  }
  if (options.project_path === undefined) return list;
  const sameProjectPath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  return list.filter(item => typeof item.project_path === 'string' && sameProjectPath(item.project_path, options.project_path));
}

export function status(project, run) {
  const root = rootPath(project);
  if (!run) {
    const runs = listRuns(project);
    const active = runs.filter(r => r.status === 'active');
    if (active.length === 1) {
      run = active[0].run_id;
    } else if (active.length === 0 && runs.length === 1) {
      run = runs[0].run_id;
    } else {
      const candidates = (active.length ? active : runs).map(r => r.run_id).join(', ');
      assert(false, candidates ? `缺少 --run 参数，可选的运行编号：${candidates}` : '未找到任何运行记录，请先使用 create 命令创建运行');
    }
  }
  const loaded = load(root, run);
  return summary(loaded.state, loaded.spec.tasks, loaded.spec.workflow ?? null);
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'run', 'task', 'phase', 'input', 'reason', 'after', 'limit', 'role', 'after-id', 'confirm-no-active-executors', 'help']);
  const [command] = options._;
  assert(options._.length <= 1, '只能指定一个命令');
  if (options.help || !command) return { commands: 'create / begin / finish / snapshot / record / fix / resume / stop / migrate / status / event / events / progress / complete / mail / inbox', usage: 'node scripts/loop.mjs COMMAND --project ROOT [--run ID] [--task ID] [--input FILE]' };
  const input = () => {
    assert(typeof options.input === 'string', '此命令需要 --input JSON文件');
    const root = options.project ? rootPath(options.project) : process.cwd();
    return jsonFile(path.resolve(root, options.input));
  };
  if (command === 'create') return create(options.project, input(), options.run);
  if (command === 'begin') return begin(options.project, options.run, options.task, options.phase);
  if (command === 'finish') return finish(options.project, options.run, options.task);
  if (command === 'snapshot') {
    const root = rootPath(options.project);
    const spec = options.run ? load(root, options.run).spec : {};
    return snapshot(root, spec.ignore_paths || [], BUNDLE, spec.snapshot_paths);
  }
  if (command === 'record') return record(options.project, options.run, input());
  if (command === 'fix') return fix(options.project, options.run, options.task);
  if (command === 'resume') return resume(options.project, options.run, options.task, options.reason);
  if (command === 'stop') return stop(options.project, options.run, options.reason);
  if (command === 'migrate') return migrate(options.project, options.run, options['confirm-no-active-executors'] === true);
  if (command === 'status') return status(options.project, options.run);
  if (command === 'event') return event(options.project, options.run, input());
  if (command === 'progress') return progress(options.project, options.run, input());
  if (command === 'events') return events(options.project, options.run, Number(options.after || 0), Number(options.limit || 50));
  if (command === 'complete') return complete(options.project, options.run, input());
  if (command === 'mail') return mail(options.project, options.run, input());
  if (command === 'inbox') return inbox(options.project, options.run, { role: options.role, task_id: options.task, after_id: options['after-id'] });
  throw new Error('未知命令，运行 --help 查看用法');
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
