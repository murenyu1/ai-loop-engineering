import { BUNDLE as SOURCE_ROOT, runtimeContent } from '../scripts/lib.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { install, REQUIRED_FILES } from '../scripts/install.mjs';
import { balanced, validateProfile, routeHash } from '../scripts/routing.mjs';
import { configureProfile, resolveProfile } from '../codex/scripts/profiles.mjs';
import { cli as modelCli, changeModel } from '../scripts/models.mjs';
import { diagnose } from '../scripts/doctor.mjs';
import { recordAgent, agentStatus } from '../scripts/agents.mjs';
import { create, status, begin, snapshot, record, fix } from '../scripts/loop.mjs';
import { rootString } from '../scripts/toml.mjs';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function fixture(t, harness = 'codex', bundleName = '源 包') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, bundleName);
  for (const file of REQUIRED_FILES) {
    fs.mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
    fs.writeFileSync(path.join(bundle, file), runtimeContent(SOURCE_ROOT, file));
  }
  return { root, project: root, bundle, harness, env: { HOME: path.join(root, 'personal') } };
}
const get = (o, file) => fs.readFileSync(path.join(o.root, file), 'utf8');
function put(o, file, content) { fs.mkdirSync(path.dirname(path.join(o.root, file)), { recursive: true }); fs.writeFileSync(path.join(o.root, file), content); }
const manifest = o => JSON.parse(get(o, '.ai-loop/install.json'));

test('Claude 原生代理模型、强度和叶子约束；默认不碰 settings 与主模型', t => {
  const o = fixture(t, 'claude-code');
  put(o, '.claude/settings.json', '{"model":"personal","permissions":{"deny":["Bash(git push)"]}}');
  install({ ...o, 'model-routing': 'balanced', apply: true });
  for (const role of ['planner', 'reviewer', 'dev', 'tester', 'scribe']) {
    const content = get(o, `.claude/agents/loop-${role}.md`);
    assert.match(content, new RegExp(`name: loop-${role}`));
    assert.ok(content.includes(`model: "${['planner', 'reviewer'].includes(role) ? 'opus' : 'sonnet'}"`));
    assert.match(content, /effort: (high|medium)/);
    assert.match(content, /disallowedTools: Agent/);
  }
  assert.match(get(o, '.claude/settings.json'), /"model":"personal"/);
  assert.equal(manifest(o).harnesses['claude-code'].native_files.length, 6);
  assert.match(get(o, '.claude/skills/ai-loop/SKILL.md'), /本技能明确要求/);
  assert.deepEqual(install({ ...o, check: true }).changes, []);
  assert.match(get(o, '.claude/ai-loop/ROUTING.md'), /原生 loop-\* 子代理/);
});

test('逐角色自定义、预演、切换保留其他角色和另一 harness，不修改活跃任务计数', t => {
  const o = fixture(t);
  install({ ...o, 'model-routing': 'balanced', apply: true });
  install({ ...o, harness: 'claude-code', 'model-routing': 'balanced', apply: true });
  const claude = get(o, '.claude/agents/loop-dev.md');
  const reviewer = get(o, '.codex/agents/loop-reviewer.toml');
  const run = create(o.root, { goal: '切换模型', tasks: [{ id: 't1', title: '任务', acceptance: ['行为'], review: 'self', checks: [{ id: 'test', command: 'check' }] }] }, 'switch').run_id;
  begin(o.root, run, 't1', 'development'); begin(o.root, run, 't1', 'verification');
  record(o.root, run, { role: 'tester', task_id: 't1', status: 'FAIL', execution: 'self', revision: snapshot(o.root), issues: ['需修复'] });
  fix(o.root, run, 't1');
  const params = { ...o, role: 'dev', model: 'custom-model', effort: 'low' };
  const preview = changeModel(params);
  assert.ok(preview.changes.includes('.codex/agents/loop-dev.toml'));
  assert.equal(rootString(get(o, '.codex/agents/loop-dev.toml'), 'model').value, 'gpt-6-luna');
  const result = changeModel({ ...params, apply: true });
  assert.equal(result.current_agents, 'unchanged');
  assert.equal(result.effective_model, 'unverified');
  assert.equal(rootString(get(o, '.codex/agents/loop-dev.toml'), 'model').value, 'custom-model');
  assert.equal(get(o, '.codex/agents/loop-reviewer.toml'), reviewer);
  assert.equal(get(o, '.claude/agents/loop-dev.md'), claude);
  assert.equal(status(o.root, run).tasks[0].fixes, 1);
  assert.deepEqual(install({ ...o, check: true }).changes, []);
});

test('Codex插件路径升级时重写原生角色指令路径并保留模型profile', t => {
  const o = fixture(t);
  const home = path.join(o.root, 'personal');
  fs.mkdirSync(home, { recursive: true });
  const nextBundle = path.join(o.root, '新插件路径');
  fs.mkdirSync(path.join(nextBundle, 'agents'), { recursive: true });
  fs.copyFileSync(path.join(o.bundle, 'agents/loop-dev.md'), path.join(nextBundle, 'agents/loop-dev.md'));
  const profile = balanced('codex');
  profile.roles.dev.model = 'custom-codex-model';
  configureProfile(o.project, profile, { home, scope: 'global', bundle: o.bundle, apply: true });

  const prior = resolveProfile(o.project, { home, scope: 'global' });
  assert.equal(prior.bundle, o.bundle.split(path.sep).join('/'));
  const result = configureProfile(o.project, prior.profile, { home, scope: 'global', bundle: nextBundle, apply: true });
  const migrated = resolveProfile(o.project, { home, scope: 'global' });
  const agent = fs.readFileSync(path.join(home, 'agents/loop-dev.toml'), 'utf8');
  assert.equal(result.status, 'configured');
  assert.equal(migrated.bundle, nextBundle.split(path.sep).join('/'));
  assert.equal(migrated.profile.roles.dev.model, 'custom-codex-model');
  assert.ok(agent.includes(nextBundle.split(path.sep).join('/') + '/agents/loop-dev.md'));
  assert.ok(!agent.includes(o.bundle.split(path.sep).join('/') + '/agents/loop-dev.md'));
});

test('模型配置字段、平台、参数与非交互选择校验', async t => {
  const o = fixture(t);
  for (const mutate of [p => p.roles.dev.effort = 'extreme', p => delete p.roles.tester, p => p.roles.dev.model = 'inherit', p => p.roles.dev.model = 'bad\nmodel', p => p.concurrency = 20, p => p.roles.dev.tool = 'write', p => p.main.effort = null]) {
    const profile = balanced('codex'); mutate(profile);
    assert.throws(() => validateProfile(profile, 'codex'));
  }
  assert.throws(() => validateProfile(balanced('codex'), 'claude-code'), /不匹配/);
  assert.throws(() => install({ ...o, 'model-routing': 'balanced', profile: balanced('codex') }), /不能同时/);
  await assert.rejects(() => modelCli(['configure', '--project', o.root, '--harness', 'codex'], { input: { isTTY: false }, output: { isTTY: false } }), /先询问/);
  await assert.rejects(() => modelCli(['configure', '--project', o.root, '--harness', 'codex', '--preset', 'balanced', '--model', 'ignored']), /单角色修改/);
  await assert.rejects(() => modelCli(['status', '--project', o.root, '--harness', 'codex', '--apply']), /不接受/);
  put(o, 'route.json', JSON.stringify(balanced('codex')));
  install({ ...o, routing: 'route.json', apply: true });
  assert.throws(() => install({ ...o, routing: '../escape.json' }), /路径/);
  assert.equal(manifest(o).harnesses.codex.model_routing.profile_hash, routeHash(balanced('codex')));
});

test('Claude 中途切换和省略 effort；无原生权限改写', t => {
  const o = fixture(t, 'claude-code');
  install({ ...o, 'model-routing': 'balanced', apply: true });
  const result = changeModel({ ...o, role: 'scribe', model: 'haiku', effort: 'inherit', apply: true });
  assert.match(get(o, '.claude/agents/loop-scribe.md'), /model: "haiku"/);
  assert.doesNotMatch(get(o, '.claude/agents/loop-scribe.md'), /^effort:/m);
  assert.equal(fs.existsSync(path.join(o.root, '.claude/settings.json')), false);
  assert.match(result.reload, /首次创建/);
});

test('同名原生定义、人工修改与环境强制覆盖有明确诊断', t => {
  for (const harness of ['codex', 'claude-code']) {
    const o = fixture(t, harness);
    const name = harness === 'codex' ? '.codex/agents/another.toml' : '.claude/agents/another.md';
    put(o, name, harness === 'codex' ? 'name = "loop-dev"\n' : '---\nname: loop-dev\n---\n');
    assert.throws(() => install({ ...o, 'model-routing': 'balanced', apply: true }), /名称已有/);
    assert.equal(fs.existsSync(path.join(o.root, '.ai-loop')), false);
  }
  const o = fixture(t, 'claude-code');
  install({ ...o, 'model-routing': 'balanced', apply: true });
  const report = diagnose({ ...o, env: { ...o.env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_EFFORT_LEVEL: 'high' } });
  assert.equal(report.configuration, 'pass');
  assert.ok(report.issues.some(issue => issue.includes('强制模型')));
  for (const key of ['native_discovery', 'execution', 'effective_model', 'ui_visibility']) assert.equal(report[key], 'unverified');
  put(o, '.claude/agents/loop-dev.md', 'edited');
  assert.equal(diagnose(o).configuration, 'fail');
  assert.throws(() => changeModel({ ...o, role: 'dev', model: 'other', apply: true }), /人工修改/);
});

test('原生技能碰撞和配置高强度支持边界', t => {
  const o = fixture(t);
  put(o, '.agents/skills/ai-loop/SKILL.md', '用户已有技能');
  assert.throws(() => install({ ...o, 'model-routing': 'balanced', apply: true }), /技能路径已有未注册/);
  assert.equal(fs.existsSync(path.join(o.root, '.ai-loop')), false);
  const profile = balanced('codex'); profile.roles.dev.effort = 'ultra';
  assert.equal(validateProfile(profile, 'codex').roles.dev.effort, 'ultra');
});

test('旧 Codex 注册配置原地迁移，仅删除已登记旧文件且保留用户正文与运行', t => {
  const o = fixture(t);
  install({ ...o, 'model-routing': 'balanced', apply: true });
  const m = manifest(o);
  const r = m.harnesses.codex;
  for (const file of r.native_files) fs.unlinkSync(path.join(o.root, file.path));
  delete r.native_files;
  const oldBlock = '# ai-loop-models:start\n[agents]\nenabled = true\n[agents.loop-dev]\nconfig_file = "ai-loop/codex/loop-dev.toml"\n# ai-loop-models:end';
  const config = get(o, '.codex/config.toml').replace(/# ai-loop-models:start[\s\S]*?# ai-loop-models:end/, oldBlock) + '\n# 用户保留\n';
  put(o, '.codex/config.toml', config);
  r.model_routing = { mode: 'balanced', block_hash: hash(oldBlock) };
  const oldPath = '.codex/ai-loop/codex/loop-dev.toml';
  put(o, oldPath, 'model = "gpt-6-luna"\n');
  r.files.push({ path: oldPath, hash: hash(get(o, oldPath)) });
  put(o, '.ai-loop/install.json', JSON.stringify(m));
  put(o, '.ai-loop/runs/keep.txt', '保留');
  const preview = install(o);
  assert.ok(preview.changes.includes(oldPath));
  assert.equal(fs.existsSync(path.join(o.root, oldPath)), true);
  install({ ...o, apply: true });
  assert.equal(fs.existsSync(path.join(o.root, oldPath)), false);
  assert.match(get(o, '.codex/agents/loop-dev.toml'), /^name = "loop-dev"/);
  assert.match(get(o, '.agents/skills/ai-loop/SKILL.md'), /原生 loop-\* 子代理/);
  assert.match(get(o, '.codex/config.toml'), /# 用户保留/);
  assert.equal(get(o, '.ai-loop/runs/keep.txt'), '保留');
  assert.deepEqual(install({ ...o, check: true }).changes, []);
});

test('代理生命周期、证据与切换关联，不把记录当作真实模型证明', t => {
  const o = fixture(t);
  install({ ...o, 'model-routing': 'balanced', apply: true });
  const run = create(o.root, { goal: '状态', tasks: [{ id: 't1', title: '任务', acceptance: ['行为'], review: 'self', checks: [{ id: 'c', command: 'check' }] }] }, 'agents').run_id;
  recordAgent(o.root, run, { id: 'a1', harness: 'codex', role: 'dev', task: 't1', state: 'requested', summary: '准备派发' });
  assert.throws(() => recordAgent(o.root, run, { id: 'a1', state: 'running', summary: '启动' }), /真实原生/);
  assert.throws(() => recordAgent(o.root, run, { id: 'a2', harness: 'codex', role: 'dev', task: 't1', state: 'requested', summary: '替换', replaces: 'a1' }), /先完成或停止/);
  const evidence = `.ai-loop/runs/${run}/reports/native.json`;
  put(o, evidence, '{"example":"测试夹具，非真实调用"}');
  const result = recordAgent(o.root, run, { id: 'a1', native_id: 'native-test-fixture', state: 'running', summary: '夹具启动', observation: { source: 'native-log', path: evidence, model: 'observed-model' } });
  assert.equal(result.effective_model, 'unverified');
  assert.equal(result.observations[0].verification, 'reported-with-evidence');
  assert.throws(() => recordAgent(o.root, run, { id: 'a1', state: 'waiting', summary: '观察', observation: { source: 'native-log', path: '../out' } }), /路径/);
  recordAgent(o.root, run, { id: 'a1', state: 'stopped', summary: '安全停止并交接' });
  assert.throws(() => recordAgent(o.root, run, { id: 'a1', state: 'running', summary: '不能恢复' }), /终态/);
  changeModel({ ...o, role: 'dev', model: 'replacement-model', apply: true });
  recordAgent(o.root, run, { id: 'a2', harness: 'codex', role: 'dev', task: 't1', state: 'requested', summary: '接续同任务', replaces: 'a1' });
  const agents = agentStatus(o.root, run).agents;
  assert.equal(agents[0].requested.model, 'gpt-6-luna');
  assert.equal(agents[1].requested.model, 'replacement-model');
  assert.equal(agents[1].replaces, 'a1');
});

// 用独立 Node 进程执行 README 中的 CLI，而非只调用安装器函数。
// 仅验证本地安装/状态协议；无模型调用，不宣称原生子代理或 UI 已通过。
for (const kind of ['new', 'existing']) for (const harness of ['codex', 'claude-code']) {
  test(`README CLI：${kind} 项目 / ${harness} 安装、启动、切换与证据闭环`, t => {
    const o = fixture(t, harness, 'ai-loop-engineering');
    const home = harness === 'codex' ? '.codex/ai-loop' : '.claude/ai-loop';
    const sourceHashes = REQUIRED_FILES.map(file => [file, hash(get(o, 'ai-loop-engineering/' + file))]);
    const existing = new Map();
    if (kind === 'existing') {
      existing.set('AGENTS.md', '# 项目规则：保留已有内容\n');
      existing.set('CLAUDE.md', '# 既有 Claude 项目说明\n');
      existing.set('src/main.txt', '已有业务源码与未提交修改\n');
      existing.set('.codex/config.toml', '# 项目已有配置\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n[profiles.keep]\nmodel = "personal"\n');
      existing.set('.claude/settings.json', '{"model":"personal"}\n');
      for (const [file, content] of existing) put(o, file, content);
    }
    const runCli = (script, argv) => {
      // 仅给测试安装器一个隔离的个人配置位置，不运行 harness、不修改当前进程环境。
      const child = spawnSync(process.execPath, [script, ...argv], { cwd: o.root, encoding: 'utf8',
        env: { ...process.env, CODEX_HOME: path.join(o.root, 'test-personal-config') } });
      assert.equal(child.status, 0, child.stderr || child.error?.message);
      return JSON.parse(child.stdout);
    };
    const installer = './ai-loop-engineering/scripts/install.mjs';
    const params = ['--project', '.', '--harness', harness];
    assert.equal(runCli(installer, [...params, '--model-routing', 'balanced']).status, 'dry-run');
    assert.equal(fs.existsSync(path.join(o.root, '.ai-loop')), false);
    assert.equal(runCli(installer, [...params, '--model-routing', 'balanced', '--apply']).status, 'configured');
    assert.deepEqual(runCli(installer, [...params, '--check']).changes, []);
    const models = `./${home}/scripts/models.mjs`;
    const requested = runCli(models, ['status', ...params]);
    assert.equal(requested.profile.roles.dev.model, harness === 'codex' ? 'gpt-6-luna' : 'sonnet');
    const nextModel = harness === 'codex' ? 'gpt-6.1-sol' : 'opus';
    const update = ['set', ...params, '--role', 'dev', '--model', nextModel, '--effort', 'medium'];
    assert.equal(runCli(models, update).status, 'dry-run');
    assert.equal(runCli(models, ['status', ...params]).profile.roles.dev.effort, 'high');
    assert.equal(runCli(models, [...update, '--apply']).current_agents, 'unchanged');
    assert.equal(runCli(models, ['status', ...params]).profile.roles.dev.effort, 'medium');
    assert.equal(runCli(models, ['status', ...params]).profile.roles.dev.model, nextModel);
    runCli(installer, [...params, '--apply']); // 普通升级保留自定义模型/强度。
    assert.equal(runCli(models, ['status', ...params]).profile.roles.dev.effort, 'medium');
    assert.equal(runCli(models, ['status', ...params]).profile.roles.dev.model, nextModel);
    const jsonProfile = runCli(models, ['status', ...params]).profile;
    jsonProfile.roles.scribe.effort = null;
    put(o, '.ai-loop/routing-input.json', JSON.stringify(jsonProfile));
    assert.equal(runCli(installer, [...params, '--routing', '.ai-loop/routing-input.json']).status, 'dry-run');
    runCli(installer, [...params, '--routing', '.ai-loop/routing-input.json', '--apply']);
    assert.equal(runCli(models, ['status', ...params]).profile.roles.scribe.effort, null);
    assert.deepEqual(runCli(installer, [...params, '--check']).changes, []);
    const doctor = runCli(`./${home}/scripts/doctor.mjs`, params);
    assert.equal(doctor.configuration, 'pass');
    assert.equal(doctor.execution, 'unverified');
    assert.equal(runCli(`./${home}/scripts/memory.mjs`, ['bootstrap', '--project', '.']).active_count, 0);

    // 实际运行一条 Node 检查命令，以真实退出码和日志走通已部署脚本的证据门。
    put(o, 'check.mjs', "process.stdout.write('readme-cli-ok\\n');\n");
    put(o, '.ai-loop/request.json', JSON.stringify({ goal: 'README 脚本级验收', tasks: [{ id: 'task1', title: '只读本地检查', acceptance: ['检查命令成功'], review: 'none', checks: [{ id: 'node', command: 'node check.mjs' }] }] }));
    const loop = `./${home}/scripts/loop.mjs`;
    const run = ['--project', '.', '--run', 'readme-flow'];
    runCli(loop, ['create', ...run, '--input', '.ai-loop/request.json']);
    runCli(loop, ['begin', ...run, '--task', 'task1', '--phase', 'development']);
    runCli(loop, ['begin', ...run, '--task', 'task1', '--phase', 'verification']);
    const revision = runCli(loop, ['snapshot', ...run]);
    const checked = spawnSync(process.execPath, ['check.mjs'], { cwd: o.root, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    put(o, '.ai-loop/runs/readme-flow/reports/check.log', checked.stdout + checked.stderr);
    const verification = { role: 'tester', task_id: 'task1', status: 'PASS', execution: 'self', revision,
      checks: [{ id: 'node', command: 'node check.mjs', environment: process.version + ' / ' + process.platform, exit_code: checked.status, log: 'reports/check.log' }], issues: [] };
    put(o, '.ai-loop/report.json', JSON.stringify(verification));
    runCli(loop, ['record', ...run, '--input', '.ai-loop/report.json']);
    put(o, '.ai-loop/delivery.json', JSON.stringify({ verification }));
    assert.equal(runCli(loop, ['complete', ...run, '--input', '.ai-loop/delivery.json']).status, 'complete');
    assert.equal(runCli(loop, ['status', ...run]).tasks[0].fixes, 0);
    for (const [file, content] of existing) {
      if (file === '.codex/config.toml' && harness === 'codex') assert.ok(get(o, file).includes('[profiles.keep]\nmodel = "personal"'));
      else assert.equal(get(o, file), content);
    }
    for (const [file, before] of sourceHashes) assert.equal(hash(get(o, 'ai-loop-engineering/' + file)), before);
    assert.equal(fs.existsSync(path.join(o.root, '.git')), false);
  });
}
