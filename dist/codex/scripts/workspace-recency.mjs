import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const normalize = root => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);

// Optional desktop data: old Node versions or unavailable databases keep a stable order.
export function sortWorkspaces(home, state, workspaces) {
  const recent = new Map();
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const files = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (files.length) {
      const file = path.join(home, files[0]);
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('不读取链接数据库');
      db = new DatabaseSync(file, { readOnly: true });
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
      const times = ['recency_at_ms', 'recency_at', 'updated_at_ms', 'updated_at'].filter(name => columns.has(name));
      if (times.length && columns.has('id') && columns.has('cwd')) {
        const used = `COALESCE(${times.map(name => name.endsWith('_ms') ? name : `${name} * 1000`).join(', ')}, 0)`;
        const where = [columns.has('archived') ? 'archived = 0' : '1', columns.has('has_user_event') ? 'has_user_event = 1' : '1'].join(' AND ');
        for (const row of db.prepare(`SELECT id, cwd, ${used} AS used FROM threads WHERE ${where}`).all()) {
          if (Array.isArray(state['projectless-thread-ids']) && state['projectless-thread-ids'].includes(row.id)) continue;
          const assignment = state['thread-project-assignments']?.[row.id];
          let workspace;
          if (assignment) {
            if (assignment.projectKind !== 'local') continue;
            workspace = workspaces.find(item => item.id === assignment.projectId);
          } else if (typeof row.cwd === 'string' && path.isAbsolute(row.cwd)) {
            const cwd = normalize(row.cwd);
            const candidates = workspaces.flatMap(item => item.roots.filter(root => cwd === normalize(root) || cwd.startsWith(normalize(root) + path.sep)).map(root => ({ item, length: root.length }))).sort((a, b) => b.length - a.length);
            if (candidates.length && !candidates.some(other => other.length === candidates[0].length && other.item.id !== candidates[0].item.id)) workspace = candidates[0].item;
          }
          if (workspace && Number.isFinite(row.used)) recent.set(workspace.id, Math.max(recent.get(workspace.id) || 0, row.used));
        }
      }
    }
  } catch { /* Never write desktop data or guess usage from project updatedAt. */ }
  finally { db?.close(); }
  return workspaces.map(item => ({ ...item, last_used_at: recent.get(item.id) || null }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.last_used_at || 0) - (a.last_used_at || 0));
}
