import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { balanced, disabledProfile, routeHash, nativeAgent, roleEnabled } from '../scripts/routing.mjs';
import { resolveProfile, resolveWorkspaceProfile, resolveEffectiveProfile } from '../codex/scripts/profiles.mjs';
import { startupContext } from '../codex/scripts/session-start.mjs';
import { rolePolicy } from '../codex/scripts/codex-activity.mjs';
import { createSettingsManager } from '../codex/scripts/native-settings.mjs';
import { createSettingsProtocol } from '../codex/scripts/settings-server.mjs';
import { setWorkspaceRecordById, workspaceEntryById } from '../codex/scripts/workspaces.mjs';
import { readCodexWorkspaces } from '../codex/scripts/codex-workspaces.mjs';
import { create } from '../scripts/loop.mjs';
import { buildPlugin } from '../scripts/build-plugin.mjs';
import { BUNDLE } from '../scripts/lib.mjs';

function fixture(t, count = 1) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-profiles-'));
    const home = path.join(parent, 'home');
    const roots = Array.from({ length: count }, (_, i) => path.join(parent, 'project-' + i));
    for (const dir of [home, ...roots]) fs.mkdirSync(dir);
    t.after(() => {
        assert.equal(path.dirname(parent), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(parent).startsWith('ai-loop-profiles-'));
        fs.rmSync(parent, { recursive: true, force: true });
    });
    const state = { 'local-projects': { w: { name: '夹具工作区', rootPaths: roots } } };
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify(state));
    setWorkspaceRecordById(home, { id: 'w', roots, enabled: true });
    return { parent, home, roots, root: roots[0], workspace: () => readCodexWorkspaces(home).workspaces[0] };
}

function save(f, scope, profile, root = f.root, bundle = BUNDLE) {
    const base = scope === 'global' ? f.home : root;
    const prefix = scope === 'global' ? 'agents' : '.codex/agents';
    const native = {};
    for (const [role, value] of Object.entries(profile.roles)) {
        if (!roleEnabled(value)) continue;
        const file = prefix + '/loop-' + role + '.toml';
        const content = nativeAgent(profile, role, bundle);
        fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        fs.writeFileSync(path.join(base, file), content);
        native[file] = crypto.createHash('sha256').update(content).digest('hex');
    }
    const file = path.join(base, scope === 'global' ? 'ai-loop/models.json' : '.ai-loop/models.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 2, profile, profile_hash: routeHash(profile), native, bundle }));
    return file;
}
const start = f => startupContext({ hook_event_name: 'SessionStart', cwd: f.root, session_id: 'fixture-parent' }, { home: f.home });
const models = async () => ({ models: [] });

test('仅登记启用的工作区默认继承全局，设置、启动和登记策略一致且读取不落盘', async t => {
    const f = fixture(t), global = balanced('codex');
    save(f, 'global', global);
    const before = fs.readFileSync(path.join(f.home, 'ai-loop/workspaces.json'));
    const resolved = resolveWorkspaceProfile(f.home, f.workspace());
    assert.equal(resolved.scope, 'global');
    assert.deepEqual(resolved.profile, global);
    assert.equal(resolveEffectiveProfile(f.root, { home: f.home }).scope, 'global');
    assert.deepEqual(rolePolicy(f.root, { home: f.home }), global.roles);
    assert.match(start(f).hookSpecificOutput.additionalContext, /已开启角色：planner、reviewer、dev、tester、scribe/);
    const manager = createSettingsManager({ home: f.home, modelsProvider: models });
    const view = await manager.update({ workspace_id: 'w' });
    assert.match(view.status, /项目继承全局/);
    assert.equal(view.values['model.dev'], global.roles.dev.model);
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'ai-loop/workspaces.json')), before);
    assert.equal(workspaceEntryById(f.home, 'w').inherits_global, undefined);
    assert.equal(fs.existsSync(path.join(f.root, '.ai-loop/models.json')), false);
});

test('多个空成员目录继承同一全局，后续全局变更实时反映到每个成员', t => {
    const f = fixture(t, 2), global = balanced('codex');
    save(f, 'global', global);
    for (const root of f.roots) assert.equal(resolveEffectiveProfile(root, { home: f.home }).profile.concurrency, global.concurrency);
    global.concurrency = 7; save(f, 'global', global);
    const resolved = resolveWorkspaceProfile(f.home, f.workspace());
    assert.equal(resolved.profile.concurrency, 7);
    assert.deepEqual(resolved.member_profiles.map(row => row.profile_hash), [null, null]);
    for (const root of f.roots) assert.equal(resolveEffectiveProfile(root, { home: f.home }).profile.concurrency, 7);
});

test('从未保存插件开关的宿主工作区仍可继承模型，自动入口继续保持默认停用', t => {
    const f = fixture(t), global = balanced('codex');
    save(f, 'global', global);
    fs.unlinkSync(path.join(f.home, 'ai-loop/workspaces.json'));
    assert.equal(resolveEffectiveProfile(f.root, { home: f.home }).profile_hash, routeHash(global));
    assert.equal(start(f), null);
});

test('完全未配置时保持默认全部关闭，不创建全局或项目配置', async t => {
    const f = fixture(t);
    assert.equal(resolveEffectiveProfile(f.root, { home: f.home }).profile, null);
    assert.match(start(f).hookSpecificOutput.additionalContext, /五个子代理当前全部关闭/);
    const manager = createSettingsManager({ home: f.home, modelsProvider: models });
    const view = await manager.update({ workspace_id: 'w' });
    for (const name of Object.keys(disabledProfile('codex').roles)) assert.equal(view.values['model.' + name], '关闭');
    assert.equal(fs.existsSync(path.join(f.home, 'ai-loop/models.json')), false);
});

test('项目显式全关闭覆盖全局开启，不能因角色关闭回退全局', async t => {
    const f = fixture(t), local = disabledProfile('codex');
    save(f, 'global', balanced('codex')); save(f, 'project', local);
    const resolved = resolveEffectiveProfile(f.root, { home: f.home });
    assert.equal(resolved.scope, 'project');
    assert.ok(Object.values(resolved.profile.roles).every(role => !roleEnabled(role)));
    assert.match(start(f).hookSpecificOutput.additionalContext, /五个子代理当前全部关闭/);
    const manager = createSettingsManager({ home: f.home, modelsProvider: models });
    assert.equal((await manager.update({ workspace_id: 'w' })).values['model.dev'], '关闭');
});

test('明确继承全局忽略陈旧项目配置和注册表中的旧全局快照', t => {
    const f = fixture(t), global = balanced('codex');
    save(f, 'project', disabledProfile('codex')); save(f, 'global', global);
    setWorkspaceRecordById(f.home, { id: 'w', roots: f.roots, enabled: true, inherits_global: true, profile: global, profile_hash: routeHash(global) });
    global.concurrency = 6; save(f, 'global', global);
    assert.equal(resolveEffectiveProfile(f.root, { home: f.home }).profile.concurrency, 6);
    assert.match(start(f).hookSpecificOutput.additionalContext, /已开启角色/);
});

test('多成员旧配置不一致时有效策略和启动入口都阻断，设置页提供迁移而不冒报关闭', async t => {
    const f = fixture(t, 2);
    save(f, 'global', balanced('codex')); save(f, 'project', balanced('codex'));
    assert.throws(() => resolveEffectiveProfile(f.root, { home: f.home }), /不一致/);
    assert.throws(() => start(f), /不一致/);
    const manager = createSettingsManager({ home: f.home, modelsProvider: models });
    const view = await manager.update({ workspace_id: 'w' });
    assert.match(view.status, /不一致/);
    assert.deepEqual(view.schema.properties.workspace_profile_source_id.enum, ['', ...f.roots]);
});

test('工作区集中配置与成员物化不一致时启动入口拒绝宣称角色已开启', t => {
    const f = fixture(t), profile = balanced('codex');
    setWorkspaceRecordById(f.home, { id: 'w', roots: f.roots, enabled: true, profile, profile_hash: routeHash(profile), inherits_global: false, materialized_profiles: { [f.root]: routeHash(profile) } });
    assert.throws(() => resolveEffectiveProfile(f.root, { home: f.home }), /不一致/);
    assert.throws(() => start(f), /不一致/);
});

test('损坏的全局配置在默认继承时明确报错，不能退化为全部关闭', t => {
    const f = fixture(t), file = save(f, 'global', balanced('codex'));
    const bad = JSON.parse(fs.readFileSync(file)); bad.profile_hash = '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => resolveEffectiveProfile(f.root, { home: f.home }), /摘要损坏/);
    assert.throws(() => start(f), /摘要损坏/);
});

test('模型status默认遵循工作区有效配置，显式scope仍能查看原始项目层', t => {
    const f = fixture(t), global = balanced('codex');
    save(f, 'global', global); save(f, 'project', disabledProfile('codex'));
    setWorkspaceRecordById(f.home, { id: 'w', roots: f.roots, enabled: true, inherits_global: true });
    const run = extra => spawnSync(process.execPath, ['codex/scripts/plugin-models.mjs', 'status', '--project', f.root, ...extra], { cwd: BUNDLE, env: { ...process.env, CODEX_HOME: f.home }, encoding: 'utf8', windowsHide: true });
    const effective = run([]); assert.equal(effective.status, 0, effective.stderr);
    assert.equal(JSON.parse(effective.stdout).scope, 'global');
    assert.equal(JSON.parse(effective.stdout).profile.roles.dev.model, global.roles.dev.model);
    const project = run(['--scope', 'project']); assert.equal(project.status, 0, project.stderr);
    assert.equal(JSON.parse(project.stdout).scope, 'project');
    assert.equal(JSON.parse(project.stdout).profile.roles.dev.enabled, false);
});

test('MCP看板角色状态与设置页、有效配置和登记策略使用相同全局继承', async t => {
    const f = fixture(t), global = balanced('codex');
    save(f, 'global', global);
    create(f.root, { goal: '夹具角色状态', tasks: [{ id: 't', title: '夹具', acceptance: ['角色状态一致'], review: 'self', checks: [{ id: 'check', command: 'node --version' }] }] }, 'fixture');
    const protocol = createSettingsProtocol({}, { home: f.home });
    const response = await protocol.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ai_loop.dashboard.status', arguments: { root: f.root, run: 'fixture' } } });
    assert.notEqual(response.result.isError, true, JSON.stringify(response));
    for (const [role, value] of Object.entries(global.roles)) {
        assert.equal(response.result.structuredContent.roles[role].enabled, true);
        assert.equal(response.result.structuredContent.roles[role].model, value.model);
    }
});

test('实际打包插件的doctor对宿主已登记工作区识别全局角色并保留文件篡改阻断', async t => {
    const f = fixture(t);
    const target = buildPlugin('.release/profile-test-' + path.basename(f.parent)).output;
    t.after(() => {
        assert.ok(target.startsWith(path.join(BUNDLE, '.release') + path.sep));
        fs.rmSync(target, { recursive: true, force: true });
    });
    const global = balanced('codex'); save(f, 'global', global, f.root, target);
    const runtime = await import(pathToFileURL(path.join(target, 'scripts/plugin.mjs')).href);
    const report = runtime.pluginDoctor(f.root, { home: f.home });
    assert.equal(report.configuration, 'pass', JSON.stringify(report.issues));
    assert.equal(report.dispatch, 'requires-native-verification');
    assert.equal(report.models.scope, 'global');
    assert.deepEqual(report.enabled_roles, Object.keys(global.roles));
    fs.appendFileSync(path.join(f.home, 'agents/loop-dev.toml'), '# test mutation\n');
    assert.equal(runtime.pluginDoctor(f.root, { home: f.home }).dispatch, 'blocked');
});

function modelCommand(f, args) {
    return spawnSync(process.execPath, ['codex/scripts/plugin-models.mjs', ...args, '--project', f.root], {
        cwd: BUNDLE, env: { ...process.env, CODEX_HOME: f.home }, encoding: 'utf8', windowsHide: true
    });
}

test('CLI项目set/configure按工作区事务更新全部成员，预演不写配置', t => {
    const f = fixture(t, 2), global = balanced('codex');
    save(f, 'global', global);
    const registry = path.join(f.home, 'ai-loop/workspaces.json'), before = fs.readFileSync(registry);
    const preview = modelCommand(f, ['set', '--scope', 'project', '--role', 'dev', '--model', 'fixture-model']);
    assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).status, 'dry-run');
    assert.deepEqual(fs.readFileSync(registry), before);
    for (const root of f.roots) assert.equal(fs.existsSync(path.join(root, '.ai-loop/models.json')), false);
    const applied = modelCommand(f, ['set', '--scope', 'project', '--role', 'dev', '--model', 'fixture-model', '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    for (const root of f.roots) {
        const current = resolveEffectiveProfile(root, { home: f.home });
        assert.equal(current.profile.roles.dev.model, 'fixture-model');
        assert.equal(current.profile.roles.reviewer.model, global.roles.reviewer.model, '保留继承的其他角色');
        assert.equal(current.scope, 'project');
    }
    const configured = balanced('codex'); configured.concurrency = 5;
    const input = path.join(f.parent, 'input.json'); fs.writeFileSync(input, JSON.stringify(configured));
    const changed = modelCommand(f, ['configure', '--scope', 'project', '--input', input, '--apply']);
    assert.equal(changed.status, 0, changed.stderr);
    for (const root of f.roots) assert.equal(resolveEffectiveProfile(root, { home: f.home }).profile.concurrency, 5);
    assert.equal(resolveWorkspaceProfile(f.home, f.workspace()).materialization_conflict, false);
    assert.equal(workspaceEntryById(f.home, 'w').enabled, true);
});

test('CLI恢复项目配置对全部成员生效并登记继承，预演保留项目文件', t => {
    const f = fixture(t, 2), global = balanced('codex');
    save(f, 'global', global);
    const set = modelCommand(f, ['set', '--scope', 'project', '--concurrency', '2', '--apply']);
    assert.equal(set.status, 0, set.stderr);
    const before = f.roots.map(root => fs.readFileSync(path.join(root, '.ai-loop/models.json')));
    const preview = modelCommand(f, ['reset', '--scope', 'project']);
    assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).status, 'dry-run');
    f.roots.forEach((root, i) => assert.deepEqual(fs.readFileSync(path.join(root, '.ai-loop/models.json')), before[i]));
    assert.equal(workspaceEntryById(f.home, 'w').inherits_global, false);
    const reset = modelCommand(f, ['reset', '--scope', 'project', '--apply']);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(workspaceEntryById(f.home, 'w').inherits_global, true);
    for (const root of f.roots) {
        assert.equal(fs.existsSync(path.join(root, '.ai-loop/models.json')), false);
        assert.equal(resolveEffectiveProfile(root, { home: f.home }).profile_hash, routeHash(global));
    }
});

test('CLI项目修改遇成员冲突或重复共享根时拒绝写入，不覆盖现有配置', t => {
    const f = fixture(t, 2), global = balanced('codex');
    save(f, 'global', global);
    const file = save(f, 'project', global), before = fs.readFileSync(file);
    const changed = modelCommand(f, ['set', '--scope', 'project', '--role', 'dev', '--model', 'bad', '--apply']);
    assert.equal(changed.status, 1); assert.match(changed.stderr, /不一致/);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.writeFileSync(path.join(f.home, '.codex-global-state.json'), JSON.stringify({
        'local-projects': { w: { rootPaths: f.roots }, other: { rootPaths: [f.root] } }
    }));
    const shared = modelCommand(f, ['set', '--scope', 'project', '--concurrency', '2', '--apply']);
    assert.equal(shared.status, 1); assert.match(shared.stderr, /多个 Codex 工作区/);
    assert.deepEqual(fs.readFileSync(file), before);
});


test('集中登记与旧成员不一致时设置和doctor明确阻断，原生设置可恢复全局继承', async t => {
    const f = fixture(t, 2), local = disabledProfile('codex'), central = balanced('codex');
    const target = buildPlugin('.release/recovery-test-' + path.basename(f.parent)).output;
    t.after(() => {
        assert.ok(target.startsWith(path.join(BUNDLE, '.release') + path.sep));
        fs.rmSync(target, { recursive: true, force: true });
    });
    const global = balanced('codex'); global.concurrency = 7;
    const globalFile = save(f, 'global', global, f.root, target), beforeGlobal = fs.readFileSync(globalFile);
    save(f, 'project', local);
    setWorkspaceRecordById(f.home, { id: 'w', roots: f.roots, enabled: true,
        profile: central, profile_hash: routeHash(central), inherits_global: false,
        materialized_profiles: { [f.roots[0]]: routeHash(local), [f.roots[1]]: null } });
    assert.equal(resolveWorkspaceProfile(f.home, f.workspace()).materialization_conflict, true);
    assert.throws(() => resolveEffectiveProfile(f.root, { home: f.home }), /不一致/);
    assert.throws(() => start(f), /不一致/);
    const runtime = await import(pathToFileURL(path.join(target, 'scripts/plugin.mjs')).href);
    assert.throws(() => runtime.pluginDoctor(f.root, { home: f.home }), /不一致/);
    const manager = createSettingsManager({ home: f.home, bundle: target, modelsProvider: models });
    const view = await manager.update({ workspace_id: 'w' });
    assert.match(view.status, /成员配置.*不一致/);
    assert.equal(manager.action('ai_loop.settings.reset_project').status, 'reset');
    assert.deepEqual(fs.readFileSync(globalFile), beforeGlobal);
    const recovered = await manager.read();
    assert.doesNotMatch(recovered.status, /成员配置.*不一致/);
    assert.match(recovered.status, /项目继承全局/);
    assert.equal(recovered.values.concurrency, 7);
    assert.equal(resolveEffectiveProfile(f.root, { home: f.home }).profile_hash, routeHash(global));
    assert.match(start(f).hookSpecificOutput.additionalContext, /已开启角色/);
    const doctor = runtime.pluginDoctor(f.root, { home: f.home });
    assert.equal(doctor.configuration, 'pass'); assert.equal(doctor.dispatch, 'requires-native-verification');
    assert.deepEqual(doctor.enabled_roles, Object.keys(global.roles));
});

test('CLI恢复静态集中冲突时预演不写，正式恢复清除旧登记并继承全局', t => {
    const f = fixture(t), local = disabledProfile('codex'), central = balanced('codex');
    save(f, 'global', central); const file = save(f, 'project', local);
    setWorkspaceRecordById(f.home, { id: 'w', roots: f.roots, enabled: true,
        profile: central, profile_hash: routeHash(central), inherits_global: false,
        materialized_profiles: { [f.root]: routeHash(local) } });
    const before = fs.readFileSync(file);
    const preview = modelCommand(f, ['reset', '--scope', 'project']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(fs.readFileSync(file), before);
    const reset = modelCommand(f, ['reset', '--scope', 'project', '--apply']);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(workspaceEntryById(f.home, 'w').inherits_global, true);
    assert.equal(resolveEffectiveProfile(f.root, { home: f.home }).profile_hash, routeHash(central));
});

test('设置已读取静态冲突后成员被外部修改，恢复仍拒绝且保留外部配置', async t => {
    const f = fixture(t), local = disabledProfile('codex'), central = balanced('codex');
    save(f, 'global', central); save(f, 'project', local);
    setWorkspaceRecordById(f.home, { id: 'w', roots: f.roots, enabled: true,
        profile: central, profile_hash: routeHash(central), inherits_global: false,
        materialized_profiles: { [f.root]: routeHash(local) } });
    const manager = createSettingsManager({ home: f.home, modelsProvider: models });
    await manager.update({ workspace_id: 'w' });
    const changed = balanced('codex'); changed.concurrency = 6;
    const file = save(f, 'project', changed), before = fs.readFileSync(file);
    const registry = path.join(f.home, 'ai-loop/workspaces.json'), beforeRegistry = fs.readFileSync(registry);
    assert.throws(() => manager.action('ai_loop.settings.reset_project'), /编辑期间发生变化/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readFileSync(registry), beforeRegistry);
});
