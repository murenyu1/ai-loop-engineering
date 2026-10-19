import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createConsole } from '../plugins/codex/scripts/console.mjs';
import { balanced } from '../scripts/routing.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-console-'));

test('关闭服务接口同样要求授权，合法关闭后释放监听端口', async t => {
  const {panel,request} = await setup(t);
  const response = await request('/api/shutdown',{method:'POST',body:'{}'});
  assert.equal(response.status,200);
  await new Promise(resolve=>panel.server.listening ? panel.server.once('close',resolve) : resolve());
  assert.equal(panel.server.listening,false);
});

async function setup(t) {
  const home = temp(), root = path.join(temp(), 'project');
  fs.mkdirSync(root, { recursive: true });
  const panel = await createConsole({ home, modelsProvider: async () => ({ models: [
    { model: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: 'medium' },
    { id: 'gpt-6-luna', efforts: ['medium', 'high'] },
  ] }) });
  t.after(async () => { await panel.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(path.dirname(root), { recursive: true, force: true }); });
  const token = new URL(panel.url).hash.slice(1);
  const request = (route, options = {}) => fetch(panel.origin + route, { ...options, headers: { ...(options.headers || {}), Origin: panel.origin, Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  return { home, root, panel, request };
}

test('API enforces bearer and same origin; refuses unregistered roots', async t => {
  const { root, panel, request } = await setup(t);
  const noAuth = await fetch(panel.origin + '/api/workspaces', { headers: { Origin: panel.origin } });
  assert.equal(noAuth.status, 401);
  const wrongOrigin = await fetch(panel.origin + '/api/workspaces', { headers: { Origin: 'http://localhost' , Authorization: `Bearer ${new URL(panel.url).hash.slice(1)}` } });
  assert.equal(wrongOrigin.status, 403);
  const token = new URL(panel.url).hash.slice(1);
  const browserGet = await fetch(panel.origin + '/api/workspaces', { headers: { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(browserGet.status, 200, '浏览器同源 GET 不带 Origin 时应由 Sec-Fetch-Site 识别');
  const missingOrigin = await fetch(panel.origin + '/api/workspaces', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(missingOrigin.status, 403);
  const badRoot = await request(`/api/state?root=${encodeURIComponent(root)}`);
  assert.equal(badRoot.status, 400);
  assert.match((await badRoot.json()).error, /已登记/);
});

test('registers exact workspaces and toggles workflow state', async t => {
  const { root, request } = await setup(t);
  let response = await request('/api/workspaces/register', { method: 'POST', body: JSON.stringify({ root }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).workspace, { root: fs.realpathSync(root), enabled: true });
  response = await request('/api/workspaces/enabled', { method: 'POST', body: JSON.stringify({ root, enabled: false }) });
  assert.equal((await response.json()).workspace.enabled, false);
  const list = await request('/api/workspaces');
  assert.equal((await list.json()).workspaces[0].enabled, false);
});

test('saves role models and restores project inheritance', async t => {
  const { root, request } = await setup(t);
  await request('/api/workspaces/register', { method: 'POST', body: JSON.stringify({ root }) });
  const base = balanced('codex');
  const unavailable = structuredClone(base);
  unavailable.roles.dev.model = 'unavailable-model';
  let response = await request('/api/profile', { method: 'POST', body: JSON.stringify({ root, scope: 'global', profile: unavailable }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不在原生服务/);
  const unsupportedEffort = structuredClone(base);
  unsupportedEffort.main.effort = 'xhigh';
  response = await request('/api/profile', { method: 'POST', body: JSON.stringify({ root, scope: 'global', profile: unsupportedEffort }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /思考强度/);
  response = await request('/api/profile', { method: 'POST', body: JSON.stringify({ root, scope: 'global', profile: base }) });
  assert.equal(response.status, 200, (await response.clone().json()).error);
  const project = structuredClone(base);
  project.roles.dev.model = 'gpt-6.1-sol';
  await request('/api/profile', { method: 'POST', body: JSON.stringify({ root, scope: 'project', profile: project }) });
  response = await request('/api/profile/reset', { method: 'POST', body: JSON.stringify({ root }) });
  assert.equal(response.status, 200);
  const state = await (await request(`/api/state?root=${encodeURIComponent(root)}`)).json();
  assert.equal(state.project.profile, null);
  assert.equal(state.effective.scope, 'global');
});

test('serves only the fixed panel files and reads models from injected provider', async t => {
  const { root, panel, request } = await setup(t);
  await request('/api/workspaces/register', { method: 'POST', body: JSON.stringify({ root }) });
  assert.equal((await fetch(panel.origin + '/')).status, 200);
  assert.equal((await fetch(panel.origin + '/app.js')).status, 200);
  assert.equal((await fetch(panel.origin + '/%2e%2e/scripts/lib.mjs')).status, 404);
  const models = await request(`/api/models?root=${encodeURIComponent(root)}`);
  const listed = await models.json();
  assert.equal(listed.models[0].id, 'gpt-6.1-sol');
  assert.deepEqual(listed.models[0].efforts, ['low', 'medium', 'high']);
  assert.equal(listed.models[0].default_effort, 'medium');
});

test('reports a paginated native model list as incomplete', async t => {
  const home = temp(), root = path.join(temp(), 'project');
  fs.mkdirSync(root, { recursive: true });
  const panel = await createConsole({ home, modelsProvider: async () => ({ models: [{ id: 'model-a', efforts: ['low'] }], models_next_cursor: 'cursor-2' }) });
  t.after(async () => { await panel.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(path.dirname(root), { recursive: true, force: true }); });
  const token = new URL(panel.url).hash.slice(1);
  const request = (route, options = {}) => fetch(panel.origin + route, { ...options, headers: { Origin: panel.origin, Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  await request('/api/workspaces/register', { method: 'POST', body: JSON.stringify({ root }) });
  const result = await (await request(`/api/models?root=${encodeURIComponent(root)}`)).json();
  assert.equal(result.complete, false);
  assert.equal(result.next_cursor, 'cursor-2');
});

test('CLI starts a live server with a usable fragment URL and stops cleanly', async t => {
  const home = temp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cliFile = fileURLToPath(new URL('../plugins/codex/scripts/console.mjs', import.meta.url));
  const child = spawn(process.execPath, [cliFile, '--no-open'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  const output = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CLI 未在时限内输出管理面板 URL')), 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`CLI 提前退出：${code}`)); } });
    lines.once('line', line => { clearTimeout(timeout); resolve(line); });
  });
  assert.match(output, /^AI Loop 管理面板：http:\/\/127\.0\.0\.1:\d+\/#/);
  const url = output.slice(output.indexOf('http'));
  const token = new URL(url).hash.slice(1);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const api = await fetch(new URL('/api/workspaces', url), { headers: { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(api.status, 200);
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
});
