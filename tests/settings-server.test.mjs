import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspace } from '../scripts/workspaces.mjs';
import { create, event, begin } from '../scripts/loop.mjs';
import { recordActivity } from '../scripts/activity.mjs';
import { PassThrough } from 'node:stream';
import { createSettingsProtocol, dashboardHtml, DASHBOARD_TOOL, DASHBOARD_URI, PROTOCOL_VERSION, READ_TOOL, UPDATE_TOOL, runSettingsServer } from '../codex/scripts/settings-server.mjs';

test('双页面板按实例隔离草稿，动作错误保持可见且不影响其他面板', async () => {
  const saved = [], factory = () => {
    let values = {}, fail = false;
    return { read: async () => ({ schema: { properties: {} }, values, dirty: Object.keys(values).length > 0 }),
      update: async set => { values = { ...values, ...set }; fail = set.fail === true; return { values }; },
      action: async name => { if (fail) throw Error('模拟保存冲突'); saved.push({ name, values: { ...values } }); return { status: 'ok' }; } };
  };
  const protocol = createSettingsProtocol({}, { managerFactory: factory });
  const call = async (name, args) => (await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  await call('ai_loop.panel.update', { panel_id: 'panel-one', set: { workspace_id: 'one', concurrency: 2 } });
  await call('ai_loop.panel.update', { panel_id: 'panel-two', set: { workspace_id: 'two', concurrency: 6, fail: true } });
  assert.equal((await call('ai_loop.panel.read', { panel_id: 'panel-one' })).structuredContent.values.concurrency, 2);
  const failed = await call('ai_loop.panel.action', { panel_id: 'panel-two', action: 'apply' });
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /模拟保存冲突/);
  assert.notEqual((await call('ai_loop.panel.action', { panel_id: 'panel-one', action: 'apply' })).isError, true);
  assert.equal(saved.length, 1); assert.equal(saved[0].values.workspace_id, 'one');
  assert.equal((await call('ai_loop.panel.read', { panel_id: '../bad' })).isError, true);
  assert.equal((await call('ai_loop.panel.action', { panel_id: 'panel-one', action: 'other' })).isError, true);
});

test('面板回收干净实例且保护其他范围草稿，失效实例不能空保存', async () => {
  const factory = () => {
    let values = {}, dirty = false;
    return { hasDrafts: () => dirty,
      read: async () => ({ values, dirty: false }),
      update: async set => { values = { ...values, ...set }; if (set.concurrency !== undefined) dirty = true; return { values, dirty: false }; },
      action: async () => ({ status: 'ok' }) };
  };
  const protocol = createSettingsProtocol({}, { managerFactory: factory });
  const call = async (name, args) => (await protocol.request({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args} })).result;
  await call('ai_loop.panel.update', { panel_id:'protected-panel', set:{ workspace_id:'one', concurrency:7 } });
  for (let index=0; index<80; index++) assert.notEqual((await call('ai_loop.panel.read', { panel_id:'clean-panel-'+index })).isError, true);
  assert.equal((await call('ai_loop.panel.read', { panel_id:'protected-panel' })).structuredContent.values.concurrency, 7, '当前范围干净也不能驱逐其他范围的草稿');
  const stale = await call('ai_loop.panel.action', { panel_id:'clean-panel-0', action:'apply' });
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /已回收/);
  assert.equal((await call('ai_loop.panel.update', { panel_id:'clean-panel-0', set:{ concurrency:2 } })).isError, true);
  const restored = await call('ai_loop.panel.update', { panel_id:'clean-panel-0', set:{ workspace_id:'two', scope:'project', concurrency:2 } });
  assert.equal(restored.structuredContent.values.workspace_id, 'two');
  assert.equal(restored.structuredContent.panel_created, true);
  const full = createSettingsProtocol({}, { managerFactory: () => ({ hasDrafts: () => true, read: async () => ({ dirty:true }) }) });
  for (let index=0; index<64; index++) assert.notEqual((await full.request({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ai_loop.panel.read',arguments:{panel_id:'dirty-panel-'+index}} })).result.isError, true);
  const blocked = (await full.request({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ai_loop.panel.read',arguments:{panel_id:'dirty-panel-64'}} })).result;
  assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /草稿已达上限/);
});

test('双页交互保持草稿与手选工作区，聊天切换刷新历史，删除项立即退出候选', async () => {
  const html = dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map(), handlers = new Map(), calls = [];
  const elem = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, listeners: {}, setAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
    return elements.get(id);
  };
  const pages = ['settings', 'dashboard'].map(page => ({ ...elem('page-' + page), dataset: { page } }));
  let rows = [{ id: 'one', label: '多根工作区', root: '/one', roots: ['/one', '/member'], enabled: true }, { id: 'two', label: '另一个工作区', root: '/two', roots: ['/two'], enabled: false }];
  let chat = 'chat-A', current = 'one', values = { workspace_enabled: true, scope: '仅当前工作区', concurrency: 3 }, dirty = false, recreate = false;
  const config = () => ({ schema: { properties: { workspace_enabled: { type: 'boolean', title: '启用工作区' }, concurrency: { type: 'integer', title: '并发', minimum: 1, maximum: 8 } } }, values, dirty, selection: { scope: 'project', workspaceId: current }, status: '示例状态' });
  const opening = () => ({ workspaces: rows, context: { workspace_id: 'one', root: '/one', session_id: chat } });
  const deliver = data => queueMicrotask(() => handlers.get('message')?.({ source: parent, data }));
  const parent = { postMessage(message) {
    calls.push(message); if (!message.id) return;
    let result = {};
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      if (name === DASHBOARD_TOOL) result = opening();
      if (name.startsWith('ai_loop.panel.')) {
        if (args.set?.workspace_id !== undefined || args.set?.workspace_root !== undefined) current = args.set.workspace_id ?? '';
        const fields = Object.fromEntries(Object.entries(args.set??{}).filter(([key])=>!['workspace_id','workspace_root','scope'].includes(key)));
        if (Object.keys(fields).length) { values = { ...values, ...fields }; dirty = true; }
        result = config();
        if (name.endsWith('.read') && recreate) { current=''; recreate=false; result={...config(),panel_created:true}; }
      }
      if (name === 'ai_loop.dashboard.runs') result = { runs: [] };
      if (name === 'ai_loop.dashboard.history') result = { rounds: [{ run: { run_id: args.session + '-run', tasks: [] }, activity: { agents: [] } }] };
      result = { structuredContent: result };
    }
    deliver({ jsonrpc: '2.0', id: message.id, result });
  } };
  vm.runInNewContext(script, { window: { parent, addEventListener: (name, fn) => handlers.set(name, fn) }, document: { getElementById: elem, querySelectorAll: selector => selector === '[data-page]' ? pages : [], addEventListener() {} }, setTimeout, clearTimeout, queueMicrotask });
  const drain = () => new Promise(resolve => setTimeout(resolve, 15));
  await drain();
  assert.equal(elem('workspace').value, 'one'); assert.match(elem('view').innerHTML, /chat-A-run/);
  elem('settings').listeners.change({ target: { dataset: { field: 'workspace_enabled' }, checked: false } }); await drain();
  assert.equal(elem('dirty').textContent, '有未保存修改');
  assert.match(elem('workspace').innerHTML, /🟢 多根工作区/); assert.match(elem('saved-state').innerHTML, /已启用/);
  pages[1].listeners.click(); assert.equal(elem('settings-page').hidden, true); assert.equal(elem('dashboard-page').hidden, false);
  pages[0].listeners.click(); assert.equal(elem('settings-page').hidden, false); assert.equal(dirty, true);
  assert.ok(!calls.some(call => call.params?.name === 'ai_loop.panel.action'), '切页不能自动保存或丢弃');
  chat = 'chat-B'; deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: opening() } }); await drain();
  assert.match(elem('view').innerHTML, /chat-B-run/); assert.doesNotMatch(elem('view').innerHTML, /chat-A-run/);
  elem('workspace').value = 'two'; await elem('workspace').listeners.change(); await drain();
  await elem('discover').listeners.click(); await drain();
  assert.equal(elem('workspace').value, 'two', '普通刷新不抢占手选工作区');
  dirty=false; recreate=true;
  await elem('discover').listeners.click(); await drain();
  assert.equal(current, 'two', '干净实例回收后读取会恢复明确工作区');
  const lastUpdate = calls.filter(call=>call.params?.name==='ai_loop.panel.update').at(-1);
  assert.equal(lastUpdate.params.arguments.set.workspace_id, 'two');
  assert.equal(lastUpdate.params.arguments.set.scope, 'project');
  rows = rows.filter(row => row.id !== 'two'); await elem('discover').listeners.click(); await drain();
  assert.equal(elem('workspace').value, ''); assert.doesNotMatch(elem('workspace').innerHTML, /另一个工作区/);
  assert.match(elem('view').innerHTML, /请选择工作区/);
});

test('多根工作区聚合运行并按真实聊天定位，已删除工作区不可继续读取', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-members-'));
  const home = path.join(base, 'home'), a = path.join(base, 'a'), b = path.join(base, 'b');
  for (const dir of [home, a, b]) fs.mkdirSync(dir);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const host = path.join(home, '.codex-global-state.json');
  fs.writeFileSync(host, JSON.stringify({ 'local-projects': { multi: { name: '同名工作区', rootPaths: [a, b] }, other: { name: '同名工作区', rootPaths: [b] } }, 'thread-project-assignments': { chat: { projectKind: 'local', projectId: 'multi' } }, 'selected-project': 'other' }));
  const spec = { goal: '工作区历史', tasks: [{ id: 't1', title: '方向', review: 'self', acceptance: ['隔离'], checks: [{ id: 'c', command: 'node --version' }] }] };
  for (const root of [a, b]) {
    create(root, spec, 'same-run'); begin(root, 'same-run', 't1', 'development');
    recordActivity(root, 'same-run', { id: 'dev', task: 't1', role: 'dev', harness: 'codex', state: 'requested', summary: root, context: { mode: 'independent', id: root, parent_id: 'chat' } });
  }
  const protocol = createSettingsProtocol({}, { home });
  const call = async (name, args = {}) => (await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const initial = (await call(DASHBOARD_TOOL, { session: 'chat' })).structuredContent;
  assert.equal(initial.workspaces.length, 2); assert.equal(initial.context.workspace_id, 'multi');
  assert.equal((await call(DASHBOARD_TOOL)).structuredContent.context.workspace_id, null);
  const runs = (await call('ai_loop.dashboard.runs', { workspace_id: 'multi', session: 'chat' })).structuredContent.runs;
  assert.equal(runs.length, 2); assert.deepEqual(new Set(runs.map(run => run.record_root)), new Set([a, b]));
  const history = (await call('ai_loop.dashboard.history', { workspace_id: 'multi', session: 'chat' })).structuredContent;
  assert.equal(history.rounds.length, 2); assert.deepEqual(new Set(history.rounds.map(round => round.root)), new Set([a, b]));
  assert.equal((await call('ai_loop.dashboard.runs', { workspace_id: 'other', session: 'chat' })).isError, true);
  fs.writeFileSync(host, JSON.stringify({ 'local-projects': {} }));
  assert.equal((await call('ai_loop.dashboard.runs', { workspace_id: 'multi' })).isError, true);
  assert.deepEqual((await call(DASHBOARD_TOOL)).structuredContent.workspaces, []);
});

test('initialize、discover 与 tools/list 声明 openai/settings 原生能力', async () => {
  const protocol = createSettingsProtocol({});
  const initialized = await protocol.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(initialized.result.capabilities.experimental['openai/settings'].readTool, READ_TOOL);
  assert.equal(initialized.result.capabilities.experimental['openai/settings'].updateTool, UPDATE_TOOL);
  const discovered = await protocol.request({ jsonrpc: '2.0', id: 2, method: 'server/discover' });
  assert.equal(discovered.result.capabilities.extensions['openai/settings'].readTool, READ_TOOL);
  const tools = await protocol.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.ok(tools.result.tools.some(tool => tool.name === READ_TOOL && tool.annotations.readOnlyHint));
  assert.ok(tools.result.tools.some(tool => tool.name === UPDATE_TOOL && tool.outputSchema.required.includes('values')));
  const dashboard = tools.result.tools.find(tool => tool.name === DASHBOARD_TOOL);
  assert.equal(dashboard._meta.ui.resourceUri, DASHBOARD_URI);
  assert.deepEqual(dashboard._meta['openai/ui'].entrypoints, [{ type: 'thread' }, { type: 'global' }]);
  assert.ok(dashboard.annotations.readOnlyHint);
  assert.equal(tools.result.tools.some(tool => tool.name === 'ai_loop.workspace.register'), false);
  assert.equal(tools.result.tools.some(tool => tool.name === 'ai_loop.workspace.toggle'), false, '旧动作仅保留调用兼容，不在面板列出');
});

test('代理看板注册为包内 MCP App 资源，不启动网页服务', async () => {
  const protocol = createSettingsProtocol({});
  const listed = await protocol.request({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.ok(listed.result.resources.some(item => item.uri === DASHBOARD_URI && item.mimeType === 'text/html;profile=mcp-app'));
  const loaded = await protocol.request({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: DASHBOARD_URI } });
  const html = loaded.result.contents[0].text;
  assert.match(html, /ai_loop\.dashboard\.runs/);
  assert.match(html, /ai_loop\.dashboard\.status/);
  assert.match(html, /ui\/initialize/);
  assert.match(html, /ui\/notifications\/initialized/);
  assert.match(html, /data-view="agents"/);
  assert.match(html, /data-view="tasks"/);
  assert.match(html, /data-view="activity"/);
  assert.match(html, /window\.openai/);
  assert.doesNotMatch(html, /https?:\/\//, '看板资源不依赖外部浏览器服务');
});

test('代理看板完成 MCP UI 握手并通过标准 tools/call 桥读取数据', async () => {
  const protocol = createSettingsProtocol({});
  const response = await protocol.request({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: DASHBOARD_URI } });
  const html = response.result.contents[0].text;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const sent = [], handlers = [], elements = new Map(), delayed = [];
  const parent = { postMessage(message) {
    sent.push(message);
    if (!message.id) return;
    if (message.method === 'tools/call' && message.params.name !== DASHBOARD_TOOL && !message.params.name.startsWith('ai_loop.panel.')) { delayed.push(message); return; }
    const result = message.method === 'tools/call' ? { structuredContent: { workspaces: [], note: 'empty' } } : {};
    queueMicrotask(() => handlers.forEach(handler => handler({ source: parent, data: { jsonrpc: '2.0', id: message.id, result } })));
  } };
  const elem = id => { if (!elements.has(id)) elements.set(id, { id, value: '', options: [], innerHTML: '', textContent: '', listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } }); return elements.get(id); };
  const context = { window: { parent, openai: undefined, addEventListener(name, handler) { if (name === 'message') handlers.push(handler); } }, document: { getElementById: elem, querySelectorAll: () => [] }, Map, Promise, Error, String, JSON, setTimeout, clearTimeout, queueMicrotask };
  const respond = (message, structuredContent) => queueMicrotask(() => handlers.forEach(handler => handler({ source: parent, data: { jsonrpc: '2.0', id: message.id, result: { structuredContent } } })));
  vm.runInNewContext(script, context);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(sent.some(message => message.method === 'ui/initialize'));
  assert.ok(sent.some(message => message.method === 'ui/notifications/initialized'));
  assert.ok(sent.some(message => message.method === 'tools/call' && message.params.name === DASHBOARD_TOOL));

  const workspace = elem('workspace'), run = elem('run'), view = elem('view');
  workspace.value = 'root-A'; const aRuns = workspace.listeners.change();
  workspace.value = 'root-B'; const bRuns = workspace.listeners.change();
  const pendingRuns = delayed.filter(message => message.params.name === 'ai_loop.dashboard.runs');
  respond(pendingRuns[1], { runs: [{ run_id: 'B-run' }] }); await bRuns;
  respond(pendingRuns[0], { runs: [{ run_id: 'A-run' }] }); await aRuns;
  assert.match(run.innerHTML, /B-run/, '较慢的旧工作区响应不能覆盖当前运行列表');
  assert.doesNotMatch(run.innerHTML, /A-run/);

  run.value = 'B-old'; const oldStatus = run.listeners.change();
  run.value = 'B-new'; const newStatus = run.listeners.change();
  const pendingStatus = delayed.filter(message => message.params.name === 'ai_loop.dashboard.status');
  respond(pendingStatus[1], { run: { run_id: 'B-new', status: 'active' }, activity: { note: 'last-observed', agents: [{ role: 'dev', state: 'running', summary: 'new-result', native_id: 'n2', requested: { model: 'm2' }, usage: null }] }, events: [] }); await newStatus;
  respond(pendingStatus[0], { run: { run_id: 'B-old', status: 'active' }, activity: { note: 'last-observed', agents: [{ role: 'dev', state: 'running', summary: 'old-result', native_id: 'n1', requested: { model: 'm1' }, usage: null }] }, events: [] }); await oldStatus;
  assert.match(view.innerHTML, /new-result/, '较慢的旧运行响应不能覆盖当前视图');
  assert.doesNotMatch(view.innerHTML, /old-result/);
  assert.match(view.innerHTML, /Token.*不可获取/);
  assert.match(view.innerHTML, /n2/);
  workspace.value = 'denied-root';
  const denied = workspace.listeners.change();
  const rejected = delayed.at(-1);
  queueMicrotask(() => handlers.forEach(handler => handler({ source: parent, data: { jsonrpc: '2.0', id: rejected.id, result: { isError: true, content: [{ type: 'text', text: '此工作区未授权读取' }] } } })));
  await denied;
  assert.match(elem('note').textContent, /此工作区未授权读取/, '工具级错误不能吞成空运行列表');
});

test('看板读取尾部活动及默认关闭角色，不把最早100条冒充最新活动', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-dashboard-'));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; fs.rmSync(root, { recursive: true, force: true }); });
  registerWorkspace(home, project);
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { name: '测试工作区', rootPaths: [project] } } }));
  create(project, { goal: '活动', tasks: [{ id: 't1', title: '任务', review: 'self', acceptance: ['可验证'], checks: [{ id: 'c', command: 'node --version' }] }] }, 'r1');
  for (let index = 1; index <= 105; index++) event(project, 'r1', { type: 'decision', summary: `event-${index}` });
  const protocol = createSettingsProtocol({});
  const response = await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ai_loop.dashboard.status', arguments: { root: project, run: 'r1' } } });
  assert.notEqual(response.result.isError, true);
  const value = response.result.structuredContent;
  assert.equal(value.events.length, 100);
  assert.equal(value.events.at(-1).summary, 'event-105');
  assert.ok(value.events[0].seq > 1);
  assert.ok(Object.values(value.roles).every(role => role.enabled === false));
});

test('看板直接发现未登记工作区，只读定位且不猜测当前聊天', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-discovery-'));
  const home = path.join(base, 'home'), project = path.join(base, 'project'), other = path.join(base, 'other');
  for (const directory of [home, project, other]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(home, '.codex-global-state.json');
  const native = JSON.stringify({ 'local-projects': { p: { name: '自动发现', rootPaths: [project] } }, 'active-workspace-roots': [project] });
  fs.writeFileSync(file, native);
  const protocol = createSettingsProtocol({}, { home });
  const call = async (name, args = {}) => (await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const initial = (await call(DASHBOARD_TOOL)).structuredContent;
  assert.equal(initial.workspaces[0].enabled, false);
  assert.equal(initial.context.session_id, null);
  assert.equal(initial.context.root, null, 'active 列表不代表当前聊天');
  const explicit = (await call(DASHBOARD_TOOL, { root: project, session: 'chat-A' })).structuredContent;
  assert.equal(explicit.context.root, fs.realpathSync(project));
  assert.equal(explicit.context.session_id, 'chat-A');
  assert.deepEqual((await call('ai_loop.dashboard.runs', { root: project })).structuredContent.runs, []);
  assert.equal((await call('ai_loop.dashboard.runs', { root: other })).isError, true);
  assert.equal(fs.existsSync(path.join(home, 'ai-loop')), false, '查看不应登记或启用工作区');
  assert.equal(fs.readFileSync(file, 'utf8'), native);
});

test('看板聊天历史、运行列表及单次运行都隔离同工作区其他聊天', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-chat-'));
  const home = path.join(base, 'home'), project = path.join(base, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'active-workspace-roots': [project] }));
  const spec = { goal: '历史', tasks: [{ id: 't1', title: '开发方向', review: 'self', acceptance: ['可测'], checks: [{ id: 'c', command: 'node --version' }] }] };
  for (const [run, parent] of [['r1', 'A'], ['r2', 'A'], ['r3', 'B'], ['legacy', null]]) {
    create(project, spec, run); begin(project, run, 't1', 'development');
    recordActivity(project, run, { id: 'dev', task: 't1', role: 'dev', harness: 'codex', state: 'requested', summary: run, ...(parent ? { context: { mode: 'independent', id: run + '-child', parent_id: parent } } : {}) });
  }
  const protocol = createSettingsProtocol({}, { home });
  const call = async (name, args) => (await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const history = (await call('ai_loop.dashboard.history', { root: project, session: 'A' })).structuredContent;
  assert.deepEqual(history.rounds.map(item => item.run.run_id).sort(), ['r1', 'r2']);
  assert.equal(history.rounds[0].run.tasks.length, 1);
  assert.equal(history.unbound_count, 1);
  const runs = (await call('ai_loop.dashboard.runs', { root: project, session: 'A' })).structuredContent.runs;
  assert.deepEqual(runs.map(item => item.run_id).sort(), ['r1', 'r2']);
  assert.equal((await call('ai_loop.dashboard.status', { root: project, run: 'r3', session: 'A' })).isError, true);
  assert.equal((await call('ai_loop.dashboard.history', { root: project, session: 'A', after: 'not-a-cursor' })).isError, true);
});

test('代理树展示多运行历史、转义内容并仅允许真实 Codex 聊天地址', async () => {
  const html = dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map(), handlers = [], calls = [];
  const elem = id => { if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', hidden: true, listeners: {}, addEventListener(n, fn) { this.listeners[n] = fn; } }); return elements.get(id); };
  const parent = { postMessage(message) { calls.push(message); if (!message.id) return; let result = {};
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      if (name === DASHBOARD_TOOL) result = { workspaces: [{ root: 'root-A', enabled: false }], context: { root: 'root-A', session_id: 'A' } };
      if (name === 'ai_loop.dashboard.runs') { assert.equal(args.session, 'A'); result = { runs: [] }; }
      if (name === 'ai_loop.dashboard.history') result = { rounds: ['first', 'second'].map(run => ({ run: { run_id: run, tasks: [] }, activity: { agents: [{ role: 'dev', harness: 'codex', native_id: '/root/dev', observation: { summary: '<script>bad</script>' } }, { role: 'dev', harness: 'codex', context: { id: '/root/dev' }, native_id: '01234567-89ab-cdef-0123-456789abcdef' }] } })), next_after: null };
      result = { structuredContent: result };
    }
    if (message.method === 'ui/open-link') result = { isError: true };
    queueMicrotask(() => handlers.forEach(fn => fn({ source: parent, data: { jsonrpc: '2.0', id: message.id, result } })));
  } };
  vm.runInNewContext(script, { window: { parent, addEventListener: (name, fn) => handlers.push(fn) }, document: { getElementById: elem, querySelectorAll: () => [] }, setTimeout, clearTimeout, queueMicrotask });
  await new Promise(resolve => setTimeout(resolve, 30));
  const view = elem('view');
  assert.match(view.innerHTML, /first/); assert.match(view.innerHTML, /second/);
  assert.match(view.innerHTML, /class="graph-port"/); assert.match(view.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(view.innerHTML, /data-session="\/root/);
  assert.match(view.innerHTML, /data-session="01234567-89ab-cdef-0123-456789abcdef"/);
  await view.listeners.click({ target: { closest: () => ({ dataset: { session: '01234567-89ab-cdef-0123-456789abcdef' } }) } });
  assert.ok(calls.some(call => call.method === 'ui/open-link' && call.params.url === 'codex://threads/01234567-89ab-cdef-0123-456789abcdef'));
  assert.match(elem('message').textContent, /宿主未能打开聊天.*宿主拒绝/);
  assert.doesNotMatch(elem('message').textContent, /已向宿主请求打开/);
});

test('read/update 和动作调用返回 MCP structuredContent，update等待并传回刷新schema', async () => {
  const calls = [];
  const updated = { schema: { type: 'object', properties: { flag: { type: 'boolean', title: 'Flag' } } }, values: { flag: false }, layout: [{ kind: 'group', title: '刷新' }] };
  const manager = {
    async read() { calls.push('read'); return { schema: { type: 'object', properties: { flag: { type: 'boolean', title: 'Flag' } } }, values: { flag: true }, layout: [] }; },
    async update(set) { calls.push(['update', set]); await new Promise(resolve => setTimeout(resolve, 0)); return updated; },
    async action(name) { calls.push(name); return { status: 'configured' }; },
  };
  const protocol = createSettingsProtocol(manager);
  const read = await protocol.request({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: READ_TOOL, arguments: {} } });
  assert.deepEqual(read.result.structuredContent.values, { flag: true });
  const update = await protocol.request({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: UPDATE_TOOL, arguments: { set: { flag: false } } } });
  assert.deepEqual(update.result.structuredContent, updated);
  const listed = await protocol.request({ jsonrpc: '2.0', id: 14, method: 'tools/list' });
  const updateTool = listed.result.tools.find(tool => tool.name === UPDATE_TOOL);
  assert.ok(updateTool.outputSchema.properties.schema);
  assert.ok(updateTool.outputSchema.properties.layout);
  const applied = await protocol.request({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'ai_loop.settings.apply', arguments: {} } });
  assert.equal(applied.result.structuredContent.result.status, 'configured');
  const invalid = await protocol.request({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: READ_TOOL, arguments: { path: 'x' } } });
  assert.equal(invalid.result.isError, true);
  assert.deepEqual(calls, ['read', ['update', { flag: false }], 'ai_loop.settings.apply']);
});

test('reset_project 工具调用把 fallback 失败作为可见错误返回', async () => {
  const protocol = createSettingsProtocol({
    async read() { return { schema: { type: 'object', properties: {} }, values: {}, layout: [] }; },
    update() { return { values: {} }; },
    async action(name) {
      assert.equal(name, 'ai_loop.settings.reset_project');
      throw new SyntaxError('全局模型配置损坏，停止恢复');
    },
  });
  const tools = await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(tools.result.tools.some(tool => tool.name === 'ai_loop.settings.reset_project'));
  const response = await protocol.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'ai_loop.settings.reset_project', arguments: {},
  } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /全局模型配置损坏/);
});

test('stdio transport 串行处理请求，只向 stdout 输出 JSON-RPC，并等待队列排空', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines = [];
  output.setEncoding('utf8'); output.on('data', value => lines.push(value));
  const manager = {
    async read() { await new Promise(resolve => setTimeout(resolve, 5)); return { schema: { type: 'object', properties: {} }, values: {}, layout: [] }; },
    async update(set) { await new Promise(resolve => setTimeout(resolve, 5)); return { schema: { type: 'object', properties: {} }, values: set, layout: [] }; },
    action() { return { status: 'ok' }; },
  };
  const running = runSettingsServer({ input, output, manager });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: READ_TOOL, arguments: {} } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: UPDATE_TOOL, arguments: { set: { concurrency: 4 } } } })}\n`);
  input.end();
  await running;
  const responses = lines.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.map(item => item.id), [1, 2, 3]);
  assert.equal(responses[1].result.structuredContent.values && typeof responses[1].result.structuredContent.values, 'object');
  assert.deepEqual(responses[2].result.structuredContent.values, { concurrency: 4 });
});

test('stdio transport 保留跨chunk JSON，正确解码UTF-8与CRLF', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.setEncoding('utf8'); output.on('data', value => { text += value; });
  const running = runSettingsServer({ input, output, manager: {} });
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 31, method: '不支持的方法' })}\r\n`, 'utf8');
  const split = line.indexOf(Buffer.from('支', 'utf8')) + 1;
  input.write(line.subarray(0, split));
  input.write(line.subarray(split, split + 2));
  input.write(line.subarray(split + 2));
  input.end();
  await running;
  const response = JSON.parse(text.trim());
  assert.equal(response.id, 31);
  assert.match(response.error.message, /不支持的方法/);
});

test('stdio transport 限制超长输入并在下一行恢复解析', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.setEncoding('utf8'); output.on('data', value => { text += value; });
  const running = runSettingsServer({ input, output, manager: {} });
  input.write(`${' '.repeat(1024 * 1024 + 1)}\n${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'initialize' })}\r\n`);
  input.end();
  await running;
  const responses = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].id, 41);
  assert.equal(responses[1].result.protocolVersion, '2025-11-25');
});


function graphHarness(data) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value:'', innerHTML:'', textContent:'', dataset:{}, listeners:{}, addEventListener(name, fn) { this.listeners[name]=fn; }, setAttribute(){} });
    return elements.get(id);
  };
  const key=JSON.stringify([data.root??'',data.run.run_id]);
  const port={scrollLeft:0,scrollTop:0,clientWidth:320,clientHeight:400};
  const section={dataset:{graphKey:key},innerHTML:'',querySelector:selector=>selector==='.graph-port'?port:null};
  const context=vm.createContext({window:{parent:{postMessage(){}},addEventListener(){}},document:{getElementById:element,querySelectorAll:selector=>selector==='[data-graph-key]'?[section]:[],addEventListener(){}},setTimeout,clearTimeout,queueMicrotask});
  const script=dashboardHtml().match(/<script>([\s\S]*?)<\/script>/)[1].replace(/init\(\);\s*$/, '');
  vm.runInContext(script,context);
  context.data=data;
  vm.runInContext('tree(data)',context);
  return { context,port,section,element,key,
    render:()=>vm.runInContext('tree(data)',context),
    click(dataset){const button={dataset};context.event={target:{closest:selector=>selector==='button'?button:selector==='[data-graph-key]'?section:null}};vm.runInContext('handleGraphClick(event)',context);},
    state:()=>JSON.parse(vm.runInContext('JSON.stringify(graphState(graphKey(data)))',context)),
  };
}

test('共享工作流图保持缩放、折叠和详情，画布输入不能触发配置保存',()=>{
  const data={root:'/root',run:{run_id:'graph-ui',status:'active',tasks:[{id:'a',title:'任务 A',phase:'developing',review:'independent'},{id:'b',title:'任务 B',phase:'pending',dependencies:['a']}]},activity:{agents:[{id:'dev-a',task:'a',role:'dev',harness:'codex',state:'completed',summary:'<img src=x onerror=bad()>',native_id:'01234567-89ab-cdef-0123-456789abcdef',attempt:1}]}};
  const f=graphHarness(data),html=f.render();
  assert.match(html,/class="graph-port"/);assert.match(html,/stroke-dasharray="6 4"/);
  assert.match(html,/尚无调用/);assert.match(html,/已结束/);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img src=x/);
  assert.match(html,/全部展开/);assert.match(html,/统一记录/);
  f.click({graphAction:'in'});assert.equal(f.state().zoom,1.1);
  for(let i=0;i<20;i++)f.click({graphAction:'in'});assert.equal(f.state().zoom,1.5);
  for(let i=0;i<30;i++)f.click({graphAction:'out'});assert.equal(f.state().zoom,.35);
  f.click({collapse:'a'});assert.deepEqual(f.state().collapsed,['a']);
  f.render();assert.deepEqual(f.state().collapsed,['a']);assert.equal(f.state().zoom,.35);
  f.click({graphAction:'expand'});assert.deepEqual(f.state().collapsed,[]);
  f.port.scrollLeft=70;f.port.scrollTop=90;f.click({graphAction:'reset'});assert.equal(f.state().zoom,1);assert.equal(f.port.scrollLeft,0);assert.equal(f.port.scrollTop,0);
});

test('资源注入共享纯函数且显式分支汇合不靠调用时间推断',()=>{
  const html=dashboardHtml();assert.doesNotMatch(html,/\/\* LOOP_GRAPH \*\//);assert.match(html,/const createWorkflowGraph = function/);
  const data={run:{run_id:'fanout',tasks:[{id:'a',phase:'pending'},{id:'b',phase:'pending'}],workflow:{nodes:[{id:'plan',task:'run',role:'planner'},{id:'dev-a',task:'a',role:'dev'},{id:'dev-b',task:'b',role:'dev'},{id:'scribe',task:'run',role:'scribe'}],edges:[{from:'plan',to:'dev-a'},{from:'plan',to:'dev-b'},{from:'dev-a',to:'scribe'},{from:'dev-b',to:'scribe'}]}},activity:{agents:[]}};
  const f=graphHarness(data);const graph=JSON.parse(vm.runInContext('JSON.stringify(createWorkflowGraph(data))',f.context));
  const dev=graph.nodes.filter(node=>node.role==='dev');assert.equal(dev.length,2);assert.equal(dev[0].y,dev[1].y);assert.notEqual(dev[0].x,dev[1].x);
  assert.equal(graph.edges.filter(edge=>edge.kind==='call').length,0);
  assert.ok(graph.edges.filter(edge=>edge.target==='workflow:scribe').length>=2);
});
