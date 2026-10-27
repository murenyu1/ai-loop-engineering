import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { listWorkspaces, workspaceHash } from './workspaces.mjs';
import { sortWorkspaces } from './workspace-recency.mjs';

const require = createRequire(import.meta.url);

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = root => process.platform === 'win32' ? root.toLowerCase() : root;
const cleanName = value => typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) : '';
function sortedDiscovery(home, state, workspaces, error, mode) {
  const recency = {};
  return { workspaces: sortWorkspaces(home, state, workspaces, recency), error, mode, recency };
}

function existingRoot(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)) return null;
  try {
    const absolute = path.resolve(value);
    if (fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isDirectory()) return null;
    const root = fs.realpathSync(absolute);
    return identity(root) === identity(absolute) ? root : null;
  } catch { return null; }
}

function nativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const clean = value.replace(/^\\\\\?\\/, '');
  const absolute = path.resolve(clean);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function withinRoots(value, roots) {
  const target = nativePath(value);
  if (!target || !path.isAbsolute(value.replace(/^\\\\\?\\/, ''))) return false;
  return roots.some(root => {
    const allowed = nativePath(root);
    return target === allowed || target.startsWith(allowed + path.sep);
  });
}

function safeRollout(home, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const target = path.resolve(value);
  const allowed = ['sessions', 'archived_sessions'].map(name => path.join(home, name));
  if (!allowed.some(root => target.startsWith(path.resolve(root) + path.sep))) return null;
  let current = path.resolve(home);
  const relative = path.relative(current, target);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) return null; } catch { return null; }
  }
  const info = fs.statSync(target);
  return info.isFile() && info.size > 0 ? target : null;
}

function readRolloutHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    let total = 0, position = 0;
    while (total <= 1024 * 1024) {
      const buffer = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytes) break;
      position += bytes;
      const chunk = buffer.subarray(0, bytes);
      const newline = chunk.indexOf(10);
      const part = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      chunks.push(part); total += part.length;
      if (newline >= 0) return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''));
      if (total > 1024 * 1024) return null;
    }
    return total <= 1024 * 1024 ? JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')) : null;
  } finally { fs.closeSync(fd); }
}

/** Verify a Codex child thread from the read-only thread index and its rollout header. */
export function verifyCodexSubagent(home, { threadId, parentThreadId, roots } = {}) {
  const unavailable = reason => ({ available: false, reason });
  if (typeof threadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(threadId)
    || typeof parentThreadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(parentThreadId)
    || !Array.isArray(roots) || !roots.length) return unavailable('会话身份或工作区不完整');
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const files = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!files.length) return unavailable('Codex 会话索引不可用');
    const database = path.join(home, files[0]);
    if (fs.lstatSync(database).isSymbolicLink()) return unavailable('Codex 会话索引不可用');
    db = new DatabaseSync(database, { readOnly: true });
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
    for (const name of ['id', 'cwd', 'rollout_path', 'source']) if (!columns.has(name)) return unavailable('Codex 会话索引格式不受支持');
    const row = id => db.prepare('SELECT id, cwd, rollout_path, source FROM threads WHERE id = ? LIMIT 1').get(id);
    const child = row(threadId), parent = row(parentThreadId);
    if (!child || !parent || !withinRoots(child.cwd, roots) || !withinRoots(parent.cwd, roots)) return unavailable('子会话或父会话不属于当前工作区');
    let source;
    try { source = JSON.parse(child.source); } catch { return unavailable('子会话来源无法验证'); }
    const spawn = source?.subagent?.thread_spawn;
    if (!spawn || spawn.parent_thread_id !== parentThreadId || !Number.isInteger(spawn.depth) || spawn.depth < 1
      || typeof spawn.agent_path !== 'string' || !spawn.agent_path || !['loop-planner', 'loop-dev', 'loop-tester', 'loop-reviewer', 'loop-scribe'].includes(spawn.agent_role)) return unavailable('子会话父子关系无法验证');
    const rollout = safeRollout(home, child.rollout_path);
    if (!rollout) return unavailable('子会话历史记录路径不安全或不存在');
    let metadata;
    try { metadata = readRolloutHeader(rollout); } catch { return unavailable('子会话历史记录格式无法验证'); }
    const meta = metadata?.type === 'session_meta' ? metadata.payload ?? metadata : null;
    const headerSpawn = meta?.source?.subagent?.thread_spawn;
    if (!meta || (meta.id ?? meta.thread_id) !== threadId
      || meta.parent_thread_id !== parentThreadId || headerSpawn?.parent_thread_id !== parentThreadId
      || !withinRoots(meta.cwd, roots)) return unavailable('子会话历史头部与父会话或工作区不匹配');
    return { available: true, thread_id: threadId, parent_thread_id: parentThreadId, role: spawn.agent_role };
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || error?.code === 'ERR_UNKNOWN_MODULE_REQUEST') return unavailable('当前 Node 不支持只读 Codex 会话索引验证');
    if (error?.code === 'ENOENT' || error?.code === 'SQLITE_ERROR' || error?.code === 'ERR_MODULE_NOT_FOUND') return unavailable('Codex 子会话验证所需数据不可用');
    return unavailable('Codex 子会话元数据不可用');
  } finally { db?.close(); }
}

function stateFile(home) {
  const file = path.join(home, '.codex-global-state.json');
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('状态文件必须是小于 16 MiB 的普通文件');
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!object(value)) throw new Error('状态文件不是对象');
  return value;
}

function savedSettings(home) {
  const rows = listWorkspaces(home);
  const byId = new Map(rows.filter(row => row.id).map(row => [row.id, row]));
  const byRoot = new Map();
  const conflicts = [];
  for (const row of rows.filter(row => row.root && row.id)) {
    const key = identity(row.root), previous = byRoot.get(key);
    if (previous && previous.enabled !== row.enabled) conflicts.push(row.root);
    else byRoot.set(key, row);
  }
  for (const row of rows.filter(item => item.root && !item.id)) {
    const key = identity(row.root);
    if (byRoot.has(key)) continue;
    byRoot.set(key, row);
  }
  return { rows, byId, byRoot, conflicts };
}

// A workspace is the Codex project ID and its full member-root set. Roots never become picker rows.
export function readCodexWorkspaces(home) {
  let error = '', mode = 'codex', workspaces = [];
  let state;
  try { state = stateFile(home); }
  catch (cause) { error = `无法读取 Codex 工作区列表：${cause.code === 'ENOENT' ? '本机桌面状态文件不存在' : cause.message}。`; }
  if (state && Object.hasOwn(state, 'local-projects')) {
    try {
      if (!object(state['local-projects'])) throw new Error('local-projects 格式发生变化');
      const projects = state['local-projects'];
      const order = state['project-order'] === undefined ? [] : state['project-order'];
      if (!Array.isArray(order) || order.some(id => typeof id !== 'string')) throw new Error('project-order 格式发生变化');
      const settings = savedSettings(home);
      const ids = [...new Set([...order, ...Object.keys(projects)])];
      for (const id of ids) {
        const project = projects[id];
        if (!project) continue;
        if (!object(project) || !Array.isArray(project.rootPaths) || project.rootPaths.some(root => typeof root !== 'string')) throw new Error('项目根目录格式发生变化');
        const roots = [...new Map(project.rootPaths.map(existingRoot).filter(Boolean).map(root => [identity(root), root])).values()];
        if (!roots.length) continue;
        const saved = settings.byId.get(id);
        const old = roots.map(root => settings.byRoot.get(identity(root))).filter(Boolean);
        const enabledValues = [...new Set(old.map(row => row.enabled))];
        const conflict = !saved && (settings.conflicts.some(root => roots.some(member => identity(member) === identity(root))) || enabledValues.length > 1);
        const legacyEnabled = old.filter(row => !row.id).map(row => ({ root: row.root, enabled: row.enabled }));
        workspaces.push({
          id, label: cleanName(project.name) || path.basename(roots[0]) || id,
          root: roots[0], roots, enabled: saved?.enabled ?? (conflict ? false : enabledValues[0] ?? false),
          source: 'codex', settings_conflict: conflict, registry_hash: workspaceHash(workspaceRecord(home, id) ?? null), identity_hash: workspaceHash({ record: workspaceRecord(home, id), host_roots: roots, legacy_enabled: legacyEnabled }),
        });
      }
      if (settings.conflicts.length) for (const workspace of workspaces) if (!settings.byId.has(workspace.id) && settings.conflicts.some(root => workspace.roots.some(member => identity(member) === identity(root)))) workspace.settings_conflict = true;
      const memberships = new Map();
      for (const workspace of workspaces) for (const root of workspace.roots) memberships.set(identity(root), [...(memberships.get(identity(root)) || []), workspace.id]);
      for (const workspace of workspaces) workspace.shared_roots = workspace.roots.filter(root => (memberships.get(identity(root)) || []).length > 1);
      return sortedDiscovery(home, state, workspaces, settings.conflicts.length ? `${error}${error ? ' ' : ''}部分旧工作区启用状态冲突，保存新工作区选择后可解决。` : error, 'workspace-id');
    } catch (cause) {
      error = `无法读取 Codex 工作区列表：${cause.message}。`;
      return { workspaces: [], error, mode: 'workspace-id' };
    }
  }
  if (state && !error) {
    try {
      const legacyFields = ['electron-saved-workspace-roots', 'active-workspace-roots'].filter(field => Object.hasOwn(state, field));
      if (!legacyFields.length) throw new Error('未识别此版本的工作区列表格式');
      const settings = savedSettings(home), roots = new Map();
      for (const field of legacyFields) {
        if (!Array.isArray(state[field])) throw new Error(`${field} 格式发生变化`);
        for (const value of state[field]) { const root = existingRoot(value); if (root) roots.set(identity(root), root); }
      }
      workspaces = [...roots.values()].map(root => ({ id: `legacy:${root}`, label: path.basename(root) || root, root, roots: [root], enabled: settings.byRoot.get(identity(root))?.enabled ?? false, source: 'legacy' }));
      mode = 'legacy-root';
    } catch (cause) { error = `无法读取 Codex 工作区列表：${cause.message}。`; }
  }
  return sortedDiscovery(home, state || {}, workspaces, error, mode);
}

function workspaceRecord(home, id) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'ai-loop', 'workspaces.json'), 'utf8')).workspaces.find(row => row.id === id) ?? null; }
  catch { return null; }
}

export function resolveChatWorkspace(home, session) {
  if (typeof session !== 'string' || !session.trim() || session.length > 1000) return null;
  let state;
  try { state = stateFile(home); } catch { return null; }
  const assignment = state['thread-project-assignments']?.[session];
  if (!object(assignment) || assignment.projectKind !== 'local' || typeof assignment.projectId !== 'string') return null;
  const { workspaces } = readCodexWorkspaces(home);
  return workspaces.find(item => item.id === assignment.projectId) ?? null;
}

function disambiguatedLabel(item, all) {
  const sameName = all.filter(other => other.label === item.label);
  return sameName.length > 1 ? `${item.label} · ${item.id}` : item.label;
}
export const workspaceChoice = (item, all = [item]) => `${disambiguatedLabel(item, all)} — ${item.roots?.length > 1 ? `${item.roots.length} 个目录` : item.root} — ${item.enabled ? '🟢 已启用' : '🔴 未启用'}`;
