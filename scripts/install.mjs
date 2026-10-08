import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { VERSION, BUNDLE, assert, inside, rootPath, safePath, jsonFile, atomicWrite, locked, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { ADAPTERS, selectHarness, adapterFor, entryInstructions, codexBootstrap } from './adapters.mjs';
import { rootString, updateRootString } from './toml.mjs';

const START = '<!-- ai-loop:start -->';
const END = '<!-- ai-loop:end -->';
export const REQUIRED_FILES = ['SETUP.md', 'WORKFLOW.md', 'MEMORY.md', ...['planner', 'dev', 'tester', 'reviewer', 'scribe'].map(role => `agents/loop-${role}.md`), ...['install.mjs', 'loop.mjs', 'lib.mjs', 'adapters.mjs', 'toml.mjs', 'memory.mjs', 'README.md'].map(file => `scripts/${file}`), 'templates/memory-index.md'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const wrapped = text => `${START}\n${text}\n${END}`;

function block(text) {
  const starts = [...text.matchAll(/<!-- ai-loop:start -->/g)];
  const ends = [...text.matchAll(/<!-- ai-loop:end -->/g)];
  assert(starts.length === ends.length && starts.length <= 1, '入口管理标记缺失、重复或损坏，请人工检查');
  if (!starts.length) return null;
  assert(starts[0].index < ends[0].index, '入口管理标记顺序错误');
  return { start: starts[0].index, end: ends[0].index + END.length, content: text.slice(starts[0].index, ends[0].index + END.length) };
}
function merge(text, desired, previous, name) {
  const old = block(text);
  if (previous) assert(old && hash(old.content) === previous.block_hash, `管理块已被人工修改或移除：${name}；停止覆盖，请先合并`);
  else assert(!old, `发现无安装清单的管理块：${name}；请先检查`);
  return old ? text.slice(0, old.start) + desired + text.slice(old.end)
    : text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + desired + '\n';
}
function read(root, relative) {
  const target = safePath(root, relative);
  const exists = fs.existsSync(target);
  if (exists) assert(fs.statSync(target).isFile(), `不是普通文件：${relative}`);
  return { path: relative, target, existed: exists, original: exists ? fs.readFileSync(target) : null, mode: exists ? fs.statSync(target).mode & 0o777 : 0o600 };
}
function descriptor(record) {
  assert(record && typeof record.harness === 'string' && typeof record.key === 'string', '安装清单平台记录无效');
  const adapter = record.key?.startsWith('generic:') ? adapterFor('generic', record.entry) : adapterFor(record.harness);
  assert(adapter.key === record.key && adapter.home === record.home && adapter.entry === record.entry && adapter.loader === record.loader, '安装清单与平台原生路径不一致');
  return adapter;
}
function validateRecord(root, bundle, record) {
  const adapter = descriptor(record);
  assert(Array.isArray(record.files) && Array.isArray(record.entries) && typeof record.version === 'string', '安装清单文件记录无效');
  const paths = new Set();
  for (const file of record.files) {
    assert(typeof file.path === 'string' && file.path.startsWith(adapter.home + '/') && /^[a-f0-9]{64}$/.test(file.hash), '部署清单路径或摘要无效');
    assert(!paths.has(file.path), '部署清单路径重复'); paths.add(file.path);
    const item = read(root, file.path);
    assert(!inside(bundle, item.target), '部署不能写入源包');
    assert(item.existed && hash(item.original) === file.hash, `部署文件已被人工修改或移除：${file.path}；请先合并`);
  }
  const expectedEntries = adapter.config ? [adapter.config] : adapter.entry.startsWith(adapter.home + '/') ? [] : [adapter.entry];
  assert(record.entries.length === expectedEntries.length, '安装清单入口数量不符');
  for (const entry of record.entries) {
    assert(expectedEntries.includes(entry.path) && /^[a-f0-9]{64}$/.test(entry.block_hash), '安装清单入口位置或摘要无效');
    const item = read(root, entry.path);
    assert(!inside(bundle, item.target), '入口不能写入源包');
    const text = item.original?.toString('utf8') || '';
    const content = adapter.config ? rootString(text, 'developer_instructions')?.value || '' : text;
    const current = block(content);
    assert(current && hash(current.content) === entry.block_hash, `管理块已被人工修改或移除：${entry.path}；请先合并`);
    if (adapter.harness === 'cursor') assert(/^---\r?\n[\s\S]*?\balwaysApply:\s*true\s*\r?\n[\s\S]*?---\r?\n/.test(text), 'Cursor alwaysApply 前置配置已变化，请先检查');
  }
  return adapter;
}
function globalInstructions(harness, env) {
  const globalRoot = harness === 'codex' ? env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')
    : env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), '.pi/agent');
  const file = path.join(globalRoot, harness === 'codex' ? 'config.toml' : 'APPEND_SYSTEM.md');
  if (!fs.existsSync(file)) return '';
  assert(fs.statSync(file).isFile(), '全局指令配置不是普通文件，请先检查');
  const text = fs.readFileSync(file, 'utf8');
  return harness === 'codex' ? rootString(text, 'developer_instructions')?.value || '' : text;
}

export function install(options) {
  const root = rootPath(options.project);
  const bundle = fs.realpathSync(options.bundle || BUNDLE);
  assert(inside(root, bundle) && root !== bundle, '源包必须位于目标项目内，目标不能是源包自身或其子目录');
  const env = options.env || process.env;
  const harness = selectHarness(options.harness, env);
  const selected = adapterFor(harness, options.entry);
  for (const flag of ['apply', 'check', 'migrate']) assert(options[flag] === undefined || options[flag] === true, `--${flag} 不接受值；移除该参数即可关闭`);
  assert(!options.apply || !options.check, '--apply 与 --check 不能同时使用');
  const source = path.relative(root, bundle).split(path.sep).join('/');
  safePath(root, source);
  assert(!/[\r\n`]/.test(source), '源包路径包含不适合规则引用的字符');
  const inputs = REQUIRED_FILES.map(file => {
    const item = read(bundle, file);
    assert(item.existed, `源包缺少必需普通文件：${file}`);
    return { file, ...item };
  });
  const manifestItem = read(root, '.ai-loop/install.json');
  const manifest = manifestItem.existed ? jsonFile(manifestItem.target) : null;
  assert(!manifest || [1, 2].includes(manifest.schema_version), '安装清单格式无效，先人工检查');
  const legacy = manifest?.schema_version === 1;
  assert(!legacy || options.migrate, '发现旧版根入口配置；先加 --migrate 预演迁移，再按预演应用');
  if (!legacy && manifest) assert(manifest.harnesses && typeof manifest.harnesses === 'object' && !Array.isArray(manifest.harnesses), '安装清单平台注册表无效');
  // 已部署副本不能反过来充当源包，否则升级来源会变成循环引用。
  for (const [key, record] of Object.entries(legacy ? {} : manifest?.harnesses || {})) {
    assert(key === record.key, '安装清单平台键与记录不一致');
    const adapter = descriptor(record);
    assert(!inside(safePath(root, adapter.home), bundle), '请从 install.json 的 source 原始源包运行安装器，不从部署副本安装');
  }
  const observations = new Map([[manifestItem.path, manifestItem]]);
  const changes = new Map();
  const observe = name => {
    if (!observations.has(name)) observations.set(name, read(root, name));
    const item = observations.get(name);
    assert(!inside(bundle, item.target), '安装产物不能写入源包');
    return item;
  };
  const plan = (name, content, preview) => {
    const item = observe(name);
    const desired = content === null ? null : Buffer.from(content);
    if ((desired === null && !item.existed) || (desired !== null && item.original?.equals(desired))) return;
    assert(!changes.has(name), '安装变更路径冲突：' + name);
    changes.set(name, { ...item, content: desired, preview });
  };
  const adapters = new Map([[selected.key, selected]]);
  const records = { ...(legacy ? {} : manifest?.harnesses || {}) };
  let migrationBackup = null;
  if (legacy) {
    assert(Array.isArray(manifest.harnesses) && manifest.harnesses.length && Array.isArray(manifest.entries) && manifest.entries.length, '旧版安装清单不完整');
    assert(!manifest.harnesses.includes('generic'), '旧版 generic 入口无法自动映射；请先制定明确的子目录入口迁移方案');
    for (const name of manifest.harnesses) {
      assert(Object.hasOwn(ADAPTERS, name), '旧版包含未知平台，停止迁移');
      const adapter = adapterFor(name); adapters.set(adapter.key, adapter);
    }
    migrationBackup = '.ai-loop/migrations/' + crypto.randomUUID();
    plan(migrationBackup + '/install.json', manifestItem.original, { action: 'backup' });
    const seen = new Set();
    for (const entry of manifest.entries) {
      assert(['AGENTS.md', 'CLAUDE.md'].includes(entry.path) && ['instructions', 'claude-import'].includes(entry.kind) && /^[a-f0-9]{64}$/.test(entry.block_hash), '旧版根入口记录无效');
      assert(!seen.has(entry.path), '旧版入口重复'); seen.add(entry.path);
      const item = observe(entry.path);
      const text = item.original?.toString('utf8') || '';
      const old = block(text);
      assert(old && hash(old.content) === entry.block_hash, `旧版管理块已被人工修改或移除：${entry.path}；停止迁移`);
      const retained = text.slice(0, old.start) + text.slice(old.end);
      plan(migrationBackup + '/' + entry.path, item.original, { action: 'backup' });
      plan(entry.path, retained.trim() ? retained : null, { action: retained.trim() ? 'remove-managed-block' : 'remove-workflow-only-file', preserved_existing_text: true });
    }
  }
  // 根规范只检查孤立旧块，不创建或合并新入口。
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const item = observe(name);
    const old = block(item.original?.toString('utf8') || '');
    assert(!old || (legacy && manifest.entries.some(entry => entry.path === name)), `根 ${name} 存在旧工作流管理块；先修复清单并迁移，不能重复安装`);
  }
  for (const adapter of adapters.values()) {
    safePath(root, adapter.home); safePath(root, adapter.entry);
    assert(!inside(bundle, safePath(root, adapter.home)) && !inside(safePath(root, adapter.home), bundle), '源包与部署目录不能相互包含');
    const previous = records[adapter.key];
    if (previous) {
      validateRecord(root, bundle, previous);
      for (const item of [...previous.files, ...previous.entries]) observe(item.path);
    }
    const files = [];
    const ownFiles = new Map((previous?.files || []).map(file => [file.path, file]));
    const deploy = (name, content) => {
      const item = observe(name);
      assert(!item.existed || ownFiles.has(name), `部署路径已有未注册文件：${name}；停止覆盖`);
      plan(name, content, { action: item.existed ? 'update-deployment' : 'deploy', bytes: Buffer.byteLength(content) });
      files.push({ path: name, hash: hash(content) });
    };
    for (const input of inputs) deploy(adapter.home + '/' + input.file, input.original);
    const desiredBlock = wrapped(entryInstructions(adapter));
    if (adapter.config || adapter.entry.startsWith(adapter.home + '/')) deploy(adapter.entry, desiredBlock + '\n');
    const entryPath = adapter.config || adapter.entry;
    const item = observe(entryPath);
    const original = item.original?.toString('utf8') || '';
    const previousEntry = previous?.entries.find(entry => entry.path === entryPath);
    let updated;
    let managed;
    if (adapter.config) {
      const existing = rootString(original, 'developer_instructions');
      assert(existing || !globalInstructions('codex', env).trim(), '全局 developer_instructions 非空；新项目字段会覆盖它。先保留有效个人指令到项目字段，再预演；不自动修改全局配置');
      managed = wrapped(codexBootstrap(adapter));
      updated = updateRootString(original, 'developer_instructions', value => merge(value, managed, previousEntry, entryPath));
    } else if (!adapter.entry.startsWith(adapter.home + '/')) {
      managed = desiredBlock;
      if (adapter.harness === 'pi') {
        assert(item.existed || !globalInstructions('pi', env).trim(), '个人 APPEND_SYSTEM.md 非空；项目文件会取代它。先将需要保留的个人指令合并到项目 APPEND_SYSTEM.md，再预演');
      } else assert(!item.existed || previousEntry, `原生规则文件已有未注册内容：${entryPath}；请先明确合并，不能覆盖`);
      updated = merge(original, managed, previousEntry, entryPath);
      if (adapter.harness === 'cursor' && !item.existed) updated = '---\ndescription: AI Loop Engineering\nalwaysApply: true\n---\n\n' + updated;
    }
    const entries = [];
    if (updated !== undefined) {
      plan(entryPath, updated, { action: item.existed ? 'merge-native-entry' : 'create-native-entry', managed_block: managed, preserved_existing_text: true });
      entries.push({ path: entryPath, block_hash: hash(managed) });
    }
    // 显式入口由 files 的整文件摘要管理；无需再建立第二条读取链。
    for (const old of previous?.files || []) if (!files.some(file => file.path === old.path)) plan(old.path, null, { action: 'remove-obsolete-deployment' });
    records[adapter.key] = { key: adapter.key, harness: adapter.harness, home: adapter.home, entry: adapter.entry, loader: adapter.loader, version: VERSION, files: files.sort((a, b) => a.path.localeCompare(b.path)), entries, conditions: adapter.conditions, loading: 'unverified' };
  }
  // 共享项目知识是运行资料，不作为某个平台部署文件接管或覆盖。
  const memoryIndex = observe('.ai-loop/memory/index.md');
  const memoryCatalog = observe('.ai-loop/memory/catalog.json');
  if (!memoryIndex.existed) {
    assert(!memoryCatalog.existed, '知识索引缺失但目录元信息仍在；先从历史备份合并恢复，不重置知识');
    plan(memoryIndex.path, inputs.find(input => input.file === 'templates/memory-index.md').original, { action: 'initialize-memory-index' });
  }
  const oldLessons = observe('.ai-loop/lessons.md');
  let lessonsMigration = null;
  if (oldLessons.existed) {
    const lessons = observe('.ai-loop/memory/lessons.md');
    assert(!lessons.existed || lessons.original.equals(oldLessons.original), '新旧经验文档内容不同；先读取两份资料并明确合并，不覆盖或删除任一份');
    const backup = '.ai-loop/migrations/lessons-' + hash(oldLessons.original) + '/lessons.md';
    const backupItem = observe(backup);
    assert(!backupItem.existed || backupItem.original.equals(oldLessons.original), '经验迁移备份冲突，停止并保留现场');
    plan(backup, oldLessons.original, { action: 'backup-lessons' });
    if (!lessons.existed) plan(lessons.path, oldLessons.original, { action: 'migrate-lessons' });
    plan(oldLessons.path, null, { action: 'remove-migrated-lessons' });
    lessonsMigration = { path: lessons.path, backup, indexed: false };
  }
  const next = { schema_version: 2, version: VERSION, source, harnesses: Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b))), loading: 'unverified' };
  plan('.ai-loop/install.json', JSON.stringify(next, null, 2) + '\n', { action: 'update-manifest' });
  const summary = { status: options.apply ? 'configured' : 'dry-run', source, harness: selected.harness, loader: selected.loader, loading: 'unverified', configured_harnesses: [...adapters.keys()], conditions: selected.conditions, changes: [...changes.keys()], ...(migrationBackup ? { migration_backup: migrationBackup } : {}), ...(lessonsMigration ? { lessons_migration: lessonsMigration } : {}) };
  if (options.check) {
    assert(manifest && !changes.size, '安装内容或路径需要更新；先运行预演，不要宣称已加载');
    return { ...summary, status: 'configured' };
  }
  if (!options.apply) return { ...summary, preview: [...changes.values()].map(item => ({ path: item.path, ...item.preview })) };
  if (!changes.size) return summary;
  return locked(root, 'install', () => {
    for (const item of [...observations.values(), ...inputs]) {
      assert(fs.existsSync(item.target) === item.existed && (!item.existed || fs.readFileSync(item.target).equals(item.original)), '文件在预演后发生变化，请重新预演：' + item.path);
      // 写前再次确认中间目录没有被替换成符号链接。
      safePath(item.target.startsWith(bundle + path.sep) ? bundle : root, item.path);
    }
    const applied = [];
    try {
      for (const item of changes.values()) {
        if (item.content === null) fs.unlinkSync(item.target);
        else atomicWrite(item.target, item.content);
        applied.push(item);
        if (item.content !== null) fs.chmodSync(item.target, item.mode);
      }
    } catch (error) {
      for (const item of applied.reverse()) {
        if (item.existed) { atomicWrite(item.target, item.original); fs.chmodSync(item.target, item.mode); }
        else if (fs.existsSync(item.target)) fs.unlinkSync(item.target);
      }
      throw error;
    }
    return summary;
  });
}

export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'harness', 'entry', 'apply', 'check', 'migrate', 'help']);
  assert(!options._.length, '安装器不接受位置参数');
  if (options.help) return { usage: 'node scripts/install.mjs --project ROOT [--harness auto|codex|claude-code|cursor|pi|dsh|generic] [--entry .mytool/rules/ai-loop.md] [--migrate] [--apply|--check]' };
  return install(options);
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
