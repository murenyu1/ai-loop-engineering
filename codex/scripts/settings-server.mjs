import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityStatus } from '../../scripts/activity.mjs';
import { events, listRuns, status } from '../../scripts/loop.mjs';
import { mainModule, VERSION, validId } from '../../scripts/lib.mjs';
import { readCodexWorkspaces } from './codex-workspaces.mjs';
import { chatHistory } from '../../scripts/dashboard.mjs';
import { userHome, resolveProfile } from './profiles.mjs';
import { disabledProfile, roleEnabled } from '../../scripts/routing.mjs';
import { createSettingsManager } from './native-settings.mjs';

export const PROTOCOL_VERSION = '2025-11-25';
export const SERVER_NAME = 'ai-loop-engineering-settings';
export const SERVER_VERSION = VERSION;
export const READ_TOOL = 'ai_loop.settings.read';
export const UPDATE_TOOL = 'ai_loop.settings.update';
export const DASHBOARD_TOOL = 'ai_loop.dashboard';
export const DASHBOARD_URI = 'ui://ai-loop-engineering/agent-dashboard';
const dashboardPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui/agent-dashboard.html');
const MAX_LINE_BYTES = 1024 * 1024;

const readOutputSchema = {
  type: 'object',
  properties: {
    schema: { type: 'object' },
    values: { type: 'object' },
    layout: { type: 'array', items: { type: 'object' } },
  },
  required: ['schema', 'values'],
};
const updateOutputSchema = { type: 'object', properties: readOutputSchema.properties, required: ['values'] };
const objectSchema = { type: 'object', additionalProperties: false };
const actionSchema = { type: 'object', properties: {}, additionalProperties: false };

const toolList = [
  { name: READ_TOOL, title: '读取 AI Loop 设置', description: '读取插件原生设置页所需的字段和当前值。', inputSchema: objectSchema, outputSchema: readOutputSchema, annotations: { readOnlyHint: true } },
  { name: UPDATE_TOOL, title: '更新 AI Loop 设置草稿', description: '仅暂存发生变化的字段；点击应用按钮后才写入配置。', inputSchema: { type: 'object', properties: { set: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, minProperties: 1 } }, required: ['set'], additionalProperties: false, }, outputSchema: updateOutputSchema },
  { name: 'ai_loop.settings.apply', title: '应用设置', description: '统一保存工作区开关、已开启角色模型和并发设置；失败时回滚工作区开关。', inputSchema: actionSchema },
  { name: 'ai_loop.settings.discard', title: '放弃未应用草稿', description: '放弃当前范围草稿，重新打开页面后读取最新配置。', inputSchema: actionSchema },
  { name: 'ai_loop.settings.reset_project', title: '恢复项目默认', description: '移除本工具登记的项目模型覆盖并继承全局配置。', inputSchema: actionSchema },
  { name: DASHBOARD_TOOL, title: 'AI Loop 代理看板', description: '打开只读代理树和聊天历史。若当前宿主提供真实工作区与聊天 ID，可传 root/session 自动定位；不要猜测聊天 ID。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, session: { type: 'string' } }, additionalProperties: false }, outputSchema: { type: 'object', properties: { workspaces: { type: 'array' }, note: { type: 'string' } }, required: ['workspaces', 'note'] }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } } },
  { name: 'ai_loop.dashboard.runs', title: '读取工作区运行列表', description: '读取工作区运行；提供 session 时仅列出该聊天的运行。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, session: { type: 'string' } }, required: ['root'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'ai_loop.dashboard.status', title: '读取运行代理状态', description: '读取最后一次子代理观察及任务证据，不代表实时状态。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, run: { type: 'string' }, session: { type: 'string' } }, required: ['root', 'run'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'ai_loop.dashboard.history', title: '读取当前聊天历次任务', description: '按真实父聊天 ID 筛选历次运行，未知归属的旧记录单独计数，不混入当前聊天。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, session: { type: 'string' }, after: { type: 'string' } }, required: ['root', 'session'], additionalProperties: false }, annotations: { readOnlyHint: true } },
];

function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function toolResult(structuredContent, text = '') {
  return { content: text ? [{ type: 'text', text }] : [], structuredContent };
}
function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: {
      tools: {}, resources: {},
      experimental: { 'openai/settings': { readTool: READ_TOOL, updateTool: UPDATE_TOOL } },
    },
  };
}

export function createSettingsProtocol(manager = createSettingsManager(), options = {}) {
  const home = () => options.home || userHome();
  const discoveredRoot = value => {
    if (typeof value !== 'string') throw new Error('须选择当前存在的 Codex 工作区');
    const normalize = root => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
    const found = readCodexWorkspaces(home()).workspaces.find(item => normalize(item.root) === normalize(value));
    if (!found) throw new Error('只能读取 Codex 已发现且当前存在的精确工作区');
    return found.root;
  };
  const sessionRuns = (root, session) => {
    if (typeof session !== 'string' || !session.trim() || session.length > 1000) throw new Error('须提供真实聊天标识');
    const rounds = []; let after;
    do { const page = chatHistory(root, { session_id: session, harness: 'codex', limit: 100, after }); rounds.push(...page.rounds); after = page.next_after; } while (after);
    return rounds;
  };
  let initialized = false;
  async function request(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id ?? null, -32600, '无效 JSON-RPC 请求');
    }
    const id = Object.hasOwn(message, 'id') ? message.id : undefined;
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    try {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id, result: initializeResult() };
      if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') { initialized = true; return null; }
      if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (message.method === 'server/discover') return { jsonrpc: '2.0', id, result: {
        resultType: 'complete', supportedVersions: [PROTOCOL_VERSION],
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        capabilities: { tools: {}, extensions: { 'openai/settings': { readTool: READ_TOOL, updateTool: UPDATE_TOOL } } },
      } };
      if (message.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolList } };
      if (message.method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [{ uri: DASHBOARD_URI, name: 'AI Loop 代理看板', title: 'AI Loop 代理看板', description: '当前会话的只读代理观察与任务状态看板。', mimeType: 'text/html;profile=mcp-app' }] } };
      if (message.method === 'resources/read') {
        if (params.uri !== DASHBOARD_URI) throw new Error('未知看板资源');
        return { jsonrpc: '2.0', id, result: { contents: [{ uri: DASHBOARD_URI, mimeType: 'text/html;profile=mcp-app', text: fs.readFileSync(dashboardPath, 'utf8'), _meta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } }] } };
      }
      if (message.method === 'tools/call') {
        const name = params.name;
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
        if (name === READ_TOOL) {
          if (Object.keys(args).length) throw new Error('settings.read 不接受参数');
          const result = await manager.read();
          return { jsonrpc: '2.0', id, result: toolResult(result) };
        }
        if (name === UPDATE_TOOL) {
          if (!args.set || typeof args.set !== 'object' || Array.isArray(args.set) || Object.keys(args).some(key => key !== 'set')) throw new Error('settings.update 需要且只接受 set 对象');
          const result = await manager.update(args.set);
          return { jsonrpc: '2.0', id, result: toolResult(result) };
        }
        if (name === DASHBOARD_TOOL) {
          if (Object.keys(args).some(key => !['root', 'session'].includes(key))) throw new Error('看板仅接受 root/session');
          if (args.session !== undefined && (typeof args.session !== 'string' || !args.session.trim() || args.session.length > 1000 || !args.root)) throw new Error('聊天定位需要真实 session 和 root');
          const discovery = readCodexWorkspaces(home());
          const workspaces = discovery.workspaces;
          const providedRoot = args.root || options.project || process.env.AI_LOOP_PROJECT;
          const root = providedRoot ? discoveredRoot(providedRoot) : null;
          const result = { workspaces, context: { root, session_id: args.session || null, source: args.root ? 'explicit' : root ? 'plugin-environment' : 'unavailable' }, discovery_error: discovery.error, note: '自动读取 Codex 工作区；选择不会启用工作流。宿主没有提供真实聊天标识时仅展示工作区运行，不能推断当前聊天。观察不代表实时状态。' };
          return { jsonrpc: '2.0', id, result: { ...toolResult(result), _meta: { ui: { resourceUri: DASHBOARD_URI } } } };
        }
        if (name === 'ai_loop.dashboard.runs') {
          if (typeof args.root !== 'string' || Object.keys(args).some(key => !['root', 'session'].includes(key))) throw new Error('runs 需要 root 和可选 session');
          const root = discoveredRoot(args.root);
          return { jsonrpc: '2.0', id, result: toolResult({ root, runs: args.session === undefined ? listRuns(root) : sessionRuns(root, args.session).map(item => item.run) }) };
        }
        if (name === 'ai_loop.dashboard.status') {
          if (typeof args.root !== 'string' || typeof args.run !== 'string' || Object.keys(args).some(key => !['root', 'run', 'session'].includes(key))) throw new Error('status 需要 root 和 run');
          const root = discoveredRoot(args.root), run = validId(args.run);
          const bound = args.session === undefined ? null : sessionRuns(root, args.session).find(item => item.run.run_id === run);
          if (args.session !== undefined && !bound) throw new Error('此运行不属于当前聊天');
          const current = status(root, run);
          const profile = resolveProfile(root, { home: home() }).profile || disabledProfile('codex');
          const roles = Object.fromEntries(Object.entries(profile.roles).map(([role, value]) => [role, { enabled: roleEnabled(value), model: value.model }]));
          return { jsonrpc: '2.0', id, result: toolResult({ root, run: current, roles, activity: bound?.activity ?? activityStatus(root, run), events: events(root, run, Math.max(0, current.event_seq - 100), 100).events }) };
        }
        if (name === 'ai_loop.dashboard.history') {
          if (typeof args.session !== 'string' || !args.session.trim() || args.session.length > 1000 || Object.keys(args).some(key => !['root', 'session', 'after'].includes(key))) throw new Error('history 需要真实 root/session 与可选 after');
          const root = discoveredRoot(args.root);
          return { jsonrpc: '2.0', id, result: toolResult({ root, ...chatHistory(root, { session_id: args.session, harness: 'codex', after: args.after, limit: 20 }) }) };
        }
        if (typeof name === 'string' && ['ai_loop.settings.apply', 'ai_loop.settings.discard', 'ai_loop.settings.reset_project', 'ai_loop.workspace.toggle'].includes(name)) {
          if (Object.keys(args).length) throw new Error(`${name} 不接受参数`);
          const result = await manager.action(name);
          const text = result?.message || (result?.status ? `已完成：${result.status}` : result?.root ? `工作区：${result.root}` : '操作已完成');
          return { jsonrpc: '2.0', id, result: toolResult({ result }, text) };
        }
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具：${String(name)}` }], isError: true } };
      }
      if (id === undefined) return null;
      return rpcError(id, -32601, `不支持的方法：${message.method}`);
    } catch (error) {
      if (message.method === 'tools/call') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error.message || error) }], isError: true } };
      return rpcError(id ?? null, -32603, String(error.message || error));
    }
  }
  return { request, get initialized() { return initialized; } };
}

export async function runSettingsServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const protocol = options.protocol || createSettingsProtocol(options.manager || createSettingsManager(options.managerOptions));
  let queue = Promise.resolve();
  let pending = Buffer.alloc(0), dropping = false;
  const send = value => { if (value) output.write(`${JSON.stringify(value)}\n`); };
  const enqueueLine = line => {
    queue = queue.then(async () => {
      let message;
      try { message = JSON.parse(line); }
      catch { send(rpcError(null, -32700, '无效 JSON')); return; }
      send(await protocol.request(message));
    }).catch(error => { send(rpcError(null, -32603, String(error.message || error))); });
  };
  const oversized = () => send(rpcError(null, -32700, 'JSON-RPC 输入超过 1 MiB'));
  input.on('data', chunk => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      const segment = data.subarray(start, end);
      if (dropping) {
        if (newline < 0) return;
        dropping = false; pending = Buffer.alloc(0); start = newline + 1; continue;
      }
      if (pending.length + segment.length > MAX_LINE_BYTES) {
        oversized(); pending = Buffer.alloc(0); dropping = newline < 0;
      } else {
        pending = Buffer.concat([pending, segment]);
        if (newline >= 0) {
          enqueueLine(pending.toString('utf8').replace(/\r$/, ''));
          pending = Buffer.alloc(0);
        }
      }
      if (newline < 0) break;
      start = newline + 1;
    }
  });
  input.on('error', error => { queue = queue.then(() => { throw error; }); });
  await new Promise((resolve, reject) => { input.once('end', resolve); input.once('error', reject); });
  if (pending.length && !dropping) enqueueLine(pending.toString('utf8').replace(/\r$/, ''));
  await queue;
}

if (mainModule(import.meta.url)) {
  runSettingsServer().catch(error => { process.stderr.write(`AI Loop settings MCP: ${error.message || error}\n`); process.exitCode = 1; });
}
