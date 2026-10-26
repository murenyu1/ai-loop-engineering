import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createConfig, projectKey, projectSettings, roleOptions, validateConfig, validateProjects, validateRoles } from '../dsh/config.mjs';
import * as loop from '../core/scripts/loop.mjs';
import { recordActivity } from '../core/scripts/activity.mjs';
import { chatHistory } from '../core/scripts/dashboard.mjs';

const root = 'D:\\Projects\\example';
const config = extra => ({ enabled: true, maxConcurrent: 2, roles: { reviewer: { provider: 'parent-provider', model: 'parent-model' } }, projects: [{ path: root, enabled: true }], ...extra });
const signal = () => new AbortController().signal;

test('DSH 精确项目启用、总开关与大小写路径，不启用子目录或未知项目', () => {
  assert.equal(projectSettings(config(), 'd:/projects/example/').enabled, true);
  assert.equal(projectSettings(config(), 'D:/Projects/example/sub').enabled, false);
  assert.equal(projectSettings(config({ enabled: false }), root).enabled, false);
  assert.equal(projectSettings(config({ projects: [] }), root).enabled, false);
  assert.equal(projectKey('relative/project'), undefined);
  assert.equal(projectKey('/'), '/');
  assert.throws(() => projectSettings(config({ projects: [{ path: root }, { path: root.toLowerCase() }] }), root), /重复/);
});

test('DSH volatile、项目角色字段覆盖与无效模型设置不静默回退', () => {
  const values = config({ roles: { reviewer: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } }, projects: [{ path: root, enabled: true, roles: { reviewer: { reasoningEffort: '' } } }] });
  const state = projectSettings(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { get: () => v }])), root);
  assert.deepEqual(roleOptions(state, 'reviewer'), { provider: 'deepseek', model: 'reasoner' });
  assert.throws(() => roleOptions({ roles: { dev: { provider: 'only' } } }, 'dev'), /同时/);
  assert.throws(() => roleOptions({ roles: {} }, 'unknown'), /未知/);
  assert.throws(() => projectSettings(config({ maxConcurrent: 0 }), root), /并发/);
});

test('DSH 新角色默认关闭，显式关闭覆盖旧路由；旧显式模型继续启用', () => {
  assert.equal(roleOptions({ roles: {} }, 'dev'), undefined);
  assert.equal(roleOptions({ roles: { dev: { provider: 'p', model: 'm' } } }, 'dev').model, 'm');
  assert.equal(roleOptions({ roles: { dev: { enabled: false, provider: 'p', model: 'm' } } }, 'dev'), undefined);
  assert.throws(() => roleOptions({ roles: { dev: { enabled: true } } }, 'dev'), /必须配置/);
});

test('DSH schema v2 使用 workflowEnabled，legacy enabled=false 可阻止旧版继续派发', () => {
  const legacy = config();
  assert.equal(projectSettings(legacy, root).enabled, true);
  const v2 = { ...legacy, schemaVersion: 2, enabled: false, workflowEnabled: true };
  assert.equal(projectSettings(v2, root).enabled, true);
  assert.throws(() => validateConfig({ ...v2, enabled: true }), /legacy enabled 必须为 false/);
  assert.throws(() => projectSettings({ ...v2, schemaVersion: 3 }, root), /不支持.*schemaVersion/);
  assert.equal(projectSettings({ ...v2, workflowEnabled: false }, root).enabled, false);
});

test('DSH 运行前配置校验拒绝相对/重复路径、全局半路由和合并后半路由', () => {
  assert.throws(() => validateProjects([{ path: 'relative/project' }]), /绝对路径/);
  assert.throws(() => validateProjects([{ path: root }, { path: 'd:/projects/example/' }]), /重复/);
  assert.throws(() => validateRoles({ dev: { provider: 'p' } }), /同时/);
  assert.throws(() => validateConfig(config({ roles: { dev: { provider: 'p', model: 'm' } }, projects: [{ path: root, enabled: true, roles: { dev: { provider: '' } } }] })), /同时/);
  assert.doesNotThrow(() => validateConfig(config({ roles: { dev: { provider: 'p', model: 'm' } }, projects: [{ path: root, enabled: true, roles: { dev: { reasoningEffort: 'high' } } }] })));
});

test('DSH Config仅包含浏览器可序列化声明约束，不含transform回调', () => {
  const schema = (type, fields = {}) => {
    const item = { type, ...fields, meta: {} };
    for (const name of ['default', 'volatile', 'required', 'min', 'max', 'step']) item[name] = value => {
      item.meta[name] = value ?? true; return item;
    };
    item.pattern = value => { item.meta.pattern = { source: value.source, flags: value.flags }; return item; };
    return item;
  };
  const z = {
    object: dict => schema('object', { dict }),
    union: list => schema('union', { list }),
    array: inner => schema('array', { inner }),
    string: () => schema('string'), boolean: () => schema('boolean'), number: () => schema('number')
  };
  const restored = JSON.parse(JSON.stringify(createConfig(z)));
  assert.doesNotMatch(JSON.stringify(restored), /transform|callback/);
  assert.equal(restored.dict.roles.dict.reviewer.type, 'union');
  assert.equal(restored.dict.roles.dict.reviewer.list.length, 5);
  assert.ok(restored.dict.schemaVersion);
  assert.ok(restored.dict.workflowEnabled);
  const rule = restored.dict.projects.inner.dict.path.meta.pattern;
  assert.equal(new RegExp(rule.source, rule.flags).test('D:/example'), true);
  assert.equal(new RegExp(rule.source, rule.flags).test('relative/example'), false);
});

// Contract tests use SDK doubles; real DSH loading and model calls are separate
// acceptance checks. No SDK is downloaded or copied into the source repository.
let source = fs.readFileSync(new URL('../dsh/index.mjs', import.meta.url), 'utf8');
source = source.replace("import z from '@deepseek-ai/schemastery';", 'const chain = new Proxy(function(){ return chain; }, {get:()=>chain}); const z=chain;');
source = source.replace("import { defineTool } from '@deepseek-ai/dsh-tools';", 'const defineTool = value => { for (const [name, spec] of Object.entries(value.parameters ?? {})) { if (spec.required !== undefined && spec.required !== true) throw new Error(`unsupported JSON schema: parameters.${name}.required must be true when present`); } return value; };');
source = source.replace("import { delegationDepthOf, parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';", 'const delegationDepthOf = agent => agent.depth ?? 0; const parentAgentOptionsForDelegation = agent => agent.options;');
source = source.replace("'./config.mjs'", JSON.stringify(new URL('../dsh/config.mjs', import.meta.url).href));
source = source.replaceAll('import.meta.url', JSON.stringify(new URL('../dsh/index.mjs', import.meta.url).href));
const { apply } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture(settings = config(), { managedExecution = false } = {}) {
  const skills = [], contexts = [], tools = [], calls = [], pending = [], preflights = [], routes = [];
  const connection = { requestRejection: () => undefined };
  const provider = { inheritsParentContext: false, prepareContinuable() {}, capabilities: { agentOptions: true, depthLimit: true } };
  const ctx = {
    inject: (services, setup) => {
      assert.deepEqual(services, ['webServer', 'connection']);
      setup({
        webServer: { register: route => { routes.push(route); return () => {}; } },
        connection,
        effect: callback => callback(),
      });
    },
    skills: { register: skill => skills.push(skill) },
    systemPrompt: { context: entry => contexts.push(entry) },
    tools: { register: tool => tools.push(tool) },
    workingDirectory: { ensure: async agent => `${agent.session.header.cwd}\\src` },
    llm: { resolveCallConfig: async route => preflights.push(route) },
    subagents: {
      getProvider: () => provider,
      resolveMaxDepth: () => 1,
      startActivation: async spec => {
        calls.push(spec);
        let resolve, reject;
        const result = new Promise((a, b) => { resolve = a; reject = b; });
        pending.push({ resolve, reject });
        return { childId: `child-${calls.length}`, result };
      }
    }
  };
  const configuredPath = settings.projects?.[0]?.path;
  const project = configuredPath && fs.existsSync(configuredPath) ? configuredPath : fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-dsh-dispatch-'));
  ctx.sessions = { get: id => id === 'session-1' ? { header: { cwd: project } } : undefined };
  settings.projects = [{ ...settings.projects?.[0], path: project, enabled: true }];
  if (!configuredPath || !fs.existsSync(configuredPath)) {
    loop.create(project, { goal: '测试派发', tasks: [
      { id: 'task1', title: '实现', acceptance: ['完成'], review: 'none', ...(managedExecution ? { managed_execution: true } : {}), checks: [{ id: 'check1', command: 'node --version' }] },
      { id: 'task2', title: '实现另一个任务', acceptance: ['完成'], review: 'none', checks: [{ id: 'check2', command: 'node --version' }] }
    ] }, 'dispatch-run');
    const stateFile = path.join(project, '.ai-loop', 'runs', 'dispatch-run', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.tasks[0].phase = 'reviewing';
    state.tasks[1].phase = 'reviewing';
    if (managedExecution) state.tasks[0].attempts = { reviewer: 0, tester: 0 };
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  apply(ctx, settings);
  const parent = { id: 'parent', session: { header: { cwd: project } }, options: { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'low' } };
  return { ctx, skills, contexts, tools, calls, pending, preflights, routes, connection, parent, project, run: (role = 'reviewer', extra = {}, attempt = 0, task = 'task1', project_path = '.') => tools.find(tool => tool.name === 'ai_loop_delegate').execute({ role, run: 'dispatch-run', task, attempt, project_path, description: '审查改动', prompt: '审查 src/main.mjs 正确性。' }, { agent: parent, signal: signal(), ...extra }) };
}

test('DSH 技能与动态上下文仅提供必要恢复入口，不写入项目', () => {
  const f = fixture();
  assert.deepEqual(f.skills.map(s => s.name), ['ai-loop', 'ai-loop-models']);
  assert.ok(f.skills.every(s => !s.content.includes('{{CORE}}')));
  assert.match(f.contexts[0].text({ agent: f.parent }), /此项目已启用/);
  const leaf = f.contexts[0].text({ agent: { ...f.parent, depth: 1 } });
  assert.match(leaf, /叶角色/); assert.doesNotMatch(leaf, /必须通过 ai_loop_delegate|严禁主代理/);
  f.parent.session.header.cwd = 'D:/unknown';
  assert.equal(f.contexts[0].text({ agent: f.parent }), '');
  const file = fs.readFileSync(new URL('../dsh/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(file, /writeFile|appendFile|mkdir|child_process|execFile|spawn\(/);
  assert.doesNotMatch(file, /ops_bash|callTool\(/);
});

test('状态路由只允许精确启用项目并要求宿主请求校验', async () => {
  const f = fixture();
  const route = f.routes[0];
  assert.equal(route.path, '/plugins/ai-loop-engineering/state');
  const response = () => ({ status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } });
  let res = response();
  await route.handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?project=D%3A%2FProjects%2Fother' }, res);
  assert.equal(res.status, 403);
  res = response();
  await route.handler({ method: 'POST', url: '/plugins/ai-loop-engineering/state?project=D%3A%2FProjects%2Fexample' }, res);
  assert.equal(res.status, 405);
  f.connection.requestRejection = () => 401;
  res = response();
  await route.handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?project=D%3A%2FProjects%2Fexample' }, res);
  assert.equal(res.status, 401);
});

test('状态路由以公开 sessions.get 会话 cwd 为权威，不接受工作区错配', async () => {
  const f = fixture();
  const response = () => ({ status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } });
  let res = response();
  await f.routes[0].handler({ method: 'GET', url: `/plugins/ai-loop-engineering/state?session=session-1` }, res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).project_root, f.project);
  res = response();
  await f.routes[0].handler({ method: 'GET', url: `/plugins/ai-loop-engineering/state?session=session-1&project=${encodeURIComponent(root)}` }, res);
  assert.equal(res.status, 403);
  res = response();
  await f.routes[0].handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?session=unknown' }, res);
  assert.equal(res.status, 400);
  await f.routes[0].handler({ method: 'GET', url: `/plugins/ai-loop-engineering/state?session=unknown&project=${encodeURIComponent(f.project)}` }, res);
  assert.equal(res.status, 400);
});

test('ai_loop_plan 在没有正式运行时启动原生 planner，并只授权写入独立计划目录', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-dsh-plan-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'packages/ledger'), { recursive: true });
  const f = fixture(config({ roles: { planner: { provider: 'planner-provider', model: 'planner-model' }, reviewer: { provider: 'parent-provider', model: 'parent-model' } }, projects: [{ path: project, enabled: true }] }));
  const plan = f.tools.find(tool => tool.name === 'ai_loop_plan');
  assert.ok(plan);
  const observation = JSON.parse(await plan.execute({ description: '重构账本', request: '分析目标、拆分互斥任务并给出验收。', project_path: 'packages/ledger' }, { agent: f.parent, signal: signal() }));
  assert.match(observation.plan_id, /^plan-/);
  assert.equal(observation.run_id, undefined);
  assert.equal(observation.native_id, 'child-1');
  assert.equal(observation.project_path, 'packages/ledger');
  assert.equal(observation.plan_file, `.ai-loop/plans/${observation.plan_id}/plan.json`);
  assert.equal(f.calls[0].request.cwd, path.join(project, 'packages/ledger'));
  assert.match(f.calls[0].request.prompt[0].text, /禁止创建正式 run\/task，禁止执行检查、命令或源码修改/);
  assert.deepEqual(f.preflights.at(-1), { provider: 'planner-provider', model: 'planner-model' });
  f.pending[0].resolve({ stopReason: 'completed', response: { text: '计划已写入 plan.json' } });
  await new Promise(resolve => setImmediate(resolve));
  const observe = f.tools.find(tool => tool.name === 'ai_loop_observe');
  const completed = JSON.parse(await observe.execute({ plan_id: observation.plan_id, project_path: 'packages/ledger' }, { agent: f.parent }));
  assert.equal(completed.state, 'completed');
  assert.equal(completed.evidence.native_id, 'child-1');
  assert.equal(completed.evidence.native_result.response.text, '计划已写入 plan.json');
  const failedStart = JSON.parse(await plan.execute({ description: '另一份计划', request: '梳理目标。', project_path: 'packages/ledger' }, { agent: f.parent, signal: signal() }));
  f.pending[1].reject(new Error('planner 原生调用失败'));
  await new Promise(resolve => setImmediate(resolve));
  const failed = JSON.parse(await observe.execute({ plan_id: failedStart.plan_id, project_path: 'packages/ledger' }, { agent: f.parent }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.evidence.native_result.message, 'planner 原生调用失败');
  const stoppedStart = JSON.parse(await plan.execute({ description: '取消的计划', request: '准备后取消。', project_path: 'packages/ledger' }, { agent: f.parent, signal: signal() }));
  f.pending[2].resolve({ stopReason: 'cancelled', response: { text: 'planner 已取消' } });
  await new Promise(resolve => setImmediate(resolve));
  const stopped = JSON.parse(await observe.execute({ plan_id: stoppedStart.plan_id, project_path: 'packages/ledger' }, { agent: f.parent }));
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.evidence.native_result.response.text, 'planner 已取消');
  assert.deepEqual(loop.listRuns(project), []);
  assert.equal(fs.existsSync(path.join(project, '.ai-loop')), false);
});

test('同名子项目运行使用独立幂等身份、启动锁与观察边界', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-dsh-project-boundary-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const scope of ['apps/one', 'apps/two']) {
    fs.mkdirSync(path.join(project, scope), { recursive: true });
    loop.create(project, { project_path: scope, goal: '项目隔离', tasks: [{ id: 'task1', title: '实现', acceptance: ['完成'], review: 'none', checks: [{ id: 'c', command: 'node --version' }] }] }, 'dispatch-run');
    const stateFile = path.join(project, scope, '.ai-loop', 'runs', 'dispatch-run', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.tasks[0].phase = 'reviewing';
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  const f = fixture(config({ projects: [{ path: project, enabled: true }] }));
  const prepare = f.tools.find(tool => tool.name === 'ai_loop_prepare');
  const delegate = f.tools.find(tool => tool.name === 'ai_loop_delegate');
  for (const scope of ['apps/one', 'apps/two']) {
    const ticket = JSON.parse(await prepare.execute({ run: 'dispatch-run', task: 'task1', role: 'reviewer', attempt: 0, project_path: scope }, { agent: f.parent }));
    recordActivity(project, 'dispatch-run', ticket, { project_path: scope });
    await delegate.execute({ role: 'reviewer', run: 'dispatch-run', task: 'task1', attempt: 0, project_path: scope, execution: ticket.id, description: '审查', prompt: '检查隔离。' }, { agent: f.parent, signal: signal() });
  }
  assert.equal(f.calls.length, 2);
  const observe = f.tools.find(tool => tool.name === 'ai_loop_observe');
  const first = JSON.parse(await observe.execute({ run: 'dispatch-run', project_path: 'apps/one', native_id: 'child-1' }, { agent: f.parent }));
  const second = JSON.parse(await observe.execute({ run: 'dispatch-run', project_path: 'apps/two', native_id: 'child-2' }, { agent: f.parent }));
  assert.equal(first.project_path, 'apps/one');
  assert.equal(second.project_path, 'apps/two');
  await assert.rejects(observe.execute({ run: 'dispatch-run', project_path: 'apps/two', native_id: 'child-1' }, { agent: f.parent }), /没有此会话和项目边界/);
  f.pending.forEach(item => item.resolve({ stopReason: 'completed' }));
});

test('ai_loop_status 与 Web 状态路由按 project_path 筛选并拒绝越界路径', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-dsh-status-scope-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const scope of ['packages/a', 'packages/b']) {
    fs.mkdirSync(path.join(project, scope), { recursive: true });
    loop.create(project, { project_path: scope, goal: scope, tasks: [{ id: 'task1', title: '任务', acceptance: ['完成'], review: 'none', checks: [{ id: 'c', command: 'node --version' }] }] }, 'same-run');
  }
  const f = fixture(config({ projects: [{ path: project, enabled: true }] }));
  const status = f.tools.find(tool => tool.name === 'ai_loop_status');
  const scoped = JSON.parse(await status.execute({ project_path: 'packages/a' }, { agent: f.parent, signal: signal() }));
  assert.equal(scoped.project_path, 'packages/a');
  assert.equal(scoped.goal, 'packages/a');
  const invalid = JSON.parse(await status.execute({ project_path: '../outside' }, { agent: f.parent, signal: signal() }));
  assert.match(invalid.error, /不能越出工作区/);
  const response = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
  await f.routes[0].handler({ method: 'GET', url: `/plugins/ai-loop-engineering/state?project=${encodeURIComponent(project)}&project_path=packages%2Fa` }, response);
  assert.equal(response.status, 200);
  const web = JSON.parse(response.body);
  assert.equal(web.project_path, 'packages/a');
  assert.deepEqual(web.runs.map(run => run.project_path), ['packages/a']);
});

test('同一父聊天的同名项目运行在实时与完成状态中保持隔离', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-dsh-live-scope-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const scope of ['one', 'two']) {
    fs.mkdirSync(path.join(project, scope), { recursive: true });
    loop.create(project, { project_path: scope, goal: `目标 ${scope}`, tasks: [{ id: 'task1', title: '检查', acceptance: ['完成'], review: 'none', checks: [{ id: 'c', command: 'fixture' }] }] }, 'same-run');
    loop.begin(project, 'same-run', 'task1', 'development', { project_path: scope });
  }
  const f = fixture(config({ maxConcurrent: 2, roles: { dev: { provider: 'provider', model: 'model' } }, projects: [{ path: project, enabled: true }] }));
  f.parent.id = 'session-1';
  f.ctx.sessions.get = id => ['session-1', 'session-2'].includes(id) ? { header: { cwd: project } } : undefined;
  const prepare = f.tools.find(tool => tool.name === 'ai_loop_prepare');
  const delegate = f.tools.find(tool => tool.name === 'ai_loop_delegate');
  for (const [index, scope] of ['one', 'two'].entries()) {
    const ticket = JSON.parse(await prepare.execute({ run: 'same-run', task: 'task1', role: 'dev', attempt: 0, project_path: scope }, { agent: f.parent }));
    const requested = { ...ticket, ...(scope === 'one' ? { context: { mode: 'independent', id: `pending-${scope}`, parent_id: 'session-1' } } : {}), summary: '原生派发前登记' };
    recordActivity(project, 'same-run', requested, { project_path: scope });
    await delegate.execute({ role: 'dev', run: 'same-run', task: 'task1', attempt: 0, project_path: scope, execution: ticket.id, description: '隔离测试', prompt: '完成指定项目检查。' }, { agent: f.parent, signal: signal() });
    assert.equal(f.pending[index] !== undefined, true);
  }
  const call = async query => {
    const res = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
    await f.routes[0].handler({ method: 'GET', url: `/plugins/ai-loop-engineering/state?session=session-1${query}` }, res);
    return res;
  };
  let res = await call('');
  assert.equal(res.status, 200);
  let byScope = new Map(res.body.chat_history.rounds.map(round => [round.run.project_path, round.activity.agents.filter(agent => agent.native_id).map(agent => agent.native_id)]));
  assert.deepEqual(byScope.get('one'), ['child-1']);
  assert.deepEqual(byScope.get('two'), ['child-2']);
  res = await call('&project_path=one');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.chat_history.rounds.map(round => round.run.project_path), ['one']);
  f.pending.forEach(item => item.resolve({ stopReason: 'completed', output: '检查完成' }));
  await new Promise(resolve => setImmediate(resolve));
  res = await call('');
  byScope = new Map(res.body.chat_history.rounds.map(round => [round.run.project_path, round.activity.agents.filter(agent => agent.native_id).map(agent => ({ id: agent.native_id, state: agent.state }))]));
  assert.deepEqual(byScope.get('one'), [{ id: 'child-1', state: 'completed' }]);
  assert.deepEqual(byScope.get('two'), [{ id: 'child-2', state: 'completed' }]);
  res = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
  await f.routes[0].handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?session=session-2' }, res);
  assert.deepEqual(res.body.runs, []);
});

test('唯一同聊天候选按自身 project_path 读取同名运行，缺轮补读也使用观察项目范围', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-dsh-unique-scope-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const scope of ['one', 'two']) {
    fs.mkdirSync(path.join(project, scope), { recursive: true });
    loop.create(project, { project_path: scope, goal: `目标 ${scope}`, tasks: [{ id: 'task1', title: '检查', acceptance: ['完成'], review: 'none', checks: [{ id: 'c', command: 'fixture' }] }] }, 'same-run');
    loop.begin(project, 'same-run', 'task1', 'development', { project_path: scope });
  }
  const f = fixture(config({ roles: { dev: { provider: 'provider', model: 'model' } }, projects: [{ path: project, enabled: true }] }));
  f.ctx.sessions.get = id => ['session-one', 'session-two'].includes(id) ? { header: { cwd: project } } : undefined;
  for (const [scope, parentId] of [['one', 'session-one'], ['two', 'session-two']]) {
    const context = { mode: 'independent', id: `child-${scope}`, parent_id: parentId };
    recordActivity(project, 'same-run', { id: `agent-${scope}`, project_path: scope, task: 'task1', role: 'dev', attempt: 0, harness: 'dsh', state: 'requested', summary: '登记', context }, { project_path: scope });
    recordActivity(project, 'same-run', { id: `agent-${scope}`, project_path: scope, state: 'running', native_id: `child-${scope}`, summary: '运行中' }, { project_path: scope });
  }
  const response = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
  await f.routes[0].handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?session=session-one' }, response);
  assert.equal(response.status, 200);
  assert.equal(response.body.run_id, 'same-run', JSON.stringify(response.body));
  assert.equal(response.body.project_path, 'one');
  assert.deepEqual(response.body.activity.agents.map(agent => agent.native_id), ['child-one']);
  const scoped = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
  await f.routes[0].handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?session=session-two&project_path=two' }, scoped);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.run_id, 'same-run');
  assert.equal(scoped.body.project_path, 'two');
  assert.deepEqual(scoped.body.activity.agents.map(agent => agent.native_id), ['child-two']);
});

test('共享聊天历史按父会话服务端隔离，旧未绑定观察仅计数且游标分页稳定', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-chat-history-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const spec = { goal: 'chat history', project_path: '.', tasks: [{ id: 'task1', title: 'task', acceptance: ['done'], review: 'none', checks: [{ id: 'c', command: 'node --version' }] }] };
  const makeRun = (id, created, agents) => {
    loop.create(project, spec, id);
    const directory = path.join(project, '.ai-loop', 'runs', id);
    const stateFile = path.join(directory, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.created_at = created;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(path.join(directory, 'activity.json'), JSON.stringify({ schema_version: 2, agents }));
  };
  const agent = (id, harness, context, extra = {}) => ({ id, run_id: 'ignored', task: 'task1', role: 'dev', attempt: 0, harness, state: 'running', native_id: `native-${id}`, context, started_at: '2026-10-01T00:00:00.000Z', ...extra });
  makeRun('chat-old', '2026-10-01T00:00:00.000Z', [
    agent('old-chat', 'dsh', { mode: 'independent', id: 'child-1', parent_id: 'session-1' }),
    agent('other-chat', 'dsh', { mode: 'independent', id: 'child-2', parent_id: 'session-2' }),
    agent('legacy', 'dsh', undefined),
    agent('other-harness', 'codex', { mode: 'independent', id: 'child-3', parent_id: 'session-1' }),
  ]);
  makeRun('chat-new', '2026-10-02T00:00:00.000Z', [agent('new-chat', 'dsh', { mode: 'independent', id: 'child-4', parent_id: 'session-1' })]);
  const first = chatHistory(project, { session_id: 'session-1', harness: 'dsh', limit: 1 });
  assert.deepEqual(first.rounds.map(round => round.run.run_id), ['chat-new']);
  assert.deepEqual(first.rounds[0].run.tasks.map(task => task.id), ['task1']);
  assert.equal(first.rounds[0].activity.agents[0].native_id, 'native-new-chat');
  assert.equal(first.unbound_count, 1);
  assert.ok(first.next_after);
  const next = chatHistory(project, { session_id: 'session-1', harness: 'dsh', limit: 1, after: first.next_after });
  assert.deepEqual(next.rounds.map(round => round.run.run_id), ['chat-old']);
  assert.deepEqual(next.rounds[0].activity.agents.map(item => item.id), ['old-chat']);
  assert.equal(next.next_after, null);
  assert.throws(() => chatHistory(project, { session_id: 'session-1', harness: 'dsh', limit: 1, after: 'invalid' }), /游标/);
});

test('共享聊天历史对同时间戳的混合 run ID 使用一致排序与游标分页', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-chat-history-order-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const spec = { goal: 'history order', project_path: '.', tasks: [{ id: 'task1', title: 'task', acceptance: ['done'], review: 'none', checks: [{ id: 'c', command: 'node --version' }] }] };
  const ids = ['A.run', 'a-run', 'a.runs', 'a_run'];
  for (const id of ids) {
    loop.create(project, spec, id);
    const directory = path.join(project, '.ai-loop', 'runs', id);
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')), created_at: '2026-10-03T00:00:00.000Z' }));
    fs.writeFileSync(path.join(directory, 'activity.json'), JSON.stringify({ schema_version: 2, agents: [{ id: `agent-${id}`, task: 'task1', role: 'dev', harness: 'dsh', context: { id: `child-${id}`, parent_id: 'session-1' }, state: 'running' }] }));
  }
  const seen = [];
  let after;
  do {
    const page = chatHistory(project, { session_id: 'session-1', harness: 'dsh', limit: 1, after });
    seen.push(...page.rounds.map(round => round.run.run_id));
    after = page.next_after;
  } while (after);
  assert.deepEqual(seen, ['a_run', 'a.runs', 'a-run', 'A.run']);
});

test('状态路由返回活动与历史运行供前端切换，工作区路径须精确启用', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-status-'));
  try {
    const loop = await import(new URL('../core/scripts/loop.mjs', import.meta.url));
    const spec = { goal: 'route test', tasks: [{ id: 'task1', title: '验证状态路由', acceptance: ['返回状态'], review: 'none', checks: [{ id: 'check1', command: 'node --version' }] }] };
    loop.create(project, spec, 'active-run');
    loop.create(project, spec, 'history-run');
    const historyState = path.join(project, '.ai-loop', 'runs', 'history-run', 'state.json');
    const state = JSON.parse(fs.readFileSync(historyState, 'utf8'));
    state.status = 'done';
    fs.writeFileSync(historyState, JSON.stringify(state));
    const f = fixture(config({ projects: [{ path: project, enabled: true }] }));
    const res = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
    await f.routes[0].handler({ method: 'GET', url: `/plugins/ai-loop-engineering/state?project=${encodeURIComponent(project)}` }, res);
    assert.equal(res.status, 200);
    const result = JSON.parse(res.body);
    assert.equal(result.run_id, 'active-run');
    assert.deepEqual(result.runs.map(row => row.run_id).sort(), ['active-run', 'history-run']);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('DSH 状态路由只返回当前会话已绑定的运行和代理活动', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-session-route-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const spec = { goal: 'session route', tasks: [{ id: 'task1', title: 'task', acceptance: ['done'], review: 'none', checks: [{ id: 'c', command: 'node --version' }] }] };
  for (const id of ['session-run', 'private-run']) loop.create(project, spec, id);
  const writeAgents = (run, agents) => fs.writeFileSync(path.join(project, '.ai-loop', 'runs', run, 'activity.json'), JSON.stringify({ schema_version: 2, agents }));
  const makeAgent = (id, parent_id) => ({ id, task: 'task1', role: 'dev', attempt: 0, harness: 'dsh', state: 'running', native_id: `native-${id}`, context: { mode: 'independent', id: `child-${id}`, parent_id }, started_at: '2026-10-01T00:00:00.000Z' });
  writeAgents('session-run', [makeAgent('bound', 'session-1'), makeAgent('hidden', 'session-2')]);
  writeAgents('private-run', [makeAgent('private', 'session-2')]);
  const f = fixture(config({ projects: [{ path: project, enabled: true }] }));
  f.ctx.sessions.get = id => id === 'session-1' ? { header: { cwd: project } } : undefined;
  const res = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
  await f.routes[0].handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?session=session-1' }, res);
  assert.equal(res.status, 200);
  const result = JSON.parse(res.body);
  assert.deepEqual(result.runs.map(run => run.run_id), ['session-run']);
  assert.deepEqual(result.chat_history.rounds[0].activity.agents.map(item => item.id), ['bound']);
  await f.routes[0].handler({ method: 'GET', url: '/plugins/ai-loop-engineering/state?session=session-1&run=private-run' }, res);
  assert.match(JSON.parse(res.body).message, /没有关联此运行/);
});

test('DSH 独立评审使用原生 spawn、准确模型预检和原生生命周期', async () => {
  const f = fixture(config({ roles: { reviewer: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } } }));
  assert.match(await f.run(), /独立上下文/);
  assert.deepEqual(f.preflights, [{ provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }]);
  const spec = f.calls[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'parent');
  assert.equal(spec.request.parent, f.parent);
  assert.equal(spec.request.maxDepth, 1);
  assert.equal(spec.request.cwd, `${f.project}\\src`);
  assert.match(spec.request.prompt[0].text, /这是叶角色任务/);
  assert.match(spec.request.prompt[0].text, /审批策略为 never/);
  assert.deepEqual(spec.request.agentOptions, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' });
  await assert.rejects(f.run('reviewer', {}, 1), /更换 direction 或 attempt/);
  f.pending[0].resolve({ stopReason: 'completed' });
});

test('DSH 阶段或批次不匹配时在 spawn 前阻止派发', async () => {
  const f = fixture(config({ roles: { tester: { provider: 'test-provider', model: 'test-model' } } }));
  await assert.rejects(f.run('tester'), /不能在任务阶段 reviewing 派发/);
  assert.equal(f.calls.length, 0);
});

test('模型预检后重验运行和 attempt，期间停止或批次变化不会启动子代理', async () => {
  const stopped = fixture(config({ roles: { reviewer: { provider: 'p', model: 'm' } } }));
  stopped.ctx.llm.resolveCallConfig = async () => {
    const file = path.join(stopped.project, '.ai-loop', 'runs', 'dispatch-run', 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.status = 'stopped';
    fs.writeFileSync(file, JSON.stringify(state));
  };
  await assert.rejects(stopped.run(), /运行已关闭或停止/);
  assert.equal(stopped.calls.length, 0);

  const staleAttempt = fixture(config({ roles: { reviewer: { provider: 'p', model: 'm' } } }), { managedExecution: true });
  const file = path.join(staleAttempt.project, '.ai-loop', 'runs', 'dispatch-run', 'state.json');
  staleAttempt.ctx.llm.resolveCallConfig = async () => {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    current.tasks[0].attempts.reviewer = 1;
    fs.writeFileSync(file, JSON.stringify(current));
  };
  await assert.rejects(staleAttempt.run(), /attempt 缺失或已过期/);
  assert.equal(staleAttempt.calls.length, 0);

  const duplicated = fixture(config({ roles: { reviewer: { provider: 'p', model: 'm' } } }));
  duplicated.ctx.llm.resolveCallConfig = async () => recordActivity(duplicated.project, 'dispatch-run', {
    id: 'preflight-child', task: 'task1', role: 'reviewer', attempt: 0, harness: 'DSH', state: 'requested', summary: '预检期间出现的持久执行者'
  });
  await assert.rejects(duplicated.run(), /预检期间核心代理台账出现非终态/);
  assert.equal(duplicated.calls.length, 0);
});

test('DSH 插件重载后仍以核心非终态代理观察阻止重复派发', async () => {
  const f = fixture();
  recordActivity(f.project, 'dispatch-run', { id: 'old-agent', task: 'task1', role: 'reviewer', attempt: 0, harness: 'DSH', state: 'requested', summary: '等待核对' });
  const activityFile = path.join(f.project, '.ai-loop', 'runs', 'dispatch-run', 'activity.json');
  const data = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
  data.agents[0].updated_at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(activityFile, JSON.stringify(data));
  await assert.rejects(f.run('reviewer', {}, 1), /核心代理台账中仍为非终态/);
  assert.equal(f.calls.length, 0);
});

test('DSH 方向标签不能拆分 task 或绕过同一正式任务的执行锁', async () => {
  const f = fixture();
  await f.run();
  const execute = (task, direction) => f.tools.find(tool => tool.name === 'ai_loop_delegate').execute({ role: 'reviewer', run: 'dispatch-run', task, direction, attempt: 0, description: '第二个方向', prompt: '检查方向' }, { agent: f.parent, signal: signal() });
  await assert.rejects(execute('task1', 'backend'), /更换 direction 或 attempt/);
  await assert.rejects(execute('task1#backend', undefined), /正式 task id/);
  await assert.rejects(execute('task2', 'x'.repeat(65)), /最多 64 字符/);
  assert.equal(f.calls.length, 1);
  f.pending[0].resolve({ stopReason: 'completed' });
});

test('状态路由用同 native_id 的 live 状态覆盖旧观察，终态保留磁盘观察且不再显示待停止', async () => {
  const settings = config();
  const f = fixture(settings);
  await f.run();
  recordActivity(f.project, 'dispatch-run', { id: 'child-1', native_id: 'child-1', task: 'task1', role: 'reviewer', attempt: 0, harness: 'DSH', state: 'requested', summary: '原生派发记录' });
  recordActivity(f.project, 'dispatch-run', { id: 'child-1', native_id: 'child-1', state: 'running', summary: '子代理运行中' });
  const respond = async () => {
    const res = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
    await f.routes[0].handler({ method: 'GET', url: `/plugins/ai-loop-engineering/state?project=${encodeURIComponent(f.project)}&run=dispatch-run` }, res);
    return JSON.parse(res.body).activity.agents;
  };
  let agents = await respond();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].native_id, 'child-1');
  assert.equal(agents[0].state, 'running');
  settings.roles.reviewer = { enabled: false, provider: 'parent-provider', model: 'parent-model' };
  f.pending[0].resolve({ stopReason: 'completed' });
  await Promise.resolve(); await Promise.resolve();
  agents = await respond();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].state, 'completed');
  assert.equal(agents[0].live, false);
  assert.equal(agents[0].observation.state, 'running');
  assert.notEqual(agents[0].state, 'waiting_to_stop');
});

test('DSH 并发覆盖启动中及运行中的activation，失败和取消后释放', async () => {
  const f = fixture(config({ maxConcurrent: 1 }));
  await f.run();
  await assert.rejects(f.run('reviewer', {}, 1, 'task2'), /并发上限/);
  f.pending[0].reject(new Error('child failed'));
  await Promise.resolve();
  await f.run('reviewer', {}, 1);
  f.pending[1].resolve({ stopReason: 'completed' });
  await Promise.resolve();
  f.ctx.subagents.startActivation = async () => { throw new Error('startup failed'); };
  await assert.rejects(f.run(), /startup failed/);
  await assert.rejects(f.run(), /startup failed/);
});

test('DSH 未启用、嵌套、无独立后端、未知模型、取消均不创建子代理', async () => {
  const disabled = fixture(config({ enabled: false }));
  await assert.rejects(disabled.run(), /未启用/);
  const nested = fixture(); nested.parent.depth = 1;
  await assert.rejects(nested.run(), /不得继续派发/);
  const forked = fixture(); forked.ctx.subagents.getProvider = () => ({ inheritsParentContext: true });
  await assert.rejects(forked.run(), /spawn 后端/);
  const bad = fixture(config({ roles: { reviewer: { provider: 'bad', model: 'unknown' } } }));
  bad.ctx.llm.resolveCallConfig = async () => { throw new Error('unknown model'); };
  await assert.rejects(bad.run(), /unknown model/);
  const cancelled = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.run('reviewer', { signal: controller.signal }), /abort/i);
  for (const f of [disabled, nested, forked, bad, cancelled]) assert.equal(f.calls.length, 0);
});

test('DSH 路由改变不误继承父模型强度，后端预检竞态明确失败', async () => {
  const f = fixture(config({ roles: { reviewer: { provider: 'child', model: 'child-model' } } }));
  await f.run();
  assert.deepEqual(f.preflights, [{ provider: 'child', model: 'child-model' }]);
  f.pending[0].resolve({ stopReason: 'completed' });
  const changed = fixture(config({ roles: { reviewer: { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high' } } }));
  changed.ctx.llm.resolveCallConfig = async () => { changed.ctx.subagents.getProvider = () => ({}); };
  await assert.rejects(changed.run(), /后端.*发生变化/);
  assert.equal(changed.calls.length, 0);
});

test('DSH 项目并发包括尚未发布的子代理启动操作', async () => {
  const f = fixture(config({ maxConcurrent: 1 }));
  let start;
  f.ctx.subagents.startActivation = async () => new Promise(resolve => { start = resolve; });
  const first = f.run();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.run('reviewer', {}, 1, 'task2'), /并发上限/);
  start({ childId: 'starting-child', result: Promise.resolve({ stopReason: 'completed' }) });
  assert.match(await first, /starting-child/);
});

test('DSH 新运行启动前须持久登记；原生观察可通过获准工具同步完整评审证据', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-dsh-evidence-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  loop.create(project, { goal: '真实调用记录契约', tasks: [{ id: 'task1', title: '任务', managed_execution: true, acceptance: ['证据完整'], review: 'independent', checks: [{ id: 'c', command: 'fixture' }] }] }, 'dispatch-run');
  const reports = path.join(project, '.ai-loop/runs/dispatch-run/reports');
  fs.writeFileSync(path.join(reports, 'test.log'), 'fixture');
  loop.begin(project, 'dispatch-run', 'task1', 'development'); loop.begin(project, 'dispatch-run', 'task1', 'verification');
  loop.record(project, 'dispatch-run', { role: 'tester', task_id: 'task1', status: 'PASS', execution: 'self', attempt: 1, revision: loop.snapshot(project), checks: [{ id: 'c', command: 'fixture', exit_code: 0, environment: 'fixture', log: 'reports/test.log' }], issues: [] });
  loop.begin(project, 'dispatch-run', 'task1', 'review');
  const f = fixture(config({ projects: [{ path: project, enabled: true }] }));
  const args = { role: 'reviewer', run: 'dispatch-run', task: 'task1', attempt: 1, execution: 'exec1', description: '审查', prompt: '独立审查' };
  const exec = { agent: f.parent, signal: signal() };
  const delegate = f.tools.find(tool => tool.name === 'ai_loop_delegate');
  await assert.rejects(delegate.execute(args, exec), /先通过原生工具登记/); assert.equal(f.calls.length, 0);
  const prepare = f.tools.find(tool => tool.name === 'ai_loop_prepare');
  const ticket = JSON.parse(await prepare.execute({ run: 'dispatch-run', task: 'task1', role: 'reviewer', attempt: 1 }, exec));
  args.execution = ticket.id;
  recordActivity(project, 'dispatch-run', { ...ticket, revision: loop.snapshot(project) });
  await delegate.execute(args, exec);
  const reloaded = fixture(config({ projects: [{ path: project, enabled: true }] }));
  await assert.rejects(reloaded.tools.find(tool => tool.name === 'ai_loop_delegate').execute(args, { agent: reloaded.parent, signal: signal() }), /凭据缺失、过期/);
  assert.equal(reloaded.calls.length, 0);
  const observe = f.tools.find(tool => tool.name === 'ai_loop_observe');
  let observation = JSON.parse(await observe.execute({ run: 'dispatch-run', native_id: 'child-1' }, exec));
  assert.equal(observation.state, 'running'); assert.equal(observation.context.parent_id, 'parent');
  recordActivity(project, 'dispatch-run', { id: ticket.id, native_id: observation.native_id, context: observation.context, state: 'running', summary: '原生运行观察' });
  f.pending[0].resolve({ stopReason: 'completed' }); await new Promise(resolve => setImmediate(resolve));
  observation = JSON.parse(await observe.execute({ run: 'dispatch-run', native_id: 'child-1' }, exec));
  fs.writeFileSync(path.join(reports, 'native.json'), JSON.stringify(observation));
  recordActivity(project, 'dispatch-run', { id: ticket.id, state: 'completed', evidence: { source: 'native-runtime', path: 'reports/native.json' }, summary: '原生终态持久化' });
  loop.record(project, 'dispatch-run', { role: 'reviewer', task_id: 'task1', attempt: 1, status: 'APPROVED', execution: 'independent', execution_id: ticket.id, revision: loop.snapshot(project), findings: [], issues: [] });
  assert.equal(loop.status(project, 'dispatch-run').tasks[0].phase, 'done');
  await assert.rejects(observe.execute({ run: 'dispatch-run', native_id: 'child-1' }, { ...exec, agent: { ...f.parent, id: 'other' } }), /没有此会话/);
});
