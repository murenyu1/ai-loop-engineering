import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createSettingsProtocol, PROTOCOL_VERSION, READ_TOOL, UPDATE_TOOL, runSettingsServer } from '../codex/scripts/settings-server.mjs';

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
  assert.equal(tools.result.tools.some(tool => tool.name === 'ai_loop.workspace.register'), false);
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
