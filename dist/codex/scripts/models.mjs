import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { install } from './install.mjs';
import { adapterFor, selectHarness } from './adapters.mjs';
import { balanced, disabledProfile, upgradeProfile, ROLES, validateProfile } from './routing.mjs';
import { assert, rootPath, safePath, jsonFile, args, allowArgs, mainModule } from './lib.mjs';

export function installed(project, harness) {
  const root = rootPath(project);
  const file = safePath(root, '.ai-loop/install.json');
  const manifest = fs.existsSync(file) ? jsonFile(file) : null;
  assert(!manifest || manifest.schema_version === 2, '请先通过源包安装器迁移旧入口');
  const record = manifest?.harnesses?.[harness];
  return { root, manifest, record };
}
export function changeModel(options) {
  const harness = selectHarness(options.harness);
  const { root, manifest, record } = installed(options.project, harness);
  assert(record?.model_routing?.profile, '当前工具尚未启用模型分工，请先 configure');
  assert(options.role === 'main' || Object.hasOwn(ROLES, options.role), 'role 须为 main / planner / reviewer / dev / tester / scribe');
  assert(options.model !== undefined || options.effort !== undefined || options.enabled !== undefined, '至少提供 --model、--effort 或 --enabled');
  const profile = options.enabled !== undefined || options.model === 'off' ? upgradeProfile(record.model_routing.profile) : structuredClone(record.model_routing.profile);
  const target = options.role === 'main' ? profile.main : profile.roles[options.role];
  if (options.enabled !== undefined || options.model === 'off') {
    assert(options.role !== 'main' && (options.enabled === undefined || ['true', 'false'].includes(options.enabled)), '只能为子代理指定 --enabled true|false');
    target.enabled = options.model === 'off' ? false : options.enabled === 'true';
  }
  if (options.model !== undefined && options.model !== 'off') { target.model = options.model; if (profile.schema_version === 2 && options.role !== 'main' && options.enabled === undefined) target.enabled = true; }
  if (options.effort !== undefined) target.effort = options.effort === 'inherit' ? null : options.effort;
  return applyProfile({ ...options, harness, project: root, bundle: safePath(root, manifest.source), profile });
}
function applyProfile(options) {
  assert(options.apply === undefined || options.apply === true, '--apply 不接受值');
  const profile = validateProfile(options.profile, options.harness);
  const result = install({ project: options.project, harness: options.harness, bundle: options.bundle, profile, ...(options.apply ? { apply: true } : {}), ...(options.env ? { env: options.env } : {}) });
  return { ...result, requested_profile: profile,
    warnings: new Set([profile.main.model, ...Object.values(profile.roles).map(role => role.model)]).size === 1 ? ['所有角色配置了相同模型，当前选择没有形成强弱模型分工'] : [],
    effective_model: 'unverified', applies_to: 'next-dispatch-after-native-reload',
    current_agents: 'unchanged',
    main_session: options.harness === 'claude-code' ? '请在原生 /model 中选择主模型与强度；本命令不修改 settings.json' : '配置用于后续会话；当前主会话模型须通过原生选择器核对',
    reload: options.harness === 'codex' ? '新会话核对原生角色发现后再派发；不假设支持热重载'
      : '已有 agents 目录通常自动检测；首次创建该目录、add-dir 等情形需重开会话；以 /agents 实际发现为准',
  };
}
export async function cli(argv, io = { input: stdin, output: stderr }) {
  const options = args(argv);
  allowArgs(options, ['project', 'harness', 'role', 'model', 'effort', 'enabled', 'input', 'preset', 'apply', 'help']);
  assert(options._.length <= 1, '只能指定一个命令');
  assert(options.apply === undefined || options.apply === true, '--apply 不接受值');
  const [command] = options._;
  if (options.help || !command) return { usage: 'models.mjs status|configure|set --project ROOT --harness codex|claude-code [--preset balanced | --input PROJECT_RELATIVE_JSON] [--role dev --enabled true|false --model ID|off --effort high] [--apply]', note: '默认预演；无 preset/input 的 configure 逐角色询问，需要交互终端。非交互调用请由 AI 收集用户选择后传 JSON。' };
  const harness = selectHarness(options.harness);
  adapterFor(harness);
  if (command === 'set') {
    assert(options.input === undefined && options.preset === undefined, 'set 不接受 input / preset');
    return changeModel({ ...options, harness });
  }
  const { root, record, manifest } = installed(options.project, harness);
  if (command === 'status') {
    assert(['role', 'model', 'effort', 'enabled', 'input', 'preset', 'apply'].every(key => options[key] === undefined), 'status 不接受模型修改参数');
    return { harness, profile: record?.model_routing?.profile || disabledProfile(harness), effective_model: 'unverified', note: '无配置默认关闭。这是配置状态，不是代理运行状态；原生加载另行验收' };
  }
  assert(command === 'configure', '未知命令');
  assert(['role', 'model', 'effort', 'enabled'].every(key => options[key] === undefined), 'configure 使用逐项问答 / input / preset；单角色修改请使用 set');
  assert(!(options.input && options.preset), '不能同时提供 input 与 preset');
  assert(options.preset === undefined || options.preset === 'balanced', 'preset 仅支持 balanced');
  let profile;
  if (options.input) profile = jsonFile(safePath(root, options.input));
  else if (options.preset) profile = balanced(harness);
  else {
    assert(io.input.isTTY && io.output.isTTY, '非交互环境不会自动选模型；请先询问用户，再提供 --input 或明确选择 --preset balanced');
    profile = record?.model_routing?.profile ? upgradeProfile(record.model_routing.profile) : disabledProfile(harness);
    const prompt = createInterface(io);
    try {
      io.output.write('主人，逐项选择模型与思考强度；回车保留建议值，inherit 表示省略强度。模型可用性与支持强度仍须原生验证。\n');
      for (const [role, value] of Object.entries({ main: profile.main, ...profile.roles })) {
        const model = (await prompt.question(`${role} 模型 [${value.enabled === false ? '关闭' : value.model}]，off=关闭: `)).trim();
        if (role !== 'main' && model === 'off') { value.enabled = false; continue; }
        if (model) { value.model = model; if (role !== 'main') value.enabled = true; }
        if (value.enabled === false) continue;
        const effort = (await prompt.question(`${role} 思考强度 [${value.effort ?? 'inherit'}]: `)).trim();
        if (effort) value.effort = effort === 'inherit' ? null : effort;
      }
      const concurrency = (await prompt.question(`并发上限 [${profile.concurrency}]: `)).trim();
      if (concurrency) profile.concurrency = Number(concurrency);
    } finally { prompt.close(); }
  }
  return applyProfile({ project: root, harness, profile, apply: options.apply, bundle: manifest ? safePath(root, manifest.source) : undefined });
}
if (mainModule(import.meta.url)) {
  try { console.log(JSON.stringify(await cli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`操作停止：${error.message}`); process.exitCode = 1; }
}
