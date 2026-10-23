import fs from 'node:fs';
import crypto from 'node:crypto';
import { assert, safePath, validId, jsonFile } from './lib.mjs';

export const revisionMatches = (a, b) => a?.algorithm === 'sha256' && b?.algorithm === 'sha256' && a.digest === b.digest && a.files === b.files;
export function executionEvidence(root, run, evidence) {
  assert(evidence && ['native-runtime', 'native-log', 'native-ui'].includes(evidence.source), '独立执行须有原生观察来源');
  assert(typeof evidence.path === 'string' && evidence.path.startsWith('reports/'), '原生证据须在本运行 reports/ 中');
  const file = safePath(safePath(root, `.ai-loop/runs/${validId(run)}`), evidence.path);
  assert(fs.statSync(file).isFile() && fs.statSync(file).size > 0, '原生调用证据须为非空普通文件');
  return { source: evidence.source, path: evidence.path, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), verification: 'reported-with-evidence' };
}
export function checkExecution(root, run, report, revision, task, attempt) {
  assert(typeof report.execution_id === 'string', '独立报告缺少 execution_id 原生执行关联');
  validId(report.execution_id);
  const file = safePath(root, `.ai-loop/runs/${validId(run)}/activity.json`);
  assert(fs.existsSync(file), '缺少原生执行台账，不能认定独立评审');
  const data = jsonFile(file);
  assert(data.schema_version === 2 && Array.isArray(data.agents), '原生执行台账格式无效');
  const row = data.agents.find(item => item.id === report.execution_id);
  assert(row && row.run_id === run && row.task === task && row.role === report.role && row.attempt === attempt, '执行记录的运行、任务、角色或 attempt 不匹配');
  assert(row.state === 'completed' && typeof row.native_id === 'string' && row.native_id.trim() && typeof row.harness === 'string' && row.harness.trim(), '独立执行必须有真实原生 ID、宿主及完成观察');
  assert(row.context?.mode === 'independent' && typeof row.context.id === 'string' && row.context.id.trim() && typeof row.context.parent_id === 'string' && row.context.parent_id.trim() && row.context.id !== row.context.parent_id, '独立执行须关联不同的父子上下文');
  assert(!data.agents.some(item => item.role === 'dev' && (item.native_id === row.native_id || item.context?.id === row.context.id)), '开发者上下文不能作为独立评审者');
  assert(revisionMatches(row.revision, revision), '原生执行记录快照已过期');
  const evidence = executionEvidence(root, run, row.evidence);
  assert(evidence.hash === row.evidence.hash, '原生执行证据已变化');
  return { id: row.id, native_id: row.native_id, harness: row.harness, verification: 'reported-with-evidence' };
}
