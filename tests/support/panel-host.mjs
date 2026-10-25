import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createSettingsProtocol, dashboardHtml, DASHBOARD_TOOL } from '../../codex/scripts/settings-server.mjs';

// Host resource display is an observable effect, not a canned structuredContent reply.
export async function panelHost(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-panel-host-'));
  const home = path.join(base, 'home'), root = path.join(base, 'project');
  fs.mkdirSync(home); fs.mkdirSync(root);
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { project: { name: '工作区', rootPaths: [root] } }, 'thread-project-assignments': { chat: { projectKind: 'local', projectId: 'project' } } }));
  const managerFactory = () => {
    let values = { scope: 'global', concurrency: 3 }, dirty = false;
    return { read: async () => ({ values, dirty, schema: { properties: { concurrency: { type: 'integer', minimum: 1, maximum: 8 } } } }),
      update: async set => { values = { ...values, ...set }; dirty = true; return { values, dirty, schema: { properties: {} } }; },
      action: async () => { dirty = false; return { status: 'ok' }; }, hasDrafts: () => dirty };
  };
  const protocol = createSettingsProtocol({}, { home, managerFactory });
  const tools = (await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const script = (options.html || dashboardHtml()).match(/<script>([\s\S]*?)<\/script>/)[1];
  const host = { panels: [], calls: [], messages: [], errors: [], renders: 0, jobs: new Set(), gates: [], root, home, limit: options.limit || 6 };
  let id = 10;
  async function invoke(name, args = {}, display = true) {
    host.calls.push({ name, args: structuredClone(args) });
    const gate=host.gates.find(item=>!item.used&&item.name===name);if(gate){gate.used=true;gate.enter();await gate.block;}
    if (host.calls.length > 100) throw Error('离线夹具调用上限');
    const response = (await protocol.request({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })).result;
    const descriptor = tools.find(tool => tool.name === name);
    if (display && (descriptor?._meta?.ui?.resourceUri || response?._meta?.ui?.resourceUri)) {
      host.renders++;
      if (host.panels.length < host.limit) mount(response, args);
    }
    return response;
  }
  function mount(output, input) {
    const elements = new Map(), handlers = new Map(), intervals = new Map();
    const element = name => {
      if (!elements.has(name)) elements.set(name, { value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, dataset: {}, listeners: new Map(), setAttribute() {}, addEventListener(event, fn) { this.listeners.set(event, fn); }, querySelectorAll() { return []; } });
      return elements.get(name);
    };
    const pages = ['settings', 'dashboard'].map(page => Object.assign(element('page-' + page), { dataset: { page } }));
    const dispatch = (event, payload) => [...(handlers.get(event) || [])].forEach(fn => fn(payload));
    const add = (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); };
    const remove = (event, fn) => handlers.get(event)?.delete(fn);
    const parent = { postMessage(message) {
      if (!message.id) return;
      const job = (async () => {
        let result = {};
        try {
          if (message.method === 'tools/call') result = await invoke(message.params.name, message.params.arguments);
          else if (message.method === 'ui/message') host.messages.push(message.params);
          else if (message.method === 'ui/open-link') result = { ok: true };
          dispatch('message', { source: parent, data: { jsonrpc: '2.0', id: message.id, result } });
        } catch (error) { host.errors.push(error.message); dispatch('message', { source: parent, data: { jsonrpc: '2.0', id: message.id, error: { message: error.message } } }); }
      })();
      host.jobs.add(job); job.finally(() => host.jobs.delete(job));
    } };
    const document = { visibilityState: 'visible', getElementById: element, querySelectorAll: selector => selector === '[data-page]' ? pages : [], addEventListener: add, removeEventListener: remove };
    const context = vm.createContext({ window: { parent, openai: { toolInput: input, toolOutput: output }, addEventListener: add, removeEventListener: remove }, document, setTimeout, clearTimeout, queueMicrotask,
      setInterval: fn => { const key = intervals.size + 1; intervals.set(key, fn); return key; }, clearInterval: key => intervals.delete(key) });
    const panel = { context, element, pages, intervals, dispatch, eval: code => vm.runInContext(code, context) };
    host.panels.push(panel);
    vm.runInContext(script, context);
    return panel;
  }
  host.pauseNext = name => {let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),block=new Promise(resolve=>{release=resolve;});const gate={name,enter,release,entered,block,used:false};host.gates.push(gate);return gate;};
  host.open = args => invoke(DASHBOARD_TOOL, args || {});
  host.invoke = invoke;
  host.flush = async () => { for (let turn = 0; turn < 30; turn++) { await new Promise(resolve => setImmediate(resolve)); if (!host.jobs.size) { await new Promise(resolve => setImmediate(resolve)); if (!host.jobs.size) return; } } throw Error('离线夹具未收敛'); };
  host.close = panel => panel.dispatch('pagehide', {});
  t.after(() => { for(const gate of host.gates)gate.release();for (const panel of host.panels) host.close(panel); fs.rmSync(base, { recursive: true, force: true }); });
  return host;
}
