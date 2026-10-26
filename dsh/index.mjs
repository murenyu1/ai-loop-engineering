import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf, parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { createConfig, projectKey, projectSettings, roleOptions, validateConfig, ROLES, ROLE_LABELS } from './config.mjs';

export const name = 'ai-loop-engineering';
export const inject = ['skills', 'tools', 'systemPrompt', 'subagents', 'workingDirectory', 'llm', 'sessions'];
export const Config = createConfig(z);
const validDirection = value => value === undefined || value === null || typeof value === 'string' && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
const projectPathOf = value => {
  if (value === undefined || value === null || value === '') return '.';
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('project_path 必须是工作区内的相对路径。');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('project_path 不能越出工作区。');
  return normalized || '.';
};
const projectRootOf = (root, projectPath) => path.resolve(root, projectPath);
const projectOptions = project_path => ({ project_path });
const projectPathKey = value => process.platform === 'win32' ? String(value ?? '.').toLowerCase() : String(value ?? '.');
const sameProjectPath = (item, project_path) => projectPathKey(item?.project_path) === projectPathKey(project_path);
const sameRun = (left, right) => Boolean(left?.run_id && right?.run_id && left.run_id === right.run_id && sameProjectPath(left, right.project_path));
const runKey = run => `${projectPathKey(run?.project_path)}\0${run?.run_id ?? ''}`;
const nativeResultOf = value => {
  let json;
  try { json = JSON.stringify(value); }
  catch { json = JSON.stringify({ summary: String(value), serialization: 'fallback' }); }
  if (json === undefined) json = JSON.stringify({ value: String(value) });
  if (Buffer.byteLength(json, 'utf8') > 262144) return { truncated: true, limit_bytes: 262144, preview: json.slice(0, 262144) };
  try { return JSON.parse(json); } catch { return { summary: json }; }
};

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = fs.existsSync(path.join(pluginRoot, 'core')) ? path.join(pluginRoot, 'core') : path.resolve(pluginRoot, '../core');
const corePath = coreRoot.replaceAll('\\', '/');
const resource = relative => fs.readFileSync(path.join(pluginRoot, relative), 'utf8').replaceAll('{{CORE}}', corePath);
const roleText = Object.fromEntries(ROLES.map(role => [role, fs.readFileSync(path.join(coreRoot, 'agents', `loop-${role}.md`), 'utf8')]));

// Host fs only reads fixed packaged resources. Project reads/writes and commands
// belong to DSH's native tools, where sandbox and approval are enforced.
export function apply(ctx, config) {
  validateConfig(config);
  for (const skill of ['ai-loop', 'ai-loop-models']) {
    ctx.skills.register({
      name: skill,
      description: skill === 'ai-loop' ? '在已启用的项目中执行 AI Loop 开发、测试、独立评审和记忆恢复。' : '使用 DSH 插件设置管理 AI Loop 的项目开关、角色模型与并发。',
      source: 'plugin:ai-loop-engineering',
      provider: 'ai-loop-engineering',
      path: path.join(pluginRoot, 'skills', skill, 'SKILL.md'),
      content: resource(`skills/${skill}/SKILL.md`),
      invocation: { modelInvocable: true, userInvocable: true }
    });
  }
  ctx.systemPrompt.context({
    name: 'ai-loop:project', order: 130, interpolate: false,
    text: ({ agent }) => {
      if (!agent) return '';
      const root = agent.session.header.cwd;
      if (!projectSettings(config, root).enabled) return '';
      if (delegationDepthOf(agent) > 0) return `这是 AI Loop 叶角色任务：只执行已分配的工作与验证，不得继续派发；需要审批或额外能力时返回主代理。目标工作区：${root}。`;
      const enabled = ROLES.filter(role => roleOptions(projectSettings(config, root), role));
      return `此项目已启用 AI Loop。工程任务先加载 ai-loop 技能并读取运行状态。standard/full 已授权任务使用 ai_loop_delegate 派发已开启角色（${enabled.join('、') || '当前全部关闭'}）；lite 或用户要求单代理时由主代理执行。关闭角色不调用；必须独立评审却缺少执行者时保留待复核，不能伪称完成。派发前登记 requested，返回后通过原生工具保存 ai_loop_observe 给出的真实观察及证据。工作区：${root}；共享核心：${corePath}。项目规则、deny、原生审批与沙箱优先。`;
    }
  });

  // Read-only browser route. The client uses a same-origin fetch so both the
  // DSH browser and Electron's dsh-app:// forwarding reach the host route.
  ctx.inject(['webServer', 'connection'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/plugins/ai-loop-engineering/state',
      handler: async (req, res) => {
        const rejection = webCtx.connection.requestRejection(req);
        const send = (code, value) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(value));
        };
        if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
        if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal');
          let root = url.searchParams.get('project') ?? '';
          const sessionId = url.searchParams.get('session');
          if (sessionId) {
            const session = ctx.sessions?.get?.(sessionId);
            const sessionRoot = session?.header?.cwd;
            if (sessionRoot) {
              if (root && projectKey(root) !== projectKey(sessionRoot)) return send(403, { error: '当前会话绑定了其他工作区。' });
              root = sessionRoot;
            } else return send(400, { error: '无法验证当前会话及其工作区。' });
          }
          if (!root || !projectSettings(config, root).enabled) return send(403, { error: '此工作区未启用 AI Loop。' });
          const loopMod = await import(pathToFileURL(path.join(coreRoot, 'scripts', 'loop.mjs')).href);
          const activityMod = await import(pathToFileURL(path.join(coreRoot, 'scripts', 'activity.mjs')).href);
          const run = url.searchParams.get('run');
          const rawProjectPath = url.searchParams.get('project_path');
          const project_path = rawProjectPath === null ? undefined : projectPathOf(rawProjectPath);
          const scoped = project_path === undefined ? {} : projectOptions(project_path);
          const storageMod = await import(pathToFileURL(path.join(coreRoot, 'scripts', 'storage.mjs')).href);
          const projectRoot = project_path === undefined ? root : storageMod.projectBase(root, project_path);
          const dashboardMod = sessionId ? await import(pathToFileURL(path.join(coreRoot, 'scripts', 'dashboard.mjs')).href) : null;
          let sessionHistory = dashboardMod?.chatHistory(root, {
            session_id: sessionId,
            harness: 'dsh',
            ...scoped,
            limit: Number(url.searchParams.get('limit') ?? 20),
            after: url.searchParams.get('after') ?? undefined,
          }) ?? null;
          const matchingRounds = run ? (sessionHistory?.rounds ?? []).filter(item => item.run.run_id === run && (project_path === undefined || sameProjectPath(item.run, project_path))) : [];
          let cursor = sessionHistory?.next_after;
          while (sessionHistory && run && cursor && (project_path === undefined || matchingRounds.length === 0)) {
            const page = dashboardMod.chatHistory(root, { session_id: sessionId, harness: 'dsh', ...scoped, limit: 100, after: cursor });
            matchingRounds.push(...page.rounds.filter(item => item.run.run_id === run && (project_path === undefined || sameProjectPath(item.run, project_path))));
            cursor = page.next_after;
            if (project_path !== undefined && matchingRounds.length) break;
          }
          const selectedRound = matchingRounds.length === 1 ? matchingRounds[0] : null;
          const ambiguousRun = matchingRounds.length > 1;
          if (selectedRound && !sessionHistory.rounds.some(item => runKey(item.run) === runKey(selectedRound.run))) sessionHistory.rounds.push(selectedRound);
          const currentSettings = projectSettings(config, root);
          const live = [...(activations.get(projectKey(root))?.values() ?? [])].filter(item => (project_path === undefined || sameProjectPath(item, project_path)) && (!run || item.run_id === run)).map(item => ({
            ...item,
            state: item.live !== false && ['starting', 'running', 'waiting_to_stop'].includes(item.state) && !roleOptions(currentSettings, item.role) ? 'waiting_to_stop' : item.state,
            note: item.live !== false && ['starting', 'running', 'waiting_to_stop'].includes(item.state) && !roleOptions(currentSettings, item.role) ? '角色已关闭；运行时未公开可确认的停止接口，当前执行者可能仍在运行。' : item.live === false && item.state === 'ended_unknown' ? '原生执行已结算，但退出原因未知；这不代表工作流任务通过。' : undefined
          }));
          if (sessionHistory) {
            for (const item of live.filter(agent => agent.run_id && (agent.parent_id === sessionId || agent.context?.parent_id === sessionId))) {
              const itemProject = item.project_path ?? '.';
              const itemOptions = projectOptions(itemProject);
              let round = sessionHistory.rounds.find(entry => sameRun(entry.run, item));
              if (!round) {
                const runStatus = loopMod.status(root, item.run_id, itemOptions);
                const observed = activityMod.activityStatus(root, item.run_id, itemOptions);
                const runInfo = loopMod.listRuns(root, itemOptions).find(entry => sameRun(entry, item));
                round = { run: { ...runStatus, created_at: runInfo?.updated_at ?? '' }, activity: { ...observed, agents: observed.agents.filter(agent => agent.context?.parent_id === sessionId) } };
                sessionHistory.rounds.push(round);
              }
              if (!round.activity.agents.some(agent => agent.native_id === item.native_id)) round.activity.agents.push(item);
            }
            sessionHistory.rounds.sort((left, right) => (right.run.created_at ?? '').localeCompare(left.run.created_at ?? '') || right.run.run_id.localeCompare(left.run.run_id) || runKey(right.run).localeCompare(runKey(left.run)));
          }
          const runs = sessionHistory ? sessionHistory.rounds.map(round => round.run) : loopMod.listRuns(root, scoped);
          const withAgents = (status, round) => {
            if (!status?.run_id) return status;
            const statusProject = projectPathOf(status.project_path ?? round?.run?.project_path ?? project_path ?? '.');
            const statusOptions = projectOptions(statusProject);
            const statusDirectory = storageMod.projectBase(root, statusProject);
            const observed = round?.activity ?? activityMod.activityStatus(root, status.run_id, statusOptions);
            const agents = new Map((observed.agents ?? []).map((agent, index) => [agent.native_id || `observed:${index}`, agent]));
            for (const item of live.filter(agent => sameRun(agent, status) && (!sessionId || agent.parent_id === sessionId || agent.context?.parent_id === sessionId))) {
              const key = item.native_id || `live:${item.task}:${item.role}:${item.attempt}`;
              const previous = agents.get(key);
              agents.set(key, {
                ...previous,
                ...item,
                ...(Array.isArray(previous?.history) ? { history: previous.history.slice(-20) } : {}),
                ...(previous?.observation ? { observation: previous.observation } : {}),
              });
            }
            return { ...status, project_root: root, project_path: statusProject, project_directory: statusDirectory, ...(sessionHistory ? { chat_history: sessionHistory } : {}), activity: { ...observed, agents: [...agents.values()] } };
          };
          if (run) {
            const round = selectedRound;
            if (sessionHistory && !round) return send(200, { project_root: root, runs, chat_history: sessionHistory, message: ambiguousRun ? '多个项目存在同名运行，请指定 project_path。' : '当前聊天没有关联此运行。' });
            const runProject = project_path ?? round?.run?.project_path;
            const runOptions = runProject === undefined ? scoped : projectOptions(runProject);
            return send(200, withAgents({ ...loopMod.status(root, run, runOptions), runs }, round));
          }
          const activeRuns = runs.filter(item => item.status === 'active');
          if (activeRuns.length === 1) return send(200, withAgents({ ...loopMod.status(root, activeRuns[0].run_id, projectOptions(activeRuns[0].project_path ?? '.')), runs }, sessionHistory?.rounds.find(item => sameRun(item.run, activeRuns[0]))));
          if (activeRuns.length === 0 && runs.length === 1) return send(200, withAgents({ ...loopMod.status(root, runs[0].run_id, projectOptions(runs[0].project_path ?? '.')), runs }, sessionHistory?.rounds[0]));
          return send(200, { project_root: root, ...(project_path === undefined ? {} : { project_path, project_directory: projectRoot }), runs, ...(sessionHistory ? { chat_history: sessionHistory } : {}), message: runs.length === 0 ? (sessionHistory?.unbound_count ? `${sessionHistory.unbound_count} 个旧运行含未绑定聊天的活动，不显示在当前聊天中。` : '当前聊天暂无关联运行记录。') : activeRuns.length > 1 ? '当前聊天存在多个活跃运行，请选择运行。' : '请选择要查看的运行。' });
        } catch (error) {
          return send(400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }), 'ai-loop: read-only status route');
  });

  const active = new Map();
  const activations = new Map();
  const prepared = new Map();
  ctx.tools.register(defineTool({
    name: 'ai_loop_plan',
    description: '在正式运行前创建独立规划请求，由真实 DSH 原生 planner 子代理仅生成计划；不创建 run/task、不执行检查或修改源码。计划文件由原生工具写入 .ai-loop/plans。',
    parameters: {
      project_path: { type: 'string', description: '工作区内的可选子项目相对路径；默认当前工作区根目录。' },
      description: { type: 'string', required: true, description: '计划主题。' },
      request: { type: 'string', required: true, description: '完整需求、约束与预期输出。' }
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent || delegationDepthOf(parent) > 0) throw new Error('仅主代理可启动前运行规划。');
      if (!args.description?.trim() || !args.request?.trim()) throw new Error('请提供计划主题和完整需求。');
      const root = parent.session.header.cwd;
      const project_path = projectPathOf(args.project_path);
      const storage = await import(pathToFileURL(path.join(coreRoot, 'scripts', 'storage.mjs')).href);
      const projectRoot = storage.projectBase(root, project_path);
      const settings = projectSettings(config, root);
      if (!settings.enabled) throw new Error('此工作区未启用 AI Loop。');
      const options = roleOptions(settings, 'planner');
      if (!options) throw new Error('AI Loop 计划角色已关闭；请在插件设置中启用 planner 后再规划。');
      const provider = ctx.subagents.getProvider('spawn');
      if (!provider || provider.inheritsParentContext !== false || !provider.capabilities?.agentOptions || !provider.capabilities?.depthLimit || !provider.prepareContinuable) throw new Error('需要支持独立上下文、模型覆盖和深度限制的 DSH 原生 spawn 后端。');
      const parentOptions = parentAgentOptionsForDelegation(parent);
      const route = { provider: options.provider ?? parentOptions.provider, model: options.model ?? parentOptions.model };
      if (!route.provider || !route.model) throw new Error('无法确定 AI Loop planner 的 provider/model。');
      const changed = route.provider !== parentOptions.provider || route.model !== parentOptions.model;
      const effort = options.reasoningEffort ?? (!changed ? parentOptions.reasoningEffort : undefined);
      await ctx.llm.resolveCallConfig({ ...route, ...(effort ? { reasoningEffort: effort } : {}) }, exec.signal);
      exec.signal.throwIfAborted();
      if (ctx.subagents.getProvider('spawn') !== provider) throw new Error('DSH spawn 后端在模型预检期间发生变化，请重新规划。');
      const latest = projectSettings(config, root);
      if (!latest.enabled || !roleOptions(latest, 'planner')) throw new Error('planner 已关闭或工作区已停用；已阻止启动。');
      if (JSON.stringify(roleOptions(latest, 'planner')) !== JSON.stringify(options)) throw new Error('模型预检期间 planner 配置变化，请重新预检。');
      if ((active.get(projectKey(root)) ?? 0) >= latest.maxConcurrent) throw new Error(`AI Loop 已达到工作区并发上限 ${latest.maxConcurrent}，请等待已有子代理结束。`);
      const plan_id = `plan-${crypto.randomUUID()}`;
      const pool = projectKey(root);
      const agents = activations.get(pool) ?? new Map();
      activations.set(pool, agents);
      active.set(pool, (active.get(pool) ?? 0) + 1);
      const release = () => { const count = (active.get(pool) ?? 1) - 1; if (count > 0) active.set(pool, count); else active.delete(pool); };
      try {
        const activation = await ctx.subagents.startActivation({
          provider: 'spawn', label: `AI Loop 前运行规划：${args.description}`, delivery: 'parent', signal: exec.signal,
          request: {
            parent,
            cwd: projectRoot,
            prompt: [{ type: 'text', text: `${roleText.planner}\n\n这是正式运行前的独立规划。项目根：${projectRoot}；工作区：${root}；project_path=${project_path}；plan_id=${plan_id}。请只输出任务拆分、互斥文件范围、依赖、验收标准和检查命令，并通过 DSH 原生文件工具将计划保存到 .ai-loop/plans/${plan_id}/plan.json。只可创建/写入该计划目录与计划文件；禁止创建正式 run/task，禁止执行检查、命令或源码修改。保存内容不得伪造原生执行证据；主代理会在真实调用返回后补存证据。遇到 deny、审批或范围不足时按规则停止并汇报。\n\n${args.request}` }],
            agentOptions: options,
            maxDepth: ctx.subagents.resolveMaxDepth()
          }
        });
        const observation = { plan_id, project_path, project_root: root, project_directory: projectRoot, parent_id: parent.id, context: { mode: 'independent', id: activation.childId, parent_id: parent.id }, role: 'planner', native_id: activation.childId, state: 'running', live: true, stale: false };
        agents.set(`plan:${plan_id}`, observation);
        activation.result.then(result => { observation.state = result?.stopReason === 'completed' ? 'completed' : result?.stopReason === 'cancelled' ? 'stopped' : result?.stopReason === 'error' ? 'failed' : 'ended_unknown'; observation.native_result = nativeResultOf(result); observation.live = false; observation.finished_at = new Date().toISOString(); release(); }, error => { observation.state = 'failed'; observation.native_result = nativeResultOf(error instanceof Error ? { name: error.name, message: error.message } : error); observation.live = false; observation.finished_at = new Date().toISOString(); release(); });
        return JSON.stringify({ ...observation, source: 'native-runtime', persistence: 'pending-native-write', plan_file: `.ai-loop/plans/${plan_id}/plan.json`, evidence_file: `.ai-loop/plans/${plan_id}/native-evidence.json`, note: '真实原生 childId 已返回；等待 DSH 回传计划后，使用获准原生工具保存计划和观察证据。启动及进程 completed 均不代表计划审查通过。' });
      } catch (error) { release(); throw error; }
    }
  }));
  ctx.tools.register(defineTool({
    name: 'ai_loop_delegate',
    description: '将已授权的 AI Loop 阶段交给真实独立上下文的 DSH spawn 子代理。只能在精确启用的项目使用；模型由插件设置决定；返回子代理 id，结果由 DSH 原生回传。子代理不能再次调用此工具。',
    parameters: {
      role: { type: 'string', enum: ROLES, required: true, description: '工作流角色。' },
      run: { type: 'string', required: true, description: '当前 AI Loop run_id。' },
      task: { type: 'string', required: true, description: '正式 task id。多方向拆分须在运行中创建不同的正式任务。' },
      direction: { type: 'string', description: '可选的方向显示标签，最多 64 字符；不能代替正式任务或绕过执行锁。' },
      project_path: { type: 'string', description: '可选的工作区内相对项目路径；用于隔离同名运行身份。' },
      attempt: { type: 'integer', required: true, description: '当前 tester/reviewer 批次；其他角色填 0。' },
      execution: { type: 'string', description: '已由原生工具登记的 requested 观察 id；新证据运行必须提供。' },
      description: { type: 'string', required: true, description: '简短任务名称。' },
      prompt: { type: 'string', required: true, description: '完整独立任务，包含范围、验收要求和已有授权。' }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('AI Loop 派发必须来自 DSH 原生代理。');
      if (delegationDepthOf(parent) > 0) throw new Error('AI Loop 角色子代理不得继续派发；请向主代理报告额外需求。');
      if (!ROLES.includes(args.role) || !args.prompt.trim() || !args.description.trim() || !args.run.trim() || !args.task.trim() || !Number.isInteger(args.attempt) || args.attempt < 0 || !validDirection(args.direction)) throw new Error('请提供有效角色、正式任务编号、最多 64 字符的方向标签、运行、批次、任务名称和完整任务内容。');
      const cwd = await ctx.workingDirectory.ensure(parent, exec.signal);
      const root = parent.session.header.cwd ?? cwd;
      const project_path = projectPathOf(args.project_path);
      const scoped = projectOptions(project_path);
      const storage = await import(pathToFileURL(path.join(coreRoot, 'scripts', 'storage.mjs')).href);
      storage.projectBase(root, project_path);
      const projectRoot = projectRootOf(root, project_path);
      const settings = projectSettings(config, root);
      if (!settings.enabled) throw new Error('此项目未启用 AI Loop，请在 DSH 插件设置中精确启用该工作区。');
      if (!roleOptions(settings, args.role)) throw new Error(`AI Loop ${ROLE_LABELS[args.role]}角色已关闭；请在插件设置中选择模型后再派发。`);
      const workflow = await import(pathToFileURL(path.join(coreRoot, 'scripts', 'activity.mjs')).href);
      const authorization = workflow.dispatchCheck(root, args.run, args.task, args.role, args.attempt, scoped);
      if (authorization.run_id !== args.run || authorization.task_id !== args.task || authorization.role !== args.role || authorization.attempt !== args.attempt) throw new Error('工作流只读派发校验未返回匹配的 run/task/role/attempt。');
      const direction = args.direction || null;
      const targetCwd = project_path === '.' ? cwd : projectRoot;
      const isSameExecution = item => sameProjectPath(item, project_path) && item.task === args.task && (item.direction ?? null) === direction && item.role === args.role;
      const hasActiveTaskRole = item => sameProjectPath(item, project_path) && item.task === args.task && item.role === args.role;
      const priorAgents = workflow.activityStatus(root, args.run, scoped).agents ?? [];
      if (authorization.execution_evidence === 'required-for-independent') {
        if (!args.execution || !priorAgents.some(item => item.id === args.execution && isSameExecution(item) && item.attempt === args.attempt && item.state === 'requested' && !item.native_id)) throw new Error('须先通过原生工具登记本批次 requested，并提供 execution；避免重载后重复派发。');
        const ticket = prepared.get(args.execution);
        const saved = priorAgents.find(item => item.id === args.execution);
      if (!ticket || ticket.parent_id !== parent.id || ticket.root !== projectKey(root) || ticket.project_path !== project_path || ticket.run !== args.run || ticket.task !== args.task || ticket.role !== args.role || ticket.attempt !== args.attempt || saved.requested?.dispatch_token !== ticket.dispatch_token) throw new Error('派发凭据缺失、过期或来自重载前；先核对原生执行者，不复用 requested 重派。');
      }
      if (priorAgents.some(item => hasActiveTaskRole(item) && !['completed', 'failed', 'stopped'].includes(item.state) && !(item.id === args.execution && item.state === 'requested' && !item.native_id && item.attempt === args.attempt))) throw new Error('该 run/task/role 在核心代理台账中仍为非终态；先由主代理核对原生执行者状态，不能因观察过期而重派。');
      const provider = ctx.subagents.getProvider('spawn');
      if (!provider || provider.inheritsParentContext !== false || !provider.capabilities?.agentOptions || !provider.capabilities?.depthLimit || !provider.prepareContinuable) throw new Error('需要支持独立上下文、模型覆盖和深度限制的 DSH 原生 spawn 后端。');
      const options = roleOptions(settings, args.role);
      const parentOptions = parentAgentOptionsForDelegation(parent);
      if (options) {
        const route = { provider: options.provider ?? parentOptions.provider, model: options.model ?? parentOptions.model };
        if (!route.provider || !route.model) throw new Error('无法确定 AI Loop 子代理的 provider/model。');
        const changed = route.provider !== parentOptions.provider || route.model !== parentOptions.model;
        const effort = options.reasoningEffort ?? (!changed ? parentOptions.reasoningEffort : undefined);
        await ctx.llm.resolveCallConfig({ ...route, ...(effort ? { reasoningEffort: effort } : {}) }, exec.signal);
      }
      exec.signal.throwIfAborted();
      if (ctx.subagents.getProvider('spawn') !== provider) throw new Error('DSH spawn 后端在模型预检期间发生变化，请重新派发。');
      const latestSettings = projectSettings(config, root);
      if (!latestSettings.enabled || !roleOptions(latestSettings, args.role)) throw new Error(`AI Loop ${ROLE_LABELS[args.role]}角色已关闭或工作区已停用；已阻止新的子代理启动。`);
      if (JSON.stringify(roleOptions(latestSettings, args.role)) !== JSON.stringify(options)) throw new Error('模型预检期间角色配置变化，请重新预检。');
      const finalAuthorization = workflow.dispatchCheck(root, args.run, args.task, args.role, args.attempt, scoped);
      if (finalAuthorization.run_id !== args.run || finalAuthorization.task_id !== args.task || finalAuthorization.role !== args.role || finalAuthorization.attempt !== args.attempt) throw new Error('启动前工作流只读校验未返回匹配的 run/task/role/attempt。');
      const finalAgents = workflow.activityStatus(root, args.run, scoped).agents ?? [];
      if (authorization.execution_evidence === 'required-for-independent' && !finalAgents.some(item => item.id === args.execution && item.state === 'requested' && !item.native_id && item.requested?.dispatch_token === prepared.get(args.execution)?.dispatch_token)) throw new Error('启动前派发登记已变化，停止派发。');
      if (finalAgents.some(item => hasActiveTaskRole(item) && !['completed', 'failed', 'stopped'].includes(item.state) && !(item.id === args.execution && item.state === 'requested' && !item.native_id && item.attempt === args.attempt))) throw new Error('模型预检期间核心代理台账出现非终态执行者；已阻止启动。');
      const pool = projectKey(root);
      const key = `${project_path}\0${args.run}\0${args.task}\0${args.role}\0${args.attempt}`;
      const agents = activations.get(pool) ?? new Map();
      if ([...agents.values()].some(item => sameProjectPath(item, project_path) && item.run_id === args.run && item.task === args.task && item.role === args.role && ['starting', 'running', 'waiting_to_stop'].includes(item.state))) throw new Error('此 project_path/run/task/role 已有未结束的子代理；更换 direction 或 attempt 不能绕过锁定。');
      if ((active.get(pool) ?? 0) >= latestSettings.maxConcurrent) throw new Error(`AI Loop 已达到项目并发上限 ${latestSettings.maxConcurrent}，请等待已有子代理结束。`);
      activations.set(pool, agents);
      active.set(pool, (active.get(pool) ?? 0) + 1);
      const startingKey = `starting:${key}`;
      const starting = { run_id: args.run, project_path, project_root: root, project_directory: projectRoot, task: args.task, role: args.role, attempt: args.attempt, native_id: null, state: 'starting', live: true, stale: false, key };
      agents.set(startingKey, starting);
      const release = () => {
        const count = (active.get(pool) ?? 1) - 1;
        if (count > 0) active.set(pool, count); else active.delete(pool);
      };
      try {
        prepared.delete(args.execution);
        const activation = await ctx.subagents.startActivation({
          provider: 'spawn', label: `AI Loop ${ROLE_LABELS[args.role]}：${args.description}`, delivery: 'parent', signal: exec.signal,
          request: {
            parent, cwd: targetCwd,
            prompt: [{ type: 'text', text: `${roleText[args.role]}\n\n共享核心：${corePath}；工作区根：${root}；目标项目根：${projectRoot}；project_path=${project_path}。\n当前关联：run=${args.run}，task=${args.task}，role=${args.role}，attempt=${args.attempt}。核心只读校验已通过。\n这是叶角色任务，不得再派发子代理。遵守项目规则和 deny。DSH 原生子代理审批策略为 never；遇到需要审批的操作向主代理报告，不能自行提权、改设置或切换工具绕过。不得声称未执行的检查已通过。\n\n${args.prompt}` }],
            ...(options ? { agentOptions: options } : {}),
            maxDepth: ctx.subagents.resolveMaxDepth()
          }
        });
        agents.delete(startingKey);
        const observation = { execution_id: args.execution ?? null, parent_id: parent.id, context: { mode: 'independent', id: activation.childId, parent_id: parent.id }, run_id: args.run, project_path, project_root: root, project_directory: projectRoot, task: args.task, direction: direction ?? null, role: args.role, attempt: args.attempt, native_id: activation.childId, state: 'running', live: true, stale: false, key };
        agents.set(activation.childId, observation);
        // Rejections are observed; the native runtime owns cancellation, teardown
        // and completion delivery. Do not dispose a successful background child.
        activation.result.then(result => { observation.state = result?.stopReason === 'completed' ? 'completed' : result?.stopReason === 'cancelled' ? 'stopped' : result?.stopReason === 'error' ? 'failed' : 'ended_unknown'; observation.live = false; observation.stale = false; release(); }, () => { observation.state = 'failed'; observation.live = false; observation.stale = false; release(); });
        return `已启动 AI Loop ${ROLE_LABELS[args.role]}子代理 ${activation.childId}（spawn 独立上下文）。执行记录 ${args.execution || '未登记'}；请立即用 ai_loop_observe 读取并经原生工具持久化，不能将启动当作任务通过。`;
      } catch (error) { agents.delete(startingKey); release(); throw error; }
    }
  }));

  ctx.tools.register(defineTool({
    name: 'ai_loop_prepare',
    description: '只读生成当前主会话的一次性派发凭据。将返回的 requested 输入经原生工具写入 activity，再调用 delegate；插件重载后不能复用旧凭据。',
    parameters: {
      run: { type: 'string', required: true, description: '运行编号' },
      task: { type: 'string', required: true, description: '正式 task id；多方向拆分须使用不同的正式任务。' },
      project_path: { type: 'string', description: '可选的工作区内相对项目路径；必须与对应运行的项目边界一致。' },
      direction: { type: 'string', description: '可选的方向显示标签，最多 64 字符；不能代替正式任务或绕过执行锁。' },
      role: { type: 'string', enum: ROLES, required: true, description: '角色' },
      attempt: { type: 'integer', required: true, description: '当前批次' }
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent || delegationDepthOf(parent) > 0) throw new Error('仅主代理可准备派发');
      const root = parent.session.header.cwd, settings = projectSettings(config, root);
      const project_path = projectPathOf(args.project_path);
      const scoped = projectOptions(project_path);
      if (!settings.enabled || !roleOptions(settings, args.role)) throw new Error('工作区或角色未启用');
      const workflow = await import(pathToFileURL(path.join(coreRoot, 'scripts', 'activity.mjs')).href);
      workflow.dispatchCheck(root, args.run, args.task, args.role, args.attempt, scoped);
      if (!validDirection(args.direction)) throw new Error('direction 只能是最多 64 字符的展示标签；任务拆分请使用正式 task id。');
      const direction = args.direction || null;
      const hasActiveTaskRole = item => sameProjectPath(item, project_path) && item.task === args.task && item.role === args.role;
      if (workflow.activityStatus(root, args.run, scoped).agents.some(item => hasActiveTaskRole(item) && !['completed', 'failed', 'stopped'].includes(item.state))) throw new Error('已有未确认终态的执行登记；更换 direction 不能绕过锁定');
      const id = `exec-${crypto.randomUUID()}`, dispatch_token = crypto.randomUUID();
      prepared.set(id, { root: projectKey(root), parent_id: parent.id, ...args, project_path, direction, dispatch_token });
      return JSON.stringify({ id, project_path, task: args.task, direction, role: args.role, attempt: args.attempt, harness: 'dsh', state: 'requested', requested: { dispatch_token, parent_id: parent.id }, summary: '原生派发前登记；须补充本次 revision，经原生工具保存' });
    }
  }));

  ctx.tools.register(defineTool({
    name: 'ai_loop_observe',
    description: '只读取得真实原生执行观察。正式任务传 run/native_id；前运行规划传 plan_id，可读取真实 planner 完成、失败或取消结果。由主代理经原生工具持久化返回证据。插件重载后无观察时须向原生运行时核验，不能猜测终态。',
    parameters: { run: { type: 'string', description: '正式运行编号；与 plan_id 二选一。' }, plan_id: { type: 'string', description: '前运行规划编号；与 run 二选一。' }, project_path: { type: 'string', description: '可选的工作区内相对项目路径；必须与原生观察的边界一致。' }, native_id: { type: 'string', description: '正式运行观察使用 spawn 返回的真实 childId。' } },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent || delegationDepthOf(parent) > 0) throw new Error('仅主代理可同步原生观察');
      const root = parent.session.header.cwd;
      const project_path = projectPathOf(args.project_path);
      if (!projectSettings(config, root).enabled) throw new Error('工作区未启用');
      if (Boolean(args.run) === Boolean(args.plan_id)) throw new Error('run 与 plan_id 必须且只能提供一个。');
      if (args.plan_id) {
        if (typeof args.plan_id !== 'string' || !/^plan-[0-9a-f-]{36}$/i.test(args.plan_id)) throw new Error('plan_id 格式无效。');
        const row = activations.get(projectKey(root))?.get(`plan:${args.plan_id}`);
        if (!row || !sameProjectPath(row, project_path) || row.parent_id !== parent.id) throw new Error('没有此会话和项目边界的规划观察；须核对原生运行时。');
        return JSON.stringify({ ...row, plan_file: `.ai-loop/plans/${row.plan_id}/plan.json`, evidence_file: `.ai-loop/plans/${row.plan_id}/native-evidence.json`, source: 'native-runtime', persistence: 'pending-native-write', evidence: { plan_id: row.plan_id, project_path, parent_id: row.parent_id, context: row.context, native_id: row.native_id, state: row.state, finished_at: row.finished_at ?? null, native_result: row.native_result ?? null }, note: row.live ? 'planner 仍在运行，尚无最终原生结果；完成后重新观察并将返回证据写入 evidence_file。' : '此为真实原生 planner 观察及返回结果；将其保存到 evidence_file。该结果不代表计划已审核或获批。' });
      }
      if (!args.native_id) throw new Error('正式运行观察必须提供 native_id。');
      const row = activations.get(projectKey(root))?.get(args.native_id);
      if (!row || row.run_id !== args.run || row.project_path !== project_path || row.parent_id !== parent.id) throw new Error('没有此会话和项目边界的原生观察；须核对运行时，不可重派');
      return JSON.stringify({ ...row, source: 'native-runtime', persistence: 'pending-native-write', evidence: { run_id: row.run_id, project_path, task: row.task, role: row.role, attempt: row.attempt, native_id: row.native_id, context: row.context, state: row.state }, note: '保存此返回到匹配 project_path 的 reports/ 内证据，经 activity record 更新。ended_unknown 不能视为 completed；requested 须先更新 running 再同步终态。' });
    }
  }));

  ctx.tools.register(defineTool({
    name: 'ai_loop_status',
    description: '只读查看当前项目的 AI Loop 运行状态、DAG 任务执行进度或可选运行列表。无需审批与执行 bash，直接返回结构化状态。',
    parameters: {
      project: { type: 'string', description: '工作区根目录。默认为当前会话工作区。' },
      project_path: { type: 'string', description: '可选的工作区内相对路径（例如 packages/ledger），用于精确筛选子项目本地运行。' },
      run: { type: 'string', description: '运行编号（run_id）。若省略，自动推断当前活跃的唯一运行或返回运行列表。' }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      const cwd = parent ? (await ctx.workingDirectory.ensure(parent, exec.signal)) : process.cwd();
      const root = args.project || parent?.session?.header?.cwd || cwd;
      try {
        const settings = projectSettings(config, root);
        if (!settings.enabled) throw new Error('此项目未启用 AI Loop，不能读取其运行状态。');
        const loopUrl = pathToFileURL(path.join(coreRoot, 'scripts', 'loop.mjs')).href;
        const loopMod = await import(loopUrl);
        const project_path = projectPathOf(args.project_path);
        const listOpts = projectOptions(project_path);
        if (!args.run) {
          const runs = loopMod.listRuns(root, listOpts);
          const active = runs.filter(r => r.status === 'active');
          if (active.length === 1) {
            return JSON.stringify(loopMod.status(root, active[0].run_id, listOpts), null, 2);
          } else if (active.length === 0 && runs.length === 1) {
            return JSON.stringify(loopMod.status(root, runs[0].run_id, listOpts), null, 2);
          }
          return JSON.stringify({ runs, message: active.length > 1 ? '存在多个活跃运行，请指定 run 参数。' : '当前无唯一运行，请指定 run 参数。' }, null, 2);
        }
        return JSON.stringify(loopMod.status(root, args.run, listOpts), null, 2);
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2);
      }
    }
  }));
}
