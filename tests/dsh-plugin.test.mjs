import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createConfig, projectKey, projectSettings, roleOptions, validateConfig, validateProjects, validateRoles } from '../dsh/config.mjs';

const root = 'D:\\Projects\\example';
const config = extra => ({ enabled: true, maxConcurrent: 2, roles: {}, projects: [{ path: root, enabled: true }], ...extra });
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
  assert.equal(restored.dict.roles.dict.reviewer.list.length, 2);
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

function fixture(settings = config()) {
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
    workingDirectory: { ensure: async () => `${root}\\src` },
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
  apply(ctx, settings);
  const parent = { id: 'parent', session: { header: { cwd: root } }, options: { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'low' } };
  return { ctx, skills, contexts, tools, calls, pending, preflights, routes, connection, parent, run: (role = 'reviewer', extra = {}) => tools[0].execute({ role, description: '审查改动', prompt: '审查 src/main.mjs 正确性。' }, { agent: parent, signal: signal(), ...extra }) };
}

test('DSH 技能与动态上下文仅提供必要恢复入口，不写入项目', () => {
  const f = fixture();
  assert.deepEqual(f.skills.map(s => s.name), ['ai-loop', 'ai-loop-models']);
  assert.ok(f.skills.every(s => !s.content.includes('{{CORE}}')));
  assert.match(f.contexts[0].text({ agent: f.parent }), /此项目已启用/);
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

test('DSH 独立评审使用原生 spawn、准确模型预检和原生生命周期', async () => {
  const f = fixture(config({ roles: { reviewer: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } } }));
  assert.match(await f.run(), /独立上下文/);
  assert.deepEqual(f.preflights, [{ provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }]);
  const spec = f.calls[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'parent');
  assert.equal(spec.request.parent, f.parent);
  assert.equal(spec.request.maxDepth, 1);
  assert.equal(spec.request.cwd, `${root}\\src`);
  assert.match(spec.request.prompt[0].text, /这是叶角色任务/);
  assert.match(spec.request.prompt[0].text, /审批策略为 never/);
  assert.deepEqual(spec.request.agentOptions, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' });
  f.pending[0].resolve({ stopReason: 'completed' });
});

test('DSH 并发覆盖启动中及运行中的activation，失败和取消后释放', async () => {
  const f = fixture(config({ maxConcurrent: 1 }));
  await f.run();
  await assert.rejects(f.run(), /并发上限/);
  f.pending[0].reject(new Error('child failed'));
  await Promise.resolve();
  await f.run();
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
  const changed = fixture(config({ roles: { reviewer: { reasoningEffort: 'high' } } }));
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
  await assert.rejects(f.run(), /并发上限/);
  start({ childId: 'starting-child', result: Promise.resolve({ stopReason: 'completed' }) });
  assert.match(await first, /starting-child/);
});
