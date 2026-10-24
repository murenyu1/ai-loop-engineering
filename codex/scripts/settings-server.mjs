import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityStatus } from '../../scripts/activity.mjs';
import { events, listRuns, status } from '../../scripts/loop.mjs';
import { mainModule, VERSION, validId } from '../../scripts/lib.mjs';
import { readCodexWorkspaces, resolveChatWorkspace } from './codex-workspaces.mjs';
import { themeCss } from '../../scripts/ui-theme.mjs';
import { createWorkflowGraph } from '../../scripts/workflow-graph.mjs';
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
export const dashboardHtml = () => fs.readFileSync(dashboardPath, 'utf8')
  .replace('/* LOOP_THEME */', themeCss() + ';')
  .replace('/* LOOP_GRAPH */', 'const createWorkflowGraph = ' + createWorkflowGraph.toString() + ';');
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
  { name: DASHBOARD_TOOL, title: 'AI Loop 工作流', description: '打开工作流配置与纵向子代理看板。提供真实 session 可定位聊天所属工作区；不要猜测聊天 ID。打开页面只读，统一保存才写入。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, session: { type: 'string' } }, additionalProperties: false }, outputSchema: { type: 'object', properties: { workspaces: { type: 'array' }, note: { type: 'string' } }, required: ['workspaces', 'note'] }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] } } },
  { name: 'ai_loop.panel.read', title: '读取工作流面板', description: '按面板实例读取配置和草稿。', inputSchema: { type: 'object', properties: { panel_id: { type: 'string' } }, required: ['panel_id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'ai_loop.panel.update', title: '更新面板草稿', description: '只暂存当前面板的工作区配置。', inputSchema: { type: 'object', properties: { panel_id: { type: 'string' }, set: { type: 'object' } }, required: ['panel_id', 'set'], additionalProperties: false } },
  { name: 'ai_loop.panel.action', title: '保存或放弃面板草稿', description: '明确保存、放弃草稿或恢复继承。', inputSchema: { type: 'object', properties: { panel_id: { type: 'string' }, action: { type: 'string', enum: ['apply', 'discard', 'reset_project'] } }, required: ['panel_id', 'action'], additionalProperties: false } },
  { name: 'ai_loop.dashboard.runs', title: '读取工作区运行列表', description: '读取工作区运行；提供 session 时仅列出该聊天的运行。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, session: { type: 'string' } }, required: ['root'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'ai_loop.dashboard.status', title: '读取运行代理状态', description: '读取最后一次子代理观察及任务证据，不代表实时状态。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, run: { type: 'string' }, session: { type: 'string' } }, required: ['root', 'run'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'ai_loop.dashboard.history', title: '读取当前聊天历次任务', description: '按真实父聊天 ID 筛选历次运行，未知归属的旧记录单独计数，不混入当前聊天。', inputSchema: { type: 'object', properties: { root: { type: 'string' }, session: { type: 'string' }, after: { type: 'string' } }, required: ['root', 'session'], additionalProperties: false }, annotations: { readOnlyHint: true } },
];
for (const name of ['ai_loop.dashboard.runs', 'ai_loop.dashboard.history']) {
  const tool = toolList.find(item => item.name === name);
  tool.inputSchema.properties.workspace_id = { type: 'string' };
  tool.inputSchema.required = name.endsWith('.history') ? ['session'] : [];
  tool.inputSchema.anyOf = [{ required: ['root'] }, { required: ['workspace_id'] }];
}

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
  const panels = new Map();
  const panelFor = (id, create) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('面板实例标识无效');
    if (!panels.has(id)) {
      if (!create) throw new Error('面板实例已回收，请刷新工作区后重试');
      if (panels.size >= 64) {
        const clean = [...panels].find(([, panel]) => panel.hasDrafts?.() === false);
        if (!clean) throw new Error('面板草稿已达上限，请先保存或放弃已有面板的草稿');
        panels.delete(clean[0]);
      }
      panels.set(id, options.managerFactory ? options.managerFactory() : createSettingsManager({ ...options.managerOptions, home: home() }));
    }
    return panels.get(id);
  };
  const discoveredRoot = value => {
    if (typeof value !== 'string') throw new Error('须选择当前存在的 Codex 工作区');
    const normalize = root => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
    const found = readCodexWorkspaces(home()).workspaces.find(item => (item.roots || [item.root]).some(root => normalize(root) === normalize(value)));
    if (!found) throw new Error('只能读取 Codex 已发现且当前存在的精确工作区');
    return (found.roots || [found.root]).find(root => normalize(root) === normalize(value));
  };
  const sessionRuns = (root, session) => {
    if (typeof session !== 'string' || !session.trim() || session.length > 1000) throw new Error('须提供真实聊天标识');
    const rounds = []; let after;
    do { const page = chatHistory(root, { session_id: session, harness: 'codex', limit: 100, after }); rounds.push(...page.rounds); after = page.next_after; } while (after);
    return rounds;
  };
  const workspaceFor = id => {
    const found = readCodexWorkspaces(home()).workspaces.find(item => item.id === id);
    if (!found) throw new Error('工作区已删除或不可用，请刷新列表');
    return found;
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
      if (message.method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [{ uri: DASHBOARD_URI, name: 'AI Loop 工作流', title: 'AI Loop 工作流', description: '统一工作区配置与纵向代理看板。', mimeType: 'text/html;profile=mcp-app' }] } };
      if (message.method === 'resources/read') {
        if (params.uri !== DASHBOARD_URI) throw new Error('未知看板资源');
        return { jsonrpc: '2.0', id, result: { contents: [{ uri: DASHBOARD_URI, mimeType: 'text/html;profile=mcp-app', text: dashboardHtml(), _meta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } }] } };
      }
      if (message.method === 'tools/call') {
        const name = params.name;
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
        if (['ai_loop.panel.read', 'ai_loop.panel.update', 'ai_loop.panel.action'].includes(name)) {
          const allowed = name.endsWith('.update') ? ['panel_id', 'set'] : name.endsWith('.action') ? ['panel_id', 'action'] : ['panel_id'];
          if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('面板参数无效');
          const created = !panels.has(args.panel_id);
          const canCreate = name.endsWith('.read') || name.endsWith('.update') && args.set && ['workspace_id', 'workspace_root'].some(key => Object.hasOwn(args.set, key));
          const panel = panelFor(args.panel_id, canCreate);
          let result;
          if (name.endsWith('.read')) result = await panel.read();
          else if (name.endsWith('.update')) result = await panel.update(args.set);
          else {
            if (!['apply', 'discard', 'reset_project'].includes(args.action)) throw new Error('面板动作无效');
            const action = await panel.action('ai_loop.settings.' + args.action);
            result = { ...await panel.read(), action_result: action };
          }
          return { jsonrpc: '2.0', id, result: toolResult({ ...result, panel_created: created }) };
        }
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
          if (args.session !== undefined && (typeof args.session !== 'string' || !args.session.trim() || args.session.length > 1000)) throw new Error('聊天定位需要真实 session');
          const discovery = readCodexWorkspaces(home());
          const workspaces = discovery.workspaces;
          const mapped = args.session ? resolveChatWorkspace(home(), args.session) : null;
          const explicitRoot = args.root ? discoveredRoot(args.root) : null;
          if (mapped && explicitRoot && !mapped.roots.includes(explicitRoot)) throw new Error('聊天归属与所选工作区不一致');
          const workspace = mapped || (explicitRoot ? workspaces.find(item => (item.roots || [item.root]).includes(explicitRoot)) : null);
          const root = mapped?.root || explicitRoot || null;
          const result = { workspaces, context: { root, workspace_id: workspace?.id || null, session_id: args.session || null, source: mapped ? 'thread-project-assignment' : explicitRoot ? 'explicit' : 'unavailable' }, discovery_error: discovery.error, note: '选择工作区不会启用工作流；红绿状态以保存结果为准。没有可靠聊天上下文时请手选工作区。代理状态为最后观察。' };
          return { jsonrpc: '2.0', id, result: { ...toolResult(result), _meta: { ui: { resourceUri: DASHBOARD_URI } } } };
        }
        if (['ai_loop.dashboard.runs', 'ai_loop.dashboard.history'].includes(name) && args.workspace_id !== undefined) {
          const history = name.endsWith('.history');
          if (Object.keys(args).some(key => !['workspace_id', 'session', ...(history ? ['after'] : [])].includes(key))) throw new Error('工作区查询参数无效');
          const workspace = workspaceFor(args.workspace_id);
          const roots = workspace.roots || [workspace.root];
          if (history && !args.session) throw new Error('聊天历史需要真实 session');
          if (args.session !== undefined && (typeof args.session !== 'string' || !args.session.trim() || args.session.length > 1000)) throw new Error('聊天标识无效');
          const mapped = args.session ? resolveChatWorkspace(home(), args.session) : null;
          if (mapped && mapped.id !== workspace.id) throw new Error('聊天不属于此工作区');
          if (!history) {
            const runs = roots.flatMap(root => (args.session === undefined ? listRuns(root) : sessionRuns(root, args.session).map(round => round.run)).map(run => ({ ...run, record_root: root })));
            runs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || a.record_root.localeCompare(b.record_root) || a.run_id.localeCompare(b.run_id));
            return { jsonrpc: '2.0', id, result: toolResult({ workspace_id: workspace.id, runs }) };
          }
          const rounds = []; let unbound_count = 0, unbound_activity_count = 0;
          for (const root of roots) {
            let after;
            do {
              const page = chatHistory(root, { session_id: args.session, harness: 'codex', limit: 100, after });
              rounds.push(...page.rounds.map(round => ({ ...round, root })));
              if (!after) { unbound_count += page.unbound_count; unbound_activity_count += page.unbound_activity_count; }
              after = page.next_after;
            } while (after);
          }
          const key = round => JSON.stringify([round.run.created_at || '', round.root, round.run.run_id]);
          rounds.sort((a, b) => key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0);
          let start = 0;
          if (args.after !== undefined) {
            let cursor;
            try { cursor = JSON.parse(Buffer.from(args.after, 'base64url').toString('utf8')); } catch { throw new Error('历史游标无效'); }
            if (cursor.workspace !== workspace.id || cursor.session !== args.session || typeof cursor.key !== 'string') throw new Error('历史游标不属于此工作区聊天');
            // 按稳定键向后翻页，原游标记录删除也不重复前页。
            start = rounds.findIndex(round => key(round) < cursor.key);
            if (start < 0) start = rounds.length;
          }
          const page = rounds.slice(start, start + 20);
          const next_after = start + page.length < rounds.length ? Buffer.from(JSON.stringify({ workspace: workspace.id, session: args.session, key: key(page.at(-1)) })).toString('base64url') : null;
          return { jsonrpc: '2.0', id, result: toolResult({ workspace_id: workspace.id, rounds: page, unbound_count, unbound_activity_count, next_after }) };
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
