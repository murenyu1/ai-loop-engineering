import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaces } from './workspaces.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = root => process.platform === 'win32' ? root.toLowerCase() : root;

function existingRoot(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)) return null;
  try {
    const absolute = path.resolve(value);
    if (fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isDirectory()) return null;
    const root = fs.realpathSync(absolute);
    return identity(root) === identity(absolute) ? root : null;
  } catch { return null; }
}

// Codex 桌面本机格式适配层。仅提取项目名称和根目录，不写回桌面状态。
export function readCodexWorkspaces(home) {
  const entries = new Map();
  const registered = listWorkspaces(home);
  let error = '';
  const add = (value, label, source) => {
    const root = existingRoot(value);
    if (!root) return;
    const key = identity(root);
    if (entries.has(key)) return;
    const saved = registered.find(item => identity(item.root) === key);
    const name = typeof label === 'string' ? label.replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) : '';
    entries.set(key, { root, label: name || path.basename(root) || root, enabled: saved?.enabled ?? false, source });
  };
  try {
    const file = path.join(home, '.codex-global-state.json');
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('状态文件必须是小于 16 MiB 的普通文件');
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!object(state)) throw new Error('状态文件不是对象');
    let recognized = false;
    if (Object.hasOwn(state, 'local-projects')) {
      if (!object(state['local-projects'])) throw new Error('local-projects 格式发生变化');
      recognized = true;
      const projects = state['local-projects'];
      const order = Array.isArray(state['project-order']) ? state['project-order'].filter(id => typeof id === 'string') : [];
      const ids = [...new Set([...order, ...Object.keys(projects)])];
      for (const id of ids) {
        const project = projects[id];
        if (!project) continue;
        if (!object(project) || !Array.isArray(project.rootPaths)) throw new Error('项目根目录格式发生变化');
        for (const root of project.rootPaths) add(root, project.name, 'codex');
      }
    }
    for (const field of ['electron-saved-workspace-roots', 'active-workspace-roots']) {
      if (!Object.hasOwn(state, field)) continue;
      if (!Array.isArray(state[field])) throw new Error(`${field} 格式发生变化`);
      recognized = true;
      for (const root of state[field]) add(root, null, 'codex');
    }
    if (!recognized) throw new Error('未识别此版本的工作区列表格式');
  } catch (cause) {
    // 部分解析结果不展示，避免把格式异常误报为完整列表。
    entries.clear();
    error = `无法读取 Codex 工作区列表：${cause.code === 'ENOENT' ? '本机桌面状态文件不存在' : cause.message}。`;
  }
  for (const item of registered) if (item.exists) add(item.root, null, 'registered');
  return { workspaces: [...entries.values()], error };
}

export const workspaceChoice = item => `${item.label} — ${item.root}`;
