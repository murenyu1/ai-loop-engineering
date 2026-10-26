import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BUNDLE, resourceRelative, assert, validId, rootPath, safePath, jsonFile, atomicWrite, locked, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { status, events, listRuns } from './loop.mjs';
import { loadCatalog, encodeCatalog, pagedView, verifyPages } from './memory-store.mjs';
import { resolveRunBase, runPaths, relativeRunPath, projectBase } from './storage.mjs';

const NAMES = ['index', 'architecture', 'decisions', 'lessons'];
const STATES = ['confirmed', 'observed', 'unverified', 'superseded'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const cut = (value, size) => typeof value === 'string' ? value.slice(0, size) : null;
const sameProjectPath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
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
  const value = loadCatalog(root, item);
  assert(value.schema_version === 1 && Number.isInteger(value.revision) && value.revision > 0 && value.documents && typeof value.documents === 'object' && !Array.isArray(value.documents), '知识目录格式损坏，请保留现场并合并恢复');
  for (const [name, document] of Object.entries(value.documents)) {
    assert(NAMES.includes(name) && document.name === name && /^[a-f0-9]{64}$/.test(document.content_hash) && Array.isArray(document.entries), '知识文档元信息无效');
    assert(nonempty(document.summary), '知识文档摘要无效');
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
    const stage = (relative, content) => {
      const item = file(root, relative);
      if (item.content !== null) assert(item.content === content, '不可变记录被修改；保留现场并合并：' + relative);
      else changes.push({ ...item, updated: content });
    };
    const names = new Set();
    for (const patch of input.documents) {
      assert(patch && NAMES.includes(patch.name) && !names.has(patch.name), '知识文档名称未知或重复'); names.add(patch.name);
      const item = file(root, docPath(patch.name)); observations.push(item);
      assert(patch.expected_hash === item.hash, '知识正文已更新；expected_hash 必须对应已读取的当前文件：' + patch.name);
      const old = next.documents[patch.name];
      const pageIssues = verifyPages(root, old?.pages);
      assert(!pageIssues.length || patch.import_existing === true, '知识正文分页含人工修改或缺失；先读取并合并，显式 import_existing：' + patch.name);
      for (const issue of pageIssues) {
        const existing = file(root, issue.path); observations.push(existing);
        if (existing.content !== null) changes.push(historical(root, existing));
      }
      if (old && item.content !== null && item.hash !== old.content_hash) assert(patch.import_existing === true, '已索引正文含人工修改；先读取并合并，显式 import_existing，不能重建丢弃修改：' + patch.name);
      if (!old && item.content !== null) {
        const initial = fs.readFileSync(safePath(BUNDLE, resourceRelative(BUNDLE, 'templates/memory-index.md')), 'utf8');
        assert((patch.name === 'index' && item.content === initial) || patch.import_existing === true, '未索引的已有资料需要先读取、保留有效内容，并显式 import_existing：' + patch.name);
      }
      assert(Array.isArray(patch.entries) && patch.entries.length <= 100, '知识条目须为不超过 100 项的数组');
      const entries = new Map((old?.entries || []).map(entry => [entry.id, entry]));
      const patchedIds = new Set();
      for (const entry of patch.entries) {
        validId(entry.id); assert(!patchedIds.has(entry.id), '同批次知识条目编号重复'); patchedIds.add(entry.id);
        text(entry.title, '知识标题', 160); text(entry.text, '知识正文', 200000); text(entry.scope, '适用范围', 400);
        assert(STATES.includes(entry.status) && Array.isArray(entry.sources) && entry.sources.length <= 8 && (entry.status === 'unverified' || entry.sources.length > 0), '知识须有有效状态与来源；猜测须标待核对');
        const sources = entry.sources.map(source => validateSource(root, source));
        entries.set(entry.id, { id: entry.id, title: entry.title, text: entry.text, scope: entry.scope, status: entry.status, sources });
      }
      const document = { name: patch.name, summary: text(patch.summary ?? old?.summary, '文档摘要', 1600), entries: [...entries.values()] };
      let content = render(document);
      if (content.length > (patch.name === 'index' ? 6000 : 48000)) {
        document.pages = pagedView(content, `.ai-loop/memory/pages/${patch.name}`, patch.name === 'index' ? 5500 : 12000, stage);
        content = `# ${patch.name}：分页知识索引\n\n${document.summary}\n\n完整正文共 ${document.pages.length} 页，所有条目完整保存，未截断。重要约束需按本次任务核对原文，不能只依据此导航。\n使用 memory.mjs read --document ${patch.name} --page N --project ROOT 分页读取；search 按关键词定位。\n\n` + document.pages.slice(0, 12).map((page, index) => `- 第 ${index + 1} 页：${page.path}`).join('\n') + (document.pages.length > 12 ? '\n- 后续页使用 read 命令定位。\n' : '\n');
      }
      document.content_hash = hash(content);
      next.documents[patch.name] = document;
      if (content !== item.content) {
        if (item.content !== null) changes.push(historical(root, item));
        changes.push({ ...item, updated: content });
      }
    }
    if (isDeepStrictEqual(next.documents, loaded.value.documents) && !changes.length) return { status: 'unchanged', revision: next.revision, documents: [...names] };
    next.revision++; next.updated_at = now();
    const encoded = encodeCatalog(root, next, stage);
    if (loaded.item.content && JSON.parse(loaded.item.content).schema_version === 1) changes.push(historical(root, loaded.item));
    unchanged(root, observations);
    // 来源文件也需仍对应本次实际观察，不把变化中的内容标为有效来源。
    for (const name of names) for (const entry of next.documents[name].entries) if (patchedEntry(input, name, entry.id)) for (const source of entry.sources) if (source.type === 'file') assert(fileHash(root, source.path) === source.hash, '来源文件在记录期间变化，请重新核对：' + source.path);
    changes.push({ ...loaded.item, updated: encoded });
    transaction(root, changes);
    return { status: 'saved', revision: next.revision, documents: [...names], pages: [...names].map(name => ({ name, count: next.documents[name].pages?.length || 0 })), history: changes.filter(item => item.path.includes('/history/')).map(item => item.path) };
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
      issues.push(...verifyPages(root, record.pages));
      for (const entry of record.entries) {
        if (entry.status === 'superseded') continue;
        for (const source of entry.sources) {
          const issue = sourceIssues(root, source, sourceCache);
          if (issue) issues.push({ ...issue, entry: entry.id });
        }
      }
    }
    documents.push({ name, path: item.path, hash: item.hash, indexed: Boolean(record), pages: record?.pages?.length || 0, entries: record?.entries.length || 0, issues });
  }
  return { revision: value.revision, status: !Object.keys(value.documents).length ? 'uninitialized' : documents.some(document => document.issues.length) ? 'needs-check' : 'ready', index: docPath('index'), documents };
}
function list(value, name, max = 30) {
  assert(Array.isArray(value) && value.length <= max && value.every(item => nonempty(item) && item.length <= 2000), `${name} 须为最多 ${max} 条非空短文本`);
  return value;
}
function runState(root, run, projectPath) {
  const options = projectPath !== undefined ? { project_path: projectPath } : {};
  const state = status(root, run, options);
  assert(['active', 'complete', 'stopped'].includes(state.status) && Number.isInteger(state.event_seq) && state.event_seq >= 0, '运行状态字段无效');
  const files = runPaths(root, run, projectPath);
  const lines = fs.readFileSync(files.events, 'utf8').trim().split('\n').filter(Boolean);
  const last = lines.length ? JSON.parse(lines.at(-1)) : null;
  assert((last?.seq || 0) === state.event_seq, '运行状态与事件不一致，停止并人工恢复');
  return state;
}
function checkpointInfo(root, state) {
  const relSession = relativeRunPath(root, state.run_id, 'session.md');
  const relCheckpoint = relativeRunPath(root, state.run_id, 'checkpoint.json');
  const session = file(root, relSession);
  const item = file(root, relCheckpoint);
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
    issues.push(...verifyPages(root, checkpoint.details));
    for (const change of checkpoint.changes || []) {
      safePath(root, change.path);
      if (fileHash(root, change.path) !== change.hash) issues.push({ type: 'changed-code', path: change.path });
    }
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
function renderSession(run, input, statePath = `.ai-loop/runs/${run}/state.json`) {
  const section = (title, values) => `\n## ${title}\n\n${values.length ? values.map(value => '- ' + value).join('\n') : '- 无已记录内容'}\n`;
  return `# 会话交接：${run}\n\n用户意图：${input.intent}\n\n当前阶段、计数、停止原因与验证状态以 ${statePath} 为准。\n本交接记录到事件 ${input.event_cursor}；读取后续事件，不复制全量日志。\n` + section('仍有效的约束', input.constraints) + section('已确认决策与原因', input.decisions) + section('未决问题', input.open_questions) + section('下一步', input.next_steps) + section('本阶段改动与优先读取位置', (input.changes || []).map(change => `${change.path}；符号：${change.symbols.join('、') || '无具名符号'}；原因：${change.reason}；先读：${change.read_first}${change.deleted ? '（已删除）' : ''}`)) + section('关键资料（相对项目根）', input.references);
}
export function changeContext(project, changes = []) {
  const root = rootPath(project);
  assert(Array.isArray(changes) && changes.length <= 100, '改动定位须为不超过 100 项的数组');
  const seen = new Set();
  return changes.map(change => {
    assert(change && typeof change.path === 'string' && !seen.has(change.path), '改动定位路径缺失或重复');
    safePath(root, change.path); seen.add(change.path);
    list(change.symbols, '关键符号', 20);
    text(change.reason, '改动原因', 1000); text(change.read_first, '优先读取位置', 1000);
    assert(change.deleted === undefined || typeof change.deleted === 'boolean', 'deleted 须为布尔值');
    const hash = fileHash(root, change.path);
    assert(change.deleted ? hash === null : hash !== null, '改动文件不存在或删除声明不符：' + change.path);
    return { path: change.path, symbols: change.symbols, reason: change.reason, read_first: change.read_first, deleted: change.deleted === true, hash };
  });
}
export function checkpoint(project, run, input, options = {}) {
  const root = rootPath(project); validId(run);
  const base = resolveRunBase(root, run, options.project_path);
  return locked(base, 'run-' + run, () => {
    const state = runState(root, run, options.project_path);
    const info = checkpointInfo(root, state);
    assert(input && input.expected_session_hash === info.expected_hash && input.base_cursor === info.event_cursor, '交接已变化；先读取当前正文、hash 与 event_cursor 再合并');
    assert(Number.isInteger(input.event_cursor) && input.event_cursor >= info.event_cursor && input.event_cursor <= state.event_seq, '交接游标不能回退或越过实际事件');
    text(input.intent, '交接意图');
    list(input.constraints, '约束'); list(input.decisions, '决策'); list(input.open_questions, '未决问题'); list(input.next_steps, '下一步');
    assert(input.next_steps.length, '交接必须说明下一步，包括等待条件或已交付');
    assert(Array.isArray(input.references) && input.references.length <= 30 && new Set(input.references).size === input.references.length, '关键资料引用无效或重复');
    for (const relative of input.references) assert(fileHash(root, relative), '交接引用文件不存在：' + relative);
    const changesContext = changeContext(root, input.changes);
    const prefix = path.relative(root, runPaths(root, run, options.project_path).directory).split(path.sep).join('/');
    let content = renderSession(run, { ...input, changes: changesContext }, prefix + '/state.json');
    const details = [], staged = [];
    if (content.length > 12000) {
      details.push(...pagedView(content, `${prefix}/handoff-pages`, 10000, (relative, part) => {
        const item = file(root, relative);
        assert(item.content === null || item.content === part, '交接不可变分页被修改：' + relative);
        if (item.content === null) staged.push({ ...item, updated: part });
      }));
      content = `# 会话交接：${run}\n\n用户意图：${input.intent}\n\n完整交接共 ${details.length} 页，全部约束、决策与改动均保留。继续执行前，先读取 checkpoint.json 中 details 指向的交接正文，并按任务定位必要部分。不能把此导航当作完整交接。\n\n下一步：\n${input.next_steps.slice(0, 3).map(item => '- ' + cut(item, 600)).join('\n')}\n\n${details.slice(0, 12).map((page, index) => `- 第 ${index + 1} 页：${page.path}`).join('\n')}\n`;
    }
    const session = file(root, prefix + '/session.md');
    const metadata = file(root, prefix + '/checkpoint.json');
    const desired = { schema_version: 1, run_id: run, event_cursor: input.event_cursor, intent: input.intent, constraints: input.constraints, decisions: input.decisions, open_questions: input.open_questions, next_steps: input.next_steps, references: input.references, changes: changesContext, details, session_hash: hash(content) };
    const old = metadata.content === null ? null : JSON.parse(metadata.content);
    if (session.content === content && old && JSON.stringify({ ...old, updated_at: undefined }) === JSON.stringify(desired)) return { status: 'unchanged', run_id: run, event_cursor: info.event_cursor };
    desired.updated_at = now();
    const changes = [...staged];
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
function compactRun(root, run, projectPath) {
  const state = runState(root, run, projectPath);
  const blocked = state.tasks.some(task => task.phase === 'blocked');
  const checkpoint = checkpointInfo(root, state);
  const boundedCheckpoint = { ...checkpoint, issue_count: checkpoint.issues.length, issues: checkpoint.issues.slice(0, 5) };
  const files = runPaths(root, run, projectPath);
  const recent = fs.readFileSync(files.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const units = new Map();
  for (const event of recent) if (event.type === 'progress') units.set(event.unit, event);
  const open = [...units.values()].filter(unit => unit.stage === 'planned');
  const last = [...units.values()].at(-1);
  return {
    run_id: run, goal: cut(state.goal, 240), status: state.status, project_path: state.project_path ?? '.', snapshot_paths: state.snapshot_paths ?? null,
    continuation: state.status !== 'active' ? 'closed' : blocked ? 'resolve-blocker' : 'candidate',
    task_counts: state.tasks.reduce((counts, task) => { counts[task.phase] = (counts[task.phase] || 0) + 1; return counts; }, {}),
    focus: state.tasks.filter(task => task.phase !== 'done' && task.phase !== 'pending').slice(0, 3).map(task => ({ id: task.id, title: cut(task.title, 160), phase: task.phase, fixes: task.fixes, reason: cut(task.reason, 240) })),
    checkpoint: boundedCheckpoint, snapshot_status: 'unchecked',
    work_units: { open_count: open.length, open: open.slice(0, 3).map(unit => ({ unit: unit.unit, task: unit.task_id, summary: cut(unit.summary, 240), files: unit.files.slice(0, 8).map(item => item.path) })), last: last ? { unit: last.unit, stage: last.stage, summary: cut(last.summary, 240) } : null },
  };
}
export function bootstrap(project, options = {}) {
  const root = rootPath(project);
  const intent = options.intent || 'inspect';
  if (options.project_path !== undefined) assert(options.project_path === '.' || typeof options.project_path === 'string' && !options.project_path.endsWith('/') && safePath(root, options.project_path), '子项目筛选路径无效');
  assert(['continue', 'new', 'inspect'].includes(intent), '启动 intent 须为 continue / new / inspect');
  assert(intent !== 'new' || !options.run, '新需求不能指定旧运行作为恢复目标');
  const limit = options.limit ?? 10;
  assert(Number.isInteger(limit) && limit > 0 && limit <= 30, '启动分页 limit 须为 1–30');
  if (options.after) validId(options.after);
  if (options.run) validId(options.run);
  const allRuns = listRuns(root, { project_path: options.project_path });
  assert(allRuns.length <= 10000, '运行目录超过 10000 项；先明确归档方案');
  const runs = [];
  for (const item of allRuns) {
    if (item.status === 'active') {
      runs.push(compactRun(root, item.run_id, item.project_path));
    }
  }
  let selected = null;
  if (options.run) {
    const candidate = compactRun(root, options.run, options.project_path);
    assert(options.project_path === undefined || sameProjectPath(candidate.project_path, options.project_path), '指定运行不属于筛选子项目');
    selected = { run_id: candidate.run_id, action: candidate.continuation === 'closed' ? 'do-not-resume' : candidate.continuation === 'resolve-blocker' ? 'resolve-blocker' : candidate.checkpoint.status === 'ready' ? 'check-project-before-continuing' : 'refresh-handoff-before-continuing', run: candidate };
  } else if (intent === 'continue' && runs.length === 1) {
    const candidate = runs[0];
    selected = { run_id: candidate.run_id, action: candidate.continuation === 'resolve-blocker' ? 'resolve-blocker' : candidate.checkpoint.status === 'ready' ? 'check-project-before-continuing' : 'refresh-handoff-before-continuing' };
  }
  const listed = runs.filter(run => run.run_id !== options.run && (!options.after || run.run_id > options.after));
  const visible = listed.slice(0, limit);
  const remaining = listed.length > visible.length;
  const memoryBase = options.project_path && options.project_path !== '.' ? projectBase(root, options.project_path) : root;
  const memory = inspect(fs.existsSync(safePath(memoryBase, '.ai-loop/memory')) ? memoryBase : root);
  // 启动输出只给短状态和路径，不把知识正文、已完成历史或报告回灌给模型。
  const memorySummary = { status: memory.status, revision: memory.revision, index: memory.index, documents: memory.documents.map(document => ({ name: document.name, path: document.path, indexed: document.indexed, issue_count: document.issues.length, issues: document.issues.slice(0, 5) })) };
  return { intent, memory: memorySummary, active_count: runs.length, runs: visible, selected, needs_choice: !options.run && intent === 'continue' && runs.length > 1, next_after: remaining ? visible.at(-1)?.run_id : null, snapshot_status: 'unchecked', warning: '启动仅发现记录，不自动执行、恢复或证明代码与证据有效；知识记录不代替项目规则和权限。' };
}
export function search(project, query, limit = 8, after) {
  const root = rootPath(project); text(query, '检索词', 200);
  assert(Number.isInteger(limit) && limit > 0 && limit <= 20, '检索 limit 须为 1–20');
  const { value } = catalog(root);
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = [];
  const identical = new Map();
  for (const document of Object.values(value.documents)) {
    const item = file(root, docPath(document.name));
    assert(item.hash === document.content_hash, '知识正文已被修改，先合并再检索：' + document.name);
    assert(!verifyPages(root, document.pages).length, '知识分页已被修改或缺失，先合并再检索：' + document.name);
    for (const entry of document.entries) {
      if (entry.status === 'superseded') continue;
      const content = [entry.title, entry.text, entry.scope].join(' ').toLocaleLowerCase();
      const score = terms.filter(term => content.includes(term)).length;
      if (score) {
        const key = JSON.stringify([entry.title, entry.text, entry.scope, entry.status, entry.sources]);
        if (identical.has(key)) identical.get(key).also_in.push({ document: document.name, id: entry.id });
        else {
          const match = { score, document: document.name, id: entry.id, title: entry.title, status: entry.status, scope: entry.scope, text: cut(entry.text, 1200), read: { document: document.name, entry: entry.id }, sources: entry.sources.slice(0, 4).map(source => cut(sourceLabel(source), 240)), source_count: entry.sources.length, also_in: [] };
          found.push(match); identical.set(key, match);
        }
      }
    }
  }
  found.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const start = after ? found.findIndex(item => `${item.document}:${item.id}` === after) + 1 : 0;
  assert(!after || start > 0, '检索游标失效；知识变化后从头检索');
  const matches = [];
  let size = 0;
  for (const match of found.slice(start, start + limit)) {
    const length = JSON.stringify(match).length;
    if (size + length > 8000) break;
    matches.push(match); size += length;
  }
  const truncated = found.length > start + matches.length;
  return { query, matches, truncated, next_after: truncated && matches.length ? `${matches.at(-1).document}:${matches.at(-1).id}` : null, warning: '摘要可能截断，重要约束用 read --document NAME --entry ID 核对；来源可能过期，使用前运行 inspect 并核对实际资料。' };
}
export function readHandoff(project, run, options = {}) {
  const root = rootPath(project), state = runState(root, validId(run), options.project_path ?? options['project-path']), info = checkpointInfo(root, state);
  assert(!info.issues.some(item => ['missing-session', 'edited-session', 'missing-page', 'edited-page'].includes(item.type)), '交接正文缺失或被修改，先合并');
  const target = safePath(runPaths(root, run, options.project_path ?? options['project-path']).directory, 'checkpoint.json');
  const metadata = fs.existsSync(target) ? jsonFile(target) : null;
  const pages = metadata?.details || [];
  const page = Number(options.page || 1), offset = Number(options.offset || 0), count = pages.length || 1;
  assert(Number.isInteger(page) && page >= 1 && page <= count && Number.isInteger(offset) && offset >= 0, '交接 page / offset 无效');
  const content = file(root, pages.length ? pages[page - 1].path : info.path).content;
  assert(content !== null && offset <= content.length, '交接正文不存在或 offset 超出范围');
  const end = Math.min(offset + 8000, content.length);
  return { run_id: run, page, total_pages: count, content: content.slice(offset, end), next_offset: end < content.length ? end : null, next_page: end === content.length && page < count ? page + 1 : null };
}
export function readMemory(project, options = {}) {
  const root = rootPath(project), { value } = catalog(root);
  assert(NAMES.includes(options.document), 'document 须为 index / architecture / decisions / lessons');
  const document = value.documents[options.document];
  assert(document, '知识文档尚未创建');
  assert(file(root, docPath(document.name)).hash === document.content_hash && !verifyPages(root, document.pages).length, '正文已变化；先 inspect 并合并');
  const offset = Number(options.offset || 0);
  assert(Number.isInteger(offset) && offset >= 0, 'offset 须为非负整数');
  let content, totalPages = document.pages?.length || 1, page = Number(options.page || 1);
  if (options.entry) {
    const entry = document.entries.find(entry => entry.id === options.entry);
    assert(entry, '知识条目不存在'); content = render({ ...document, entries: [entry] });
  } else {
    assert(Number.isInteger(page) && page >= 1 && page <= totalPages, 'page 超出分页范围');
    content = document.pages?.length ? file(root, document.pages[page - 1].path).content : file(root, docPath(document.name)).content;
  }
  assert(offset <= content.length, 'offset 超出正文范围');
  const end = Math.min(offset + 8000, content.length);
  return { document: document.name, entry: options.entry || null, page, total_pages: totalPages, content: content.slice(offset, end), next_offset: end < content.length ? end : null, next_page: !options.entry && end === content.length && page < totalPages ? page + 1 : null };
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'project-path', 'run', 'input', 'intent', 'limit', 'after', 'query', 'document', 'entry', 'page', 'offset', 'help']);
  const [command] = options._;
  assert(options._.length <= 1, '记忆工具只能指定一个命令');
  if (options.help || !command) return { commands: 'bootstrap / inspect / save / checkpoint / search / read', usage: 'node HOME/scripts/memory.mjs COMMAND --project ROOT [--intent continue|new|inspect] [--run ID] [--input FILE] [--document NAME --entry ID | --page N --offset N]' };
  if (command === 'read') return options.run ? readHandoff(options.project, options.run, options) : readMemory(options.project, options);
  const input = () => { assert(typeof options.input === 'string', '该命令需要 --input JSON 文件'); return jsonFile(path.resolve(options.input)); };
  if (command === 'bootstrap') return bootstrap(options.project, { intent: options.intent, run: options.run, after: options.after, project_path: options['project-path'], ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}) });
  if (command === 'inspect') return inspect(options.project);
  if (command === 'save') return save(options.project, input());
  if (command === 'checkpoint') return checkpoint(options.project, options.run, input());
  if (command === 'search') return search(options.project, options.query, options.limit === undefined ? 8 : Number(options.limit), options.after);
  throw new Error('未知记忆命令，请查看 --help');
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
