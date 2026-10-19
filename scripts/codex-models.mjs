import crypto from 'node:crypto';
import { assert } from './lib.mjs';
import { rootString, updateRootString } from './toml.mjs';
import { balanced, validateProfile, routeHash } from './routing.mjs';

const START = '# ai-loop-models:start';
const END = '# ai-loop-models:end';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function managedBlock(text) {
  const starts = [...text.matchAll(/^# ai-loop-models:start\r?$/gm)];
  const ends = [...text.matchAll(/^# ai-loop-models:end\r?$/gm)];
  assert(starts.length === ends.length && starts.length <= 1, 'Codex 模型管理标记损坏或重复，停止合并');
  if (!starts.length) return null;
  const start = starts[0].index;
  const end = ends[0].index + ends[0][0].length;
  assert(start < ends[0].index, 'Codex 模型管理标记顺序错误');
  return { start, end, text: text.slice(start, end) };
}
export function configureModels(text, previous, requested = balanced('codex')) {
  const old = managedBlock(text);
  if (previous) assert(old && digest(old.text) === previous.block_hash, 'Codex 模型管理块已被人工修改或移除，停止覆盖');
  else assert(!old, '发现未注册的 Codex 模型管理块，停止接管');
  const outside = old ? text.slice(0, old.start) + text.slice(old.end) : text;
  assert(!/^\s*(?:\[\[?\s*["']?agents(?:["']?\s*[.\]])|["']?agents["']?\s*[.=])/m.test(outside), '已有未注册的 agents 配置，先明确合并方案，停止覆盖');
  const profile = validateProfile(requested, 'codex');
  const before = previous?.profile || balanced('codex');
  for (const [key, field] of [['model', 'model'], ['model_reasoning_effort', 'effort']]) {
    const current = rootString(text, key);
    if (previous) assert(current?.value === before.main[field], `Codex ${key} 已被人工修改，停止覆盖`);
    else assert(!current || current.value === profile.main[field], `Codex ${key} 与模型分工冲突，停止覆盖`);
    text = updateRootString(text, key, () => profile.main[field]);
  }
  const block = [START, '[agents]', 'enabled = true',
    `default_subagent_model = ${JSON.stringify(profile.roles.dev.model)}`,
    ...(profile.roles.dev.effort === null ? [] : [`default_subagent_reasoning_effort = ${JSON.stringify(profile.roles.dev.effort)}`]),
    `max_concurrent_threads_per_session = ${profile.concurrency}`, END].join('\n');
  const current = managedBlock(text);
  text = current ? text.slice(0, current.start) + block + text.slice(current.end) : text + (text.endsWith('\n') ? '' : '\n') + '\n' + block + '\n';
  return { text, record: { mode: 'custom', format: 'native-v2', block_hash: digest(block), profile, profile_hash: routeHash(profile) } };
}
