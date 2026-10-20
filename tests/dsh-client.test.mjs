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
  const ctx = {
    effect: setup => { const stop = setup(); if (typeof stop === 'function') cleanup.push(stop); },
    configForms: { get: id => { assert.equal(id, 'ai-loop-engineering'); return scope; }, whileServed: (ids, run) => { assert.deepEqual(ids, ['ai-loop-engineering']); return run(); } },
    slots: { inject: (slot, run) => { assert.equal(slot, 'plugins.bundle.config'); return run(); }, register: options => { registrations.push(options); return () => {}; } },
  };
  plugin.apply(ctx);
  assert.deepEqual(registrations, [{ name: 'plugins.bundle.config', key: 'dsh-plugin-ai-loop-engineering' }]);
  cleanup.forEach(stop => stop());
  assert.equal(scope.disposed, true);
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
