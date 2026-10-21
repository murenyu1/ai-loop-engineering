import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildDshClient } from '../scripts/build-dsh-client.mjs';
import { createPlugin } from '../plugins/dsh/client/index.mjs';

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
  if (name === 'react') return { createElement: (type, props) => ({ type, props }) };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { SettingsFormModel: FormBridge };
  throw new Error(`Unexpected host dependency: ${name}`);
};
const plugin = createPlugin(runtime);
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
  assert.deepEqual(Array.from(client.inject), ['slots', 'configForms', 'remote', 'remote.session']);
});

test('DSH native configuration attaches only to its own installed package page', () => {
  const { scope } = controller();
  const registrations = [];
  const cleanup = [];
  const injected = [];
  const ctx = {
    effect: setup => { const stop = setup(); if (typeof stop === 'function') cleanup.push(stop); },
    configForms: { get: id => { assert.equal(id, 'ai-loop-engineering'); return scope; }, whileServed: (ids, run) => { assert.deepEqual(ids, ['ai-loop-engineering']); return run(); } },
    slots: { inject: (slot, run) => { injected.push(slot); return run(); }, register: options => { registrations.push(options); return () => {}; } },
  };
  plugin.apply(ctx);
  assert.deepEqual(registrations.map(row => row.name), ['plugins.bundle.config', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  assert.deepEqual(injected, ['plugins.bundle.config', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
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
  await assert.rejects(plugin.requestStatus(async () => ({ ok: false, status: 403, json: async () => ({ error: '工作区未启用' }) }), 'D:\\Projects\\x'), /工作区未启用/);
  await assert.rejects(plugin.requestStatus(async () => { throw new Error('network down'); }, 'D:\\Projects\\x'), /network down/);
});

test('DSH看板多工作区可先选择、按钮点击不把事件当运行号、切换后丢弃旧响应并清理轮询', async () => {
  const slots = [];
  const effects = [];
  const cleanups = [];
  const values = [];
  let cursor = 0;
  let intervals = 0;
  let cleared = 0;
  const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in values)) values[index] = { current: initial }; return values[index]; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const index = cursor++; const previous = values[index]; if (!previous || !same(previous.deps, deps)) { values[index] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); const cleanup = fn(); values[index].cleanup = cleanup; if (cleanup) cleanups.push(cleanup); }); } },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
  };
  const hooksPlugin = createPlugin(name => name === 'react' ? React : runtime(name));
  const render = component => { cursor = 0; effects.length = 0; const tree = component(); effects.splice(0).forEach(effect => effect()); return tree; };
  const resetHooks = () => { values.length = 0; cursor = 0; effects.length = 0; };
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...(node.props?.children || []).flatMap(flatten)] : [];
  const scope = { value: { enabled: true, maxConcurrent: 3, roles: {}, projects: [{ path: '/one', enabled: true }, { path: '/two', enabled: true }] }, mutate() {} };
  const controller = new hooksPlugin.Controller(scope);
  const sidebarTree = render(() => hooksPlugin.SidebarDashboard({ controller, ctx: {} }));
  assert.equal(sidebarTree.props.path, '');
  resetHooks();
  const emptyPathTree = render(() => hooksPlugin.RunDashboard({ path: '', ctx: {}, projects: scope.value.projects }));
  assert.ok(flatten(emptyPathTree).some(node => node.type === 'select'));
  resetHooks();

  const pending = [];
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url: new URL(url), options, resolve }));
  globalThis.setInterval = callback => { intervals++; slots.push(callback); return intervals; };
  globalThis.clearInterval = () => { cleared++; };
  try {
    let tree = render(() => hooksPlugin.RunDashboard({ path: '/one', ctx: {} }));
    assert.equal(pending[0].url.searchParams.get('project'), '/one');
    tree = render(() => hooksPlugin.RunDashboard({ path: '/two', ctx: {} }));
    assert.equal(pending[1].url.searchParams.get('project'), '/two');
    pending[1].resolve({ ok: true, status: 200, json: async () => ({ run_id: 'new', tasks: [], runs: [{ run_id: 'new', status: 'active' }, { run_id: 'history', status: 'complete' }] }) });
    await Promise.resolve(); await Promise.resolve();
    pending[0].resolve({ ok: true, status: 200, json: async () => ({ run_id: 'old', tasks: [] }) });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(values[0].data.run_id, 'new');
    tree = render(() => hooksPlugin.RunDashboard({ path: '/two', ctx: {} }));
    const runSelect = flatten(tree).find(node => node.type === 'select');
    assert.ok(flatten(runSelect).some(child => child.props?.value === 'history'));
    runSelect.props.onChange({ target: { value: 'history' } });
    tree = render(() => hooksPlugin.RunDashboard({ path: '/two', ctx: {} }));
    assert.equal(pending.at(-1).url.searchParams.get('run'), 'history');
    const refresh = flatten(tree).find(node => node.type === 'button');
    refresh.props.onClick({ type: 'click' });
    await Promise.resolve();
    assert.equal(pending.at(-1).url.searchParams.get('run'), 'history');
    render(() => hooksPlugin.RunDashboard({ path: '', ctx: {} }));
    assert.ok(cleared > 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    cleanups.forEach(cleanup => cleanup?.());
  }
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
  const projects = scope.writes.at(-1)[0].value;
  assert.equal(projects.length, 2);
  assert.equal(projects[0].enabled, true);
  assert.equal(projects[0].roles.reviewer.model, 'review');
  assert.equal(projects[0].roles.dev.model, 'code');
  assert.equal(projects[0].maxConcurrent, 4);
  assert.deepEqual(projects[1], { path: '/other', enabled: false });
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
  assert.deepEqual(scope.writes.at(-1)[0].value[0].roles.dev, { reasoningEffort: 'high' });

  controls = findControls(render());
  controls[1].props.onChange({ target: { value: '' } });
  assert.deepEqual(card.store.getSnapshot().projects[0].roles.dev, { provider: '', model: '', reasoningEffort: '' });
  assert.equal(componentPlugin.rolesValid(card.store.getSnapshot().projects[0].roles), true);
  await card.actions.save();
  assert.deepEqual(scope.writes.at(-1)[0].value[0].roles.dev, { provider: '', model: '', reasoningEffort: '' });
});
test('DSH restore inheritance removes only the selected role override', async () => {
  const { card, scope } = controller({ projects: [{ path: '/a', enabled: true, maxConcurrent: 4, roles: { dev: { provider: '', model: '' }, reviewer: { provider: 'p', model: 'r' } } }] });
  card.resetRole('dev', '/a');
  await card.actions.save();
  const project = scope.writes.at(-1)[0].value[0];
  assert.equal(project.enabled, true);
  assert.equal(project.maxConcurrent, 4);
  assert.deepEqual(project.roles, { reviewer: { provider: 'p', model: 'r' } });
  card.resetRole('reviewer', '/a');
  await card.actions.save();
  assert.equal(Object.hasOwn(scope.writes.at(-1)[0].value[0], 'roles'), false);
});

test('DSH removal means unknown project is no longer explicitly enabled', async () => {
  const { card, scope } = controller({ projects: [{ path: 'D:\\A', enabled: true }, { path: '/b', enabled: true }] });
  card.removeProject('d:/a');
  await card.actions.save();
  assert.deepEqual(scope.writes.at(-1), [{ op: 'set', path: ['projects'], value: [{ path: '/b', enabled: true }] }]);
  assert.equal(plugin.samePath('/Project', '/project'), false);
});

test('DSH form rejects invalid concurrency and model routes while retaining inherited blanks', () => {
  const { card } = controller();
  const number = card.form.specs.find(spec => spec.field === 'maxConcurrent');
  for (const value of ['0', '17', '1.5', 'NaN', '']) assert.equal(number.parse(value), undefined);
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
