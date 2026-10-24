import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = message => { throw new Error(message); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const fileFor = home => path.join(path.resolve(home), 'ai-loop', 'workspaces.json');
const lockFor = home => path.join(path.resolve(home), 'ai-loop', 'workspaces.lock');
function checkedDirectory(home, create = false) {
  const base = path.resolve(home);
  ensure(fs.existsSync(base) && fs.statSync(base).isDirectory() && !fs.lstatSync(base).isSymbolicLink(), 'CODEX_HOME 必须是现存的真实目录');
  const dir = path.join(base, 'ai-loop');
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir);
  if (fs.existsSync(dir)) ensure(fs.statSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), 'ai-loop 注册表目录不能是符号链接');
  return dir;
}

function exactRoot(value) {
  ensure(typeof value === 'string' && value.trim(), '必须显式提供工作区目录');
  const absolute = path.resolve(value);
  ensure(fs.existsSync(absolute), '工作区目录不存在');
  ensure(!fs.lstatSync(absolute).isSymbolicLink(), '工作区根目录不能是符号链接');
  const root = fs.realpathSync(absolute);
  ensure(root === absolute || (process.platform === 'win32' && root.toLowerCase() === absolute.toLowerCase()), '工作区路径必须是精确的真实目录');
  ensure(fs.statSync(root).isDirectory(), '工作区路径必须是目录');
  return root;
}

function read(file) {
  if (!fs.existsSync(file)) return { schema_version: 2, workspaces: [] };
  ensure(!fs.lstatSync(file).isSymbolicLink(), '工作区注册表不能是符号链接');
  ensure(fs.statSync(file).isFile() && fs.statSync(file).size <= 1024 * 1024, '工作区注册表必须是小于 1 MiB 的普通文件');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  ensure([1, 2].includes(value?.schema_version) && Array.isArray(value.workspaces), '工作区注册表格式无效');
  if (value.schema_version === 1) ensure(value.workspaces.every(item => item && typeof item.root === 'string' && path.isAbsolute(item.root) && typeof item.enabled === 'boolean'), '工作区登记项格式无效');
  else ensure(value.workspaces.every(item => item && typeof item.enabled === 'boolean' && (typeof item.id === 'string' && item.id && Array.isArray(item.roots) && item.roots.length > 0 && item.roots.every(root => typeof root === 'string' && path.isAbsolute(root)) || item.legacy === true && typeof item.root === 'string' && path.isAbsolute(item.root))), '工作区登记项格式无效');
  return value;
}

function currentProjects(home) {
  try {
    const file = path.join(path.resolve(home), '.codex-global-state.json'), info = fs.lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024 * 1024) return null;
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const projects = state?.['local-projects'];
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;
    return projects;
  } catch { return null; }
}

function write(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function locked(home, action) {
  const dir = checkedDirectory(home, true);
  const lock = lockFor(home);
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('工作区注册表已有操作持锁；确认后再处理锁文件'); throw error; }
  try { return action(fileFor(home)); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export function listWorkspaces(home) {
  checkedDirectory(home);
  const data = read(fileFor(home));
  const entries = data.schema_version === 1 ? data.workspaces : data.workspaces.flatMap(item => item.legacy ? [item] : item.roots.map(root => ({ ...item, root })));
  return entries.map(item => ({ ...(item.id ? { id: item.id } : {}), root: item.root, enabled: item.enabled === true, exists: (() => { try { return fs.realpathSync(item.root) === item.root && fs.statSync(item.root).isDirectory(); } catch { return false; } })() }));
}
export function workspaceEntry(home, value) {
  checkedDirectory(home);
  const root = exactRoot(value);
  const data = read(fileFor(home));
  const entry = data.workspaces.find(item => item.root === root || item.id && item.roots.some(member => member === root));
  return entry ? { ...entry, ...(entry.id ? { root } : {}) } : null;
}
export const workspaceHash = entry => crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');

export function registerWorkspace(home, value, options = {}) {
  const root = exactRoot(value);
  ensure(options && typeof options === 'object' && (options.enabled === undefined || typeof options.enabled === 'boolean'), '工作区启用选项无效');
  return locked(home, file => {
    const data = read(file), found = data.workspaces.find(item => item.root === root);
    if (!found) data.workspaces.push(data.schema_version === 2 ? { root, enabled: options.enabled ?? true, legacy: true } : { root, enabled: options.enabled ?? true });
    write(file, data);
    return { root, enabled: found ? found.enabled === true : (options.enabled ?? true) };
  });
}

export function setWorkspaceEnabled(home, value, enabled, options = {}) {
  ensure(typeof enabled === 'boolean', 'enabled 必须为布尔值');
  const root = exactRoot(value);
  return locked(home, file => {
    const data = read(file), found = data.workspaces.find(item => item.root === root);
    ensure(found || options.create === true, '工作区尚未登记');
    if (options.expectedHash !== undefined) ensure(workspaceHash(found || null) === options.expectedHash, '工作区开关在编辑期间变化，请重新读取后保存');
    const revision = options.revision || crypto.randomUUID();
    if (found) { found.enabled = enabled; found.revision = revision; }
    else data.workspaces.push(data.schema_version === 2 ? { root, enabled, revision, legacy: true } : { root, enabled, revision });
    write(file, data);
    return { root, enabled };
  });
}

export function workspaceEntryById(home, id) {
  checkedDirectory(home);
  ensure(typeof id === 'string' && id.trim(), '必须提供宿主工作区 ID');
  const data = read(fileFor(home));
  if (data.schema_version === 1) return null;
  const item = data.workspaces.find(row => row.id === id);
  return item ? { ...item, roots: [...item.roots] } : null;
}

export function setWorkspaceRecordById(home, record, options = {}) {
  ensure(record && typeof record.id === 'string' && record.id.trim(), '必须提供宿主工作区 ID');
  ensure(Array.isArray(record.roots) && record.roots.length > 0 && record.roots.every(root => typeof root === 'string'), '工作区根目录列表无效');
  ensure(typeof record.enabled === 'boolean', 'enabled 必须为布尔值');
  const checkedRoots = [...new Set(record.roots.map(exactRoot))];
  return locked(home, file => {
    const data = read(file);
    const previousVersion = data.schema_version;
    if (data.schema_version === 1) {
      data.workspaces = data.workspaces.map(item => ({ ...item, legacy: true }));
      data.schema_version = 2;
    }
    const existing = data.workspaces.find(row => row.id === record.id);
    const projects = currentProjects(home), activeIds = projects ? new Set(Object.keys(projects)) : null;
    if (projects) {
      ensure(activeIds.has(record.id), 'Codex 工作区已删除，不能保存其配置');
      const paths = projects[record.id]?.rootPaths;
      ensure(Array.isArray(paths), 'Codex 工作区根目录格式已变化，不能保存配置');
      const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
      const currentRoots = [...new Set(paths.map(value => exactRoot(value)))].map(normalize).sort();
      const requestedRoots = checkedRoots.map(normalize).sort();
      ensure(JSON.stringify(currentRoots) === JSON.stringify(requestedRoots), 'Codex 工作区成员目录已变化，不能保存配置');
    }
    const others = data.workspaces.filter(row => row.id && row.id !== record.id && (!activeIds || activeIds.has(row.id)));
    const rootKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const shared = checkedRoots.find(root => others.some(row => row.roots.some(member => rootKey(member) === rootKey(root))));
    ensure(!shared, `目录同时属于多个 Codex 工作区，不能保存工作区级配置：${shared || ''}`);
    if (options.expectedHash !== undefined) ensure(workspaceHash(existing || null) === options.expectedHash, '工作区配置在编辑期间变化，请重新读取后保存');
    const next = { ...record, roots: checkedRoots, revision: options.revision || crypto.randomUUID() };
    delete next.root;
    if (existing) Object.assign(existing, next);
    else data.workspaces.push(next);
    write(file, data);
    return { ...next, migrated_registry: previousVersion === 1 };
  });
}

export function restoreWorkspaceRecordById(home, id, previous, options = {}) {
  ensure(typeof id === 'string' && id.trim(), '必须提供宿主工作区 ID');
  ensure(previous === null || (previous && previous.id === id && typeof previous.enabled === 'boolean'), '工作区恢复快照无效');
  return locked(home, file => {
    const data = read(file);
    if (data.schema_version === 1) {
      data.workspaces = data.workspaces.map(item => ({ ...item, legacy: true }));
      data.schema_version = 2;
    }
    const index = data.workspaces.findIndex(row => row.id === id);
    if (options.expectedRevision !== undefined) ensure(index >= 0 && data.workspaces[index].revision === options.expectedRevision, '工作区已被其他进程修改，停止回滚并保留外部值');
    if (previous === null) { if (index >= 0) data.workspaces.splice(index, 1); }
    else if (index >= 0) data.workspaces[index] = { ...previous, roots: [...previous.roots] };
    else data.workspaces.push({ ...previous, roots: [...previous.roots] });
    write(file, data);
    return { id, restored: previous !== null };
  });
}

export function setWorkspaceEnabledById(home, id, roots, enabled, options = {}) {
  ensure(typeof id === 'string' && id.trim(), '必须提供宿主工作区 ID');
  ensure(Array.isArray(roots) && roots.length > 0 && roots.every(root => typeof root === 'string'), '工作区根目录列表无效');
  ensure(typeof enabled === 'boolean', 'enabled 必须为布尔值');
  const checkedRoots = [...new Set(roots.map(exactRoot))];
  const previous = workspaceEntryById(home, id);
  return setWorkspaceRecordById(home, { ...(previous || {}), id, roots: checkedRoots, enabled }, options);
}

export function restoreWorkspaceEntry(home, value, previous, options = {}) {
  const root = exactRoot(value);
  ensure(previous === null || (previous && previous.root === root && typeof previous.enabled === 'boolean'), '工作区回滚快照无效');
  return locked(home, file => {
    const data = read(file), index = data.workspaces.findIndex(item => item.root === root);
    if (options.expectedRevision !== undefined) ensure(index >= 0 && data.workspaces[index].revision === options.expectedRevision, '工作区已被其他进程修改，停止回滚并保留外部值');
    if (options.expectedEnabled !== undefined) ensure(index >= 0 && data.workspaces[index].enabled === options.expectedEnabled, '工作区开关已被外部修改，停止回滚并保留外部值');
    if (previous === null) {
      if (index >= 0) data.workspaces.splice(index, 1);
    } else if (index >= 0) data.workspaces[index] = { ...previous };
    else data.workspaces.push({ ...previous });
    write(file, data);
    return { root, restored: previous !== null };
  });
}

export function isRegisteredWorkspace(home, value) {
  checkedDirectory(home);
  let root;
  try { root = exactRoot(value); } catch { return false; }
  return read(fileFor(home)).workspaces.some(item => item.root === root);
}

export function registeredRoot(home, value) {
  checkedDirectory(home);
  const root = exactRoot(value);
  ensure(read(fileFor(home)).workspaces.some(item => item.root === root), '只能操作已登记且当前存在的精确工作区');
  return root;
}
