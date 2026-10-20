import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf, parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { createConfig, projectKey, projectSettings, roleOptions, validateConfig, ROLES, ROLE_LABELS } from './config.mjs';

export const name = 'ai-loop-engineering';
export const inject = ['skills', 'tools', 'systemPrompt', 'subagents', 'workingDirectory', 'llm'];
export const Config = createConfig(z);

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = fs.existsSync(path.join(pluginRoot, 'core')) ? path.join(pluginRoot, 'core') : path.resolve(pluginRoot, '../../core');
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
      return `此项目已启用 AI Loop。先加载 ai-loop 技能，按新需求/继续/只读检查区分意图，恢复必要的 .ai-loop/ 资料后行动。项目根目录：${root}。共享核心：${corePath}。项目规则、deny、原生审批与沙箱优先；不要通过宿主 fs/exec 绕过。独立角色使用 ai_loop_delegate；只有用户或工作流授权时才派发。`;
    }
  });

  const active = new Map();
  ctx.tools.register(defineTool({
    name: 'ai_loop_delegate',
    description: '将已授权的 AI Loop 阶段交给真实独立上下文的 DSH spawn 子代理。只能在精确启用的项目使用；模型由插件设置决定；返回子代理 id，结果由 DSH 原生回传。子代理不能再次调用此工具。',
    parameters: {
      role: { type: 'string', enum: ROLES, required: true, description: '工作流角色。' },
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
      if (!ROLES.includes(args.role) || !args.prompt.trim() || !args.description.trim()) throw new Error('请提供有效角色、任务名称和完整任务内容。');
      const cwd = await ctx.workingDirectory.ensure(parent, exec.signal);
      const root = parent.session.header.cwd ?? cwd;
      const settings = projectSettings(config, root);
      if (!settings.enabled) throw new Error('此项目未启用 AI Loop，请在 DSH 插件设置中精确启用该工作区。');
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
      const pool = projectKey(root);
      if ((active.get(pool) ?? 0) >= settings.maxConcurrent) throw new Error(`AI Loop 已达到项目并发上限 ${settings.maxConcurrent}，请等待已有子代理结束。`);
      active.set(pool, (active.get(pool) ?? 0) + 1);
      const release = () => {
        const count = (active.get(pool) ?? 1) - 1;
        if (count > 0) active.set(pool, count); else active.delete(pool);
      };
      try {
        const activation = await ctx.subagents.startActivation({
          provider: 'spawn', label: `AI Loop ${ROLE_LABELS[args.role]}：${args.description}`, delivery: 'parent', signal: exec.signal,
          request: {
            parent, cwd,
            prompt: [{ type: 'text', text: `${roleText[args.role]}\n\n共享核心：${corePath}；目标项目根：${root}。\n这是叶角色任务，不得再派发子代理。遵守项目规则和 deny。DSH 原生子代理审批策略为 never；遇到需要审批的操作向主代理报告，不能自行提权、改设置或切换工具绕过。不得声称未执行的检查已通过。\n\n${args.prompt}` }],
            ...(options ? { agentOptions: options } : {}),
            maxDepth: ctx.subagents.resolveMaxDepth()
          }
        });
        // Rejections are observed; the native runtime owns cancellation, teardown
        // and completion delivery. Do not dispose a successful background child.
        activation.result.then(release, release);
        return `已启动 AI Loop ${ROLE_LABELS[args.role]}子代理 ${activation.childId}（spawn 独立上下文）。`;
      } catch (error) { release(); throw error; }
    }
  }));

  ctx.tools.register(defineTool({
    name: 'ai_loop_status',
    description: '只读查看当前项目的 AI Loop 运行状态、DAG 任务执行进度或可选运行列表。无需审批与执行 bash，直接返回结构化状态。',
    parameters: {
      project: { type: 'string', required: false, description: '项目根目录。默认为当前工作区。' },
      run: { type: 'string', required: false, description: '运行编号（run_id）。若省略，自动推断当前活跃的唯一运行或返回运行列表。' }
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
        const loopUrl = pathToFileURL(path.join(coreRoot, 'scripts', 'loop.mjs')).href;
        const loopMod = await import(loopUrl);
        if (!args.run) {
          const runs = loopMod.listRuns(root);
          const active = runs.filter(r => r.status === 'active');
          if (active.length === 1) {
            return JSON.stringify(loopMod.status(root, active[0].run_id), null, 2);
          } else if (active.length === 0 && runs.length === 1) {
            return JSON.stringify(loopMod.status(root, runs[0].run_id), null, 2);
          }
          return JSON.stringify({ runs, message: active.length > 1 ? '存在多个活跃运行，请指定 run 参数。' : '当前无唯一运行，请指定 run 参数。' }, null, 2);
        }
        return JSON.stringify(loopMod.status(root, args.run), null, 2);
      } catch (error) {
        return JSON.stringify({ error: error.message }, null, 2);
      }
    }
  }));
}
