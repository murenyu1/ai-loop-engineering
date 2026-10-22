import fs from 'node:fs';
import crypto from 'node:crypto';
import { assert, rootPath, safePath, jsonFile, writeJson, locked, args, allowArgs, mainModule, printResult } from './lib.mjs';

export const ROLE_NAMES = ['planner', 'dev', 'tester', 'reviewer', 'scribe'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
export const roleEnabled = value => value?.enabled === false ? false : value?.enabled === true ? true : Boolean(typeof value?.model === 'string' && value.model.trim());
export function effectiveRoles(input = {}, parent = {}) {
  assert(object(input) && object(parent), '角色配置须为对象');
  assert(Object.keys(input).every(role => ROLE_NAMES.includes(role)), '未知子代理角色');
  return Object.fromEntries(ROLE_NAMES.map(role => {
    const value = { ...parent[role], ...input[role] };
    return [role, { ...value, enabled: roleEnabled(value) }];
  }));
}
export function validateRoles(input) {
  const roles = effectiveRoles(input);
  for (const [role, value] of Object.entries(roles)) {
    assert(object(input[role] ?? {}) && Object.keys(value).every(key => ['enabled', 'provider', 'model', 'effort', 'reasoningEffort'].includes(key)), `${role} 角色字段无效`);
    assert(input[role]?.enabled === undefined || typeof input[role].enabled === 'boolean', `${role}.enabled 须为布尔值`);
    for (const key of ['model', 'provider', 'effort', 'reasoningEffort']) assert(value[key] === undefined || value[key] === null || typeof value[key] === 'string', `${role}.${key} 类型无效`);
    if (value.enabled) assert(modelId(value.model), `${role} 开启时须明确选择模型`);
  }
  return roles;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function rolesStatus(project) {
  const root = rootPath(project), file = safePath(root, '.ai-loop/roles.json');
  if (!fs.existsSync(file)) return { schema_version: 2, roles: validateRoles({}), source: 'default-off', hash: null };
  const data = jsonFile(file);
  assert(data.schema_version === 2 && object(data.roles), '角色策略版本不支持；请升级适配器，不忽略关闭配置');
  return { schema_version: 2, roles: validateRoles(data.roles), source: '.ai-loop/roles.json', hash: digest(data) };
}
export function configureRoles(project, input, options = {}) {
  const root = rootPath(project);
  assert(input?.schema_version === 2, '角色策略须使用 schema_version 2');
  const roles = validateRoles(input.roles);
  const next = { schema_version: 2, roles };
  const apply = () => {
    const current = rolesStatus(root);
    if (options.expected_hash !== undefined) assert(options.expected_hash === current.hash, '角色策略已变化，请重新读取后合并');
    if (options.apply) writeJson(safePath(root, '.ai-loop/roles.json'), next);
    return { ...next, hash: digest(next), status: options.apply ? 'configured' : 'dry-run', applies_to: 'next-dispatch', running_agents: 'unchanged-until-native-stop-confirmed' };
  };
  return options.apply ? locked(root, 'roles', apply) : apply();
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'input', 'role', 'model', 'effort', 'enabled', 'apply', 'help']);
  const [command] = options._;
  if (options.help || !command) return { usage: 'roles.mjs status|configure|set --project ROOT [--input JSON | --role dev --enabled true|false --model ID --effort high] [--apply]', note: '新配置默认全部关闭。关闭不启动替代子代理；运行中执行者须由原生工具确认停止。' };
  assert(options._.length === 1, '只能指定一个命令');
  if (command === 'status') return rolesStatus(options.project);
  assert(['configure', 'set'].includes(command), '未知角色命令');
  const current = rolesStatus(options.project);
  const next = options.input ? jsonFile(safePath(rootPath(options.project), options.input)) : { schema_version: 2, roles: current.roles };
  if (command === 'set') {
    assert(ROLE_NAMES.includes(options.role) && !options.input, 'set 须指定合法 role，不能传 input');
    assert(['true', 'false'].includes(options.enabled), '--enabled 须明确为 true 或 false');
    next.roles[options.role] = { ...next.roles[options.role], enabled: options.enabled === 'true', ...(options.model !== undefined ? { model: options.model } : {}), ...(options.effort !== undefined ? { effort: options.effort } : {}) };
  }
  return configureRoles(options.project, next, { apply: options.apply === true, expected_hash: current.hash });
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
