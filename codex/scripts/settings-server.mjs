import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityStatus } from '../../scripts/activity.mjs';
import { events, listRuns, status } from '../../scripts/loop.mjs';
import { mainModule, VERSION, validId } from '../../scripts/lib.mjs';
import { listWorkspaces, registeredRoot } from '../../scripts/workspaces.mjs';
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
  { name: DASHBOARD_TOOL, title: 'AI Loop 代理看板', description: '打开当前会话的只读子代理观察看板；只显示已登记工作区和本地记录，不调用模型。', inputSchema: actionSchema, outputSchema: { type: 'object', properties: { workspaces: { type: 'array' }, note: { type: 'string' } }, required: ['workspaces', 'note'] }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } } },
  { name: 'ai_loop.dashboard.runs', title: '读取工作区运行列表', description: '读取已登记工作区的本地 AI Loop 运行记录。', inputSchema: { type: 'object', properties: { root: { type: 'string' } }, required: ['root'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'ai_loop.dashboard.status', title: '读取运行代理状态', description: '读取最后一次子代理观察及任务证据，不代表实时状态。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, run: { type: 'string' } }, required: ['root', 'run'], additionalProperties: false }, annotations: { readOnlyHint: true } },
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

export function createSettingsProtocol(manager = createSettingsManager()) {
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
          if (Object.keys(args).length) throw new Error(`${DASHBOARD_TOOL} 不接受参数`);
          const workspaces = listWorkspaces(userHome()).filter(item => item.exists).map(item => ({ root: item.root, enabled: item.enabled }));
          const result = { workspaces, note: '每个线程单独显示；请选择已登记工作区后读取运行。观察数据仅来自最后一次本地记录，不代表实时运行，也不调用模型。' };
          return { jsonrpc: '2.0', id, result: { ...toolResult(result), _meta: { ui: { resourceUri: DASHBOARD_URI } } } };
        }
        if (name === 'ai_loop.dashboard.runs') {
          if (typeof args.root !== 'string' || Object.keys(args).some(key => key !== 'root')) throw new Error('runs 需要且只接受 root');
          const root = registeredRoot(userHome(), args.root);
          return { jsonrpc: '2.0', id, result: toolResult({ root, runs: listRuns(root) }) };
        }
        if (name === 'ai_loop.dashboard.status') {
          if (typeof args.root !== 'string' || typeof args.run !== 'string' || Object.keys(args).some(key => !['root', 'run'].includes(key))) throw new Error('status 需要 root 和 run');
          const root = registeredRoot(userHome(), args.root), run = validId(args.run);
          const current = status(root, run);
          const profile = resolveProfile(root, { home: userHome() }).profile || disabledProfile('codex');
          const roles = Object.fromEntries(Object.entries(profile.roles).map(([role, value]) => [role, { enabled: roleEnabled(value), model: value.model }]));
          return { jsonrpc: '2.0', id, result: toolResult({ root, run: current, roles, activity: activityStatus(root, run), events: events(root, run, Math.max(0, current.event_seq - 100), 100).events }) };
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
