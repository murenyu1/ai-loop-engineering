import path from 'node:path';

export const ROLES = ['planner', 'dev', 'tester', 'reviewer', 'scribe'];
export const ROLE_LABELS = { planner: '计划', dev: '开发', tester: '测试', reviewer: '评审', scribe: '记录' };

export function createConfig(z) {
  // Config is sent to the browser and reconstructed there. Keep every
  // constraint declarative: transform callbacks do not survive that boundary.
  const model = () => z.union([
    z.object({ enabled: z.boolean(), provider: z.string().pattern(/\S/).required(), model: z.string().pattern(/\S/).required(), reasoningEffort: z.string() }),
    z.object({ enabled: z.boolean(), provider: z.string().pattern(/^\s*$/), model: z.string().pattern(/^\s*$/), reasoningEffort: z.string() }),
    z.object({ enabled: z.boolean() }),
    z.object({ provider: z.string().pattern(/\S/).required(), model: z.string().pattern(/\S/).required(), reasoningEffort: z.string() }),
    z.object({ provider: z.string().pattern(/^\s*$/), model: z.string().pattern(/^\s*$/), reasoningEffort: z.string() })
  ]);
  const roles = () => z.object(Object.fromEntries(ROLES.map(role => [role, model().default(undefined)])));
  return z.object({
    enabled: z.boolean().default(false).volatile(),
    schemaVersion: z.number().step(1).min(2).max(2).volatile(),
    workflowEnabled: z.boolean().volatile(),
    maxConcurrent: z.number().step(1).min(1).max(16).default(3).volatile(),
    roles: roles().default({}).volatile(),
    projects: z.array(z.object({
      path: z.string().pattern(/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i).required(),
      enabled: z.boolean().default(false),
      maxConcurrent: z.number().step(1).min(1).max(16),
      roles: roles().default(undefined)
    })).default([]).volatile()
  });
}

export const valueOf = value => typeof value?.get === 'function' ? value.get() : value;

export function validateRoles(roles) {
  if (!roles) return roles;
  for (const role of ROLES) roleOptions({ roles }, role);
  return roles;
}

export function validateProjects(projects) {
  const seen = new Set();
  for (const project of projects ?? []) {
    const key = projectKey(project.path);
    if (!key) throw new Error('AI Loop 项目路径必须为绝对路径。');
    if (seen.has(key)) throw new Error('AI Loop 项目配置重复，请保留同一路径的一条设置。');
    seen.add(key);
    validateRoles(project.roles);
  }
  return projects;
}

export function validateConfig(config) {
  const schemaVersion = valueOf(config.schemaVersion);
  if (schemaVersion !== undefined && schemaVersion !== 2) throw new Error(`不支持 AI Loop 配置 schemaVersion=${schemaVersion}。`);
  if (schemaVersion === 2 && (valueOf(config.workflowEnabled) === undefined || valueOf(config.enabled) !== false)) throw new Error('AI Loop schema v2 必须配置 workflowEnabled，且 legacy enabled 必须为 false。');
  validateRoles(valueOf(config.roles));
  const projects = validateProjects(valueOf(config.projects) ?? []);
  for (const project of projects) projectSettings(config, project.path);
  return config;
}

export function projectKey(root) {
  if (typeof root !== 'string' || !root.trim()) return undefined;
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(root)) return path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase();
  if (!path.posix.isAbsolute(root)) return undefined;
  return path.posix.normalize(root).replace(/\/$/, '') || '/';
}

export function projectSettings(config, root) {
  const schemaVersion = valueOf(config.schemaVersion);
  if (schemaVersion !== undefined && schemaVersion !== 2) throw new Error(`不支持 AI Loop 配置 schemaVersion=${schemaVersion}。`);
  const key = projectKey(root);
  const projects = valueOf(config.projects) ?? [];
  const matches = projects.filter(item => key && projectKey(item.path) === key);
  if (matches.length > 1) throw new Error('AI Loop 项目配置重复，请保留同一路径的一条设置。');
  const project = matches[0];
  const maxConcurrent = project?.maxConcurrent ?? valueOf(config.maxConcurrent) ?? 3;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new Error('AI Loop 并发数必须是 1 到 16 的整数。');
  const globalRoles = valueOf(config.roles) ?? {};
  const settings = {
    enabled: (schemaVersion === 2 ? valueOf(config.workflowEnabled) === true && valueOf(config.enabled) === false : valueOf(config.enabled) === true) && project?.enabled === true,
    maxConcurrent,
    roles: Object.fromEntries(ROLES.map(role => [role, {
      ...globalRoles[role],
      ...Object.fromEntries(Object.entries(project?.roles?.[role] ?? {}).filter(([, value]) => value !== undefined))
    }]))
  };
  validateRoles(settings.roles);
  return settings;
}

export function roleOptions(settings, role) {
  if (!ROLES.includes(role)) throw new Error('未知 AI Loop 角色。');
  const values = settings.roles[role] ?? {};
  if (values.enabled !== undefined && typeof values.enabled !== 'boolean') throw new Error(`AI Loop ${role}.enabled 必须为布尔值。`);
  const hasLegacyRoute = Boolean(values.provider?.trim() && values.model?.trim());
  const options = {};
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (values[key] !== undefined && typeof values[key] !== 'string') throw new Error(`AI Loop ${role}.${key} 必须为字符串。`);
    if (values[key]?.trim()) options[key] = values[key].trim();
  }
  if (Boolean(options.provider) !== Boolean(options.model)) throw new Error('AI Loop 角色的 provider 和 model 必须同时填写或同时留空。');
  if (values.enabled === false || (values.enabled !== true && !hasLegacyRoute)) return undefined;
  if (values.enabled === true && !hasLegacyRoute) throw new Error('已启用的 AI Loop 角色必须配置 provider 和 model。');
  return Object.keys(options).length ? options : undefined;
}
