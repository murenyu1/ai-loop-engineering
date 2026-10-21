import { mainModule, VERSION } from '../../scripts/lib.mjs';
import { createSettingsManager } from './native-settings.mjs';

export const PROTOCOL_VERSION = '2025-11-25';
export const SERVER_NAME = 'ai-loop-engineering-settings';
export const SERVER_VERSION = VERSION;
export const READ_TOOL = 'ai_loop.settings.read';
export const UPDATE_TOOL = 'ai_loop.settings.update';
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
  { name: 'ai_loop.settings.apply', title: '应用模型配置', description: '校验当前模型支持后应用模型和并发配置。', inputSchema: actionSchema },
  { name: 'ai_loop.settings.discard', title: '放弃未应用草稿', description: '放弃当前范围草稿，重新打开页面后读取最新配置。', inputSchema: actionSchema },
  { name: 'ai_loop.settings.reset_project', title: '恢复项目默认', description: '移除本工具登记的项目模型覆盖并继承全局配置。', inputSchema: actionSchema },
  { name: 'ai_loop.workspace.toggle', title: '应用工作区开关', description: '按当前开关值启用或停用所选工作区。完成后重新进入插件详情页刷新。', inputSchema: actionSchema },
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
      tools: {},
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
