import fs from 'node:fs';
import { status } from './loop.mjs';
import { executionEvidence } from './execution.mjs';
import { ROLE_NAMES, roleEnabled, rolesStatus } from './roles.mjs';
import { assert, rootPath, safePath, validId, jsonFile, writeJson, locked, args, allowArgs, mainModule, printResult } from './lib.mjs';

const terminal = new Set(['completed', 'failed', 'stopped']);
const states = ['requested', 'running', 'waiting', 'stop_requested', 'unknown', ...terminal];
const text = value => typeof value === 'string' && value.trim() && value.length <= 1000;
export function dispatchCheck(project, run, taskId, role, attempt) {
  const root = rootPath(project), current = status(root, validId(run));
  assert(current.status === 'active', '运行已关闭或停止，不能派发');
  assert(ROLE_NAMES.includes(role), '未知子代理角色');
  const task = taskId === 'final' && ['tester', 'reviewer'].includes(role) && current.tasks.every(item => item.phase === 'done') ? { id: 'final', phase: role === 'reviewer' ? 'reviewing' : 'verifying', managed_execution: true, attempts: { tester: current.event_seq, reviewer: current.event_seq } } : current.tasks.find(item => item.id === taskId);
  assert(task, '任务不属于当前运行');
  const spec = jsonFile(safePath(root, `.ai-loop/runs/${run}/spec.json`));
  if (spec.role_policy) assert(roleEnabled(spec.role_policy[role]), `角色 ${role} 已关闭，禁止派发`);
  const savedPolicy = rolesStatus(root);
  if (savedPolicy.source !== 'default-off') assert(roleEnabled(savedPolicy.roles[role]), `角色 ${role} 已关闭，禁止派发`);
  const phase = { dev: 'developing', tester: 'verifying', reviewer: 'reviewing' }[role];
  if (phase) assert(task.phase === phase, `角色 ${role} 不能在任务阶段 ${task.phase} 派发`);
  if ((task.managed_execution || spec.execution_evidence) && ['tester', 'reviewer'].includes(role)) assert(Number.isInteger(attempt) && attempt === task.attempts?.[role], '派发 attempt 缺失或已过期');
  return { run_id: run, task_id: taskId, role, attempt: attempt ?? null, task, execution_evidence: current.execution_evidence };
}
function read(root, run) {
  const file = safePath(root, `.ai-loop/runs/${validId(run)}/activity.json`);
  const data = fs.existsSync(file) ? jsonFile(file) : { schema_version: 2, agents: [] };
  assert(data.schema_version === 2 && Array.isArray(data.agents), '代理观察格式无效');
  return { file, data };
}
function legacyAgents(root, run) {
  const file = safePath(root, `.ai-loop/runs/${validId(run)}/agents.json`);
  const data = fs.existsSync(file) ? jsonFile(file) : { schema_version: 1, agents: [] };
  assert(data.schema_version === 1 && Array.isArray(data.agents), '旧代理台账格式无效');
  return data.agents;
}
export function recordActivity(project, run, input) {
  const root = rootPath(project);
  assert(input && Object.keys(input).every(key => ['id', 'task', 'role', 'attempt', 'harness', 'native_id', 'session_id', 'state', 'requested', 'observed_model', 'observed_effort', 'usage', 'source', 'summary', 'context', 'revision', 'evidence'].includes(key)), '代理观察字段无效');
  validId(input.id);
  assert(states.includes(input.state) && text(input.summary), '代理状态或摘要无效');
  return locked(root, `run-${validId(run)}`, () => {
    const current = status(root, run);
    const { file, data } = read(root, run);
    let item = data.agents.find(row => row.id === input.id);
    assert(current.status === 'active' || item && ['stop_requested', 'stopped', 'failed', 'completed'].includes(input.state), '已关闭运行只能确认已有执行者停止或终态');
    const at = new Date().toISOString();
    if (!item) {
      assert(input.state === 'requested', '首次观察须为 requested');
      dispatchCheck(root, run, input.task, input.role, input.attempt);
      assert(text(input.harness), '须提供宿主名称');
      assert(![...data.agents, ...legacyAgents(root, run)].some(row => row.task === input.task && row.role === input.role && !terminal.has(row.state)), '同任务同角色已有未确认停止的执行者');
      item = { id: input.id, run_id: run, task: input.task, role: input.role, attempt: input.attempt ?? null, harness: input.harness, state: 'requested', native_id: null, requested: input.requested ?? null, started_at: at, history: [] };
      data.agents.push(item);
    } else {
      assert(!terminal.has(item.state) && input.state !== 'requested', '终态不能恢复或重复派发，请创建新观察');
      for (const key of ['task', 'role', 'attempt', 'harness']) assert(input[key] === undefined || input[key] === item[key], '不能改变执行者身份或批次');
    }
    if (input.native_id !== undefined) { assert(text(input.native_id) && (!item.native_id || item.native_id === input.native_id), '真实代理 ID 不能缺失或变化'); item.native_id = input.native_id; }
    if (input.context !== undefined) {
      const value = input.context;
      assert(value && ['independent', 'inherited', 'self'].includes(value.mode) && text(value.id) && text(value.parent_id), '上下文须有 mode、id、parent_id');
      assert(value.mode !== 'independent' || value.id !== value.parent_id, '独立父子上下文不能相同');
      assert(!item.context || JSON.stringify(item.context) === JSON.stringify(value), '执行上下文不能变化'); item.context = value;
    }
    if (input.revision !== undefined) {
      assert(input.revision?.algorithm === 'sha256' && /^[a-f0-9]{64}$/.test(input.revision.digest) && Number.isInteger(input.revision.files) && input.revision.files >= 0, '执行快照无效');
      assert(!item.revision || JSON.stringify(item.revision) === JSON.stringify(input.revision), '执行快照不能变化'); item.revision = input.revision;
    }
    if (input.evidence !== undefined) item.evidence = executionEvidence(root, run, input.evidence);
    assert(!['running', 'waiting', 'completed', 'stop_requested'].includes(input.state) || text(item.native_id), '运行观察须有真实原生代理 ID');
    assert(input.source === undefined || ['scheduler', 'native-runtime', 'native-log', 'native-ui'].includes(input.source), '观察来源无效');
    if (input.usage !== undefined && input.usage !== null) {
      assert(typeof input.usage === 'object' && !Array.isArray(input.usage), 'usage 须为真实计数对象');
      assert(Object.entries(input.usage).every(([key, value]) => ['input_tokens', 'output_tokens', 'cached_tokens'].includes(key) && Number.isSafeInteger(value) && value >= 0), 'usage 仅接受非负整数实际计数');
      item.usage = input.usage;
    }
    for (const key of ['session_id', 'observed_model', 'observed_effort']) if (input[key] !== undefined) { assert(input[key] === null || text(input[key]), `${key} 无效`); item[key] = input[key]; }
    item.state = input.state; item.updated_at = at; item.source = input.source ?? 'scheduler';
    if (terminal.has(item.state)) item.finished_at = at;
    item.history.push({ at, state: item.state, summary: input.summary });
    assert(data.agents.length <= 1000 && item.history.length <= 1000, '代理观察超过单次运行预算，请显式归档');
    writeJson(file, data);
    return { ...item, history: undefined, live: false, effective_model: item.observed_model ?? 'unverified' };
  });
}
export function activityStatus(project, run) {
  const root = rootPath(project);
  status(root, run);
  const { data } = read(root, run);
  const known = new Set(data.agents.map(row => row.native_id).filter(Boolean));
  const agents = [...data.agents, ...legacyAgents(root, run).filter(row => !row.native_id || !known.has(row.native_id))].map(({ history, observations, ...row }) => ({ ...row, observation: history?.at(-1) ?? observations?.at(-1) ?? null, live: false, stale: !terminal.has(row.state) && (!row.updated_at || Date.now() - Date.parse(row.updated_at) > 60000), usage: row.usage ?? null, effective_model: row.observed_model ?? 'unverified' }));
  return { schema_version: 2, run_id: run, agents, note: '仅最后观察，不是实时运行保证。completed 不代表任务 PASS；usage 缺失表示不可获取。' };
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'run', 'task', 'role', 'attempt', 'input', 'help']);
  const [command] = options._;
  if (options.help || !command) return { usage: 'activity.mjs status|record|check --project ROOT --run ID [--input JSON | --task ID --role dev --attempt N]' };
  assert(options._.length === 1, '只能指定一个命令');
  if (command === 'status') return activityStatus(options.project, options.run);
  if (command === 'record') return recordActivity(options.project, options.run, jsonFile(safePath(rootPath(options.project), options.input)));
  assert(command === 'check', '未知观察命令');
  assert(roleEnabled(rolesStatus(options.project).roles[options.role]), '通用工作流角色默认关闭；请先显式启用');
  return dispatchCheck(options.project, options.run, options.task, options.role, options.attempt === undefined ? undefined : Number(options.attempt));
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
