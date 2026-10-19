import crypto from 'node:crypto';
import { assert } from './lib.mjs';

export const ROLES = { planner: '复杂需求的计划、依赖与验收设计', reviewer: '独立评审正确性、回归与关键风险', dev: '按批准方案实现任务或修复问题', tester: '执行验证并保存命令、退出码和原始日志', scribe: '批量整理阶段记忆与交接' };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const routeHash = profile => crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
export function balanced(harness) {
  assert(['codex', 'claude-code'].includes(harness), '原生模型分工仅适用于 codex / claude-code');
  const codex = harness === 'codex';
  return validateProfile({ schema_version: 1, harness, concurrency: 3,
    main: { model: codex ? 'gpt-6.1-sol' : 'opus', effort: 'medium' },
    roles: Object.fromEntries(Object.keys(ROLES).map(role => [role, {
      model: codex ? (['planner', 'reviewer'].includes(role) ? 'gpt-6.1-sol' : 'gpt-6-luna') : (['planner', 'reviewer'].includes(role) ? 'opus' : 'sonnet'),
      effort: role === 'scribe' && !codex ? 'medium' : 'high',
    }])),
  }, harness);
}
export function validateProfile(input, harness) {
  assert(object(input) && input.schema_version === 1 && input.harness === harness, '模型配置 schema_version / harness 不匹配');
  assert(Object.keys(input).every(key => ['schema_version', 'harness', 'concurrency', 'main', 'roles'].includes(key)), '模型配置包含未知字段');
  assert(['codex', 'claude-code'].includes(harness), '原生模型分工仅适用于 codex / claude-code');
  assert(Number.isInteger(input.concurrency) && input.concurrency >= 1 && input.concurrency <= 8, 'concurrency 须为 1–8');
  const entry = (value, role) => {
    assert(object(value) && Object.keys(value).every(key => ['model', 'effort'].includes(key)), role + ' 模型字段无效');
    assert(typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model) && value.model !== 'inherit', role + ' 须明确模型，不能 inherit');
    const levels = harness === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    assert(value.effort === null || levels.includes(value.effort), role + ' 思考强度无效；null 表示采用平台默认/继承');
    assert(!(harness === 'codex' && role === 'main' && value.effort === null), 'Codex 主代理思考强度须明确');
    return { model: value.model, effort: value.effort };
  };
  assert(object(input.roles) && Object.keys(input.roles).length === Object.keys(ROLES).length && Object.keys(input.roles).every(role => Object.hasOwn(ROLES, role)), 'roles 须完整包含 planner/reviewer/dev/tester/scribe');
  return { schema_version: 1, harness, concurrency: input.concurrency, main: entry(input.main, 'main'), roles: Object.fromEntries(Object.keys(ROLES).map(role => [role, entry(input.roles[role], role)])) };
}
export function agentPath(harness, role) {
  assert(Object.hasOwn(ROLES, role), '未知代理角色');
  assert(['codex', 'claude-code'].includes(harness), '该 harness 没有已实现的原生代理适配');
  return `${harness === 'codex' ? '.codex' : '.claude'}/agents/loop-${role}.${harness === 'codex' ? 'toml' : 'md'}`;
}
export function skillPath(harness) {
  assert(['codex', 'claude-code'].includes(harness), '该 harness 没有已实现的原生技能入口');
  return `${harness === 'codex' ? '.agents' : '.claude'}/skills/ai-loop/SKILL.md`;
}
export function nativeSkill(harness) {
  const home = harness === 'codex' ? '.codex/ai-loop' : '.claude/ai-loop';
  return ['---', 'name: ai-loop', 'description: 当用户要求使用 AI Loop 工作流实施、继续或验证开发任务时使用；按批准范围进行原生子代理分工、证据验证与交接。', '---', '',
    '# AI Loop 原生调度入口', '',
    '本技能明确要求：standard/full 的已批准任务使用原生 loop-* 子代理进行开发、验证与必要评审；主代理负责计划、调度、难点与验收。lite 任务可直接执行。不要仅口头扮演代理，不强制无意义并发。',
    `先读取项目规则与 ${home}/WORKFLOW.md、${home}/ROUTING.md，内容已在上下文且未变化时复用。使用本部署 memory.mjs bootstrap 恢复共享记忆。命中 deny 立即停止；遵守用户审批范围，不修改 settings.json。`,
    `首次调度先用 ${home}/scripts/doctor.mjs 检查配置，并从当前客户端实际提供的原生工具确认角色发现；Agent/Task 等工具名以客户端为准。只选择已发现的 loop-*，等待原生结果，不用 shell 启动 CLI 冒充当前会话子代理。`,
    '派发完整的精简任务包，记录真实原生代理 ID；必要规则与验收不能省略。原生能力不足时报告，独立评审不能降格为 self。实际模型、思考强度、UI 分别验收，无法观察就保留 unverified。',
    '用户要求切换角色模型时，用 models.mjs 预演/应用；说明重载和下一次派发生效边界。当前执行者安全停止并 checkpoint 后，以新代理接续同一任务，不清零修复次数。agents.mjs 台账记录最后观察，不冒充实时面板。', ''].join('\n');
}
export function nativeAgent(profile, role, deployment) {
  const { model, effort } = profile.roles[role];
  const home = deployment || (profile.harness === 'codex' ? '.codex/ai-loop' : '.claude/ai-loop');
  const instructions = `你是 AI Loop 的 ${role}。遵守用户、项目规则和批准范围；命中 deny 立即停止，不能换工具或代理绕过。修改 settings.json 必须先获得具体许可；三个及以上文件改动须有已确认方案。读取任务包、必要项目规则和 ${home}/agents/loop-${role}.md，按需读 ${home}/ROUTING.md。只做本任务，不再派发子代理；疑难、权限不足或范围变化返回主代理。简体中文，用户可见回答先称呼“主人”。返回角色契约的简短 JSON，长日志保存在运行目录。`;
  if (profile.harness === 'codex') return [`name = "loop-${role}"`, `description = ${JSON.stringify(ROLES[role])}`, `model = ${JSON.stringify(model)}`, ...(effort === null ? [] : [`model_reasoning_effort = ${JSON.stringify(effort)}`]), `developer_instructions = ${JSON.stringify(instructions)}`, ''].join('\n');
  return ['---', `name: loop-${role}`, `description: ${JSON.stringify(ROLES[role])}`, `model: ${JSON.stringify(model)}`, ...(effort === null ? [] : [`effort: ${effort}`]), 'disallowedTools: Agent', '---', '', instructions, ''].join('\n');
}
export function routingGuide(profile, protocol) {
  return '# 当前模型分工\n\n配置摘要：`' + routeHash(profile) + '`。以下均为请求值，实际值须看原生记录。\n\n| 角色 | 模型 | 思考强度 |\n|---|---|---|\n'
    + Object.entries({ main: profile.main, ...profile.roles }).map(([role, value]) => `| ${role} | ${value.model} | ${value.effort ?? '平台默认/继承'} |`).join('\n')
    + `\n\n并发上限：${profile.concurrency}。Claude Code 此值是调度约束，不是平台硬限制。\n\n` + protocol;
}
