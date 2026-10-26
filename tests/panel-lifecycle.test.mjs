import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { panelHost } from './support/panel-host.mjs';
import { DASHBOARD_READ_TOOL, DASHBOARD_TOOL } from '../codex/scripts/settings-server.mjs';
import { create, begin } from '../scripts/loop.mjs';
import { recordActivity } from '../scripts/activity.mjs';

test('无工作区的全局草稿可保存，项目草稿仍要求选择工作区', async t => {
  const host = await panelHost(t); await host.open(); await host.flush();
  const panel = host.panels[0];
  panel.element('settings').listeners.get('change')({ target: { dataset: { field: 'concurrency' }, value: '4' } });
  await host.flush();
  assert.equal(panel.element('workspace').value, '');
  assert.equal(panel.element('save').disabled, false);
  await panel.element('save').listeners.get('click')(); await host.flush();
  assert.equal(panel.element('save').disabled, true);
  panel.eval("renderSettings({dirty:true,values:{scope:'project'},schema:{properties:{}}})");
  assert.equal(panel.element('save').disabled, true);
  assert.equal(host.messages.length, 0);
});

test('同一聊天轮询读取最新任务状态且保留草稿与视图状态', async t => {
  const host = await panelHost(t); await host.open({ root: host.root, session: 'chat' }); await host.flush();
  const panel = host.panels[0];
  panel.element('settings').listeners.get('change')({ target: { dataset: { field: 'concurrency' }, value: '4' } }); await host.flush();
  panel.eval("graphState('sample').zoom=.7;graphState('sample').selected='node'");
  const before = host.calls.filter(c => c.name === 'ai_loop.dashboard.history').length;
  for (const tick of panel.intervals.values()) tick(); await host.flush();
  assert.equal(host.calls.filter(c => c.name === 'ai_loop.dashboard.history').length, before + 1);
  assert.equal(panel.element('dirty').textContent, '有未保存修改');
  assert.equal(panel.eval("graphState('sample').zoom"), .7);
  assert.equal(panel.eval("graphState('sample').selected"), 'node');
  assert.equal(panel.element('run').value, '@history');
  assert.equal(host.renders, 1); assert.equal(host.messages.length, 0);
});

test('Codex面板同名子项目运行可分别选中并读取状态', async t => {
  const host = await panelHost(t);
  for (const project_path of ['one', 'two']) {
    fs.mkdirSync(host.root + '/' + project_path);
    create(host.root, { goal: project_path, project_path, tasks: [{ id: 't', title: '任务', review: 'none', acceptance: ['隔离'], checks: [{ id: 'c', command: 'fixture' }] }] }, 'same');
    begin(host.root, 'same', 't', 'development', { project_path });
    recordActivity(host.root, 'same', { id: 'dev', task: 't', role: 'dev', harness: 'codex', state: 'requested', context: { mode: 'independent', id: project_path, parent_id: 'chat' }, summary: project_path }, { project_path });
  }
  await host.open({ root: host.root, session: 'chat' }); await host.flush();
  const panel = host.panels[0];
  assert.match(panel.element('run').innerHTML, /one/); assert.match(panel.element('run').innerHTML, /two/);
  for (const project_path of ['one', 'two']) {
    panel.element('run').value = JSON.stringify([host.root, 'same', project_path]);
    await panel.element('run').listeners.get('change')(); await host.flush();
    assert.equal(panel.eval('payload.run.project_path'), project_path);
  }
  assert.equal(host.messages.length, 0);
});

test('标准宿主不注入 window.openai，arguments 通知仍定位设置与看板且不发消息', async t => {
  const host = await panelHost(t, { standard: true });
  await host.open({ root: host.root, session: 'chat' }); await host.flush();
  const panel = host.panels[0];
  assert.equal(panel.element('workspace').value, 'project');
  assert.equal(panel.eval('chat.id'), 'chat');
  assert.ok(host.calls.some(call => call.name === 'ai_loop.panel.update' && call.args.set.workspace_id === 'project'));
  assert.ok(host.calls.some(call => call.name === 'ai_loop.dashboard.history' && call.args.session === 'chat'));
  panel.pages[1].listeners.get('click')(); panel.pages[0].listeners.get('click')();
  assert.equal(panel.element('workspace').value, 'project');
  assert.equal(host.messages.length, 0); assert.equal(host.panels.length, 1);
});

test('标准空输入清除原聊天，未知线程字段与局部输入不能冒充归属', async t => {
  const host = await panelHost(t, { standard: true });
  await host.open({ root: host.root, session: 'chat' }); await host.flush();
  const panel = host.panels[0];
  panel.notify('ui/notifications/tool-input-partial', { arguments: { session: 'other' } });
  await host.flush(); assert.equal(panel.eval('chat.id'), 'chat');
  panel.notify('ui/notifications/tool-input', { arguments: {}, session: 'chat', root: host.root });
  await host.flush();
  assert.equal(panel.element('workspace').value, ''); assert.equal(panel.eval('chat'), null);
  assert.match(panel.element('scope').textContent, /未提供/);
  panel.notify('ui/notifications/tool-input', { arguments: { threadId: 'chat', cwd: host.root } });
  await host.flush(); assert.equal(panel.element('workspace').value, '');
  assert.equal(host.messages.length, 0); assert.equal(host.panels.length, 1);
});

test('标准宿主关闭请求与在途请求ID相同时仍销毁面板并确认关闭', async t => {
  const host = await panelHost(t, { standard: true });
  await host.open({ root: host.root }); await host.flush();
  const panel = host.panels[0], gate = host.pauseNext(DASHBOARD_READ_TOOL);
  const reading = panel.eval('discover()'); await gate.entered;
  const requestId = panel.eval('[...pending.keys()][0]');
  panel.notify('ui/resource-teardown', { reason: '关闭侧栏' }, requestId);
  await reading;
  assert.equal(panel.eval('disposed'), true); assert.equal(panel.eval('pending.size'), 0);
  assert.equal(panel.intervals.size, 0);
  assert.deepEqual(host.replies, [{ jsonrpc: '2.0', id: requestId, result: {} }]);
  const count = host.calls.length; gate.release(); await host.flush();
  panel.notify('ui/notifications/tool-input', { arguments: { root: host.root, session: 'chat' } });
  await host.flush(); assert.equal(host.calls.length, count); assert.equal(host.messages.length, 0);
});

test('旧版binding渲染请求明确停用且不返回UI资源', async t => {
  const host = await panelHost(t);
  const result = await host.invoke(DASHBOARD_TOOL, { binding: 'legacy-binding-0001' }, false);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /已停用/);
  assert.equal(result._meta, undefined); assert.equal(host.panels.length, 0);
});

test('标准空入口不被在途旧聊天响应重新绑定，兼容宿主仍可定位', async t => {
  const host = await panelHost(t);
  await host.open({ root: host.root, session: 'chat' }); await host.flush();
  const panel = host.panels[0], gate = host.pauseNext(DASHBOARD_READ_TOOL);
  const reading = panel.eval('discover()'); await gate.entered;
  panel.notify('ui/notifications/tool-input', { arguments: {} });
  // New entry's request completes while the previous chat's request remains paused.
  for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.element('workspace').value, '');
  gate.release(); await reading; await host.flush();
  assert.equal(panel.element('workspace').value, ''); assert.equal(panel.eval('chat'), null);
  const compatible = await panelHost(t, { standard: false });
  await compatible.open({ root: compatible.root, session: 'chat' }); await compatible.flush();
  assert.equal(compatible.panels[0].element('workspace').value, 'project');
  assert.equal(host.messages.length + compatible.messages.length, 0);
});

test('旧版在受限宿主生命周期夹具中复现跨实例扩张，测试不发送真实聊天消息', async t => {
  const html = fs.readFileSync(new URL('./support/legacy-loop.html', import.meta.url), 'utf8');
  const host = await panelHost(t, { html, limit: 5 });
  await host.open(); await host.flush();
  assert.equal(host.panels.length, 5);
  assert.ok(host.renders > 1);
  assert.ok(host.messages.length > 0, '旧版自动定位消息被离线夹具截获');
});

test('空入口、重复初始化、切页、刷新、保存和后台轮询均不创建新面板或自动消息', async t => {
  const host = await panelHost(t); await host.open(); await host.flush();
  const panel = host.panels[0];
  assert.equal(panel.element('workspace').value, '');
  assert.equal(panel.eval('typeof locateChat'), 'undefined');
  await panel.eval('Promise.all([init(),init(),init()])');
  for (let turn = 0; turn < 4; turn++) {
    panel.pages[1].listeners.get('click')(); panel.pages[0].listeners.get('click')();
    panel.dispatch('focus', {}); for (const tick of panel.intervals.values()) tick();
    await host.flush();
  }
  panel.element('settings').listeners.get('change')({ target: { dataset: { field: 'concurrency' }, value: '4' } }); await host.flush();
  await panel.element('save').listeners.get('click')(); await host.flush();
  assert.equal(host.renders, 1); assert.equal(host.panels.length, 1); assert.equal(host.messages.length, 0); assert.deepEqual(host.errors, []);
  assert.equal(host.calls.filter(call => call.name === DASHBOARD_TOOL).length, 1);
  assert.ok(host.calls.some(call => call.name === DASHBOARD_READ_TOOL));
});

test('显式真实上下文只定位现有面板，重复通知和后台刷新不会重新挂载', async t => {
  const host = await panelHost(t); await host.open({ root: host.root, session: 'chat' }); await host.flush();
  const panel = host.panels[0]; assert.equal(panel.element('workspace').value, 'project');
  const before = host.calls.length;
  for (let turn = 0; turn < 5; turn++) panel.dispatch('message', { source: panel.context.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { root: host.root, session: 'chat' } } });
  await host.flush(); assert.equal(host.calls.length, before, '相同输入幂等');
  await panel.eval('discover()'); await host.flush();
  assert.equal(host.renders, 1); assert.equal(host.messages.length, 0); assert.equal(panel.element('workspace').value, 'project');
});

test('关闭后清除轮询、拒收迟到响应，重新打开也不触发自动消息', async t => {
  const host = await panelHost(t); await host.open(); await host.flush();
  const panel = host.panels[0], oldTicks = [...panel.intervals.values()];
  host.close(panel); const calls = host.calls.length;
  for (const tick of oldTicks) tick(); panel.dispatch('focus', {}); await panel.eval('discover()'); await host.flush();
  assert.equal(panel.intervals.size, 0); assert.equal(host.calls.length, calls); assert.equal(panel.eval('pending.size'), 0);
  await host.open(); await host.flush(); assert.equal(host.panels.length, 2); assert.equal(host.renders, 2); assert.equal(host.messages.length, 0);
});


test('真实请求在途时关闭会拒绝等待并忽略迟到协议响应和通知', async t => {
  const host = await panelHost(t); await host.open({ root: host.root }); await host.flush();
  const panel = host.panels[0], gate = host.pauseNext(DASHBOARD_READ_TOOL);
  const reading = panel.eval('discover()'); await gate.entered;
  assert.equal(panel.eval('pending.size'), 1, '请求确实未完成');
  const before = panel.element('settings').innerHTML;
  host.close(panel); await reading;
  const calls = host.calls.length; gate.release(); await host.flush();
  panel.dispatch('message', { source: panel.context.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { workspaces: [], context: {} } } } });
  assert.equal(panel.eval('pending.size'), 0); assert.equal(panel.intervals.size, 0);
  assert.equal(panel.element('settings').innerHTML, before);
  assert.equal(host.calls.length, calls); assert.equal(host.renders, 1); assert.equal(host.messages.length, 0);
});
