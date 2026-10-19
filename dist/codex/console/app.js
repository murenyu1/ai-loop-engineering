(() => {
  const token = location.hash.slice(1);
  if (!token) { document.body.innerHTML = '<main class="shell"><h1>面板链接无效</h1><p>请从本机管理命令重新打开面板。</p></main>'; return; }
  const initialProject = new URLSearchParams(location.search).get('project');
  history.replaceState(null, '', location.pathname + location.search);
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  };
  const $ = id => document.getElementById(id);
  const roleNames = { planner: '计划', reviewer: '评审', dev: '开发', tester: '验证', scribe: '记忆整理' };
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  let workspaces = [], models = null, modelsComplete = false, state = null, draft = null, initialLoad = true;
  const root = () => $('workspace').value;
  const message = (text, bad = false) => { $('status').textContent = text; $('status').className = 'status' + (bad ? ' error' : ''); };

  function normalizeModels(items) {
    if (!Array.isArray(items)) return null;
    return items.map(item => {
      const raw = item.efforts ?? item.supportedReasoningEfforts ?? item.supported_reasoning_efforts ?? [];
      const efforts = raw.map(value => typeof value === 'string' ? value : value?.reasoningEffort ?? value?.reasoning_effort).filter(value => typeof value === 'string' && levels.includes(value));
      return {
        id: item.id || item.model,
        name: item.name || item.displayName || item.display_name || '',
        efforts: [...new Set(efforts)],
        default_effort: item.default_effort || item.defaultReasoningEffort || item.default_reasoning_effort || null,
      };
    }).filter(item => typeof item.id === 'string' && item.id);
  }

  function paintWorkspaces(selectRoot) {
    const select = $('workspace'), old = select.value;
    select.replaceChildren(...workspaces.map(item => { const option = document.createElement('option'); option.value = item.root; option.textContent = item.root + (item.exists ? '' : '（目录已不存在）'); return option; }));
    if (selectRoot && workspaces.some(item => item.root === selectRoot)) select.value = selectRoot;
    else if (workspaces.some(item => item.root === old)) select.value = old;
    const item = workspaces.find(entry => entry.root === root());
    $('enabled').checked = !!item?.enabled;
    $('enabled').disabled = !item;
    $('workspace-note').textContent = item ? (item.exists ? `登记状态：${item.enabled ? '已启用' : '已停用'}` : '该目录已不存在；恢复目录后才能操作。') : '尚无已登记工作区。';
    $('reset').disabled = !item;
  }

  function profileSource() {
    if (!state) return null;
    return $('scope').value === 'project' ? (state.project.profile || state.global.profile || state.effective.profile) : state.global.profile;
  }

  function currentDraft() {
    const source = profileSource();
    if (draft && draft.root === root() && draft.scope === $('scope').value) return draft.profile;
    const profile = source ? structuredClone(source) : {
      schema_version: 1, harness: 'codex', concurrency: 3,
      main: { model: '', effort: null },
      roles: Object.fromEntries(Object.keys(roleNames).map(name => [name, { model: '', effort: null }])),
    };
    draft = { root: root(), scope: $('scope').value, profile };
    return profile;
  }

  function canSave(profile) {
    if (!models?.length) return false;
    return Object.entries(profile.roles).every(([role, value]) => {
      const model = models.find(item => item.id === value.model);
      if (!model) return false;
      return value.effort === null || model.efforts.includes(value.effort);
    });
  }

  function buildMain(profile) {
    const prior = profile.main;
    const oldModel = models.find(item => item.id === prior?.model);
    if (oldModel && (oldModel.efforts.includes(prior.effort) || oldModel.default_effort === prior.effort)) return { model: prior.model, effort: prior.effort };
    const selected = models.find(item => item.id === profile.roles.planner.model);
    if (!selected) throw new Error('请先为“计划”角色选择一个原生模型');
    const effort = selected.default_effort;
    if (!effort) throw new Error('所选计划模型没有原生默认思考强度，无法生成主会话元数据');
    return { model: selected.id, effort };
  }

  function renderProfile() {
    if (!state) return;
    const profile = currentDraft();
    const roles = $('roles'); roles.replaceChildren();
    const source = state.effective.scope === 'project' ? '当前工作区项目覆盖' : '全局默认';
    const sourceNote = document.createElement('p'); sourceNote.className = 'muted';
    sourceNote.textContent = `当前有效配置来源：${source}。保存后的角色配置将在 Codex 原生配置下一次重载后用于后续派发；不会改变当前主会话。`;
    roles.append(sourceNote);
    const mainNote = document.createElement('p'); mainNote.className = 'muted main-note';
    mainNote.textContent = '主会话由 Codex 原生模型选择器管理。本面板不修改主会话；首次保存时从你选择的“计划”模型读取原生默认强度，现有配置则保留已登记的主会话元数据。';
    roles.append(mainNote);
    for (const [name, value] of Object.entries(profile.roles)) {
      const row = document.createElement('div'); row.className = 'role-row';
      const title = document.createElement('strong'); title.textContent = roleNames[name] || name;
      const modelSelect = document.createElement('select'); modelSelect.dataset.role = name; modelSelect.dataset.field = 'model';
      const available = models || [];
      const ids = new Set(available.map(item => item.id));
      if (!value.model) { const option = document.createElement('option'); option.value = ''; option.textContent = '请选择原生模型'; modelSelect.append(option); }
      if (value.model && !ids.has(value.model)) { const option = document.createElement('option'); option.value = value.model; option.textContent = `${value.model}（当前配置不在原生列表）`; modelSelect.append(option); }
      for (const item of available) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name ? `${item.name} · ${item.id}` : item.id; modelSelect.append(option); }
      modelSelect.value = value.model;
      const effort = document.createElement('select'); effort.dataset.role = name; effort.dataset.field = 'effort';
      const fillEfforts = selectedModel => {
        const options = [new Option('平台默认 / 继承', '')].concat((selectedModel?.efforts || []).map(level => new Option(level, level)));
        effort.replaceChildren(...options);
        if (value.effort && !selectedModel?.efforts.includes(value.effort)) effort.value = '';
        else effort.value = value.effort || '';
        effort.disabled = !selectedModel;
      };
      fillEfforts(available.find(item => item.id === modelSelect.value));
      modelSelect.addEventListener('change', () => {
        value.model = modelSelect.value;
        value.effort = null;
        fillEfforts(available.find(item => item.id === modelSelect.value));
        renderSaveState(profile);
      });
      effort.addEventListener('change', () => { value.effort = effort.value || null; renderSaveState(profile); });
      row.append(title, modelSelect, effort); roles.append(row);
    }
    $('concurrency').value = profile.concurrency;
    $('concurrency').onchange = () => { profile.concurrency = Number($('concurrency').value); renderSaveState(profile); };
    renderSaveState(profile);
  }

  function renderSaveState(profile) {
    $('save').disabled = !canSave(profile);
  }

  async function loadModels() {
    $('models-note').textContent = '正在从 Codex 本机原生服务读取模型清单…';
    try {
      const result = await api(`/api/models?root=${encodeURIComponent(root())}`);
      models = normalizeModels(result.models);
      modelsComplete = result.complete === true;
      if (!models) $('models-note').textContent = `无法读取原生模型清单：${result.error || '服务未返回模型'}。不会使用静态列表代替。`;
      else if (!modelsComplete) $('models-note').textContent = `已读取 ${models.length} 个原生模型；原生服务还有下一页（${result.next_cursor || '游标未提供'}），当前清单不完整。`;
      else $('models-note').textContent = `已读取 ${models.length} 个原生模型。仅显示原生服务返回的模型与思考强度。`;
    } catch (error) { models = null; modelsComplete = false; $('models-note').textContent = `读取模型失败：${error.message}`; }
    renderProfile();
  }

  async function reload({ selectRoot, clearStatus = true } = {}) {
    if (clearStatus) message('');
    workspaces = (await api('/api/workspaces')).workspaces;
    let preferred = selectRoot;
    if (initialLoad) { preferred ||= initialProject; initialLoad = false; }
    paintWorkspaces(preferred);
    if (preferred && !workspaces.some(item => item.root === preferred)) $('new-root').value = preferred;
    if (!root()) { state = null; draft = null; $('roles').textContent = '请登记并选择工作区后管理模型配置。'; $('save').disabled = true; return; }
    if (draft?.root !== root()) draft = null;
    state = await api(`/api/state?root=${encodeURIComponent(root())}`);
    await loadModels();
  }

  $('register').addEventListener('click', async () => {
    try {
      const requestedRoot = $('new-root').value.trim();
      const result = await api('/api/workspaces/register', { method: 'POST', body: JSON.stringify({ root: requestedRoot }) });
      $('new-root').value = '';
      await reload({ selectRoot: result.workspace.root, clearStatus: false });
      message('工作区已登记并启用。');
    } catch (error) { message(error.message, true); }
  });
  $('workspace').addEventListener('change', () => { draft = null; reload().catch(error => message(error.message, true)); });
  $('enabled').addEventListener('change', async () => { try { await api('/api/workspaces/enabled', { method: 'POST', body: JSON.stringify({ root: root(), enabled: $('enabled').checked }) }); await reload({ clearStatus: false }); } catch (error) { message(error.message, true); } });
  $('scope').addEventListener('change', () => { draft = null; renderProfile(); });
  $('refresh').addEventListener('click', () => loadModels());
  $('reset').addEventListener('click', async () => { try { const result = await api('/api/profile/reset', { method: 'POST', body: JSON.stringify({ root: root() }) }); draft = null; await reload({ clearStatus: false }); message(result.message); } catch (error) { message(error.message, true); } });
  $('save').addEventListener('click', async () => {
    try {
      const profile = structuredClone(currentDraft());
      profile.concurrency = Number($('concurrency').value);
      profile.main = buildMain(profile);
      if (!canSave(profile)) throw new Error('请为每个角色选择清单中的模型和支持的思考强度');
      const result = await api('/api/profile', { method: 'POST', body: JSON.stringify({ root: root(), scope: $('scope').value, profile }) });
      await reload({ clearStatus: false });
      message(result.message);
    } catch (error) { message(error.message, true); }
  });
  $('shutdown').addEventListener('click', async () => {
    try {
      const result = await api('/api/shutdown', {method:'POST',body:'{}'});
      for(const control of document.querySelectorAll('button,input,select')) control.disabled = true;
      message(result.message);
    } catch(error) { message(error.message,true); }
  });
  reload().catch(error => message(error.message, true));
})();
