import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildDshClient } from '../scripts/build-dsh-client.mjs';
import { createPlugin } from '../dsh/client/index.mjs';

// Minimal native-form bridge: field serialization and persistence belong to the
// host. Capture the bridge boundary so tests assert our writes, not host internals.
class FormBridge {
  constructor(scope, specs) { this.scope = scope; this.specs = specs; this.drafts = new Map(); }
  field(name) {
    const spec = this.specs.find(field => field.field === name);
    return { text: this.drafts.get(name) ?? spec.format(this.scope.value[name]) };
  }
  shell() { return { available: true, writable: true, dirty: this.drafts.size > 0, invalid: false, saving: false, failed: false }; }
  bind(project) { return { getSnapshot: project, subscribe: () => () => {} }; }
  actions() {
    return {
      edit: (field, text) => this.drafts.set(field, text),
      discard: () => this.drafts.clear(),
      save: () => {
        const changes = [...this.drafts].map(([field, text]) => {
          const parsed = this.specs.find(spec => spec.field === field).parse(text);
          assert.equal(parsed?.kind, 'set');
          return { op: 'set', path: [field], value: parsed.value };
        });
        return this.scope.mutate(changes);
      },
    };
  }
  dispose() { this.scope.disposed = true; }
}

const runtime = name => {
  if (name === 'react') return { Component: class {}, createElement: (type, props) => ({ type, props }) };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { SettingsFormModel: FormBridge };
  throw new Error(`Unexpected host dependency: ${name}`);
};
const plugin = createPlugin(runtime);
function settingsView(initial) {
  const slots = []; let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useMemo: fn => fn(), useRef: value => ({ current: value }), useEffect: () => {},
    useSyncExternalStore: (_subscribe, read) => read(),
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
  };
  const view = createPlugin(name => name === 'react' ? React : { SettingsForm: 'form' });
  const state = { writable: true, saving: false, enabled: true, roles: {}, projects: [], maxConcurrent: 3, ...initial };
  const edits = [];
  const controller = { store: { subscribe: () => {}, getSnapshot: () => state }, actions: { save: () => {}, discard: () => {} }, edit: (...args) => edits.push(args) };
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children || [])] : [];
  return { state, edits, render(props) { cursor = 0; return flatten(view.Card({ ctx: {}, controller, ...props })); } };
}

test('工作区完整空列表不复活已删除项；加载中保存保留其他配置，成功快照才对账', () => {
  const f = settingsView({ projects: [{ path: '/gone', enabled: true }, { path: '/live', enabled: true }] });
  let tree = f.render({ useWorkspaces: () => ({ items: [{ path: '/live' }], phase: 'loading', state: 'loading' }) });
  tree.find(node => node.type === 'form').props.onSave(); assert.equal(f.edits.length, 0);
  tree = f.render({ useWorkspaces: () => ({ items: [], phase: 'ready', state: 'idle' }) });
  assert.ok(!tree.some(node => node.type === 'option' && node.props.value === '/gone'));
  tree.find(node => node.type === 'form').props.onSave(); assert.deepEqual(f.edits.at(-1), ['projects', []]);
});
test('总开关关闭时工作区红点；会话异步到达及未知新会话不能保留旧配置目标', () => {
  const f = settingsView({ enabled: false, projects: [{ path: '/one', enabled: true }] });
  let byId = {}; const ctx = { sessions: { list: { getSnapshot: () => ({ byId }) } } };
  const props = { ctx, sessionId: 's1', useWorkspaces: () => ({ items: [{ path: '/one' }], phase: 'ready', state: 'idle' }) };
  let tree = f.render(props); assert.equal(tree.find(node => node.type === 'select').props.value, '');
  byId = { s1: { cwd: '/one' } }; tree = f.render(props);
  assert.equal(tree.find(node => node.type === 'select').props.value, '/one');
  assert.match(tree.find(node => node.type === 'option' && node.props.value === '/one').props.children.join(''), /🔴/);
  tree = f.render({ ...props, sessionId: 'unknown', initialWorkspacePath: '/one' });
  assert.equal(tree.find(node => node.type === 'select').props.value, '');
});
function controller(value = {}) {
  const scope = { value: { enabled: false, maxConcurrent: 3, roles: {}, projects: [], ...value }, writes: [], mutate(changes) { this.writes.push(changes); return true; } };
  return { scope, card: new plugin.Controller(scope) };
}

test('DSH client release uses the real lazy factory contract without eager dependencies', () => {
  let loaded;
  vm.runInNewContext(buildDshClient(), { window: { __ModuleLoader__: { load: module => { loaded = module; } } } });
  assert.equal(loaded.id, 'dsh-plugin-ai-loop-engineering');
  const client = loaded.factory(runtime);
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(Array.from(client.inject), ['slots', 'configForms', 'remote', 'remote.session', 'workspaces', 'sessions']);
});

test('DSH native configuration attaches only to its own installed package page', () => {
  const { scope } = controller();
  const registrations = [];
  const cleanup = [];
  const injected = [];
  const ctx = {
    effect: setup => { const stop = setup(); if (typeof stop === 'function') cleanup.push(stop); },
    configForms: { get: id => { assert.equal(id, 'ai-loop-engineering'); return scope; }, whileServed: (ids, run) => { assert.deepEqual(ids, ['ai-loop-engineering']); return run(); } },
    slots: { inject: (slot, run) => { injected.push(slot); return run(); }, register: (options, render) => { registrations.push({ ...options, render }); return () => {}; } },
  };
  plugin.apply(ctx);
  assert.deepEqual(registrations.map(row => row.name), ['plugins.bundle.config', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.view']);
  assert.deepEqual(injected, ['plugins.bundle.config', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.view']);
  const panel = registrations[1].render({ sessionId: 'session-1', injectedValue: 'preserved' });
  assert.equal(panel.props.sessionId, 'session-1');
  assert.equal(panel.props.injectedValue, 'preserved');
  const title = registrations[2].render({ sessionId: 'session-1' });
  assert.equal(title.type.name, 'SidebarTitle');
  assert.equal(title.props.sessionId, 'session-1');
  const convView = registrations[3].render({ sessionId: 'session-1' });
  assert.equal(convView.type.name, 'ConversationDashboard');
  assert.equal(convView.props.sessionId, 'session-1');
  cleanup.forEach(stop => stop());
  assert.equal(scope.disposed, true);
});

test('DSH status bridge uses same-origin fetch, encodes paths, preserves errors and does not choose a run', async () => {
  let request;
  const result = await plugin.requestStatus(async (url, options) => {
    request = { url: new URL(url), options };
    return { ok: true, status: 200, json: async () => ({ runs: [{ run_id: 'r1' }, { run_id: 'r2' }] }) };
  }, 'D:\\Projects\\my app');
  assert.equal(request.url.searchParams.get('project'), 'D:\\Projects\\my app');
  assert.equal(request.url.searchParams.has('run'), false);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.url.pathname, '/plugins/ai-loop-engineering/state');
  assert.equal(result.runs.length, 2);
  await assert.rejects(plugin.requestStatus(async () => ({ ok: false, status: 403, json: async () => ({ error: '工作区未启用' }) }), 'D:\\Projects\\x'), error => error.message === '工作区未启用' && error.status === 403);
  await assert.rejects(plugin.requestStatus(async () => { throw new Error('network down'); }, 'D:\\Projects\\x'), /network down/);
});

test('两个看板订阅同一 session/project/run 时共享一次状态请求', async () => {
  const pending = [];
  const store = plugin.createStatusPollStore((url, options) => new Promise(resolve => pending.push({ url: new URL(url), options, resolve })), {});
  const params = { sessionId: 's1', path: '/project', run: 'r1' };
  const first = store.subscribe(params, () => {});
  const second = store.subscribe(params, () => {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url.searchParams.get('session'), 's1');
  assert.equal(pending[0].url.searchParams.get('project'), '/project');
  assert.equal(pending[0].url.searchParams.get('run'), 'r1');
  first();
  assert.equal(pending[0].options.signal.aborted, false);
  second();
  assert.equal(pending[0].options.signal.aborted, true);
});

test('聊天看板按 opaque 游标请求更早历史页并保留会话与工作区绑定', async () => {
  let requested;
  const store = plugin.createStatusPollStore(async url => {
    requested = new URL(url);
    return { ok: true, status: 200, json: async () => ({ chat_history: { rounds: [], next_after: null } }) };
  });
  const page = await store.loadHistory({ path: '/workspace', sessionId: 'session-1' }, 'opaque-cursor');
  assert.equal(requested.searchParams.get('project'), '/workspace');
  assert.equal(requested.searchParams.get('session'), 'session-1');
  assert.equal(requested.searchParams.get('after'), 'opaque-cursor');
  assert.equal(requested.searchParams.get('limit'), '20');
  assert.equal(page.chat_history.next_after, null);
});

test('共享状态轮询串行执行，页面隐藏时暂停并取消请求，恢复时立即刷新', async () => {
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const host = {
    document: {
      visibilityState: 'visible',
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name),
    },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const pending = [];
  const store = plugin.createStatusPollStore((url, options) => new Promise((resolve, reject) => {
    const request = { options, resolve, reject };
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    pending.push(request);
  }), host);
  const unsubscribe = store.subscribe({ path: '/p', run: 'r' }, () => {});
  assert.equal(pending.length, 1);
  assert.equal(timers.size, 0);
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ run_id: 'r', runs: [] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1);
  assert.equal(timers.size, 1);
  const tick = timers.values().next().value;
  timers.clear(); tick();
  assert.equal(pending.length, 2);
  host.document.visibilityState = 'hidden'; listeners.get('visibilitychange')();
  assert.equal(pending[1].options.signal.aborted, true);
  assert.equal(timers.size, 0);
  host.document.visibilityState = 'visible'; listeners.get('visibilitychange')();
  assert.equal(pending.length, 3);
  unsubscribe();
});

test('DSH模型目录仍从注入的remote.session读取', async () => {
  let current;
  const React = {
    useState: initial => [initial, value => { current = value; }],
    useEffect: fn => { fn(); },
  };
  const hooksPlugin = createPlugin(name => name === 'react' ? React : runtime(name));
  let calls = 0;
  const state = hooksPlugin.useCatalog({
    remote: {
      session: { modelCatalog: async () => { calls++; return { ok: true, value: { groups: [{ id: 'p', models: [] }], failures: [] } }; } },
      $on: () => () => {},
    },
    on: () => () => {},
  });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(current.status, 'ready');
  assert.equal(current.groups[0].id, 'p');
});

test('DSH project edits preserve unrelated projects and role settings', async () => {
  const { card, scope } = controller({ projects: [{ path: 'D:\\A', enabled: true, roles: { reviewer: { model: 'review', provider: 'p' } } }, { path: '/other', enabled: false }] });
  card.updateProject('d:/A/', row => ({ ...row, maxConcurrent: 4 }));
  card.setRole('dev', { provider: 'p', model: 'code', reasoningEffort: 'high' }, 'D:\\A');
  await card.actions.save();
  const projects = scope.writes.at(-1).find(change => change.path[0] === 'projects').value;
  assert.equal(projects.length, 2);
  assert.equal(projects[0].enabled, true);
  assert.equal(projects[0].roles.reviewer.model, 'review');
  assert.equal(projects[0].roles.dev.model, 'code');
  assert.equal(projects[0].maxConcurrent, 4);
  assert.deepEqual(projects[1], { path: '/other', enabled: false });
});

test('保存新配置时将总开关原子迁移到 schema v2 并把 legacy enabled 置 false', async () => {
  const { card, scope } = controller({ enabled: true });
  assert.equal(card.store.getSnapshot().enabled, true);
  card.edit('maxConcurrent', 4);
  await card.actions.save();
  const writes = scope.writes.at(-1);
  assert.deepEqual(writes.find(change => change.path[0] === 'schemaVersion'), { op: 'set', path: ['schemaVersion'], value: 2 });
  assert.deepEqual(writes.find(change => change.path[0] === 'enabled'), { op: 'set', path: ['enabled'], value: false });
  assert.deepEqual(writes.find(change => change.path[0] === 'workflowEnabled'), { op: 'set', path: ['workflowEnabled'], value: true });
});

test('DSH角色卡项目强度交互只写入用户覆盖，模型继承成对清除路由', async () => {
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...props, children });
      return { type, props: { ...props, children } };
    },
  };
  const componentPlugin = createPlugin(name => name === 'react' ? React : runtime(name));
  const { card, scope } = controller({
    roles: { dev: { provider: 'global-provider', model: 'global-model', reasoningEffort: 'low' } },
    projects: [{ path: '/a', enabled: true }],
  });
  const catalog = {
    status: 'ready',
    groups: [{ id: 'global-provider', models: [{ id: 'global-model', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } }] }],
  };
  const findControls = tree => {
    const nodes = [];
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      visit(node.props?.children);
    };
    visit(tree);
    return nodes.filter(node => node.type === 'select');
  };
  const render = () => componentPlugin.RoleCard({ role: 'dev', path: '/a', state: card.store.getSnapshot(), controller: card, catalog, disabled: false });

  let controls = findControls(render());
  assert.equal(controls.length, 3);
  controls[2].props.onChange({ target: { value: 'high' } });
  assert.deepEqual(card.store.getSnapshot().projects[0].roles.dev, { reasoningEffort: 'high' });
  await card.actions.save();
  assert.deepEqual(scope.writes.at(-1).find(change => change.path[0] === 'projects').value[0].roles.dev, { reasoningEffort: 'high' });

  controls = findControls(render());
  controls[1].props.onChange({ target: { value: '' } });
  assert.equal(Object.hasOwn(card.store.getSnapshot().projects[0], 'roles'), false);
  await card.actions.save();
  assert.equal(Object.hasOwn(scope.writes.at(-1).find(change => change.path[0] === 'projects').value[0], 'roles'), false);
});

test('项目角色选择关闭时优先保留显式关闭，选择空继承项则删除项目覆盖', () => {
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...props, children });
      return { type, props: { ...props, children } };
    },
  };
  const componentPlugin = createPlugin(name => name === 'react' ? React : runtime(name));
  const writes = [];
  const state = { roles: { dev: { provider: 'p', model: 'm' } }, projects: [{ path: '/a', enabled: true, roles: { dev: { provider: 'p', model: 'm' } } }] };
  const controller = {
    setRole: (...args) => writes.push(['set', ...args]),
    resetRole: (...args) => writes.push(['reset', ...args]),
  };
  const catalog = { status: 'ready', groups: [{ id: 'p', models: [{ id: 'm' }] }] };
  const tree = componentPlugin.RoleCard({ role: 'dev', path: '/a', state, controller, catalog, disabled: false });
  const selects = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'select') selects.push(node);
    visit(node.props?.children);
  };
  visit(tree);
  selects[1].props.onChange({ target: { value: '__off' } });
  assert.equal(writes[0][0], 'set');
  assert.equal(writes[0][2].enabled, false);
  assert.equal(writes[0][2].provider, '');
  selects[1].props.onChange({ target: { value: '' } });
  assert.deepEqual(writes[1], ['reset', 'dev', '/a']);
  selects[0].props.onChange({ target: { value: '' } });
  assert.deepEqual(writes[2], ['reset', 'dev', '/a']);
});

test('看板切换会话或工作区时清空运行选择并隔离旧响应', async () => {
  const pending = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url: new URL(url), options, resolve }));
  const slots = [];
  let cursor = 0;
  let effects = [];
  const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !same(previous.deps, deps)) effects.push(() => {
        previous?.cleanup?.();
        const cleanup = fn();
        slots[index] = { deps, cleanup };
      });
    },
  };
  const view = createPlugin(name => name === 'react' ? React : runtime(name));
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...(node.props?.children || []).flatMap(flatten)] : [node];
  const render = props => {
    cursor = 0; effects = [];
    const tree = view.RunDashboard({ ctx: {}, ...props });
    effects.forEach(effect => effect());
    return tree;
  };
  const props = { path: '/one', sessionId: 's1' };
  try {
    render(props);
    assert.equal(pending.length, 1);
    pending[0].resolve({ ok: true, status: 200, json: async () => ({ run_id: 'run-old', runs: [{ run_id: 'run-old', status: 'active' }] }) });
    await new Promise(resolve => setImmediate(resolve));
    let tree = render(props);
    const runSelect = flatten(tree).find(node => node?.type === 'select');
    assert.ok(runSelect);
    runSelect.props.onChange({ target: { value: 'run-old' } });
    render(props);
    assert.equal(pending.at(-1).url.searchParams.get('run'), 'run-old');

    tree = render({ path: '/two', sessionId: 's2' });
    assert.ok(!flatten(tree).includes('run-old'));
    assert.equal(pending.at(-1).url.searchParams.get('session'), 's2');
    assert.equal(pending.at(-1).url.searchParams.get('project'), '/two');
    assert.equal(pending.at(-1).url.searchParams.has('run'), false);
    pending[1].resolve({ ok: true, status: 200, json: async () => ({ run_id: 'run-old', runs: [{ run_id: 'run-old' }] }) });
    await new Promise(resolve => setImmediate(resolve));
    tree = render({ path: '/two', sessionId: 's2' });
    assert.ok(!flatten(tree).includes('run-old'));
  } finally {
    globalThis.fetch = originalFetch;
    for (const slot of slots) slot?.cleanup?.();
  }
});

test('当前聊天切换到无工作区会话时立即丢弃上一个 cwd', async t => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    requested.push(new URL(url));
    return { ok: true, status: 200, json: async () => ({ runs: [], message: 'no history' }) };
  };
  const slots = []; let cursor = 0; let effects = [];
  const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  const React = {
    Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useMemo: fn => fn(), useRef: value => ({ current: value }), useSyncExternalStore: (_sub, get) => get(),
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useEffect(fn, deps) {
      const index = cursor++; const old = slots[index];
      if (!old || !same(old.deps, deps)) effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; });
    },
  };
  const view = createPlugin(name => name === 'react' ? React : runtime(name));
  const { card } = controller();
  let byId = { one: { cwd: '/workspace-one' }, two: { cwd: '' } };
  const ctx = { get: key => key === 'sessions' ? { list: { getSnapshot: () => ({ byId }), subscribe: () => () => {} } } : undefined };
  const render = sessionId => {
    cursor = 0; effects = [];
    const outer = view.ConversationDashboard({ ctx, sessionId, controller: card });
    const child = outer.props.children[0];
    const tree = child.type(child.props);
    effects.forEach(effect => effect());
    return tree;
  };
  t.after(() => { globalThis.fetch = originalFetch; slots.forEach(slot => slot?.cleanup?.()); });
  try {
    render('one');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requested.at(-1).searchParams.get('project'), '/workspace-one');
    render('two');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requested.at(-1).searchParams.get('session'), 'two');
    assert.equal(requested.at(-1).searchParams.has('project'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('聊天树展开观察对象可读，并使用真实子代理 ID 导航', async t => {
  const observation = { state: 'failed', summary: '子代理调用失败', native_id: 'child-real' };
  const payload = {
    run_id: 'round-1', goal: '树形看板', status: 'active',
    runs: [{ run_id: 'round-1', project_path: '.', status: 'active' }],
    tasks: [{ id: 'task1', title: '实现', phase: 'developing', ready: true }],
    chat_history: { rounds: [{ run: { run_id: 'round-1' }, activity: { agents: [] } }], unbound_count: 0, next_after: 'cursor-1' },
    activity: { agents: [
      { id: 'execution-record', native_id: 'child-real', task: 'task1', role: 'dev', state: 'failed', live: false, context: { id: 'child-real', parent_id: 'parent-session' }, observation },
      { id: 'child-partial', native_id: 'child-partial', task: 'task1', role: 'tester', state: 'completed', live: false, context: { id: 'child-partial', parent_id: 'parent-session' }, usage: { input_tokens: 12 } },
    ] },
  };
  const originalFetch = globalThis.fetch;
  let requestedHistoryUrl;
  globalThis.fetch = async url => { requestedHistoryUrl = new URL(url); return { ok: true, status: 200, json: async () => payload }; };
  const slots = []; let cursor = 0; const effects = [];
  let expandedAgentId = 'child-real';
  const React = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useMemo: fn => fn(), useRef: value => ({ current: value }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      if (initial === null) slots[index] = expandedAgentId;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const old = slots[index];
      if (!old || !old.deps || old.deps.length !== deps?.length || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects.push(() => {
        old?.cleanup?.();
        slots[index] = { deps, cleanup: fn() };
      });
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const view = createPlugin(name => name === 'react' ? React : runtime(name));
  const { card } = controller();
  const opened = [];
  const ctx = {
    get: key => key === 'sessions' ? {
      list: { getSnapshot: () => ({ byId: { 'parent-session': { cwd: '/project' } } }), subscribe: () => () => {} },
      openSubagent: address => opened.push(address), subagentAddress: () => undefined,
    } : key === 'layout' ? { selectPanel: () => {} } : undefined,
  };
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...(node.props?.children || []).flatMap(flatten)] : [node];
  const child = view.ConversationDashboard({ ctx, sessionId: 'parent-session', controller: card }).props.children[0];
  const render = () => { cursor = 0; const tree = child.type(child.props); effects.splice(0).forEach(effect => effect()); return tree; };
  t.after(() => { globalThis.fetch = originalFetch; slots.forEach(slot => slot?.cleanup?.()); });
  try {
    render();
    await new Promise(resolve => setImmediate(resolve));
    render();
    const tree = render();
    const nodes = flatten(tree);
    assert.ok(nodes.includes(JSON.stringify(observation, null, 2)));
    assert.ok(!nodes.includes(observation));
    assert.ok(nodes.includes('Token 用量不可获取'));
    assert.ok(nodes.includes('Tokens: 12 In / 不可获取 Out（部分数据）'));
    assert.ok(nodes.some(node => node?.props?.children?.includes('任务分支 1')));
    assert.ok(!nodes.some(node => node?.props?.children?.includes('Round 1')));
    expandedAgentId = 'child-partial';
    assert.ok(flatten(render()).includes('观察数据不可获取。'));
    expandedAgentId = 'child-real';
    render();
    const agentNode = nodes.find(node => node?.props?.['aria-level'] === 3);
    assert.equal(agentNode?.props?.role, 'treeitem');
    assert.equal(typeof agentNode?.props?.onKeyDown, 'function');
    await agentNode.props.onClick();
    assert.deepEqual(opened, [{ parentSessionId: 'parent-session', childSessionId: 'child-real', mode: 'continuable' }]);
    const olderButton = nodes.find(node => node?.type === 'button' && node.props.children?.includes('加载更早运行'));
    assert.ok(olderButton);
    await olderButton.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requestedHistoryUrl.searchParams.get('after'), 'cursor-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('聊天看板组件区分加载、403、网络错误与空历史并保留错误重试', async t => {
  const originalFetch = globalThis.fetch;
  const mounts = [];
  const mount = fetcher => {
    let calls = 0;
    globalThis.fetch = (...args) => { calls++; return fetcher(...args); };
    const slots = []; let cursor = 0; const effects = [];
    const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
    const React = {
      Component: class {},
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useMemo: fn => fn(), useRef: value => ({ current: value }),
      useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
      useEffect(fn, deps) { const index = cursor++; const old = slots[index]; if (!old || !same(old.deps, deps)) effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; }); },
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const view = createPlugin(name => name === 'react' ? React : runtime(name));
    const state = { enabled: true, maxConcurrent: 3, roles: {}, projects: [{ path: '/workspace', enabled: true }] };
    const controller = new view.Controller({ value: state, mutate: () => true });
    const sessionId = `session-${mounts.length}`;
    const ctx = { get: key => key === 'sessions' ? { list: { getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/workspace' } } }), subscribe: () => () => {} } } : undefined };
    const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...(node.props?.children || []).flatMap(flatten)] : [node];
    const render = () => {
      cursor = 0; effects.length = 0;
      const wrapper = view.ConversationDashboard({ ctx, sessionId, controller });
      const child = wrapper.props.children[0];
      const tree = child.type(child.props);
      effects.splice(0).forEach(effect => effect());
      return flatten(tree);
    };
    const entry = { render, get calls() { return calls; }, cleanup: () => slots.forEach(slot => slot?.cleanup?.()) };
    mounts.push(entry);
    return entry;
  };
  t.after(() => { globalThis.fetch = originalFetch; mounts.forEach(item => item.cleanup()); });

  let finishLoading;
  const loading = mount(() => new Promise(resolve => { finishLoading = resolve; }));
  let nodes = loading.render();
  await new Promise(resolve => setImmediate(resolve));
  nodes = loading.render();
  assert.ok(nodes.includes('正在加载当前聊天的运行历史…'));
  assert.ok(!nodes.some(node => node?.props?.role === 'tree'));
  assert.ok(!nodes.includes('已就绪，等待工程任务编排与派发'));
  assert.ok(!nodes.includes('当前聊天暂无关联运行记录。'));

  finishLoading({ ok: false, status: 403, json: async () => ({ error: '工作区未启用' }) });
  await new Promise(resolve => setImmediate(resolve));
  nodes = loading.render();
  assert.ok(nodes.includes('无权读取当前工作区：工作区未启用'));
  assert.ok(nodes.some(node => node?.props?.role === 'alert'));
  assert.ok(!nodes.includes('当前聊天暂无关联运行记录。'));
  const retry = nodes.find(node => node?.type === 'button' && node.props.children?.includes('重试'));
  assert.ok(retry);
  const priorCalls = loading.calls;
  retry.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(loading.calls > priorCalls);

  const network = mount(async () => { throw new Error('network down'); });
  network.render();
  await new Promise(resolve => setImmediate(resolve));
  nodes = network.render();
  assert.ok(nodes.includes('读取聊天运行历史失败：network down'));
  assert.ok(nodes.some(node => node?.type === 'button' && node.props.children?.includes('重试')));
  assert.ok(!nodes.includes('已就绪，等待工程任务编排与派发'));

  const empty = mount(async () => ({ ok: true, status: 200, json: async () => ({ runs: [], chat_history: { rounds: [], unbound_count: 0, next_after: null }, message: '当前聊天暂无关联运行记录。' }) }));
  empty.render();
  await new Promise(resolve => setImmediate(resolve));
  nodes = empty.render();
  assert.ok(nodes.includes('当前聊天暂无关联运行记录。'));
  assert.ok(nodes.some(node => node?.props?.role === 'status'));
  assert.ok(!nodes.some(node => node?.props?.role === 'alert'));
  assert.ok(!nodes.some(node => node?.props?.role === 'tree'));
  assert.ok(!nodes.includes('已就绪，等待工程任务编排与派发'));
});

test('活动数量只统计真实 live 且未结算的状态', () => {
  assert.equal(plugin.activeActivityCount([
    { live: true, state: 'running' },
    { live: true, state: 'ended_unknown' },
    { live: false, state: 'running' },
    { live: true, state: 'completed' },
  ]), 1);
});

test('Token 用量明确标识不可获取和部分数据', () => {
  assert.equal(plugin.tokenUsageLabel(null), 'Token 用量不可获取');
  assert.equal(plugin.tokenUsageLabel({ input_tokens: 0, output_tokens: 4 }), 'Tokens: 0 In / 4 Out');
  assert.equal(plugin.tokenUsageLabel({ input_tokens: 12 }), 'Tokens: 12 In / 不可获取 Out（部分数据）');
});

test('运行状态明确区分加载、403 和无关联运行记录', () => {
  assert.equal(plugin.statusMessage({ loading: true, error: '旧错误', errorStatus: 403 }), '正在加载当前聊天的运行状态…');
  assert.equal(plugin.statusMessage({ loading: false, error: '工作区未启用', errorStatus: 403 }), '无权读取此工作区：工作区未启用');
  assert.equal(plugin.statusMessage({ loading: false, error: null, errorStatus: null }), '当前聊天在此工作区暂无关联运行记录。');
});
test('DSH restore inheritance removes only the selected role override', async () => {
  const { card, scope } = controller({ projects: [{ path: '/a', enabled: true, maxConcurrent: 4, roles: { dev: { provider: '', model: '' }, reviewer: { provider: 'p', model: 'r' } } }] });
  card.resetRole('dev', '/a');
  await card.actions.save();
  const project = scope.writes.at(-1).find(change => change.path[0] === 'projects').value[0];
  assert.equal(project.enabled, true);
  assert.equal(project.maxConcurrent, 4);
  assert.deepEqual(project.roles, { reviewer: { provider: 'p', model: 'r' } });
  card.resetRole('reviewer', '/a');
  await card.actions.save();
  assert.equal(Object.hasOwn(scope.writes.at(-1).find(change => change.path[0] === 'projects').value[0], 'roles'), false);
});

test('DSH removal means unknown project is no longer explicitly enabled', async () => {
  const { card, scope } = controller({ projects: [{ path: 'D:\\A', enabled: true }, { path: '/b', enabled: true }] });
  card.removeProject('d:/a');
  await card.actions.save();
  assert.deepEqual(scope.writes.at(-1).find(change => change.path[0] === 'projects'), { op: 'set', path: ['projects'], value: [{ path: '/b', enabled: true }] });
  assert.equal(plugin.samePath('/Project', '/project'), false);
});

test('DSH form rejects invalid concurrency and model routes while retaining inherited blanks', () => {
  const { card } = controller();
  const number = card.form.specs.find(spec => spec.field === 'maxConcurrent');
  for (const value of ['0', '33', '1.5', 'NaN', '']) assert.equal(number.parse(value), undefined);
  assert.deepEqual(number.parse('4'), { kind: 'set', value: 4 });
  assert.equal(plugin.rolesValid({ dev: { provider: '', model: 'code' } }), false);
  assert.equal(plugin.rolesValid({ dev: { provider: 'p', model: '' } }), false);
  assert.equal(plugin.rolesValid({ dev: { provider: 'p' } }), false);
  assert.equal(plugin.rolesValid({ dev: { provider: 'p', model: 'code' } }), true);
  assert.equal(plugin.rolesValid({ dev: { provider: '', model: '', reasoningEffort: '' } }), true);
  assert.equal(plugin.rolesValid({ dev: { model: '' } }), true);
  assert.equal(plugin.rolesValid({ dev: { model: 'override-global-provider' } }), false);
  assert.equal(plugin.rolesValid({ dev: { reasoningEffort: 'high' } }), true);
  const roleField = card.form.specs.find(spec => spec.field === 'roles');
  assert.equal(roleField.parse(JSON.stringify({ dev: { provider: 'p', model: '' } })), undefined);
  assert.equal(roleField.parse(JSON.stringify({ dev: { model: 'code' } })), undefined);
  const projectField = card.form.specs.find(spec => spec.field === 'projects');
  assert.equal(projectField.parse(JSON.stringify([{ path: '/a', enabled: true, roles: { dev: { provider: 'p' } } }])), undefined);
  assert.equal(projectField.parse(JSON.stringify([{ path: '/a', enabled: true, roles: { dev: { reasoningEffort: 'high' } } }]))?.kind, 'set');
  assert.equal(plugin.samePath('/', ''), false);
  assert.equal(plugin.projectsValid([{ path: '/a', enabled: true, maxConcurrent: 0 }]), false);
});

test('betterSidebar 存在时注册统一的设置面板标签页并支持当前聊天工作区定位', () => {
  const { scope } = controller();
  let registeredTab = null;
  const mockBetterSidebar = {
    registerTab: tab => { registeredTab = tab; return () => { registeredTab = null; }; },
  };
  const ctx = {
    effect: setup => setup(),
    configForms: { get: () => scope, whileServed: (_, run) => run() },
    slots: { inject: (_, run) => run(), register: () => () => {} },
    inject: (deps, callback) => {
      if (deps.includes('betterSidebar')) {
        callback({
          get: key => key === 'betterSidebar' ? mockBetterSidebar : undefined,
          effect: setup => setup(),
        });
      }
    },
  };
  plugin.apply(ctx);
  assert.ok(registeredTab);
  assert.equal(registeredTab.id, 'ai-loop-engineering:settings');
  assert.equal(registeredTab.title(), 'AI Loop');
  assert.equal(registeredTab.single, true);
  const rendered = registeredTab.component({ scope: { sessionId: 'chat-1', cwd: 'D:\\Projects\\app' } });
  assert.equal(rendered.type.name, 'Card');
  assert.equal(rendered.props.initialWorkspacePath, 'D:\\Projects\\app');
  assert.equal(rendered.props.sessionId, 'chat-1');
});

test('sessionCwdOf 从 sessions 列表中解析当前会话的工作区', () => {
  const ctx = {
    get: key => key === 'sessions' ? {
      list: {
        getSnapshot: () => ({
          byId: {
            'sess-1': { cwd: 'D:\\Workspace\\Repo' },
            'sess-2': { cwd: '' },
          },
        }),
      },
    } : undefined,
  };
  assert.equal(plugin.sessionCwdOf(ctx, 'sess-1'), 'D:\\Workspace\\Repo');
  assert.equal(plugin.sessionCwdOf(ctx, 'sess-2'), '');
  assert.equal(plugin.sessionCwdOf(ctx, 'sess-unknown'), '');
  assert.equal(plugin.sessionCwdOf(ctx, ''), '');
});

test('ConversationDashboard 正确处理会话工作区与子代理看板', () => {
  const ctx = {
    get: key => key === 'sessions' ? {
      list: {
        getSnapshot: () => ({ byId: { 'sess-chat': { cwd: 'D:\\TestProject' } } }),
        subscribe: () => () => {},
      },
    } : undefined,
  };
  const mockReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
    useSyncExternalStore: (sub, get) => get(),
  };
  const customPlugin = createPlugin(name => name === 'react' ? mockReact : runtime(name));
  const { card } = controller();
  const rendered = customPlugin.ConversationDashboard({ ctx, sessionId: 'sess-chat', controller: card });
  assert.ok(rendered);
  const child = rendered.props.children[0];
  assert.equal(child.props.sessionId, 'sess-chat');
  assert.equal(child.type(child.props).props.style.flex, '1 1 auto');
});
