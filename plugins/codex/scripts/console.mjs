import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { listWorkspaces, registerWorkspace, setWorkspaceEnabled, registeredRoot } from '../../../scripts/workspaces.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, '..');
const pluginConsole = fs.existsSync(path.join(bundle, 'console', 'index.html'))
  ? path.join(bundle, 'console')
  : fs.existsSync(path.join(bundle, 'plugins', 'codex', 'console', 'index.html'))
    ? path.join(bundle, 'plugins', 'codex', 'console')
    : path.resolve(bundle, '..', 'plugins', 'codex', 'console');
const MIME = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
const homeDefault = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };

async function dependencies() {
  const bundleScripts = path.basename(path.dirname(here)) === 'codex';
  const repo = bundleScripts ? path.resolve(here, '../../../') : path.resolve(here, '..');
  const moduleFile = (local, fallback) => pathToFileURL(fs.existsSync(path.join(here, local)) ? path.join(here, local) : path.join(repo, fallback)).href;
  return Promise.all([
    import(moduleFile('profiles.mjs', 'plugins/codex/scripts/profiles.mjs')),
    import(moduleFile('doctor.mjs', 'adapters/project/scripts/doctor.mjs')),
    import(moduleFile('lib.mjs', 'core/scripts/lib.mjs')),
    import(moduleFile('windows.mjs', 'plugins/codex/scripts/windows.mjs')),
  ]);
}

export async function createConsole(options = {}) {
  const home = path.resolve(options.home || homeDefault());
  const [profiles, doctor, lib, windows] = await dependencies();
  const profileBundle = lib.BUNDLE;
  const token = crypto.randomBytes(32).toString('base64url');
  const files = new Map(Object.keys(MIME).map(name => [name, path.join(pluginConsole, name)]));
  const modelsProvider = options.modelsProvider || ((root) => doctor.inspectNative(root, 'codex'));
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!origin || host !== new URL(origin).host) return json(res, 403, { error: 'Host 不匹配' });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const requestOrigin = req.headers.origin;
        const sameOriginFetch = req.method === 'GET' && req.headers['sec-fetch-site'] === 'same-origin';
        if (requestOrigin ? requestOrigin !== origin : !sameOriginFetch) return json(res, 403, { error: 'Origin 不匹配' });
        if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: '未授权' });
        if (req.method === 'GET' && url.pathname === '/api/workspaces') return json(res, 200, { workspaces: listWorkspaces(home) });
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (url.pathname === '/api/shutdown') {
            json(res, 200, { message: '管理服务已关闭，可关闭本页；下次通过快捷入口重新打开。' });
            setImmediate(() => { server.close(); server.closeIdleConnections?.(); });
            return;
          }
          if (url.pathname === '/api/workspaces/register' || url.pathname === '/api/workspaces/enabled') {
            assertOwners(body.root, windows, home);
            if (url.pathname === '/api/workspaces/register') return json(res, 200, { workspace: registerWorkspace(home, body.root) });
            return json(res, 200, { workspace: setWorkspaceEnabled(home, body.root, body.enabled) });
          }
          const root = registeredRoot(home, body.root);
          if (url.pathname === '/api/profile') {
            const scope = body.scope;
            if (!['global', 'project'].includes(scope)) throw new Error('scope 须为 global / project');
            const available = await modelsProvider(root);
            validateModels(body.profile, available);
            const result = profiles.configureProfile(root, body.profile, { home, scope, apply: true, bundle: profileBundle });
            return json(res, 200, { result, message: '配置已保存；将在原生配置下一次重载后用于后续派发，当前主会话不变。' });
          }
          if (url.pathname === '/api/profile/reset') {
            const result = profiles.resetProjectProfile(root, { home, apply: true });
            return json(res, 200, { result, message: '项目覆盖已恢复为继承全局默认；将在原生配置下一次重载后用于后续派发。' });
          }
          return json(res, 404, { error: 'API 不存在' });
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const root = registeredRoot(home, url.searchParams.get('root'));
          return json(res, 200, {
            root,
            global: profiles.resolveProfile(root, { home, scope: 'global' }),
            project: profiles.resolveProfile(root, { home, scope: 'project' }),
            effective: profiles.resolveProfile(root, { home }),
            workspaces: listWorkspaces(home),
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/models') {
          const root = registeredRoot(home, url.searchParams.get('root'));
          const native = await modelsProvider(root);
          if (native?.models_error) return json(res, 200, { models: null, complete: false, next_cursor: native.models_next_cursor || null, error: String(native.models_error), source: 'native model/list' });
          const models = Array.isArray(native?.models) ? normalizeNativeModels(native.models) : null;
          return json(res, 200, { models, complete: !!models && !native.models_next_cursor, next_cursor: native.models_next_cursor || null, error: models ? null : '原生模型列表不可用', source: 'native model/list' });
        }
        return json(res, 404, { error: 'API 不存在' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '仅允许读取面板文件' });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!files.has(name)) return json(res, 404, { error: '文件不存在' });
      const content = fs.readFileSync(files.get(name));
      res.writeHead(200, { 'content-type': MIME[name], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(content);
    } catch (error) { json(res, 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const initialProject = options.project ? `?project=${encodeURIComponent(options.project)}` : '';
  const url = `${origin}/${initialProject}#${token}`;
  return { server, url, origin, token, address, close: () => !server.listening ? Promise.resolve() : new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); }) };
}

function assertOwners(root, windows, home) {
  const info = windows.inspectWindows(root, { home });
  if (!['ready', 'not-windows'].includes(info.status)) throw new Error('Windows 所有者预检未通过，停止工作区操作');
}

function validateModels(profile, native) {
  if (native?.models_error || !Array.isArray(native?.models)) throw new Error('无法读取原生模型清单，停止保存模型配置');
  const models = new Map(normalizeNativeModels(native.models).map(model => [model.id, model]));
  const entries = [['main', profile?.main], ...Object.entries(profile?.roles || {})];
  for (const [role, entry] of entries) {
    const model = models.get(entry?.model);
    if (!model) throw new Error(`${role} 模型不在原生服务当前返回的可用清单中`);
    const efforts = Array.isArray(model.efforts) ? model.efforts : [];
    if (entry.effort === null && role !== 'main') continue;
    if (efforts.includes(entry.effort)) continue;
    if (role === 'main' && model.default_effort === entry.effort) continue;
    throw new Error(`${role} 思考强度不在该模型的原生支持清单中`);
  }
}

function normalizeNativeModels(items) {
  return items.map(item => {
    const values = item.efforts ?? item.supportedReasoningEfforts ?? item.supported_reasoning_efforts ?? [];
    const efforts = values.map(value => typeof value === 'string' ? value : value?.reasoningEffort ?? value?.reasoning_effort).filter(value => typeof value === 'string');
    return {
      id: item.id || item.model,
      name: item.name || item.displayName || item.display_name || '',
      efforts: [...new Set(efforts)],
      default_effort: item.default_effort || item.defaultReasoningEffort || item.default_reasoning_effort || null,
    };
  }).filter(item => typeof item.id === 'string' && item.id);
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('JSON 请求体不得超过 64 KiB'); chunks.push(chunk); }
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new Error('请求必须使用 application/json');
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象');
  return body;
}

function parseArgs(argv) {
  let project = null, noOpen = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) project = argv[++i];
    else if (argv[i] === '--no-open') noOpen = true;
    else throw new Error('用法：console.mjs [--project ROOT] [--no-open]');
  }
  return { project, noOpen };
}

export async function cli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), home = homeDefault();
  const [, , , windows] = await dependencies();
  const root = args.project ? fs.realpathSync(path.resolve(args.project)) : os.homedir();
  if (!fs.statSync(root).isDirectory()) throw new Error('预检目录必须是现存目录');
  assertOwners(root, windows, home);
  const panel = await createConsole({ home, ...(args.project ? { project: root } : {}) });
  if (!args.noOpen) {
    const command = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -FilePath $env:AI_LOOP_CONSOLE_URL']] : process.platform === 'darwin' ? ['open', [panel.url]] : ['xdg-open', [panel.url]];
    const child = spawn(command[0], command[1], { windowsHide: true, detached: true, stdio: 'ignore', ...(process.platform === 'win32' ? { env: { ...process.env, AI_LOOP_CONSOLE_URL: panel.url } } : {}) });
    child.on('error', error => console.error(`无法自动打开浏览器：${error.message}。请复制上方管理面板 URL 手动打开。`));
    child.unref();
  }
  console.log(`AI Loop 管理面板：${panel.url}`);
  return { status: 'running', origin: panel.origin, project: args.project ? root : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error('操作停止：' + error.message); process.exitCode = 1; });
}
