import path from 'node:path';
import crypto from 'node:crypto';
import { ROLES, disabledProfile, roleEnabled, upgradeProfile } from '../../scripts/routing.mjs';
import { assert, rootPath } from '../../scripts/lib.mjs';
import { getNativeModels } from './native-models.mjs';
import { configureProfile, resetProjectProfile, resolveProfile, userHome } from './profiles.mjs';
import { inspectWindows } from './windows.mjs';
import { workspaceEntry, workspaceHash, restoreWorkspaceEntry, setWorkspaceEnabled } from './workspaces.mjs';
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
function profileSnapshot(project, home, scope) {
  const current = currentRecord(project, home, scope);
  const inherited = scope === 'project' ? currentRecord(project, home, 'global') : null;
  return { profile_hash: current.profile_hash || null, fallback_hash: inherited?.profile_hash || null, workspace_hash: workspaceHash(project ? workspaceEntry(home, project) : null), error: current.error || inherited?.error || '' };
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
  let lastError = '';
  let applying = false;

  const key = () => `${scope}\n${selectedRoot}`;
  const hasModelDraft = values => Object.keys(values).some(field => field === 'concurrency' || field.startsWith('model.') || field.startsWith('effort.'));
  const mergeBaseline = (previous, current, values) => ({
    profile_hash: hasModelDraft(values) && previous ? previous.profile_hash : current.profile_hash,
    fallback_hash: hasModelDraft(values) && previous ? previous.fallback_hash : current.fallback_hash,
    workspace_hash: values.workspace_enabled !== undefined && previous ? previous.workspace_hash : current.workspace_hash,
  });
  const capture = (nextScope, nextRoot) => {
    const nextKey = `${nextScope}\n${nextRoot}`;
    const values = drafts.get(nextKey) || {};
    const project = nextRoot || defaultProject;
    const current = profileSnapshot(project, home, nextScope);
    bases.set(nextKey, mergeBaseline(bases.get(nextKey), current, values));
  };
  const projectFor = () => {
    const value = selectedRoot || defaultProject;
    if (!value) return null;
    try { return rootPath(value); } catch { return null; }
  };
  const allowedProject = () => {
    assert(selectedRoot, '先选择一个存在的 Codex 工作区');
    const { workspaces } = readCodexWorkspaces(home);
    const selected = workspaces.find(item => item.root === selectedRoot);
    assert(selected, '所选工作区已不可用，请重新选择 Codex 工作区');
    return rootPath(selected.root);
  };
  const activeProfile = () => {
    const project = projectFor();
    const active = currentRecord(project, home, scope);
    if (active.error) lastError = active.error;
    const fallback = scope === 'project' ? currentRecord(project, home, 'global').profile : null;
    const profile = upgradeProfile(active.profile || fallback || disabledProfile('codex'));
    const snapshot = profileSnapshot(project, home, scope);
    if (!bases.has(key())) bases.set(key(), snapshot);
    return profile;
  };
  const draft = () => drafts.get(key()) || {};
  const clearModelDraft = () => {
    const enabled = draft().workspace_enabled;
    drafts.delete(key());
    if (enabled !== undefined) drafts.set(key(), { workspace_enabled: enabled });
    const previous = bases.get(key());
    const current = profileSnapshot(projectFor(), home, scope);
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
    if (selectedRoot && !workspaces.some(item => item.root === selectedRoot)) {
      selectedRoot = '';
      lastError = '所选工作区已不可用，请重新选择。';
    }
    const project = projectFor();
    const profile = effective();
    const modelsResult = await readModels(project, profile);
    const models = modelsResult.models.filter(item => item && typeof item.id === 'string' && item.id.length <= 128);
    const invalidModels = [], invalidEfforts = [];
    const props = {
      scope: { type: 'string', title: '配置范围', enum: Object.values(scopeLabels), description: '全局默认供所有继承它的工作区使用；仅当前工作区只覆盖所选项目。选择工作区时默认仅当前工作区。' },
      workspace_root: { type: 'string', title: 'Codex 工作区', description: '自动读取 Codex 本机工作区；选择仅查看配置，不会启用。留空可查看全局配置。', enum: ['', ...workspaces.map(workspaceChoice)] },
      workspace_enabled: { type: 'boolean', title: '工作区启用', description: '关闭后 AI Loop 不会在该工作区注入入口。' },
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
    const exactRecord = currentRecord(project, home, scope);
    const baseline = bases.get(key());
    const configDrafts = Object.keys(draft()).some(field => field === 'concurrency' || field.startsWith('model.') || field.startsWith('effort.'));
    const currentSnapshot = profileSnapshot(project, home, scope);
    const conflict = Boolean(baseline && (baseline.profile_hash !== currentSnapshot.profile_hash || baseline.fallback_hash !== currentSnapshot.fallback_hash));
    if (!currentSnapshot.error) bases.set(key(), mergeBaseline(baseline, currentSnapshot, draft()));
    const source = scope === 'project' ? exactRecord.error ? '项目配置异常' : exactRecord.profile ? '项目专属覆盖' : '项目继承全局' : '全局配置';
    const values = {
      scope: scopeLabels[scope],
      workspace_root: workspaces.find(item => item.root === selectedRoot) ? workspaceChoice(workspaces.find(item => item.root === selectedRoot)) : '',
      workspace_enabled: workspaces.find(item => item.root === selectedRoot)?.enabled ?? false,
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
    const status = [discovery.error, error, `配置来源：${source}`, selectedRoot ? `所选工作区：${selectedRoot}` : '尚未选择工作区；全局配置仍可查看。', conflict && configDrafts ? '检测到外部配置变化；应用已暂停，请放弃草稿后重新进入页面。' : '', models.length ? `发现 ${models.length} 个可用模型。` : '模型列表尚未验证。', invalidModels.length ? `模型不可用：${invalidModels.join(', ')}` : '', invalidEfforts.length ? `需修正思考深度：${invalidEfforts.join(', ')}` : ''].filter(Boolean).join(' ');
    return {
      schema: { type: 'object', properties: props }, values,
      layout: [
        { kind: 'group', title: '工作区', items: [{ kind: 'property', property: 'workspace_root' }, { kind: 'property', property: 'workspace_enabled' }] },
        { kind: 'group', title: '模型分工', items: [{ kind: 'property', property: 'scope' }, ...roleNames.flatMap(role => [{ kind: 'property', property: `model.${role}` }, { kind: 'property', property: `effort.${role}` }]), { kind: 'property', property: 'concurrency' }, { kind: 'tool', tool: 'ai_loop.settings.apply' }, { kind: 'tool', tool: 'ai_loop.settings.reset_project' }] },
        { kind: 'group', title: `状态：${status}`.slice(0, 240), items: [{ kind: 'tool', tool: 'ai_loop.settings.discard' }] },
      ],
    };
  }

  async function update(set) {
    assert(!applying, '设置正在应用，暂不能修改草稿');
    assert(set && typeof set === 'object' && !Array.isArray(set), 'settings.update 需要 set 对象');
    const fields = new Set(['scope', 'workspace_root', 'workspace_enabled', 'concurrency', ...roleNames.flatMap(role => [`model.${role}`, `effort.${role}`])]);
    const entries = Object.entries(set);
    const scopeId = Object.keys(scopeLabels).find(id => set.scope === id || set.scope === scopeLabels[id]);
    const workspaces = Object.hasOwn(set, 'workspace_root') ? readCodexWorkspaces(home).workspaces : [];
    const selected = workspaces.find(item => workspaceChoice(item) === set.workspace_root || item.root === set.workspace_root);
    for (const [field, value] of entries) {
      assert(fields.has(field), `未知设置字段：${field}`);
      if (field === 'scope') assert(scopeId, '配置范围无效');
      if (field === 'workspace_root') {
        assert(validString(value), '工作区路径无效');
        assert(value === '' || selected, '只能选择 Codex 列表中存在的工作区');
      }
      if (field === 'workspace_enabled') assert(typeof value === 'boolean', '工作区启用值须为布尔值');
      if (field === 'concurrency') assert(Number.isInteger(value) && value >= 1 && value <= 8, '并发值须为 1–8');
      if (field.startsWith('model.')) assert(typeof value === 'string' && (value === '关闭' || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)), '模型 ID 无效');
      if (field.startsWith('effort.')) assert(effortOptions.includes(value), '思考深度无效');
    }
    const previousKey = key();
    const nextRoot = Object.hasOwn(set, 'workspace_root') ? (selected?.root || '') : selectedRoot;
    const nextScope = Object.hasOwn(set, 'scope') ? scopeId : nextRoot !== selectedRoot ? (nextRoot ? 'project' : 'global') : scope;
    if (nextScope !== scope || nextRoot !== selectedRoot) capture(nextScope, nextRoot);
    if (scope === 'global' && nextScope === 'global' && nextRoot !== selectedRoot) {
      const existing = drafts.get(previousKey) || {};
      const transferable = Object.fromEntries(Object.entries(existing).filter(([name]) => name === 'concurrency' || name.startsWith('model.') || name.startsWith('effort.')));
      const nextKey = `global\n${nextRoot}`;
      const targetDraft = drafts.get(nextKey) || {};
      const sourceBase = bases.get(previousKey);
      if (Object.keys(transferable).length && sourceBase && !hasModelDraft(targetDraft)) {
        drafts.set(nextKey, { ...targetDraft, ...transferable });
        const targetBase = bases.get(nextKey);
        bases.set(nextKey, {
          profile_hash: sourceBase.profile_hash,
          fallback_hash: sourceBase.fallback_hash,
          workspace_hash: targetBase?.workspace_hash ?? null,
        });
      }
    }
    scope = nextScope;
    selectedRoot = nextRoot;
    for (const [field, value] of entries) {
      if (field === 'scope' || field === 'workspace_root') continue;
      drafts.set(key(), { ...drafts.get(key()), [field]: value });
    }
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
    const currentSnapshot = profileSnapshot(project, home, scope);
    assert(base && !currentSnapshot.error && currentSnapshot.profile_hash === base.profile_hash && currentSnapshot.fallback_hash === base.fallback_hash, '配置在编辑期间发生变化，请放弃草稿后重新进入设置');
    const workspaceDraft = draft().workspace_enabled;
    const registryBefore = workspaceEntry(home, project);
    const savedBefore = readCodexWorkspaces(home).workspaces.find(item => item.root === project);
    const previousEnabled = registryBefore?.enabled ?? savedBefore?.enabled ?? false;
    let workspaceResult = null;
    let workspaceChanged = false;
    const workspaceRevision = crypto.randomUUID();
    if (workspaceDraft !== undefined) assert(currentSnapshot.workspace_hash === base.workspace_hash, '工作区开关在编辑期间变化，请重新读取后保存');
    if (workspaceDraft !== undefined && workspaceDraft !== previousEnabled) {
      workspaceResult = setWorkspaceEnabled(home, project, workspaceDraft, { create: true, revision: workspaceRevision, expectedHash: base.workspace_hash });
      workspaceChanged = true;
    }
    try {
      const result = hasProfileDraft ? configureProfile(project, profile, { home, scope, apply: true, bundle }) : { status: 'unchanged', scope };
      drafts.delete(key()); bases.delete(key()); lastError = '';
      return { ...result, workspace: workspaceResult, message: `${scopeLabels[scope]}设置已统一应用。${workspaceResult ? `工作区${workspaceResult.enabled ? '已启用' : '已停用'}。` : ''}请重新进入插件详情页刷新原生设置；代理配置在下一次原生重载后生效。` };
    } catch (error) {
      if (workspaceChanged) {
        try { restoreWorkspaceEntry(home, project, registryBefore, { expectedRevision: workspaceRevision, expectedEnabled: workspaceDraft }); }
        catch (rollbackError) { throw new Error(`${error.message}；${rollbackError.message}`, { cause: error }); }
      }
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
    const current = readCodexWorkspaces(home).workspaces.find(item => item.root === project);
    assert(current, '所选工作区已不可用');
    const previousKey = key();
    const result = setWorkspaceEnabled(home, project, draft().workspace_enabled ?? current.enabled, { create: true });
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
    const current = resolveProfile(project, { home, scope: 'project' });
    const base = bases.get(key());
    assert(!base || (current.profile_hash || null) === base.profile_hash, '项目配置在编辑期间发生变化，请放弃草稿后重新进入设置');
    const result = resetProjectProfile(project, { home, apply: true });
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

  return { read, update, action, getSelection: () => ({ scope, selectedRoot }) };
}
