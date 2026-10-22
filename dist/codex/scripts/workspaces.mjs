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
  if (!fs.existsSync(file)) return { schema_version: 1, workspaces: [] };
  ensure(!fs.lstatSync(file).isSymbolicLink(), '工作区注册表不能是符号链接');
  ensure(fs.statSync(file).isFile() && fs.statSync(file).size <= 1024 * 1024, '工作区注册表必须是小于 1 MiB 的普通文件');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  ensure(value?.schema_version === 1 && Array.isArray(value.workspaces), '工作区注册表格式无效');
  ensure(value.workspaces.every(item => item && typeof item.root === 'string' && path.isAbsolute(item.root) && typeof item.enabled === 'boolean'), '工作区登记项格式无效');
  return value;
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
  const entries = read(fileFor(home)).workspaces;
  return entries.map(item => ({ root: item.root, enabled: item.enabled === true, exists: (() => { try { return fs.realpathSync(item.root) === item.root && fs.statSync(item.root).isDirectory(); } catch { return false; } })() }));
}
export function workspaceEntry(home, value) {
  checkedDirectory(home);
  const root = exactRoot(value);
  const entry = read(fileFor(home)).workspaces.find(item => item.root === root);
  return entry ? { ...entry } : null;
}
export const workspaceHash = entry => crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');

export function registerWorkspace(home, value, options = {}) {
  const root = exactRoot(value);
  ensure(options && typeof options === 'object' && (options.enabled === undefined || typeof options.enabled === 'boolean'), '工作区启用选项无效');
  return locked(home, file => {
    const data = read(file), found = data.workspaces.find(item => item.root === root);
    if (!found) data.workspaces.push({ root, enabled: options.enabled ?? true });
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
    else data.workspaces.push({ root, enabled, revision });
    write(file, data);
    return { root, enabled };
  });
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
