import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { save, inspect, readMemory, search, bootstrap, checkpoint } from '../scripts/memory.mjs';
import { create, begin, progress, status, snapshot } from '../scripts/loop.mjs';
import { assessOwners } from '../scripts/windows.mjs';
import { balanced } from '../scripts/routing.mjs';
import { configureProfile, resolveProfile, resetProjectProfile } from '../scripts/profiles.mjs';
import { initialize } from '../scripts/plugin.mjs';
import { buildPlugin } from '../scripts/build-plugin.mjs';
import { pathToFileURL } from 'node:url';
import { publishFiles } from '../scripts/publish-files.mjs';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.txt'), '真实夹具');
  return root;
}
const entry = (id, text = '接口兼容要求') => ({ id, title: id, text, scope: '接口', status: 'observed', sources: [{ type: 'file', path: 'main.txt' }] });
function update(root, name, entries) {
  const info = inspect(root);
  return save(root, { base_revision: info.revision, documents: [{ name, summary: '重要约束及详细资料', expected_hash: info.documents.find(item => item.name === name)?.hash || null, entries }] });
}
function task(root) {
  create(root, { goal: '继续接口', tasks: [{ id: 't1', title: '接口', acceptance: ['兼容'], review: 'none', checks: [{ id: 'c', command: 'check' }] }] }, 'run1');
}
function handoff(root, extra = {}) {
  const info = bootstrap(root, { run: 'run1' }).selected.run.checkpoint;
  return { expected_session_hash: info.expected_hash, base_cursor: info.event_cursor, event_cursor: status(root, 'run1').event_seq, intent: '继续接口', constraints: ['兼容'], decisions: [], open_questions: [], next_steps: ['核对 main.txt 再继续'], references: ['main.txt'], changes: [{ path: 'main.txt', symbols: ['handler'], reason: '兼容接口', read_first: 'handler 函数及相邻调用' }], ...extra };
}

test('长知识、超过 100 条和超过 1 MiB 聚合数据自动分片，完整条目可分页读取', t => {
  const root = fixture(t);
  for (let batch = 0; batch < 3; batch++) update(root, 'architecture', Array.from({ length: 70 }, (_, index) => entry('e' + (batch * 70 + index), '接口兼容。'.repeat(1200))));
  const info = inspect(root).documents[0];
  assert.equal(info.entries, 210); assert.ok(info.pages > 20);
  assert.equal(inspect(root).status, 'ready');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '.ai-loop/memory/catalog.json')));
  assert.equal(catalog.schema_version, 2);
  assert.ok(fs.statSync(path.join(root, '.ai-loop/memory/catalog.json')).size < 10000);
  assert.ok(catalog.documents.architecture.shards.length > 1);
  const long = '特长正文。'.repeat(5000);
  update(root, 'architecture', [entry('long', long)]);
  let offset = 0, text = '';
  do { const result = readMemory(root, { document: 'architecture', entry: 'long', offset }); text += result.content; offset = result.next_offset; } while (offset !== null);
  assert.ok(text.includes(long));
  assert.deepEqual(update(root, 'architecture', [entry('long', long)]).status, 'unchanged');
});

test('长索引短导航、搜索给精确读取指令，分页手改被识别', t => {
  const root = fixture(t);
  update(root, 'index', [entry('long', '接口兼容。'.repeat(3000))]);
  const file = path.join(root, '.ai-loop/memory/index.md');
  assert.ok(fs.readFileSync(file, 'utf8').length <= 6000);
  assert.equal(search(root, '兼容').matches[0].read.entry, 'long');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '.ai-loop/memory/catalog.json')));
  const pageDirectory = JSON.parse(fs.readFileSync(path.join(root, catalog.documents.index.page_shards[0].path)));
  const page = path.join(root, pageDirectory.pages[0].path);
  fs.appendFileSync(page, '人工约束');
  assert.ok(inspect(root).documents[0].issues.some(item => item.type === 'edited-page'));
  assert.throws(() => search(root, '兼容'), /分页/);
  assert.throws(() => update(root, 'index', []), /分页含人工修改/);
  assert.ok(fs.readFileSync(page, 'utf8').endsWith('人工约束'));
});

test('schema 1 知识迁移保留编号、来源、旧目录与正文历史', t => {
  const root = fixture(t); update(root, 'index', [entry('old')]);
  const target = path.join(root, '.ai-loop/memory/catalog.json'), disk = JSON.parse(fs.readFileSync(target));
  const document = disk.documents.index;
  document.entries = document.shards.flatMap(item => JSON.parse(fs.readFileSync(path.join(root, item.path))).entries);
  delete document.shards; delete document.entry_count; disk.schema_version = 1;
  fs.writeFileSync(target, JSON.stringify(disk));
  const saved = update(root, 'index', [entry('new')]);
  assert.equal(search(root, '兼容').matches.length, 2);
  assert.ok(saved.history.some(item => item.endsWith('catalog.json')));
});

test('长交接完整分页、改动符号与哈希核对，恢复不改变阶段或计数', t => {
  const root = fixture(t); task(root);
  const before = JSON.stringify(status(root, 'run1'));
  checkpoint(root, 'run1', handoff(root, { constraints: Array.from({ length: 20 }, (_, index) => `${index}：` + '仍有效约束'.repeat(180)) }));
  const data = JSON.parse(fs.readFileSync(path.join(root, '.ai-loop/runs/run1/checkpoint.json')));
  assert.ok(data.details.length > 1);
  assert.ok(data.details.map(item => fs.readFileSync(path.join(root, item.path), 'utf8')).join('').includes('handler 函数及相邻调用'));
  assert.equal(JSON.stringify(status(root, 'run1')), before);
  assert.equal(bootstrap(root, { intent: 'continue' }).selected.action, 'check-project-before-continuing');
  fs.appendFileSync(path.join(root, 'main.txt'), '其他用户修改');
  assert.ok(bootstrap(root, { run: 'run1' }).selected.run.checkpoint.issues.some(item => item.type === 'changed-code'));
});

test('开发中途无结束交接，新会话发现未关闭工作单元与实际已改文件', t => {
  const root = fixture(t); task(root); begin(root, 'run1', 't1', 'development');
  progress(root, 'run1', { unit: 'u1', task: 't1', stage: 'planned', summary: '改接口后验证', files: ['main.txt'] });
  fs.appendFileSync(path.join(root, 'main.txt'), '已改但尚未验证');
  const startup = bootstrap(root, { intent: 'continue' });
  assert.equal(startup.selected.run_id, 'run1'); assert.equal(startup.runs[0].work_units.open_count, 1);
  assert.equal(startup.runs[0].snapshot_status, 'unchecked');
  assert.equal(status(root, 'run1').tasks[0].fixes, 0);
  assert.throws(() => progress(root, 'run1', { unit: 'u1', task: 't1', stage: 'planned', summary: '重复', files: [] }), /工作单元/);
  progress(root, 'run1', { unit: 'u1', task: 't1', stage: 'done', summary: '代码完成，待验证', files: ['main.txt'] });
  assert.equal(bootstrap(root).runs[0].work_units.open_count, 0);
});

test('插件项目只初始化共享记录，可兼容已失效的旧源包路径', t => {
  const root = fixture(t);
  assert.equal(initialize(root).status, 'dry-run'); assert.equal(fs.existsSync(path.join(root, '.ai-loop')), false);
  initialize(root, { apply: true });
  assert.equal(fs.existsSync(path.join(root, '.codex')), false);
  fs.writeFileSync(path.join(root, '.ai-loop/install.json'), JSON.stringify({ schema_version: 2, source: 'old-bundle', harnesses: {} }));
  assert.ok(snapshot(root).digest);
  assert.deepEqual(initialize(root).changes, []);
});

test('所有者检查区分沙箱创建者、异常目录和正常用户，不修改任何 ACL', () => {
  assert.equal(assessOwners({ user: 'PC\\Rainwood', paths: [{ path: '.codex', exists: true, owner: 'PC\\CodexSandboxOffline' }] }).issues[0].type, 'sandbox-owner');
  assert.equal(assessOwners({ user: 'PC\\CodexSandboxOffline', paths: [] }, { purpose: 'configure' }).issues[0].type, 'sandbox-creator');
  assert.equal(assessOwners({ user: 'PC\\Rainwood', paths: [{ path: '.codex', exists: true, owner: 'PC\\Rainwood' }] }).status, 'ready');
});

test('全局模型、项目覆盖与恢复默认，不改主模型、settings 或其他原生代理', t => {
  const root = fixture(t), home = path.join(root, 'personal'); fs.mkdirSync(home);
  const options = { home, bundle: path.resolve('.') };
  const global = balanced('codex');
  assert.equal(configureProfile(root, global, options).status, 'dry-run');
  configureProfile(root, global, { ...options, apply: true });
  assert.equal(resolveProfile(root, options).scope, 'global');
  const local = structuredClone(global); local.roles.dev.model = 'custom-model'; local.roles.dev.effort = 'medium';
  configureProfile(root, local, { ...options, scope: 'project', apply: true });
  assert.equal(resolveProfile(root, options).profile.roles.dev.model, 'custom-model');
  assert.equal(resolveProfile(root, { ...options, scope: 'global' }).profile.roles.dev.model, global.roles.dev.model);
  const result = resetProjectProfile(root, { ...options, apply: true });
  assert.equal(result.status, 'reset'); assert.equal(resolveProfile(root, options).scope, 'global');
  assert.equal(fs.existsSync(path.join(root, '.codex/config.toml')), false);
  assert.equal(fs.existsSync(path.join(home, 'settings.json')), false);
  fs.appendFileSync(path.join(home, 'agents/loop-dev.toml'), '# 人工修改');
  assert.throws(() => configureProfile(root, global, options), /停止覆盖/);
});

test('插件可重复构建并在外部项目独立执行，手改产物停止覆盖', async t => {
  const root = fixture(t), relative = '.release/plugin-test-' + path.basename(root);
  const built = buildPlugin(relative), target = built.output;
  assert.ok(target.startsWith(path.resolve('.release') + path.sep));
  t.after(() => { assert.ok(target.startsWith(path.resolve('.release') + path.sep)); fs.rmSync(target, { recursive: true, force: true }); });
  assert.equal(buildPlugin(relative, { check: true }).changed.length, 0);
  assert.equal(buildPlugin(relative).changed.length, 0);
  const runtime = await import(pathToFileURL(path.join(target, 'scripts/memory.mjs')).href);
  assert.equal(runtime.bootstrap(root).active_count, 0);
  fs.appendFileSync(path.join(target, 'MEMORY.md'), '用户改动');
  assert.throws(() => buildPlugin(relative), /停止覆盖/);
});

test('GitHub 发行清单只包含源包、插件和市场，不包含本机运行或配置', () => {
  buildPlugin();
  const files = publishFiles();
  assert.ok(files.some(item => item.path === '.agents/plugins/marketplace.json'));
  assert.ok(files.some(item => item.path === 'codex/plugin.json'));
  assert.ok(files.some(item => item.path === 'dist/codex/plugin.json'));
  assert.ok(files.every(item => !/(?:^|\/)(?:\.release|\.ai-loop|\.validation|\.env|node_modules)(?:\/|$)/.test(item.path)));
  assert.ok(files.every(item => !item.path.endsWith('.log')));
});


test('沙箱账户只读预检不误阻断，配置写入与真实 owner/ACL 异常仍阻断', () => {
  const data = { user: 'PC\\CodexSandboxOffline', paths: [{ path: '.codex', exists: true, owner: 'PC\\Rainwood' }] };
  const read = assessOwners(data);
  assert.equal(read.status, 'ready');
  assert.deepEqual(read.issues, []);
  assert.equal(read.warnings[0].type, 'sandbox-creator');
  assert.equal(assessOwners(data, { purpose: 'configure' }).status, 'needs-repair');
  assert.equal(assessOwners({ user: 'PC\\Rainwood', paths: [{ path: '.codex', exists: true, owner: 'PC\\CodexSandboxOnline' }] }).issues[0].type, 'sandbox-owner');
  assert.equal(assessOwners({ user: 'PC\\Rainwood', paths: [{ path: '.codex', exists: true, error: 'access denied' }] }).issues[0].type, 'acl-unreadable');
  assert.throws(() => assessOwners(data, { purpose: 'unknown' }), /purpose/);
});

test('纯插件项目的兼容 doctor 识别全局角色，损坏配置与篡改插件仍阻断', async t => {
  const root = fixture(t), home = path.join(root, 'personal'); fs.mkdirSync(home);
  const relative = '.release/doctor-test-' + path.basename(root), target = buildPlugin(relative).output;
  t.after(() => { assert.ok(target.startsWith(path.resolve('.release') + path.sep)); fs.rmSync(target, { recursive: true, force: true }); });
  const runtime = await import(pathToFileURL(path.join(target, 'scripts/plugin.mjs')).href);
  runtime.initialize(root, { apply: true });
  configureProfile(root, balanced('codex'), { home, bundle: target, apply: true });
  assert.equal(fs.existsSync(path.join(root, '.ai-loop/install.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.codex')), false);
  const routing = fs.readFileSync(path.join(target, 'ROUTING.md'), 'utf8');
  assert.match(routing, /scripts\/plugin\.mjs doctor/);
  assert.doesNotMatch(routing, /先运行本部署.*scripts\/doctor\.mjs/);
  const run = () => spawnSync(process.execPath, [path.join(target, 'scripts/doctor.mjs'), '--project', root, '--harness', 'codex'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const good = run(); assert.equal(good.status, 0, good.stderr);
  const report = JSON.parse(good.stdout);
  assert.equal(report.mode, 'plugin'); assert.equal(report.configuration, 'pass');
  assert.equal(report.dispatch, 'requires-native-verification'); assert.deepEqual(report.issues, []);
  assert.equal(report.execution, 'unverified'); assert.equal(report.models.scope, 'global');
  const agent = path.join(home, 'agents/loop-dev.toml'), before = fs.readFileSync(agent, 'utf8');
  fs.appendFileSync(agent, '# artificial mutation');
  const bad = JSON.parse(run().stdout);
  assert.equal(bad.dispatch, 'blocked'); assert.ok(bad.issues.some(item => item.includes('原生模型文件')));
  fs.writeFileSync(agent, before);
  fs.appendFileSync(path.join(target, 'MEMORY.md'), '# artificial mutation');
  const damaged = JSON.parse(run().stdout);
  assert.equal(damaged.dispatch, 'blocked'); assert.ok(damaged.issues.some(item => item.includes('插件文件缺失或变化')));
});
