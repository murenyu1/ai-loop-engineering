import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { install, REQUIRED_FILES } from '../scripts/install.mjs';
import { selectHarness } from '../scripts/adapters.mjs';
import { rootString, updateRootString } from '../scripts/toml.mjs';
import { snapshot } from '../scripts/loop.mjs';

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, '工作流 包');
  for (const name of REQUIRED_FILES) {
    fs.mkdirSync(path.dirname(path.join(bundle, name)), { recursive: true });
    fs.copyFileSync(new URL('../' + name, import.meta.url), path.join(bundle, name));
  }
  return { root, bundle, project: root, harness: 'codex', env: { HOME: path.join(root, 'personal') } };
}
const get = (options, name) => fs.readFileSync(path.join(options.root, name), 'utf8');
function put(options, name, text) { const file = path.join(options.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function legacy(options, edited = false, pure = false) {
  const instructions = '<!-- ai-loop:start -->\n旧工作流\n<!-- ai-loop:end -->';
  const claude = '<!-- ai-loop:start -->\n@AGENTS.md\n<!-- ai-loop:end -->';
  put(options, 'AGENTS.md', (pure ? '' : '# 项目规则\n') + instructions + '\n');
  put(options, 'CLAUDE.md', claude + '\n');
  put(options, '.ai-loop/install.json', JSON.stringify({ schema_version: 1, version: '2.0.0', source: '工作流 包', harnesses: ['codex', 'claude-code'], entries: [{ path: 'AGENTS.md', kind: 'instructions', block_hash: digest(instructions) }, { path: 'CLAUDE.md', kind: 'claude-import', block_hash: digest(claude) }] }));
  if (edited) put(options, 'AGENTS.md', instructions.replace('旧工作流', '人工修改'));
}

test('预演不写，根规范原样保留，无根规范也不创建；重复安装幂等', t => {
  const options = fixture(t);
  put(options, 'AGENTS.md', '# 项目规范\n'); put(options, 'CLAUDE.md', '# Claude 项目规范\n');
  const preview = install(options);
  assert.equal(preview.status, 'dry-run');
  assert.equal(fs.existsSync(path.join(options.root, '.ai-loop')), false);
  assert.ok(!preview.changes.includes('AGENTS.md'));
  install({ ...options, apply: true });
  assert.equal(get(options, 'AGENTS.md'), '# 项目规范\n');
  assert.equal(get(options, 'CLAUDE.md'), '# Claude 项目规范\n');
  assert.match(get(options, '.codex/config.toml'), /developer_instructions/);
  assert.equal(install({ ...options, check: true }).loading, 'unverified');
  assert.deepEqual(install({ ...options, apply: true }).changes, []);
  fs.unlinkSync(path.join(options.root, 'AGENTS.md')); fs.unlinkSync(path.join(options.root, 'CLAUDE.md'));
  install({ ...options, apply: true });
  assert.equal(fs.existsSync(path.join(options.root, 'AGENTS.md')), false);
});

test('Codex 无损合并 TOML，保留个人正文、注释、表和文件权限', t => {
  const options = fixture(t);
  const before = '# comment\ndeveloper_instructions = """\n我的个人指令\\n第二行\n""" # keep\nmodel = "test"\n[projects."/work"]\ntrust_level = "trusted"\n';
  put(options, '.codex/config.toml', before);
  fs.chmodSync(path.join(options.root, '.codex/config.toml'), 0o640);
  install({ ...options, apply: true });
  const after = get(options, '.codex/config.toml');
  assert.match(rootString(after, 'developer_instructions').value, /^我的个人指令\n第二行\n/);
  assert.ok(after.endsWith('# keep\nmodel = "test"\n[projects."/work"]\ntrust_level = "trusted"\n'));
  assert.equal(fs.statSync(path.join(options.root, '.codex/config.toml')).mode & 0o777, 0o640);
  assert.equal((rootString(after, 'developer_instructions').value.match(/ai-loop:start/g) || []).length, 1);
  put(options, '.codex/config.toml', after.replace('model = "test"', 'model = "changed"'));
  assert.deepEqual(install({ ...options, apply: true }).changes, []);
});

test('各原生入口与显式入口独立配置，升级仅当前平台', t => {
  const options = fixture(t);
  for (const harness of ['codex', 'claude-code', 'cursor', 'pi', 'dsh', 'generic']) {
    const params = { ...options, harness, ...(harness === 'generic' ? { entry: '.mytool/rules/ai-loop.md' } : {}) };
    install({ ...params, apply: true });
    assert.deepEqual(install({ ...params, apply: true }).changes, []);
  }
  assert.equal(fs.existsSync(path.join(options.root, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(options.root, 'CLAUDE.md')), false);
  assert.match(get(options, '.claude/rules/ai-loop.md'), /\.claude\/ai-loop\/WORKFLOW/);
  assert.match(get(options, '.cursor/rules/ai-loop.mdc'), /alwaysApply: true/);
  assert.match(get(options, '.pi/APPEND_SYSTEM.md'), /\.pi\/ai-loop/);
  assert.equal(install({ ...options, harness: 'dsh', check: true }).loader, 'explicit');
  const cursor = get(options, '.cursor/ai-loop/WORKFLOW.md');
  fs.appendFileSync(path.join(options.bundle, 'WORKFLOW.md'), '\n升级内容\n');
  const result = install({ ...options, apply: true });
  assert.ok(result.changes.includes('.codex/ai-loop/WORKFLOW.md'));
  assert.ok(result.changes.every(name => !name.startsWith('.cursor/') && !name.startsWith('.claude/')));
  assert.equal(get(options, '.cursor/ai-loop/WORKFLOW.md'), cursor);
});

test('Pi 合并已有项目提示，不修改 settings.json', t => {
  const options = fixture(t);
  put(options, '.pi/APPEND_SYSTEM.md', '已有个人规则\n'); put(options, '.pi/settings.json', '{"keep":true}');
  install({ ...options, harness: 'pi', apply: true });
  assert.match(get(options, '.pi/APPEND_SYSTEM.md'), /^已有个人规则\n/);
  assert.equal(get(options, '.pi/settings.json'), '{"keep":true}');
});

test('全局提示覆盖风险停止安装，源包与项目尚无写入', t => {
  const options = fixture(t);
  put(options, 'personal/.codex/config.toml', 'developer_instructions = "个人规则"\n');
  assert.throws(() => install({ ...options, apply: true }), /全局 developer_instructions/);
  assert.equal(fs.existsSync(path.join(options.root, '.ai-loop')), false);
  put(options, 'personal/.pi/agent/APPEND_SYSTEM.md', '个人 Pi 规则');
  assert.throws(() => install({ ...options, harness: 'pi', apply: true }), /个人 APPEND_SYSTEM/);
  assert.equal(fs.existsSync(path.join(options.root, '.pi')), false);
});

test('部署正文与管理块人工修改停止，块外规则可保留', t => {
  const options = fixture(t);
  install({ ...options, harness: 'pi', apply: true });
  fs.appendFileSync(path.join(options.root, '.pi/APPEND_SYSTEM.md'), '\n块外追加\n');
  assert.deepEqual(install({ ...options, harness: 'pi', check: true }).changes, []);
  put(options, '.pi/APPEND_SYSTEM.md', get(options, '.pi/APPEND_SYSTEM.md').replace('开始开发时', '人工修改'));
  assert.throws(() => install({ ...options, harness: 'pi', apply: true }), /人工修改/);
  install({ ...options, apply: true });
  fs.appendFileSync(path.join(options.root, '.codex/ai-loop/WORKFLOW.md'), '\n修改\n');
  assert.throws(() => install({ ...options, apply: true }), /部署文件已被人工修改/);
});

test('不接管未注册原生文件、孤立根块与缺损源包', t => {
  const options = fixture(t);
  put(options, '.claude/rules/ai-loop.md', '手写规则');
  assert.throws(() => install({ ...options, harness: 'claude-code', apply: true }), /未注册/);
  put(options, 'AGENTS.md', '<!-- ai-loop:start --><!-- ai-loop:end -->');
  assert.throws(() => install({ ...options, apply: true }), /旧工作流/);
  fs.unlinkSync(path.join(options.root, 'AGENTS.md'));
  fs.unlinkSync(path.join(options.bundle, 'agents/loop-reviewer.md'));
  assert.throws(() => install({ ...options, apply: true }), /必需普通文件/);
  assert.equal(fs.existsSync(path.join(options.root, '.ai-loop')), false);
});

test('旧版迁移需显式参数，迁移所有旧平台并备份，保留块外规则与运行', t => {
  const options = fixture(t); legacy(options);
  put(options, '.ai-loop/runs/old/state.json', '{"kept":true}');
  const oldAgents = get(options, 'AGENTS.md');
  assert.throws(() => install({ ...options, apply: true }), /--migrate/);
  const preview = install({ ...options, migrate: true });
  assert.equal(get(options, 'AGENTS.md'), oldAgents);
  assert.deepEqual(preview.configured_harnesses.sort(), ['claude-code', 'codex']);
  const result = install({ ...options, migrate: true, apply: true });
  assert.equal(get(options, 'AGENTS.md'), '# 项目规则\n\n');
  assert.equal(fs.existsSync(path.join(options.root, 'CLAUDE.md')), false);
  assert.equal(get(options, result.migration_backup + '/AGENTS.md'), oldAgents);
  assert.equal(get(options, '.ai-loop/runs/old/state.json'), '{"kept":true}');
  assert.deepEqual(install({ ...options, check: true }).changes, []);
});

test('纯工作流根文件迁移后删除；旧块被编辑时不写任何新文件', t => {
  const options = fixture(t); legacy(options, true);
  assert.throws(() => install({ ...options, migrate: true, apply: true }), /停止迁移/);
  assert.equal(fs.existsSync(path.join(options.root, '.codex')), false);
  legacy(options, false, true);
  install({ ...options, migrate: true, apply: true });
  assert.equal(fs.existsSync(path.join(options.root, 'AGENTS.md')), false);
});

test('路径越界、符号链接、源包目标及非法参数均停止', t => {
  const options = fixture(t);
  assert.throws(() => install({ ...options, project: options.bundle }), /目标/);
  for (const entry of ['AGENTS.md', '../out.md', '.mytool/../out.md', '.codex/rule.md', '.ai-loop/rules.md', '.mytool//rules.md']) assert.throws(() => install({ ...options, harness: 'generic', entry }));
  assert.throws(() => install({ ...options, apply: 'false' }), /不接受值/);
  fs.symlinkSync(options.bundle, path.join(options.root, '.codex'));
  assert.throws(() => install({ ...options, apply: true }), /符号链接/);
  assert.equal(fs.existsSync(path.join(options.root, '.ai-loop')), false);
});

test('工具识别显式优先；环境不明确或相互矛盾不猜测', () => {
  assert.equal(selectHarness('codex', { CLAUDECODE: '1' }), 'codex');
  assert.equal(selectHarness('auto', { AI_LOOP_HARNESS: 'pi', CODEX_THREAD_ID: 'x' }), 'pi');
  assert.equal(selectHarness(undefined, { CODEX_THREAD_ID: 'x' }), 'codex');
  assert.throws(() => selectHarness(undefined, {}), /唯一识别/);
  assert.throws(() => selectHarness('auto', { CODEX_THREAD_ID: 'x', CLAUDECODE: '1' }), /唯一识别/);
});

test('TOML 更新跳过多行伪键、表字段和点分键，拒绝重复或非字符串字段', () => {
  const text = 'other = """\ndeveloper_instructions = "伪键"\n"""\n[profile]\ndeveloper_instructions = "表字段"\n';
  assert.equal(rootString(text, 'developer_instructions'), null);
  const updated = updateRootString(text, 'developer_instructions', () => '真实\n规则');
  assert.equal(rootString(updated, 'developer_instructions').value, '真实\n规则');
  assert.ok(updated.endsWith(text));
  assert.equal(rootString("developer_instructions = '''\n literal \'\n'''\n", 'developer_instructions').value, " literal '\n");
  assert.equal(rootString('developer_instructions = "\\u4e3b\\U00004eba"', 'developer_instructions').value, '主人');
  assert.throws(() => rootString('developer_instructions = false', 'developer_instructions'), /须为字符串/);
  assert.throws(() => rootString('developer_instructions="a"\ndeveloper_instructions="b"', 'developer_instructions'), /重复/);
});

test('源包移动只更新清单，运行保留；部署安装器不得自我作为更新来源', t => {
  const options = fixture(t); install({ ...options, apply: true });
  const moved = path.join(options.root, 'new-bundle'); fs.renameSync(options.bundle, moved);
  put(options, '.ai-loop/runs/old/state.json', '{}');
  install({ ...options, bundle: moved, apply: true });
  assert.equal(JSON.parse(get(options, '.ai-loop/install.json')).source, 'new-bundle');
  assert.equal(get(options, '.ai-loop/runs/old/state.json'), '{}');
  assert.throws(() => install({ ...options, bundle: path.join(options.root, '.codex/ai-loop') }), /原始源包/);
});

test('源包与所有部署正文排除，native 设置仍绑定快照，切换脚本快照一致', t => {
  const options = fixture(t); install({ ...options, apply: true });
  install({ ...options, harness: 'claude-code', apply: true });
  const before = snapshot(options.root, [], options.bundle);
  const deployed = snapshot(options.root, [], path.join(options.root, '.codex/ai-loop'));
  assert.deepEqual(before, deployed);
  fs.appendFileSync(path.join(options.root, '.claude/ai-loop/WORKFLOW.md'), '\n部署变化');
  assert.deepEqual(snapshot(options.root, [], options.bundle), before);
  fs.appendFileSync(path.join(options.root, '.codex/config.toml'), '\nmodel = "changed"\n');
  assert.notEqual(snapshot(options.root, [], options.bundle).digest, before.digest);
});

test('配置表类型与点分键不强行改写，Cursor 关闭 alwaysApply 会停止', t => {
  for (const text of ['[developer_instructions]\nvalue="x"', 'developer_instructions.value="x"', '["developer_\\u0069nstructions"]\nvalue="x"']) assert.throws(() => updateRootString(text, 'developer_instructions', () => 'x'), /不能自动覆盖/);
  const options = fixture(t);
  install({ ...options, harness: 'cursor', apply: true });
  put(options, '.cursor/rules/ai-loop.mdc', get(options, '.cursor/rules/ai-loop.mdc').replace('alwaysApply: true', 'alwaysApply: false'));
  assert.throws(() => install({ ...options, harness: 'cursor', check: true }), /alwaysApply/);
});

test('清单平台键损坏与部署路径碰撞停止；已有锁不删除或覆盖', t => {
  const options = fixture(t);
  install({ ...options, apply: true });
  const manifest = JSON.parse(get(options, '.ai-loop/install.json'));
  manifest.harnesses.cursor = manifest.harnesses.codex;
  put(options, '.ai-loop/install.json', JSON.stringify(manifest));
  assert.throws(() => install({ ...options, apply: true }), /平台键/);
  delete manifest.harnesses.cursor;
  put(options, '.ai-loop/install.json', JSON.stringify(manifest));
  put(options, '.ai-loop/install.lock', '运行中');
  fs.appendFileSync(path.join(options.bundle, 'WORKFLOW.md'), '\n升级');
  assert.throws(() => install({ ...options, apply: true }), /持有锁/);
  assert.equal(get(options, '.ai-loop/install.lock'), '运行中');
  assert.notEqual(get(options, '.codex/ai-loop/WORKFLOW.md'), fs.readFileSync(path.join(options.bundle, 'WORKFLOW.md'), 'utf8'));
});
