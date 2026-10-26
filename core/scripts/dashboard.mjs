import { rootPath, assert } from './lib.mjs';
import { listRuns, status } from './loop.mjs';
import { activityStatus } from './activity.mjs';

const encodeCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const compareRunKey = (left, right) => compareText(left.created_at, right.created_at) || compareText(left.project_path ?? '.', right.project_path ?? '.') || compareText(left.run_id, right.run_id);
function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  assert(typeof value === 'string' && value.length <= 2048, '历史游标无效');
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    assert(cursor && typeof cursor.created_at === 'string' && typeof cursor.run_id === 'string', '历史游标无效');
    return cursor;
  } catch { throw new Error('历史游标无效'); }
}

/** Read run history bound to one host session. Unbound legacy activity is counted, never attributed. */
export function chatHistory(project, { session_id, harness, project_path, limit = 20, after } = {}) {
  const root = rootPath(project);
  assert(typeof session_id === 'string' && session_id.trim().length > 0 && session_id.length <= 1000, '必须提供有效 session_id');
  assert(typeof harness === 'string' && harness.trim().length > 0 && harness.length <= 100, '必须提供有效 harness');
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, '历史数量须为 1–100');
  const cursor = decodeCursor(after);
  const runs = listRuns(root, { project_path }).map(run => {
    const options = { project_path: run.project_path };
    const current = status(root, run.run_id, options);
    const activity = activityStatus(root, run.run_id, options);
    const hostAgents = activity.agents.filter(agent => agent.harness === harness);
    const agents = hostAgents.filter(agent => agent.context?.parent_id === session_id);
    const unbound = hostAgents.filter(agent => !agent.context?.parent_id).length;
    return {
      run: { ...current, created_at: run.created_at ?? run.updated_at ?? '' },
      activity: { ...activity, agents },
      unbound,
    };
  });
  const ordered = runs.sort((a, b) => -compareRunKey(a.run, b.run));
  const unbound_count = ordered.filter(item => item.unbound > 0).length;
  const unbound_activity_count = ordered.reduce((sum, item) => sum + item.unbound, 0);
  const matching = ordered.filter(item => item.activity.agents.length > 0 && (!cursor
    || compareRunKey(item.run, cursor) < 0));
  const page = matching.slice(0, limit);
  const hasMore = matching.length > page.length;
  const last = page.at(-1);
  const rounds = page.map(({ unbound: _unbound, ...round }) => round);
  return {
    rounds,
    unbound_count,
    unbound_activity_count,
    next_after: hasMore && last ? encodeCursor({ created_at: last.run.created_at, run_id: last.run.run_id, project_path: last.run.project_path }) : null,
  };
}
