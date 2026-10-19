import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { resolveProfile, configureProfile, resetProjectProfile } from './profiles.mjs';
import { balanced, ROLES } from './routing.mjs';
import { inspectNative } from './doctor.mjs';
import { assert, rootPath, jsonFile, args, allowArgs, mainModule } from './lib.mjs';

export async function cli(argv, io = { input: stdin, output: stderr }) {
  const options = args(argv);
  allowArgs(options, ['project', 'scope', 'role', 'model', 'effort', 'concurrency', 'input', 'preset', 'apply', 'help']);
  assert(options._.length <= 1 && (options.apply === undefined || options.apply === true), '模型设置参数无效');
  const [command] = options._;
  if (options.help) return { usage: 'plugin-models.mjs status|list|configure|set|reset --project ROOT [--scope global|project] [--role dev --model ID --effort high] [--concurrency N] [--input JSON | --preset balanced] [--apply]', note: '默认预演；无输入的 configure 在交互终端逐项设置；聊天中由 AI 收集选择。' };
  const root = rootPath(options.project);
  if (command === 'list') {
    const native = await inspectNative(root, 'codex');
    return { models: native.models, error: native.models_error, next_cursor: native.models_next_cursor, source: 'native-model/list', warning: '原生服务返回的模型和强度；未返回时询问用户，不用静态预设冒充可用列表' };
  }
  const current = resolveProfile(root, command === 'status' ? options : { ...options, scope: options.scope || 'global' });
  if (command === 'status') return current;
  if (command === 'reset') {
    assert(options.scope === 'project', 'reset 仅撤销项目覆盖，恢复全局默认；全局默认用 configure 更新');
    return resetProjectProfile(root, options);
  }
  assert(['configure', 'set'].includes(command), '未知模型设置命令');
  assert(!(options.input && options.preset) && (!options.preset || options.preset === 'balanced'), '选择 input 或明确预设 balanced，不能同时指定');
  let profile = options.input ? jsonFile(options.input) : structuredClone(options.preset ? balanced('codex') : current.profile || balanced('codex'));
  if (command === 'set') {
    assert(current.profile || options.preset || options.input, '首次配置请 configure，不能静默选择其他角色模型');
    if (options.role) {
      assert(options.role === 'main' || Object.hasOwn(ROLES, options.role), 'role 不存在');
      assert(options.model !== undefined || options.effort !== undefined, '请指定 model 或 effort');
      const value = options.role === 'main' ? profile.main : profile.roles[options.role];
      if (options.model !== undefined) value.model = options.model;
      if (options.effort !== undefined) value.effort = options.effort === 'inherit' ? null : options.effort;
    } else assert(options.concurrency !== undefined, 'set 需 role 或 concurrency');
  } else if (!options.input && !options.preset) {
    assert(io.input.isTTY && io.output.isTTY, '非交互环境请先向主人展示当前配置/可用模型，收集选择后使用 --input；不自动选择预设');
    const prompt = createInterface(io);
    try {
      for (const [role, value] of Object.entries({ main: profile.main, ...profile.roles })) {
        value.model = (await prompt.question(`主人，${role} 模型 [${value.model}]: `)).trim() || value.model;
        const effort = (await prompt.question(`${role} 思考强度 [${value.effort || 'inherit'}]: `)).trim();
        if (effort) value.effort = effort === 'inherit' ? null : effort;
      }
      const concurrency = (await prompt.question(`并发上限 [${profile.concurrency}]: `)).trim();
      if (concurrency) profile.concurrency = Number(concurrency);
    } finally { prompt.close(); }
  }
  if (options.concurrency !== undefined) profile.concurrency = Number(options.concurrency);
  return configureProfile(root, profile, { ...options, scope: options.scope || 'global' });
}
if (mainModule(import.meta.url)) {
  try { console.log(JSON.stringify(await cli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`操作停止：${error.message}`); process.exitCode = 1; }
}
