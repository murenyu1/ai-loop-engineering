import fs from 'node:fs';
import crypto from 'node:crypto';
import { status as runStatus } from './loop.mjs';
import { installed } from './models.mjs';
import { resolveProfile } from './profiles.mjs';
import { ROLES, routeHash, validateProfile } from './routing.mjs';
import { assert, rootPath, safePath, validId, jsonFile, locked, writeJson, args, allowArgs, mainModule, printResult } from './lib.mjs';

const transitions = { requested: ['running', 'failed', 'stopped'], running: ['waiting', 'completed', 'failed', 'stopped'], waiting: ['running', 'failed', 'stopped'], completed: [], failed: [], stopped: [] };
const nonempty = value => typeof value === 'string' && value.trim() && value.length <= 1000;
function ledger(root, run) {
  validId(run);
  const file = safePath(root, `.ai-loop/runs/${run}/agents.json`);
  return { file, data: fs.existsSync(file) ? jsonFile(file) : { schema_version: 1, agents: [] } };
}
const compact = item => ({ id: item.id, harness: item.harness, role: item.role, task: item.task,
  state: item.state, native_id: item.native_id, requested: item.requested, profile_hash: item.profile_hash,
  updated_at: item.updated_at, ...(item.replaces ? { replaces: item.replaces } : {}),
  observations: item.observations.slice(-1), history_count: item.history.length });
export function recordAgent(project, run, input) {
  const root = rootPath(project);
  assert(input && Object.keys(input).every(key => ['id', 'harness', 'role', 'task', 'state', 'native_id', 'summary', 'observation', 'replaces'].includes(key)), '代理记录字段无效');
  validId(input.id);
  assert(Object.hasOwn(transitions, input.state) && nonempty(input.summary), '代理状态或摘要无效');
  return locked(root, `run-${validId(run)}`, () => {
    const current = runStatus(root, run);
    assert(current.status !== 'complete' && current.status !== 'stopped', '已关闭运行不能新增或更新代理记录');
    const { file, data } = ledger(root, run);
    assert(data.schema_version === 1 && Array.isArray(data.agents), '代理台账格式无效');
    const previous = data.agents.find(agent => agent.id === input.id);
    let item;
    if (!previous) {
      assert(input.state === 'requested' && Object.hasOwn(ROLES, input.role), '首次记录须为 requested 且有合法角色');
      assert(current.tasks.some(task => task.id === input.task), '代理任务不属于当前运行');
      const { record } = installed(root, input.harness);
      const marker = safePath(root, '.ai-loop/plugin.json');
      const plugin = fs.existsSync(marker) ? resolveProfile(root) : null;
      const profile = plugin?.profile || record?.model_routing?.profile;
      assert(profile, '该 harness 未配置模型分工');
      assert(routeHash(validateProfile(profile, input.harness)) === (plugin?.profile_hash || record.model_routing.profile_hash), '模型配置摘要损坏，停止派发记录');
      if (input.replaces) {
        const old = data.agents.find(agent => agent.id === input.replaces);
        assert(old && ['completed', 'failed', 'stopped'].includes(old.state) && old.task === input.task && old.role === input.role, '替换前须先完成或停止同任务同角色代理并保存交接');
      }
      item = { id: input.id, harness: input.harness, role: input.role, task: input.task, requested: profile.roles[input.role], profile_hash: routeHash(profile), state: 'requested', native_id: null, observations: [], history: [], ...(input.replaces ? { replaces: input.replaces } : {}) };
      data.agents.push(item);
    } else {
      assert(transitions[previous.state].includes(input.state), '代理状态转换无效；终态不能恢复，请新建代理记录');
      for (const key of ['harness', 'role', 'task', 'replaces']) assert(input[key] === undefined || input[key] === previous[key], '不能更改已派发代理的身份或任务');
      item = previous;
    }
    if (input.native_id !== undefined) {
      assert(nonempty(input.native_id) && (!item.native_id || item.native_id === input.native_id), '原生代理 ID 无效或变化');
      item.native_id = input.native_id;
    }
    assert(!['running', 'waiting', 'completed'].includes(input.state) || item.native_id, '运行/完成状态必须记录真实原生代理 ID');
    const at = new Date().toISOString();
    if (input.observation) {
      const observation = input.observation;
      assert(['native-log', 'native-ui'].includes(observation.source) && nonempty(observation.path), '观察须有 native-log/native-ui 来源与项目内证据路径');
      const target = safePath(root, observation.path);
      assert(fs.statSync(target).isFile() && fs.statSync(target).size > 0, '观察证据须为非空普通文件');
      assert(observation.model === undefined || nonempty(observation.model), '观察模型无效');
      assert(observation.effort === undefined || observation.effort === null || nonempty(observation.effort), '观察强度无效');
      assert(observation.visible === undefined || typeof observation.visible === 'boolean', 'visible 须为布尔值');
      item.observations.push({ source: observation.source, path: observation.path, hash: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), model: observation.model ?? null, effort: observation.effort ?? null, visible: observation.visible ?? null, at, verification: 'reported-with-evidence' });
    }
    item.state = input.state;
    item.updated_at = at;
    item.history.push({ state: input.state, summary: input.summary, at });
    writeJson(file, data);
    return { ...compact(item), effective_model: 'unverified', note: '台账记录调度者的原生观察，不自动解析证据或强制模型；completed 不代表任务验证通过' };
  });
}
export function agentStatus(project, run) {
  const root = rootPath(project);
  runStatus(root, run);
  const { data } = ledger(root, run);
  assert(data.schema_version === 1 && Array.isArray(data.agents), '代理台账格式无效');
  return { schema_version: 1, agents: data.agents.map(compact), note: '仅显示最后记录的状态和最近观察，不是实时轮询。完整历史保存在 agents.json；实际运行状态以原生工具为准。' };
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'run', 'input', 'help']);
  assert(options._.length <= 1, '只能指定一个命令');
  const [command] = options._;
  if (options.help || !command) return { usage: 'agents.mjs record|status --project ROOT --run ID [--input PROJECT_RELATIVE_JSON]' };
  if (command === 'status') return agentStatus(options.project, options.run);
  assert(command === 'record', '未知命令');
  return recordAgent(options.project, options.run, jsonFile(safePath(rootPath(options.project), options.input)));
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
