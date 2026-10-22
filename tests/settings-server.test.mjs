import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspace } from '../scripts/workspaces.mjs';
import { create, event } from '../scripts/loop.mjs';
import { PassThrough } from 'node:stream';
import { createSettingsProtocol, DASHBOARD_TOOL, DASHBOARD_URI, PROTOCOL_VERSION, READ_TOOL, UPDATE_TOOL, runSettingsServer } from '../codex/scripts/settings-server.mjs';

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
  assert.deepEqual(dashboard._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
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
    if (message.method === 'tools/call' && message.params.name !== DASHBOARD_TOOL) { delayed.push(message); return; }
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
