import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROLES, disabledProfile, roleEnabled, upgradeProfile } from './routing.mjs';
import { assert, rootPath, atomicWrite } from './lib.mjs';
import { getNativeModels } from './native-models.mjs';
import { configureProfile, resolveProfile, userHome, configureWorkspaceProfile, resolveWorkspaceProfile, resetWorkspaceProfile } from './profiles.mjs';
import { inspectWindows } from './windows.mjs';
import { workspaceEntry, workspaceHash, workspaceEntryById, setWorkspaceRecordById, restoreWorkspaceRecordById } from './workspaces.mjs';
import { readCodexWorkspaces, workspaceChoice } from './codex-workspaces.mjs';

const roleNames = Object.keys(ROLES);
const effortOptions = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const validString = value => typeof value === 'string' && value.length <= 4096;
const scopeLabels = { global: '全局默认', project: '仅当前工作区' };
function currentRecord(project, home, scope) {
  if (!project && scope !== 'global') return { profile: null, profile_hash: null };
  try {
    const value = resolveProfile(project, { home, scope });
    return { profile: value.profile, profile_hash: value.profile ? value.profile_hash : null };
  } catch (error) { return { error: error.message, profile: null, profile_hash: null }; }
}
function profileSnapshot(project, home, scope, sourceRoot = '', workspaceId = '') {
  const workspaces = readCodexWorkspaces(home).workspaces;
  const workspace = workspaceId ? workspaces.find(item => item.id === workspaceId) : project ? workspaces.find(item => item.roots.includes(project)) : null;
  const resolved = workspace && scope === 'project' ? resolveWorkspaceProfile(home, workspace) : null;
  const chosen = workspace && resolved?.migration?.conflict ? resolved.migration.sources.find(item => item.root === sourceRoot) : null;
  const current = chosen || (scope === 'project' && workspace ? resolved : currentRecord(project, home, scope));
  const inherited = scope === 'project' ? currentRecord(project, home, 'global') : null;
  const currentError = resolved?.migration?.conflict && !chosen ? '工作区成员中的旧配置不一致；请选择迁移来源。' : resolved?.materialization_conflict ? '工作区成员配置与已保存工作区配置不一致，已暂停保存。' : '';
  const registry = workspace ? workspaceEntryById(home, workspace.id) : project ? workspaceEntry(home, project) : null;
  const memberProfiles = resolved?.member_profiles || resolved?.actual_members || [];
  return { profile_hash: current.profile_hash || null, fallback_hash: inherited?.profile_hash || null, workspace_hash: workspace?.identity_hash || workspaceHash(registry), workspace_registry_hash: workspace?.registry_hash || workspaceHash(registry), materialized_hash: workspaceHash(memberProfiles), member_profiles: memberProfiles, workspace_profile_source_id: sourceRoot || '', migration_needed: Boolean(resolved?.migration?.needed), error: current.error || inherited?.error || currentError };
}

export function createSettingsManager(options = {}) {
  const home = path.resolve(options.home || userHome());
  const defaultProject = options.project || process.env.AI_LOOP_PROJECT || null;
  const modelsProvider = options.modelsProvider || getNativeModels;
  const bundle = options.bundle;
  const probeMode = process.env.AI_LOOP_NATIVE_MODEL_PROBE === '1';
  const drafts = new Map();
  const bases = new Map();
  let scope = 'global';
  let selectedRoot = '';
  let selectedWorkspaceId = '';
  let initialSelection = true;
  let lastError = '';
  let applying = false;

  const key = () => `${scope}\n${selectedWorkspaceId || selectedRoot}`;
  const hasModelDraft = values => Object.keys(values).some(field => field === 'concurrency' || field.startsWith('model.') || field.startsWith('effort.'));
  const hasWorkspaceProfileWriteDraft = (values, current) => hasModelDraft(values) || Boolean(values.workspace_profile_source_id) || (values.workspace_enabled !== undefined && current.migration_needed);
  const mergeBaseline = (previous, current, values) => {
    const freezeProfileWrite = hasWorkspaceProfileWriteDraft(values, current);
    const sourceChanged = Boolean(values.workspace_profile_source_id) && values.workspace_profile_source_id !== (previous?.workspace_profile_source_id || '');
    return {
      profile_hash: freezeProfileWrite && previous && !sourceChanged ? previous.profile_hash : current.profile_hash,
      fallback_hash: freezeProfileWrite && previous ? previous.fallback_hash : current.fallback_hash,
      workspace_hash: (values.workspace_enabled !== undefined || freezeProfileWrite) && previous ? previous.workspace_hash : current.workspace_hash,
      workspace_registry_hash: (values.workspace_enabled !== undefined || freezeProfileWrite) && previous ? previous.workspace_registry_hash : current.workspace_registry_hash,
      materialized_hash: freezeProfileWrite && previous ? previous.materialized_hash : current.materialized_hash,
      member_profiles: freezeProfileWrite && previous ? previous.member_profiles : current.member_profiles,
      workspace_profile_source_id: current.workspace_profile_source_id,
    };
  };
  const capture = (nextScope, nextRoot, nextWorkspaceId = selectedWorkspaceId) => {
    const nextKey = `${nextScope}\n${nextWorkspaceId || nextRoot}`;
    const values = drafts.get(nextKey) || {};
    const project = nextRoot || defaultProject;
    const current = profileSnapshot(project, home, nextScope, values.workspace_profile_source_id, nextWorkspaceId);
    bases.set(nextKey, mergeBaseline(bases.get(nextKey), current, values));
  };
  const projectFor = () => {
    const value = selectedRoot || defaultProject;
    if (!value) return null;
    try { return rootPath(value); } catch { return null; }
  };
  const selectedWorkspace = () => {
    if (!selectedWorkspaceId) return null;
    return readCodexWorkspaces(home).workspaces.find(item => item.id === selectedWorkspaceId) || null;
  };
  const allowedProject = () => {
    assert(selectedRoot, '先选择一个存在的 Codex 工作区');
    const selected = selectedWorkspace();
    assert(selected && selected.roots.every(root => fs.existsSync(root)), '所选工作区已不可用，请重新选择 Codex 工作区');
    assert(!selected.shared_roots?.length, '此成员目录同时属于多个 Codex 工作区，不能保存工作区级配置');
    return rootPath(selected.root);
  };
  const activeProfile = () => {
    if (scope === 'project' && selectedWorkspaceId) {
      const workspace = selectedWorkspace();
      if (!workspace) { lastError = '所选工作区已不可用，请重新选择。'; return disabledProfile('codex'); }
      const migrated = resolveWorkspaceProfile(home, workspace);
      if (migrated.materialization_conflict) lastError = '工作区成员配置与已保存工作区配置不一致，已暂停保存。';
      if (migrated.migration?.conflict) {
        const sourceId = draft().workspace_profile_source_id;
        const source = migrated.migration.sources.find(item => item.root === sourceId);
        if (source) { lastError = ''; return upgradeProfile(source.profile || currentRecord(workspace.root, home, 'global').profile || disabledProfile('codex')); }
        lastError = '工作区成员中的旧配置不一致；请选择迁移来源后再保存。';
        return disabledProfile('codex');
      }
      if (migrated.migration?.needed) lastError = '检测到根目录旧配置；统一保存后将迁移为工作区配置。';
      return upgradeProfile(migrated.profile || currentRecord(workspace.root, home, 'global').profile || disabledProfile('codex'));
    }
    const project = projectFor();
    const active = currentRecord(project, home, scope);
    if (active.error) lastError = active.error;
    const fallback = scope === 'project' ? currentRecord(project, home, 'global').profile : null;
    const profile = upgradeProfile(active.profile || fallback || disabledProfile('codex'));
    const snapshot = profileSnapshot(project, home, scope, draft().workspace_profile_source_id, selectedWorkspaceId);
    if (!bases.has(key())) bases.set(key(), snapshot);
    return profile;
  };
  const draft = () => drafts.get(key()) || {};
  const clearModelDraft = () => {
    const enabled = draft().workspace_enabled;
    drafts.delete(key());
    if (enabled !== undefined) drafts.set(key(), { workspace_enabled: enabled });
    const previous = bases.get(key());
    const current = profileSnapshot(projectFor(), home, scope, draft().workspace_profile_source_id, selectedWorkspaceId);
    if (!current.error) bases.set(key(), mergeBaseline(previous, current, draft()));
    else if (enabled === undefined) bases.delete(key());
    else if (previous) bases.set(key(), previous);
  };
  const effective = () => {
    const profile = structuredClone(activeProfile());
    const values = draft();
    if (values.concurrency !== undefined) profile.concurrency = values.concurrency;
    for (const role of roleNames) {
      if (values[`model.${role}`] !== undefined) {
        if (values[`model.${role}`] === '关闭') profile.roles[role] = { ...profile.roles[role], enabled: false };
        else profile.roles[role] = { ...profile.roles[role], enabled: true, model: values[`model.${role}`] };
      }
      if (values[`effort.${role}`] !== undefined) profile.roles[role].effort = values[`effort.${role}`];
    }
    return profile;
  };
  async function readModels(project, profile) {
    if (probeMode || typeof modelsProvider !== 'function') return { models: [], error: probeMode ? '模型探测进程已禁用递归查询' : '模型列表提供器不可用' };
    if (!project) return { models: [], error: '选择一个 Codex 工作区后，才能读取本机模型列表。' };
    try {
      const result = await modelsProvider(project);
      const models = Array.isArray(result) ? result : result?.models;
      assert(Array.isArray(models), '模型列表格式无效');
      return { models, error: '' };
    } catch (error) { return { models: [], error: error.message || String(error) }; }
  }

  async function read() {
    const discovery = readCodexWorkspaces(home);
    const workspaces = discovery.workspaces;
    if (initialSelection) {
      initialSelection = false;
      const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      const current = defaultProject && workspaces.find(item => item.roots.some(root => normalize(root) === normalize(defaultProject)));
      if (current) { selectedWorkspaceId = current.id; selectedRoot = current.root; scope = 'project'; }
    }
    if (selectedWorkspaceId && !workspaces.some(item => item.id === selectedWorkspaceId)) {
      selectedWorkspaceId = ''; selectedRoot = '';
      lastError = '所选工作区已不可用，请重新选择。';
    }
    const workspace = workspaces.find(item => item.id === selectedWorkspaceId) || null;
    if (workspace) selectedRoot = workspace.root;
    if (workspace?.shared_roots?.length) lastError = '此工作区与其他工作区共享成员目录，工作区配置写入已禁用。';
    const workspaceProfileInfo = workspace && scope === 'project' ? resolveWorkspaceProfile(home, workspace) : null;
    const project = projectFor();
    const profile = effective();
    const modelsResult = await readModels(project, profile);
    const models = modelsResult.models.filter(item => item && typeof item.id === 'string' && item.id.length <= 128);
    const invalidModels = [], invalidEfforts = [];
    const props = {
      scope: { type: 'string', title: '配置范围', enum: Object.values(scopeLabels), description: '全局默认供所有继承它的工作区使用；仅当前工作区只覆盖所选项目。选择工作区时默认仅当前工作区。' },
      workspace_id: { type: 'string', title: 'Codex 工作区', description: '按宿主工作区 ID 选择；目录仅作为成员。新工作区默认停用。', enum: ['', ...workspaces.map(item => item.id)] },
      workspace_root: { type: 'string', title: 'Codex 工作区（兼容）', description: '兼容旧客户端；新面板应使用工作区 ID。', enum: ['', ...workspaces.map(item => workspaceChoice(item, workspaces))] },
      workspace_enabled: { type: 'boolean', title: '工作区启用', description: '关闭后 AI Loop 不会在该工作区注入入口。' },
      workspace_profile_source_id: { type: 'string', title: '旧配置迁移来源', description: '成员根目录配置不一致时，明确选择一个配置作为工作区配置。', enum: workspaceProfileInfo?.migration?.conflict ? ['', ...workspace.roots] : [''] },
      concurrency: { type: 'integer', title: '子代理并发上限', minimum: 1, maximum: 8 },
    };
    for (const role of roleNames) {
      const enabled = roleEnabled(profile.roles[role]);
      const selectedId = enabled ? profile.roles[role].model : '关闭';
      const ids = [...new Set(models.map(item => item.id))];
      const choices = ids.length ? ids : (enabled && selectedId !== '关闭' ? [selectedId] : []);
      const selectedModel = enabled ? models.find(item => item.id === selectedId) : null;
      if (enabled && models.length && !selectedModel) invalidModels.push(role);
      props[`model.${role}`] = { type: 'string', title: `${role} 模型`, enum: ['关闭', ...new Set([...choices, ...(enabled ? [selectedId] : [])])], description: selectedModel ? '选择本机可用模型；选择“关闭”可停用此角色。' : enabled ? `当前配置模型 ${selectedId} 未出现在本机列表中；应用前请替换或关闭角色。` : '此角色已关闭，不会派发或调用模型。' };
      const supported = Array.isArray(selectedModel?.efforts) ? selectedModel.efforts.map(item => typeof item === 'string' ? item : item?.reasoningEffort).filter(item => effortOptions.includes(item)) : [];
      const effort = profile.roles[role].effort;
      const shownEffort = effort ?? (selectedModel?.default_effort || 'medium');
      if (enabled && effort !== null && supported.length && !supported.includes(effort)) invalidEfforts.push(role);
      const effortChoices = [...new Set([...(supported.length ? supported : effortOptions), shownEffort])];
      props[`effort.${role}`] = { type: 'string', title: `${role} 思考深度`, enum: effortChoices, description: supported.length ? `仅显示该模型支持的值${invalidEfforts.includes(role) ? '；当前值不受支持，请选择下拉项' : ''}。` : '应用时会根据本机模型列表校验。' };
    }
    const exactRecord = scope === 'project' && workspace
      ? { profile: workspaceProfileInfo?.inherits_global ? null : workspaceProfileInfo?.profile ?? null, error: '' }
      : currentRecord(project, home, scope);
    const baseline = bases.get(key());
    const configDrafts = Object.keys(draft()).some(field => field === 'concurrency' || field.startsWith('model.') || field.startsWith('effort.'));
    const currentSnapshot = profileSnapshot(project, home, scope, draft().workspace_profile_source_id, selectedWorkspaceId);
    const conflict = Boolean(baseline && (baseline.profile_hash !== currentSnapshot.profile_hash || baseline.fallback_hash !== currentSnapshot.fallback_hash));
    if (!currentSnapshot.error) bases.set(key(), mergeBaseline(baseline, currentSnapshot, draft()));
    const source = scope === 'project' ? exactRecord.error ? '项目配置异常' : exactRecord.profile ? '项目专属覆盖' : '项目继承全局' : '全局配置';
    const values = {
      scope: scopeLabels[scope],
      workspace_id: workspace?.id ?? '',
      workspace_root: workspace ? workspaceChoice(workspace, workspaces) : '',
      workspace_enabled: workspace?.enabled ?? false,
      workspace_profile_source_id: draft().workspace_profile_source_id ?? '',
      concurrency: profile.concurrency,
    };
    for (const role of roleNames) {
      values[`model.${role}`] = roleEnabled(profile.roles[role]) ? profile.roles[role].model : '关闭';
      const selectedModel = models.find(item => item.id === profile.roles[role].model);
      values[`effort.${role}`] = profile.roles[role].effort ?? selectedModel?.default_effort ?? 'medium';
    }
    if (draft().workspace_enabled !== undefined) values.workspace_enabled = draft().workspace_enabled;
    for (const [field, value] of Object.entries(draft())) if (field.startsWith('model.') || field.startsWith('effort.') || field === 'concurrency') values[field] = value;
    if (models.length) for (const role of roleNames) if (!props[`model.${role}`].enum.includes(values[`model.${role}`])) props[`model.${role}`].enum.push(values[`model.${role}`]);
    const info = project ? inspectWindows(project, { home }) : { status: 'unavailable' };
    const error = currentSnapshot.error || exactRecord.error || lastError || modelsResult.error || (info.status === 'needs-repair' ? 'Windows 目录所有者检查未通过，写入已禁用。' : '');
    const migration = workspaceProfileInfo?.migration ?? null;
    const status = [discovery.error, workspace?.settings_conflict ? '工作区开关的旧根配置存在冲突；选择启用状态并统一保存。' : '', migration?.conflict ? '根目录模型配置不一致；明确选择迁移来源后才能保存。' : migration?.needed ? '发现根目录旧配置；统一保存后将迁移为工作区配置。' : '', error, `配置来源：${source}`, selectedRoot ? `所选工作区：${selectedRoot}` : '尚未选择工作区；全局配置仍可查看。', conflict && configDrafts ? '检测到外部配置变化；应用已暂停，请放弃草稿后重新进入页面。' : '', models.length ? `发现 ${models.length} 个可用模型。` : '模型列表尚未验证。', invalidModels.length ? `模型不可用：${invalidModels.join(', ')}` : '', invalidEfforts.length ? `需修正思考深度：${invalidEfforts.join(', ')}` : ''].filter(Boolean).join(' ');
    return {
      schema: { type: 'object', properties: props }, values,
      workspaces, selection: { workspaceId: selectedWorkspaceId, root: selectedRoot, roots: workspace?.roots ?? [], scope },
      dirty: Object.keys(draft()).length > 0,
      status,
      layout: [
        { kind: 'group', title: '工作区', items: [{ kind: 'property', property: 'workspace_root' }, { kind: 'property', property: 'workspace_enabled' }, ...(workspaceProfileInfo?.migration?.conflict ? [{ kind: 'property', property: 'workspace_profile_source_id' }] : [])] },
        { kind: 'group', title: '模型分工', items: [{ kind: 'property', property: 'scope' }, ...roleNames.flatMap(role => [{ kind: 'property', property: `model.${role}` }, { kind: 'property', property: `effort.${role}` }]), { kind: 'property', property: 'concurrency' }, { kind: 'tool', tool: 'ai_loop.settings.apply' }, { kind: 'tool', tool: 'ai_loop.settings.reset_project' }] },
        { kind: 'group', title: `状态：${status}`.slice(0, 240), items: [{ kind: 'tool', tool: 'ai_loop.settings.discard' }] },
      ],
    };
  }

  async function update(set) {
    assert(!applying, '设置正在应用，暂不能修改草稿');
    assert(set && typeof set === 'object' && !Array.isArray(set), 'settings.update 需要 set 对象');
    if (Object.hasOwn(set, 'workspace_root') || Object.hasOwn(set, 'workspace_id') || Object.hasOwn(set, 'scope')) initialSelection = false;
    const fields = new Set(['scope', 'workspace_id', 'workspace_root', 'workspace_enabled', 'workspace_profile_source_id', 'concurrency', ...roleNames.flatMap(role => [`model.${role}`, `effort.${role}`])]);
    const entries = Object.entries(set);
    const scopeId = Object.keys(scopeLabels).find(id => set.scope === id || set.scope === scopeLabels[id]);
    const workspaces = Object.hasOwn(set, 'workspace_root') || Object.hasOwn(set, 'workspace_id') ? readCodexWorkspaces(home).workspaces : [];
    const selected = Object.hasOwn(set, 'workspace_id')
      ? workspaces.find(item => item.id === set.workspace_id)
      : Object.hasOwn(set, 'workspace_root')
        ? workspaces.find(item => workspaceChoice(item, workspaces) === set.workspace_root || item.root === set.workspace_root || item.roots.includes(set.workspace_root))
        : null;
    const sourceWorkspace = selected || selectedWorkspace();
    const sourceMigration = sourceWorkspace ? resolveWorkspaceProfile(home, sourceWorkspace).migration : null;
    for (const [field, value] of entries) {
      assert(fields.has(field), `未知设置字段：${field}`);
      if (field === 'scope') assert(scopeId, '配置范围无效');
      if (field === 'workspace_id') assert(typeof value === 'string' && (value === '' || selected), '只能选择 Codex 列表中存在的工作区');
      if (field === 'workspace_root') {
        assert(validString(value), '工作区路径无效');
        assert(value === '' || selected, '只能选择 Codex 列表中存在的工作区');
      }
      if (field === 'workspace_enabled') assert(typeof value === 'boolean', '工作区启用值须为布尔值');
      if (field === 'workspace_profile_source_id') assert(typeof value === 'string' && (value === '' || sourceMigration?.conflict && sourceWorkspace.roots.includes(value)), '旧配置来源只能在成员根配置冲突时选择当前成员目录');
      if (field === 'concurrency') assert(Number.isInteger(value) && value >= 1 && value <= 8, '并发值须为 1–8');
      if (field.startsWith('model.')) assert(typeof value === 'string' && (value === '关闭' || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)), '模型 ID 无效');
      if (field.startsWith('effort.')) assert(effortOptions.includes(value), '思考深度无效');
    }
    const choosingWorkspace = Object.hasOwn(set, 'workspace_root') || Object.hasOwn(set, 'workspace_id');
    const previousKey = key();
    const previousScope = scope;
    const previousWorkspaceId = selectedWorkspaceId;
    const nextRoot = choosingWorkspace ? (selected?.root || '') : selectedRoot;
    const nextWorkspaceId = choosingWorkspace ? (selected?.id || '') : selectedWorkspaceId;
    const nextScope = Object.hasOwn(set, 'scope') ? scopeId : nextRoot !== selectedRoot || nextWorkspaceId !== selectedWorkspaceId ? (nextWorkspaceId ? 'project' : 'global') : scope;
    if (nextScope !== scope || nextRoot !== selectedRoot || nextWorkspaceId !== selectedWorkspaceId) capture(nextScope, nextRoot, nextWorkspaceId);
    const switchingGlobalWorkspace = choosingWorkspace && previousScope === 'global' && nextScope === 'global' && previousWorkspaceId !== nextWorkspaceId;
    if (switchingGlobalWorkspace) {
      const targetKey = `global\n${nextWorkspaceId || nextRoot}`;
      const sourceKey = previousKey;
      const sourceDraft = drafts.get(sourceKey) || {};
      const targetDraft = drafts.get(targetKey) || {};
      const sourceModels = Object.fromEntries(Object.entries(sourceDraft).filter(([field]) => field === 'concurrency' || field.startsWith('model.') || field.startsWith('effort.')));
      const targetHasModels = hasModelDraft(targetDraft);
      if (Object.keys(sourceModels).length && !targetHasModels) {
        drafts.set(targetKey, { ...sourceModels, ...targetDraft });
        const sourceBase = bases.get(sourceKey), targetBase = bases.get(targetKey);
        if (sourceBase && targetBase) bases.set(targetKey, {
          ...targetBase,
          profile_hash: sourceBase.profile_hash,
          fallback_hash: sourceBase.fallback_hash,
          materialized_hash: sourceBase.materialized_hash,
        });
      }
    }
    scope = nextScope;
    selectedRoot = nextRoot;
    selectedWorkspaceId = nextWorkspaceId;
    for (const [field, value] of entries) {
      if (field === 'scope' || field === 'workspace_root' || field === 'workspace_id') continue;
      drafts.set(key(), { ...drafts.get(key()), [field]: value });
    }
    if (Object.hasOwn(set, 'workspace_profile_source_id')) capture(scope, selectedRoot, selectedWorkspaceId);
    return read();
  }

  async function apply() {
    assert(!probeMode, '模型探测进程禁止写入配置');
    assert(!applying, '设置正在应用，请勿重复提交');
    applying = true;
    try {
    const project = allowedProject();
    const info = inspectWindows(project, { home, purpose: 'configure' });
    assert(['ready', 'not-windows'].includes(info.status), 'Windows 目录所有者检查未通过，停止写入');
    const profile = effective();
    const hasProfileDraft = Object.keys(draft()).some(field => field === 'concurrency' || field.startsWith('model.') || field.startsWith('effort.'));
    const validateRoles = new Set(roleNames.filter(role => {
      const selected = draft()[`model.${role}`];
      return selected !== undefined ? selected !== '关闭' : draft()[`effort.${role}`] !== undefined && roleEnabled(profile.roles[role]);
    }));
    if (validateRoles.size) {
      const modelsResult = await readModels(project, profile);
      assert(!modelsResult.error, `无法读取本机模型列表：${modelsResult.error}`);
      const models = modelsResult.models;
      for (const role of validateRoles) {
      const model = models.find(item => item.id === profile.roles[role].model);
      assert(model, `${role} 模型不在当前本机模型列表中`);
      const efforts = Array.isArray(model.efforts) ? model.efforts.map(item => typeof item === 'string' ? item : item?.reasoningEffort).filter(Boolean) : [];
      const selectedEffort = profile.roles[role].effort ?? model.default_effort;
      assert(efforts.includes(selectedEffort), `${role} 模型不支持思考深度 ${selectedEffort || '(未提供默认值)'}；请从设置页选择支持的值`);
      }
    }
    const base = bases.get(key());
    const currentSnapshot = profileSnapshot(project, home, scope, draft().workspace_profile_source_id, selectedWorkspaceId);
    assert(base && !currentSnapshot.error && currentSnapshot.profile_hash === base.profile_hash && currentSnapshot.fallback_hash === base.fallback_hash && currentSnapshot.materialized_hash === base.materialized_hash, '配置在编辑期间发生变化，请放弃草稿后重新进入设置');
    const workspaceDraft = draft().workspace_enabled;
    const workspace = selectedWorkspace();
    const workspaceMigration = workspace && scope === 'project' ? resolveWorkspaceProfile(home, workspace).migration : null;
    const migrateWorkspaceProfile = Boolean(workspaceMigration?.needed && (!workspaceMigration.conflict || draft().workspace_profile_source_id));
    const registryBefore = workspace ? workspaceEntryById(home, workspace.id) : null;
    const previousEnabled = workspace?.enabled ?? false;
    const desiredEnabled = workspaceDraft ?? previousEnabled;
    let workspaceResult = null, workspaceChanged = false, registryCommitted = false, workspaceRevision = crypto.randomUUID();
    if (workspaceDraft !== undefined) assert(currentSnapshot.workspace_hash === base.workspace_hash, '工作区配置在编辑期间变化，请重新读取后保存');
    if (workspaceDraft !== undefined && workspaceDraft !== previousEnabled && workspace) workspaceChanged = true;
    if (scope === 'project' && (hasProfileDraft || migrateWorkspaceProfile) && workspace) {
      assert(!workspaceMigration?.conflict || draft().workspace_profile_source_id, '工作区旧配置冲突；请选择迁移来源后再保存');
      assert(!workspace.settings_conflict || workspaceDraft !== undefined, '工作区旧启用状态冲突；请明确选择启用或停用后再保存。');
    }
    let profileWrite = null;
    try {
      let result;
      if (scope === 'project' && workspace && (hasProfileDraft || migrateWorkspaceProfile)) {
        result = configureWorkspaceProfile(home, workspace, profile, {
          bundle, apply: true, enabled: desiredEnabled, expectedHash: base.workspace_registry_hash,
          expectedMemberProfiles: base.member_profiles,
          allowLegacyConflict: Boolean(draft().workspace_profile_source_id), revision: workspaceRevision,
        });
        workspaceChanged = false;
      } else {
        if (hasProfileDraft) {
          const preview = configureProfile(project, profile, { home, scope, apply: false, bundle });
          const before = new Map(preview.changes.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
          result = configureProfile(project, profile, { home, scope, apply: true, bundle });
          profileWrite = { before, after: new Map([...before.keys()].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null])) };
        } else result = { status: 'unchanged', scope };
        if (workspace && (workspaceDraft !== undefined || hasProfileDraft && scope === 'project')) {
          workspaceResult = setWorkspaceRecordById(home, {
            ...(registryBefore || {}), id: workspace.id, roots: workspace.roots, enabled: desiredEnabled,
          }, { expectedHash: base.workspace_registry_hash, revision: workspaceRevision });
          registryCommitted = true;
          workspaceChanged = true;
        }
      }
      if (scope === 'global') {
        for (const [draftKey, values] of drafts) if (draftKey.startsWith('global\n')) {
          for (const field of Object.keys(values)) if (field === 'concurrency' || field.startsWith('model.') || field.startsWith('effort.')) delete values[field];
          if (Object.keys(values).length) drafts.set(draftKey, values);
          else { drafts.delete(draftKey); bases.delete(draftKey); }
        }
      } else { drafts.delete(key()); bases.delete(key()); }
      if (workspaceDraft !== undefined) { const values = drafts.get(key()); if (values) { delete values.workspace_enabled; if (!Object.keys(values).length) drafts.delete(key()); } bases.delete(key()); }
      lastError = '';
      const savedWorkspace = workspace ? readCodexWorkspaces(home).workspaces.find(item => item.id === workspace.id) : null;
      return { ...result, workspace: workspaceResult || (workspaceChanged ? { id: workspace?.id, enabled: desiredEnabled } : null), message: `${scopeLabels[scope]}设置已统一应用。${workspaceChanged ? `工作区${desiredEnabled ? '已启用' : '已停用'}。` : ''}${savedWorkspace ? '工作区身份和成员已复核。' : ''}请重新进入插件详情页刷新原生设置；代理配置在下一次原生重载后生效。` };
    } catch (error) {
      const rollbackErrors = [];
      if (registryCommitted && workspace) {
        try { restoreWorkspaceRecordById(home, workspace.id, registryBefore, { expectedRevision: workspaceRevision }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (profileWrite) for (const [file, before] of [...profileWrite.before].reverse()) {
        try {
          const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
          const after = profileWrite.after.get(file);
          if (current === null || !current.equals(after)) throw new Error(`并发改动，保留文件：${file}`);
          if (before === null) fs.unlinkSync(file);
          else atomicWrite(file, before);
        } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (rollbackErrors.length) throw new Error(`${error.message}；回滚未完整：${rollbackErrors.join('；')}`, { cause: error });
      throw error;
    }
    } finally { applying = false; }
  }

  function toggleWorkspace() {
    assert(!applying, '设置正在应用，暂不能单独修改工作区');
    assert(!probeMode, '模型探测进程禁止写入配置');
    const project = allowedProject();
    const info = inspectWindows(project, { home, purpose: 'configure' });
    assert(['ready', 'not-windows'].includes(info.status), 'Windows 目录所有者检查未通过，停止修改');
    const current = selectedWorkspace();
    assert(current, '所选工作区已不可用');
    const previousKey = key();
    const result = setWorkspaceRecordById(home, { ...(workspaceEntryById(home, current.id) || {}), id: current.id, roots: current.roots, enabled: draft().workspace_enabled ?? current.enabled }, { expectedHash: workspaceHash(workspaceEntryById(home, current.id)) });
    const values = drafts.get(previousKey) || {}; delete values.workspace_enabled; drafts.set(previousKey, values);
    return { ...result, message: `工作区${result.enabled ? '已启用' : '已停用'}。请重新进入插件详情页刷新原生设置。` };
  }

  function resetProject() {
    assert(!applying, '设置正在应用，暂不能恢复项目配置');
    assert(!probeMode, '模型探测进程禁止写入配置');
    assert(scope === 'project', '请先将范围切换为“仅当前工作区”');
    const project = allowedProject();
    const info = inspectWindows(project, { home, purpose: 'configure' });
    assert(['ready', 'not-windows'].includes(info.status), 'Windows 目录所有者检查未通过，停止恢复');
    const base = bases.get(key());
    const currentSnapshot = profileSnapshot(project, home, scope, draft().workspace_profile_source_id, selectedWorkspaceId);
    assert(!base || (currentSnapshot.profile_hash || null) === base.profile_hash, '工作区配置在编辑期间发生变化，请放弃草稿后重新进入设置');
    const workspace = selectedWorkspace();
    assert(workspace, '所选工作区已不可用');
    const result = resetWorkspaceProfile(home, workspace, { expectedHash: base?.workspace_registry_hash });
    clearModelDraft(); lastError = '';
    return { ...result, message: '已恢复全局继承。请重新进入插件详情页刷新原生设置。' };
  }

  function discardDraft() {
    assert(!applying, '设置正在应用，暂不能放弃草稿');
    drafts.delete(key());
    bases.delete(key());
    lastError = '';
    return { status: 'discarded', message: '已放弃此范围的未应用草稿。请重新进入插件详情页读取最新配置。' };
  }

  function action(name) {
    if (name === 'ai_loop.settings.apply') return apply();
    if (name === 'ai_loop.workspace.toggle') return toggleWorkspace();
    if (name === 'ai_loop.settings.reset_project') return resetProject();
    if (name === 'ai_loop.settings.discard') return discardDraft();
    throw new Error(`未知设置动作：${name}`);
  }

  return { read, update, action, getSelection: () => ({ scope, selectedRoot, selectedWorkspaceId }), hasDrafts: () => [...drafts.values()].some(values => Object.keys(values).length > 0) };
}
