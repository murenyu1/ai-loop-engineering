import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaces, workspaceHash } from './workspaces.mjs';
import { sortWorkspaces } from './workspace-recency.mjs';

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
