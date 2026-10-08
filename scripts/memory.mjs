import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUNDLE, assert, validId, rootPath, safePath, jsonFile, atomicWrite, locked, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { status, events } from './loop.mjs';

const NAMES = ['index', 'architecture', 'decisions', 'lessons'];
const STATES = ['confirmed', 'observed', 'unverified', 'superseded'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const cut = (value, size) => typeof value === 'string' ? value.slice(0, size) : null;
const docPath = name => `.ai-loop/memory/${name}.md`;
function text(value, name, size = 2000) {
  assert(nonempty(value) && value.length <= size, `${name} 须为非空文本，且不超过 ${size} 个字符`);
  return value;
}
function file(root, relative, max = 1024 * 1024) {
  const target = safePath(root, relative);
  if (!fs.existsSync(target)) return { path: relative, target, content: null, hash: null };
  const stat = fs.statSync(target);
  assert(stat.isFile() && stat.size <= max, `资料须为普通文件且不超过 ${max} 字节：${relative}`);
  const bytes = fs.readFileSync(target);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('记忆与交接文档须为 UTF-8；先保留原文并明确转换：' + relative); }
  return { path: relative, target, content, hash: hash(bytes) };
}
function fileHash(root, relative) {
  const target = safePath(root, relative);
  if (!fs.existsSync(target)) return null;
  assert(fs.statSync(target).isFile(), '知识引用须为普通文件：' + relative);
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(target, 'r');
  try {
    const buffer = Buffer.allocUnsafe(65536);
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
}
function catalog(root) {
  const item = file(root, '.ai-loop/memory/catalog.json');
  if (item.content === null) return { item, value: { schema_version: 1, revision: 0, documents: {} } };
  const value = jsonFile(item.target);
  assert(value.schema_version === 1 && Number.isInteger(value.revision) && value.revision > 0 && value.documents && typeof value.documents === 'object' && !Array.isArray(value.documents), '知识目录格式损坏，请保留现场并合并恢复');
  for (const [name, document] of Object.entries(value.documents)) {
    assert(NAMES.includes(name) && document.name === name && /^[a-f0-9]{64}$/.test(document.content_hash) && Array.isArray(document.entries), '知识文档元信息无效');
    assert(nonempty(document.summary) && document.entries.length <= 100, '知识文档摘要或条目数量无效');
    const ids = new Set();
    for (const entry of document.entries) {
      validId(entry.id); assert(!ids.has(entry.id), '知识条目编号重复'); ids.add(entry.id);
      assert(STATES.includes(entry.status) && nonempty(entry.title) && nonempty(entry.text) && nonempty(entry.scope) && Array.isArray(entry.sources) && entry.sources.length <= 8, '知识条目字段无效');
      for (const source of entry.sources) validateSource(root, source, false);
    }
  }
  return { item, value };
}
function validateSource(root, source, observe = true) {
  assert(source && typeof source === 'object' && !Array.isArray(source), '知识来源格式无效');
  if (source.type === 'file') {
    text(source.path, '来源路径', 1024); safePath(root, source.path);
    assert(!source.path.startsWith('.ai-loop/memory/'), '知识来源请引用原始项目资料、事件或迁移备份，不能循环引用知识库自身');
    if (!observe) { assert(/^[a-f0-9]{64}$/.test(source.hash), '文件来源摘要无效'); return source; }
    const digest = fileHash(root, source.path); assert(digest, '知识来源文件不存在：' + source.path);
    return { type: 'file', path: source.path, hash: digest };
  }
  if (source.type === 'event') {
    validId(source.run); assert(Number.isInteger(source.seq) && source.seq > 0, '事件来源编号无效');
    if (observe) assert(events(root, source.run, source.seq - 1, 1).events[0]?.seq === source.seq, '知识来源事件不存在');
    return { type: 'event', run: source.run, seq: source.seq };
  }
  if (source.type === 'user') return { type: 'user', text: text(source.text, '已记录用户原意', 1000) };
  assert(source.type === 'url' && typeof source.url === 'string' && source.url.length <= 2048, '未知知识来源类型');
  const url = new URL(source.url);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, '外部来源须为无凭据的 HTTP(S) 链接');
  return { type: 'url', url: source.url }; // 仅记录链接；脚本不联网，也不证明该页面支持结论。
}
function sourceLabel(source) {
  if (source.type === 'file') return '`' + source.path + '`';
  if (source.type === 'event') return `${source.run} 的事件 ${source.seq}`;
  if (source.type === 'user') return '用户确认记录：' + source.text;
  return source.url;
}
function render(document) {
  const labels = { index: '项目知识索引', architecture: '项目架构与接口', decisions: '项目重要决策', lessons: '项目经验' };
  const states = { confirmed: '已确认', observed: '实际观察', unverified: '待核对', superseded: '已撤销或被替代' };
  const header = `# ${labels[document.name]}\n\n${document.summary}\n\n记录仅提供背景，现有用户要求、项目规则和实际源码优先；执行进度以 state.json 为准。\n`;
  const entries = document.entries.map(entry => `\n## ${entry.id}：${entry.title}\n\n- 状态：${states[entry.status]}\n- 适用范围：${entry.scope}\n- 来源：${entry.sources.map(sourceLabel).join('；') || '尚无可核对来源'}\n\n${entry.text}\n`).join('');
  const index = document.name === 'index' ? '\n资料按需读取：memory/architecture.md、memory/decisions.md、memory/lessons.md；文件可尚未创建。运行用 bootstrap 发现，不在此复制执行计数。以上路径相对 .ai-loop/。\n' : '';
  return header + entries + index;
}
function unchanged(root, observations) {
  for (const item of observations) assert(file(root, item.path).hash === item.hash, '资料在读取后发生变化，请重新读取后合并：' + item.path);
}
function transaction(root, changes) {
  const applied = [];
  try {
    for (const item of changes) {
      safePath(root, item.path);
      atomicWrite(item.target, item.updated);
      applied.push(item);
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.content === null) fs.unlinkSync(item.target);
      else atomicWrite(item.target, item.content);
    }
    throw error;
  }
}
function historical(root, item) {
  const target = `.ai-loop/memory/history/${crypto.randomUUID()}/${path.basename(item.path)}`;
  return { ...file(root, target), updated: item.content };
}

export function save(project, input) {
  const root = rootPath(project);
  assert(input && Number.isInteger(input.base_revision) && input.base_revision >= 0 && Array.isArray(input.documents) && input.documents.length > 0 && input.documents.length <= NAMES.length, '知识更新需要 base_revision 和 documents');
  return locked(root, 'memory', () => {
    const loaded = catalog(root);
    assert(input.base_revision === loaded.value.revision, '知识目录已更新，请读取最新 revision 后合并');
    const next = structuredClone(loaded.value);
    const observations = [loaded.item];
    const changes = [];
    const names = new Set();
    for (const patch of input.documents) {
      assert(patch && NAMES.includes(patch.name) && !names.has(patch.name), '知识文档名称未知或重复'); names.add(patch.name);
      const item = file(root, docPath(patch.name)); observations.push(item);
      assert(patch.expected_hash === item.hash, '知识正文已更新；expected_hash 必须对应已读取的当前文件：' + patch.name);
      const old = next.documents[patch.name];
      if (old && item.content !== null && item.hash !== old.content_hash) assert(patch.import_existing === true, '已索引正文含人工修改；先读取并合并，显式 import_existing，不能重建丢弃修改：' + patch.name);
      if (!old && item.content !== null) {
        const initial = fs.readFileSync(safePath(BUNDLE, 'templates/memory-index.md'), 'utf8');
        assert((patch.name === 'index' && item.content === initial) || patch.import_existing === true, '未索引的已有资料需要先读取、保留有效内容，并显式 import_existing：' + patch.name);
      }
      assert(Array.isArray(patch.entries) && patch.entries.length <= 100, '知识条目须为不超过 100 项的数组');
      const entries = new Map((old?.entries || []).map(entry => [entry.id, entry]));
      const patchedIds = new Set();
      for (const entry of patch.entries) {
        validId(entry.id); assert(!patchedIds.has(entry.id), '同批次知识条目编号重复'); patchedIds.add(entry.id);
        text(entry.title, '知识标题', 160); text(entry.text, '知识正文', 4000); text(entry.scope, '适用范围', 400);
        assert(STATES.includes(entry.status) && Array.isArray(entry.sources) && entry.sources.length <= 8 && (entry.status === 'unverified' || entry.sources.length > 0), '知识须有有效状态与来源；猜测须标待核对');
        const sources = entry.sources.map(source => validateSource(root, source));
        entries.set(entry.id, { id: entry.id, title: entry.title, text: entry.text, scope: entry.scope, status: entry.status, sources });
      }
      assert(entries.size <= 100, '单文档条目超过 100 项；先按项目资料组织方式整理，不全量回灌');
      const document = { name: patch.name, summary: text(patch.summary ?? old?.summary, '文档摘要', 1600), entries: [...entries.values()] };
      const content = render(document);
      assert(content.length <= (patch.name === 'index' ? 6000 : 48000), '知识文档超过字符预算；索引保留必要约束和指针，详细知识整理到相关项目文档');
      document.content_hash = hash(content);
      next.documents[patch.name] = document;
      if (content !== item.content) {
        if (item.content !== null) changes.push(historical(root, item));
        changes.push({ ...item, updated: content });
      }
    }
    if (JSON.stringify(next.documents) === JSON.stringify(loaded.value.documents) && !changes.length) return { status: 'unchanged', revision: next.revision, documents: [...names] };
    next.revision++; next.updated_at = now();
    const encoded = JSON.stringify(next, null, 2) + '\n';
    assert(Buffer.byteLength(encoded) <= 1024 * 1024, '知识目录超过 1 MiB；先整理来源指针和过时资料');
    unchanged(root, observations);
    // 来源文件也需仍对应本次实际观察，不把变化中的内容标为有效来源。
    for (const name of names) for (const entry of next.documents[name].entries) if (patchedEntry(input, name, entry.id)) for (const source of entry.sources) if (source.type === 'file') assert(fileHash(root, source.path) === source.hash, '来源文件在记录期间变化，请重新核对：' + source.path);
    changes.push({ ...loaded.item, updated: encoded });
    transaction(root, changes);
    return { status: 'saved', revision: next.revision, documents: [...names], history: changes.filter(item => item.path.includes('/history/')).map(item => item.path) };
  });
}
function patchedEntry(input, name, id) { return input.documents.find(document => document.name === name)?.entries.some(entry => entry.id === id); }

function sourceIssues(root, source, cache = new Map()) {
  const key = JSON.stringify(source);
  if (cache.has(key)) return cache.get(key);
  const issue = uncachedSourceIssue(root, source);
  cache.set(key, issue);
  return issue;
}
function uncachedSourceIssue(root, source) {
  if (source.type === 'file') {
    const digest = fileHash(root, source.path);
    return digest === null ? { type: 'missing-reference', path: source.path } : digest !== source.hash ? { type: 'changed-reference', path: source.path } : null;
  }
  if (source.type === 'event') {
    if (!fs.existsSync(safePath(root, '.ai-loop/runs/' + source.run + '/state.json'))) return { type: 'missing-event-run', run: source.run };
    const selected = events(root, source.run, source.seq - 1, 1).events[0];
    return selected?.seq === source.seq ? null : { type: 'missing-event', run: source.run, seq: source.seq };
  }
  return null;
}
export function inspect(project) {
  const root = rootPath(project);
  const { value } = catalog(root);
  const documents = [];
  const sourceCache = new Map();
  for (const name of NAMES) {
    const item = file(root, docPath(name));
    const record = value.documents[name];
    if (!record && item.content === null) continue;
    const issues = [];
    if (!record) issues.push({ type: 'unindexed-document' });
    else {
      if (item.content === null) issues.push({ type: 'missing-document' });
      else if (item.hash !== record.content_hash) issues.push({ type: 'edited-document' });
      for (const entry of record.entries) {
        if (entry.status === 'superseded') continue;
        for (const source of entry.sources) {
          const issue = sourceIssues(root, source, sourceCache);
          if (issue) issues.push({ ...issue, entry: entry.id });
        }
      }
    }
    documents.push({ name, path: item.path, hash: item.hash, indexed: Boolean(record), issues });
  }
  return { revision: value.revision, status: !Object.keys(value.documents).length ? 'uninitialized' : documents.some(document => document.issues.length) ? 'needs-check' : 'ready', index: docPath('index'), documents };
}
function list(value, name, max = 30) {
  assert(Array.isArray(value) && value.length <= max && value.every(item => nonempty(item) && item.length <= 2000), `${name} 须为最多 ${max} 条非空短文本`);
  return value;
}
function runState(root, run) {
  const state = status(root, run);
  assert(['active', 'complete', 'stopped'].includes(state.status) && Number.isInteger(state.event_seq) && state.event_seq >= 0, '运行状态字段无效');
  const lines = fs.readFileSync(safePath(root, '.ai-loop/runs/' + run + '/events.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const last = lines.length ? JSON.parse(lines.at(-1)) : null;
  assert((last?.seq || 0) === state.event_seq, '运行状态与事件不一致，停止并人工恢复');
  return state;
}
function checkpointInfo(root, state) {
  const prefix = `.ai-loop/runs/${state.run_id}`;
  const session = file(root, prefix + '/session.md');
  const item = file(root, prefix + '/checkpoint.json');
  const issues = [];
  if (session.content === null) issues.push({ type: 'missing-session' });
  let cursor = 0;
  if (item.content === null) issues.push({ type: 'missing-checkpoint', detail: '旧运行或尚未整理交接；保留现有 session，补读必要事件' });
  else {
    const checkpoint = jsonFile(item.target);
    assert(checkpoint.schema_version === 1 && checkpoint.run_id === state.run_id && Number.isInteger(checkpoint.event_cursor) && checkpoint.event_cursor >= 0 && checkpoint.event_cursor <= state.event_seq && /^[a-f0-9]{64}$/.test(checkpoint.session_hash), '交接元信息无效，不能当作恢复依据');
    text(checkpoint.intent, '交接意图'); text(checkpoint.updated_at, '交接时间', 100);
    list(checkpoint.constraints, '约束'); list(checkpoint.decisions, '决策'); list(checkpoint.open_questions, '未决问题'); list(checkpoint.next_steps, '下一步');
    assert(checkpoint.next_steps.length && Array.isArray(checkpoint.references) && checkpoint.references.length <= 30, '交接下一步或资料引用无效');
    if (session.hash !== checkpoint.session_hash) issues.push({ type: 'edited-session' });
    cursor = checkpoint.event_cursor;
    if (cursor < state.event_seq) issues.push({ type: 'events-pending', count: state.event_seq - cursor });
    for (const relative of checkpoint.references) {
      safePath(root, relative);
      if (!fs.existsSync(safePath(root, relative))) issues.push({ type: 'missing-reference', path: relative });
      else assert(fs.statSync(safePath(root, relative)).isFile(), '交接引用不是普通文件：' + relative);
    }
  }
  return { status: issues.length ? 'needs-check' : 'ready', path: session.path, expected_hash: session.hash, event_cursor: cursor, event_head: state.event_seq, issues };
}
function renderSession(run, input) {
  const section = (title, values) => `\n## ${title}\n\n${values.length ? values.map(value => '- ' + value).join('\n') : '- 无已记录内容'}\n`;
  return `# 会话交接：${run}\n\n用户意图：${input.intent}\n\n当前阶段、计数、停止原因与验证状态以 .ai-loop/runs/${run}/state.json 为准。\n本交接记录到事件 ${input.event_cursor}；读取后续事件，不复制全量日志。\n` + section('仍有效的约束', input.constraints) + section('已确认决策与原因', input.decisions) + section('未决问题', input.open_questions) + section('下一步', input.next_steps) + section('关键资料（相对项目根）', input.references);
}
export function checkpoint(project, run, input) {
  const root = rootPath(project); validId(run);
  return locked(root, 'run-' + run, () => {
    const state = runState(root, run);
    const info = checkpointInfo(root, state);
    assert(input && input.expected_session_hash === info.expected_hash && input.base_cursor === info.event_cursor, '交接已变化；先读取当前正文、hash 与 event_cursor 再合并');
    assert(Number.isInteger(input.event_cursor) && input.event_cursor >= info.event_cursor && input.event_cursor <= state.event_seq, '交接游标不能回退或越过实际事件');
    text(input.intent, '交接意图');
    list(input.constraints, '约束'); list(input.decisions, '决策'); list(input.open_questions, '未决问题'); list(input.next_steps, '下一步');
    assert(input.next_steps.length, '交接必须说明下一步，包括等待条件或已交付');
    assert(Array.isArray(input.references) && input.references.length <= 30 && new Set(input.references).size === input.references.length, '关键资料引用无效或重复');
    for (const relative of input.references) assert(fileHash(root, relative), '交接引用文件不存在：' + relative);
    const content = renderSession(run, input);
    assert(content.length <= 12000, '交接超过字符预算；保留约束、未决问题与资料指针');
    const prefix = `.ai-loop/runs/${run}`;
    const session = file(root, prefix + '/session.md');
    const metadata = file(root, prefix + '/checkpoint.json');
    const desired = { schema_version: 1, run_id: run, event_cursor: input.event_cursor, intent: input.intent, constraints: input.constraints, decisions: input.decisions, open_questions: input.open_questions, next_steps: input.next_steps, references: input.references, session_hash: hash(content) };
    const old = metadata.content === null ? null : JSON.parse(metadata.content);
    if (session.content === content && old && JSON.stringify({ ...old, updated_at: undefined }) === JSON.stringify(desired)) return { status: 'unchanged', run_id: run, event_cursor: info.event_cursor };
    desired.updated_at = now();
    const changes = [];
    if (session.content !== null && session.content !== content) {
      const backup = file(root, `${prefix}/handoffs/${crypto.randomUUID()}.md`);
      changes.push({ ...backup, updated: session.content });
    }
    changes.push({ ...session, updated: content }, { ...metadata, updated: JSON.stringify(desired, null, 2) + '\n' });
    unchanged(root, [session, metadata]);
    transaction(root, changes);
    return { status: input.event_cursor < state.event_seq ? 'events-pending' : 'saved', run_id: run, event_cursor: input.event_cursor, event_head: state.event_seq, history: changes.filter(item => item.path.includes('/handoffs/')).map(item => item.path) };
  });
}
function compactRun(root, run) {
  const state = runState(root, run);
  const blocked = state.tasks.some(task => task.phase === 'blocked');
  const checkpoint = checkpointInfo(root, state);
  const boundedCheckpoint = { ...checkpoint, issue_count: checkpoint.issues.length, issues: checkpoint.issues.slice(0, 5) };
  return {
    run_id: run, goal: cut(state.goal, 240), status: state.status,
    continuation: state.status !== 'active' ? 'closed' : blocked ? 'resolve-blocker' : 'candidate',
    task_counts: state.tasks.reduce((counts, task) => { counts[task.phase] = (counts[task.phase] || 0) + 1; return counts; }, {}),
    focus: state.tasks.filter(task => task.phase !== 'done' && task.phase !== 'pending').slice(0, 3).map(task => ({ id: task.id, title: cut(task.title, 160), phase: task.phase, fixes: task.fixes, reason: cut(task.reason, 240) })),
    checkpoint: boundedCheckpoint, snapshot_status: 'unchecked',
  };
}
export function bootstrap(project, options = {}) {
  const root = rootPath(project);
  const intent = options.intent || 'inspect';
  assert(['continue', 'new', 'inspect'].includes(intent), '启动 intent 须为 continue / new / inspect');
  assert(intent !== 'new' || !options.run, '新需求不能指定旧运行作为恢复目标');
  const limit = options.limit ?? 10;
  assert(Number.isInteger(limit) && limit > 0 && limit <= 30, '启动分页 limit 须为 1–30');
  if (options.after) validId(options.after);
  if (options.run) validId(options.run);
  const directory = safePath(root, '.ai-loop/runs');
  const ids = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  assert(ids.length <= 10000, '运行目录超过 10000 项；先明确归档方案');
  const runs = [];
  for (const id of ids) {
    validId(id);
    assert(fs.statSync(safePath(root, '.ai-loop/runs/' + id)).isDirectory(), '运行条目不是目录：' + id);
    const state = status(root, id);
    assert(['active', 'complete', 'stopped'].includes(state.status), '运行状态字段无效');
    if (state.status === 'active') runs.push(compactRun(root, id));
  }
  let selected = null;
  if (options.run) {
    const candidate = compactRun(root, options.run);
    selected = { run_id: candidate.run_id, action: candidate.continuation === 'closed' ? 'do-not-resume' : candidate.continuation === 'resolve-blocker' ? 'resolve-blocker' : candidate.checkpoint.status === 'ready' ? 'check-project-before-continuing' : 'refresh-handoff-before-continuing', run: candidate };
  } else if (intent === 'continue' && runs.length === 1) {
    const candidate = runs[0];
    selected = { run_id: candidate.run_id, action: candidate.continuation === 'resolve-blocker' ? 'resolve-blocker' : candidate.checkpoint.status === 'ready' ? 'check-project-before-continuing' : 'refresh-handoff-before-continuing' };
  }
  const listed = runs.filter(run => run.run_id !== options.run && (!options.after || run.run_id > options.after));
  const visible = listed.slice(0, limit);
  const remaining = listed.length > visible.length;
  const memory = inspect(root);
  // 启动输出只给短状态和路径，不把知识正文、已完成历史或报告回灌给模型。
  const memorySummary = { status: memory.status, revision: memory.revision, index: memory.index, documents: memory.documents.map(document => ({ name: document.name, path: document.path, indexed: document.indexed, issue_count: document.issues.length, issues: document.issues.slice(0, 5) })) };
  return { intent, memory: memorySummary, active_count: runs.length, runs: visible, selected, needs_choice: !options.run && intent === 'continue' && runs.length > 1, next_after: remaining ? visible.at(-1)?.run_id : null, snapshot_status: 'unchecked', warning: '启动仅发现记录，不自动执行、恢复或证明代码与证据有效；知识记录不代替项目规则和权限。' };
}
export function search(project, query, limit = 8) {
  const root = rootPath(project); text(query, '检索词', 200);
  assert(Number.isInteger(limit) && limit > 0 && limit <= 20, '检索 limit 须为 1–20');
  const { value } = catalog(root);
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = [];
  const identical = new Map();
  for (const document of Object.values(value.documents)) {
    const item = file(root, docPath(document.name));
    assert(item.hash === document.content_hash, '知识正文已被修改，先合并再检索：' + document.name);
    for (const entry of document.entries) {
      if (entry.status === 'superseded') continue;
      const content = [entry.title, entry.text, entry.scope].join(' ').toLocaleLowerCase();
      const score = terms.filter(term => content.includes(term)).length;
      if (score) {
        const key = JSON.stringify([entry.title, entry.text, entry.scope, entry.status, entry.sources]);
        if (identical.has(key)) identical.get(key).also_in.push({ document: document.name, id: entry.id });
        else {
          const match = { score, document: document.name, id: entry.id, title: entry.title, status: entry.status, scope: entry.scope, text: cut(entry.text, 1200), sources: entry.sources.slice(0, 4).map(source => cut(sourceLabel(source), 240)), source_count: entry.sources.length, also_in: [] };
          found.push(match); identical.set(key, match);
        }
      }
    }
  }
  found.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const matches = [];
  let size = 0;
  for (const match of found.slice(0, limit)) {
    const length = JSON.stringify(match).length;
    if (size + length > 8000) break;
    matches.push(match); size += length;
  }
  return { query, matches, truncated: found.length > matches.length, warning: '摘要可能截断，重要约束按文件核对；来源可能过期，使用前运行 inspect 并核对实际资料。' };
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'run', 'input', 'intent', 'limit', 'after', 'query', 'help']);
  const [command] = options._;
  assert(options._.length <= 1, '记忆工具只能指定一个命令');
  if (options.help || !command) return { commands: 'bootstrap / inspect / save / checkpoint / search', usage: 'node HOME/scripts/memory.mjs COMMAND --project ROOT [--intent continue|new|inspect] [--run ID] [--input FILE]' };
  const input = () => { assert(typeof options.input === 'string', '该命令需要 --input JSON 文件'); return jsonFile(path.resolve(options.input)); };
  if (command === 'bootstrap') return bootstrap(options.project, { intent: options.intent, run: options.run, after: options.after, ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}) });
  if (command === 'inspect') return inspect(options.project);
  if (command === 'save') return save(options.project, input());
  if (command === 'checkpoint') return checkpoint(options.project, options.run, input());
  if (command === 'search') return search(options.project, options.query, options.limit === undefined ? 8 : Number(options.limit));
  throw new Error('未知记忆命令，请查看 --help');
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
