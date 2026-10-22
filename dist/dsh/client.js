window.__ModuleLoader__.load({
  id: "dsh-plugin-ai-loop-engineering",
  factory: function createPlugin(require) {
  const React = require('react');
  const { SettingsForm, SettingsFormModel } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const PACKAGE = 'dsh-plugin-ai-loop-engineering';
  const CONFIG_ID = 'ai-loop-engineering';
  const ROLES = {
    planner: { name: '计划 (Planner)', desc: '任务规划与规格拆解' },
    dev: { name: '开发 (Dev)', desc: '核心代码实现与修复' },
    tester: { name: '测试 (Tester)', desc: '编写用例与执行验证' },
    reviewer: { name: '评审 (Reviewer)', desc: '独立架构与代码审核' },
    scribe: { name: '记录 (Scribe)', desc: '记忆库与交接持久化' },
  };
  const emptyRole = () => ({ enabled: false, provider: '', model: '', reasoningEffort: '' });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const numberValid = value => Number.isInteger(value) && value >= 1 && value <= 16;
  const phaseLabel = phase => ({ done: '已完成', developed: '等待验证', developing: '开发中', verifying: '验证中', reviewing: '评审中', needs_fix: '待修复', blocked: '阻塞', pending: '待开始' }[phase] || phase || '未知');
  const agentStateLabel = state => ({ starting: '正在启动', running: '运行中', waiting_to_stop: '已关闭新派发；在途任务未确认停止', requested: '已请求', waiting: '等待中', stop_requested: '已请求停止（未确认）', completed: '子代理已结束（不代表任务通过）', failed: '子代理失败', cancelled: '已取消', stopped: '已停止', unknown: '状态未知', ended_unknown: '已结束（原因未知）' }[state] || state || '未知');
  const activeActivityCount = agents => (agents ?? []).filter(agent => agent.live === true && !['completed', 'failed', 'cancelled', 'stopped', 'ended_unknown'].includes(agent.state)).length;
  const roleValid = role => object(role) && Object.keys(role).every(key => key === 'enabled' ? typeof role[key] === 'boolean' : ['provider', 'model', 'reasoningEffort'].includes(key) && typeof role[key] === 'string')
    && Boolean(role.model?.trim()) === Boolean(role.provider?.trim());
  const rolesValid = roles => object(roles) && Object.entries(roles).every(([key, role]) => Object.hasOwn(ROLES, key) && roleValid(role));
  const projectsValid = projects => Array.isArray(projects) && projects.every(project => object(project)
    && typeof project.path === 'string' && project.path.length > 0 && typeof project.enabled === 'boolean'
    && (project.maxConcurrent === undefined || numberValid(project.maxConcurrent))
    && (project.roles === undefined || rolesValid(project.roles)));
  const jsonField = (field, fallback, valid) => ({
    field,
    format: value => JSON.stringify(value ?? fallback),
    parse: text => {
      try { const value = JSON.parse(text); return valid(value) ? { kind: 'set', value } : undefined; }
      catch { return undefined; }
    },
  });

  class Controller {
    constructor(scope) {
      this.form = new SettingsFormModel(scope, [
        jsonField('enabled', false, value => typeof value === 'boolean'),
        jsonField('workflowEnabled', undefined, value => typeof value === 'boolean'),
        { field: 'schemaVersion', format: value => value === undefined ? '' : String(value), parse: text => text === '2' ? { kind: 'set', value: 2 } : undefined },
        { field: 'maxConcurrent', format: value => String(value ?? 3), parse: text => numberValid(Number(text)) ? { kind: 'set', value: Number(text) } : undefined },
        jsonField('roles', {}, rolesValid), jsonField('projects', [], projectsValid),
      ]);
      this.actions = this.form.actions();
      const editField = this.actions.edit.bind(this.actions);
      this.actions.edit = (field, text) => {
        const next = field === 'enabled' ? JSON.parse(text) : this.store?.getSnapshot().enabled ?? JSON.parse(this.form.field('workflowEnabled').text || this.form.field('enabled').text || 'false');
        editField('schemaVersion', '2');
        editField('enabled', 'false');
        editField('workflowEnabled', JSON.stringify(next));
        if (field !== 'enabled') editField(field, text);
      };
      this.store = this.form.bind(() => ({
        ...this.form.shell(),
        enabled: JSON.parse(this.form.field('schemaVersion').text || '0') === 2
          ? JSON.parse(this.form.field('workflowEnabled').text || 'false')
          : JSON.parse(this.form.field('enabled').text || 'false'),
        maxConcurrent: this.form.field('maxConcurrent').text,
        roles: JSON.parse(this.form.field('roles').text),
        projects: JSON.parse(this.form.field('projects').text),
      }));
    }
    edit(field, value) { this.actions.edit(field, JSON.stringify(value)); }
    setRole(role, value, path) {
      const state = this.store.getSnapshot();
      if (path === '') this.edit('roles', { ...state.roles, [role]: value });
      else this.updateProject(path, project => ({ ...project, roles: { ...project.roles, [role]: value } }));
    }
    updateProject(path, update) {
      const rows = clone(this.store.getSnapshot().projects);
      const index = rows.findIndex(row => samePath(row.path, path));
      const row = index < 0 ? { path, enabled: false } : rows[index];
      const next = update(row);
      if (index >= 0) rows[index] = next;
      else rows.push(next);
      this.edit('projects', rows);
    }
    removeProject(path) { this.edit('projects', this.store.getSnapshot().projects.filter(row => !samePath(row.path, path))); }
    resetRole(role, path) {
      if (path === '') this.setRole(role, emptyRole(), '');
      else this.updateProject(path, project => {
        const roles = { ...project.roles };
        delete roles[role];
        const next = { ...project };
        if (Object.keys(roles).length) next.roles = roles;
        else delete next.roles;
        return next;
      });
    }
    dispose() { this.form.dispose(); }
  }

  function samePath(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const normalize = path => {
      const trimmed = path.trim().replace(/^[A-Za-z]:[\\/]/, m => m.toLowerCase());
      const value = trimmed.replace(/\\/g, '/').replace(/\/+$/, '') || (trimmed ? '/' : '');
      return /^[a-z]:\//.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
    };
    return normalize(left) === normalize(right);
  }

  function useCatalog(ctx) {
    const [state, setState] = React.useState({ status: 'loading', groups: [], partial: false });
    const [revision, retry] = React.useState(0);
    React.useEffect(() => {
      let active = true;
      let generation = 0;
      const load = async () => {
        const current = ++generation;
        setState({ status: 'loading', groups: [], partial: false });
        try {
          const response = await ctx.remote.session.modelCatalog();
          if (!active || current !== generation) return;
          if (!response.ok) throw new Error('模型目录读取失败');
          setState({ status: 'ready', groups: response.value.groups, partial: response.value.failures.length > 0 });
        } catch {
          if (active && current === generation) setState({ status: 'error', groups: [], partial: false });
        }
      };
      load();
      const offs = [
        ctx.remote?.$on?.('llm/adapters-updated', load),
        ctx.remote?.$on?.('settings/document-updated', load),
        ctx.on?.('connection/reset', load),
      ].filter(Boolean);
      return () => { active = false; generation += 1; offs.forEach(off => off()); };
    }, [ctx, revision]);
    return { ...state, retry: () => retry(value => value + 1) };
  }

  const S = {
    card: {
      background: 'var(--dsw-alias-bg-layer-1, #1e1e24)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
      borderRadius: 10,
      padding: '16px 20px',
      display: 'grid',
      gap: 16,
      marginBottom: 16,
    },
    cardHeader: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.06))',
      paddingBottom: 12,
    },
    title: {
      margin: 0,
      fontSize: 15,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary, #ffffff)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    subtitle: {
      margin: 0,
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary, #999)',
      lineHeight: 1.5,
    },
    badge: active => ({
      fontSize: 11,
      fontWeight: 500,
      padding: '2px 8px',
      borderRadius: 12,
      background: active ? 'rgba(74, 222, 128, 0.12)' : 'rgba(156, 163, 175, 0.12)',
      color: active ? 'var(--dsw-alias-state-success-primary, #4ade80)' : 'var(--dsw-alias-label-secondary, #9ca3af)',
      border: `1px solid ${active ? 'rgba(74, 222, 128, 0.25)' : 'rgba(156, 163, 175, 0.2)'}`,
    }),
    row: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 12,
    },
    input: {
      font: 'inherit',
      fontSize: 13,
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.25))',
      border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15))',
      borderRadius: 6,
      padding: '7px 10px',
      outline: 'none',
      transition: 'border-color 0.2s',
      minWidth: 140,
    },
    btn: (primary = false) => ({
      font: 'inherit',
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      padding: '6px 14px',
      borderRadius: 6,
      border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15))',
      background: primary ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))',
      color: primary ? '#ffffff' : 'var(--dsw-alias-label-primary, inherit)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      transition: 'all 0.15s ease',
    }),
    roleGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      gap: 14,
    },
    roleCard: {
      background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.18))',
      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.06))',
      borderRadius: 8,
      padding: '12px 14px',
      display: 'grid',
      gap: 10,
    },
    roleHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    label: {
      display: 'grid',
      gap: 4,
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary, #aaa)',
    },
    dashCard: {
      background: 'var(--dsw-alias-bg-layer-1, #1e1e24)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
      borderRadius: 10,
      padding: '16px 20px',
      display: 'grid',
      gap: 14,
      marginBottom: 16,
    },
    taskGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      gap: 12,
    },
    taskCard: phase => {
      const colors = {
        done: 'rgba(74, 222, 128, 0.25)',
        developed: 'rgba(96, 165, 250, 0.3)',
        developing: 'rgba(96, 165, 250, 0.35)',
        verifying: 'rgba(250, 204, 21, 0.3)',
        reviewing: 'rgba(192, 132, 252, 0.35)',
        needs_fix: 'rgba(248, 113, 113, 0.35)',
        blocked: 'rgba(239, 68, 68, 0.35)',
        pending: 'rgba(255, 255, 255, 0.08)',
      };
      return {
        background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.2))',
        border: `1px solid ${colors[phase] || colors.pending}`,
        borderRadius: 8,
        padding: '12px 14px',
        display: 'grid',
        gap: 8,
      };
    },
    phaseBadge: phase => {
      const config = {
        done: { label: '✔ 已完成', bg: 'rgba(74, 222, 128, 0.15)', color: '#4ade80' },
        developed: { label: '等待验证', bg: 'rgba(96, 165, 250, 0.15)', color: '#60a5fa' },
        developing: { label: '⚡ 开发中', bg: 'rgba(96, 165, 250, 0.15)', color: '#60a5fa' },
        verifying: { label: '🧪 验证中', bg: 'rgba(250, 204, 21, 0.15)', color: '#facc15' },
        reviewing: { label: '🔍 评审中', bg: 'rgba(192, 132, 252, 0.15)', color: '#c084fc' },
        needs_fix: { label: '⚠️ 待修复', bg: 'rgba(248, 113, 113, 0.15)', color: '#f87171' },
        blocked: { label: '⛔ 阻塞', bg: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' },
        pending: { label: '⏳ 待开始', bg: 'rgba(156, 163, 175, 0.12)', color: '#9ca3af' },
      };
      const c = config[phase] || { label: phase, bg: 'rgba(255,255,255,0.1)', color: '#ccc' };
      return {
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 10,
        background: c.bg,
        color: c.color,
      };
    },
  };

  async function requestStatus(fetcher, path, run, sessionId, signal) {
    const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://dsh.internal/';
    const url = new URL('/plugins/ai-loop-engineering/state', base);
    if (path) url.searchParams.set('project', path);
    if (sessionId) url.searchParams.set('session', sessionId);
    if (run) url.searchParams.set('run', run);
    const response = await fetcher(url.href, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok || parsed.error) throw new Error(parsed.error || `HTTP ${response.status}`);
    return parsed;
  }

  function createStatusPollStore(fetcher = globalThis.fetch, host = globalThis) {
    const entries = new Map();
    const keyOf = params => JSON.stringify([params.sessionId || '', params.path || '', params.run || '']);
    const visible = () => !host.document || host.document.visibilityState !== 'hidden';
    const notify = entry => entry.listeners.forEach(listener => listener());
    const clearTimer = entry => { if (entry.timer !== undefined) host.clearTimeout(entry.timer); entry.timer = undefined; };
    const schedule = (entry, params) => {
      clearTimer(entry);
      if (entry.listeners.size && visible()) entry.timer = host.setTimeout(() => poll(entry, params), 5000);
    };
    const poll = async (entry, params) => {
      clearTimer(entry);
      if (!entry.listeners.size || !visible() || entry.abort) return;
      const abort = new AbortController();
      entry.abort = abort;
      entry.state = { ...entry.state, loading: true, error: null };
      notify(entry);
      try {
        const data = await requestStatus(fetcher, params.path, params.run, params.sessionId, abort.signal);
        if (entry.abort !== abort) return;
        entry.state = { loading: false, data: data.run_id ? data : null, runs: Array.isArray(data.runs) ? data.runs : entry.state.runs, error: data.error || data.message || null };
      } catch (error) {
        if (entry.abort !== abort) return;
        if (error?.name === 'AbortError') return;
        entry.state = { loading: false, data: null, runs: [], error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (entry.abort === abort) {
          entry.abort = undefined;
          notify(entry);
          schedule(entry, params);
        }
      }
    };
    const get = params => entries.get(keyOf(params))?.state ?? { loading: false, data: null, runs: [], error: null };
    const subscribe = (params, listener) => {
      const key = keyOf(params);
      let entry = entries.get(key);
      if (!entry) {
        entry = { state: { loading: false, data: null, runs: [], error: null }, listeners: new Set(), timer: undefined, abort: undefined, visibility: undefined };
        entries.set(key, entry);
      }
      entry.listeners.add(listener);
      if (entry.listeners.size === 1) {
        if (host.document?.addEventListener) {
          entry.visibility = () => {
            if (!visible()) { clearTimer(entry); const active = entry.abort; entry.abort = undefined; active?.abort(); }
            else if (entry.listeners.size) poll(entry, params);
          };
          host.document.addEventListener('visibilitychange', entry.visibility);
        }
        poll(entry, params);
      }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size) return;
        clearTimer(entry);
        entry.abort?.abort();
        if (entry.visibility) host.document?.removeEventListener?.('visibilitychange', entry.visibility);
        entries.delete(key);
      };
    };
    const refresh = params => {
      const entry = entries.get(keyOf(params));
      if (entry && !entry.abort) poll(entry, params);
    };
    return { get, subscribe, refresh };
  }

  const statusPollStore = createStatusPollStore((...args) => globalThis.fetch(...args));
  function useStatus(path, run, sessionId) {
    const params = { path, run, sessionId };
    const key = JSON.stringify([sessionId || '', path || '', run || '']);
    const [snapshot, setSnapshot] = React.useState({ key, ...statusPollStore.get(params) });
    React.useEffect(() => {
      setSnapshot({ key, ...statusPollStore.get(params) });
      if (!path && !sessionId) return undefined;
      return statusPollStore.subscribe(params, () => setSnapshot({ key, ...statusPollStore.get(params) }));
    }, [key]);
    const state = snapshot.key === key ? snapshot : { loading: Boolean(path || sessionId), data: null, runs: [], error: null };
    return { ...state, refresh: () => statusPollStore.refresh(params) };
  }

  function RunDashboard({ path, ctx, projects = [], onProjectChange, sessionId }) {
    const selectionKey = JSON.stringify([sessionId || '', path || '']);
    const [selection, setSelection] = React.useState({ key: selectionKey, run: '' });
    const run = selection.key === selectionKey ? selection.run : '';
    React.useEffect(() => {
      if (selection.key !== selectionKey) setSelection({ key: selectionKey, run: '' });
    }, [selectionKey]);
    const runInfo = useStatus(path, run, sessionId);
    const data = runInfo.data;
    React.useEffect(() => {
      if (!path && data?.project_root && projects.some(row => samePath(row.path, data.project_root))) onProjectChange?.(data.project_root);
    }, [path, data?.project_root, projects, onProjectChange]);
    return h('div', { style: S.dashCard },
      h('div', { style: S.cardHeader },
        h('div', null,
          h('h3', { style: S.title }, '📊 AI Loop 运行状态与任务拓扑看板'),
          h('p', { style: S.subtitle }, '实时监控当前工作区的闭环推进、DAG 任务执行阶段与独立角色协作。'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('button', {
            type: 'button',
            style: S.btn(false),
            disabled: runInfo.loading,
            onClick: runInfo.refresh,
          }, runInfo.loading ? '正在刷新…' : '🔄 刷新看板'),
        ),
      ),
      h('div', { style: { display: 'grid', gap: 10 } },
        projects.length ? h('label', { style: S.label }, '工作区', h('select', { value: path, style: S.input, onChange: event => onProjectChange?.(event.target.value) }, h('option', { value: '' }, '请选择工作区'), projects.map(row => h('option', { key: row.path, value: row.path }, row.path)))) : null,
        runInfo.runs.length ? h('label', { style: S.label }, '选择运行', h('select', { value: run, style: S.input, onChange: event => setSelection({ key: selectionKey, run: event.target.value }) }, h('option', { value: '' }, '请选择运行'), runInfo.runs.map(row => h('option', { key: row.run_id, value: row.run_id }, `${row.run_id} · ${row.status || '未知'} · ${row.goal || ''}`)))) : null,
      ),
      !path ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 13, padding: '12px 0' } }, '请选择一个已启用的工作区。') : runInfo.error || !data ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 13, padding: '12px 0' } },
        runInfo.loading ? '正在加载当前运行状态…' : (runInfo.error || '当前工作区暂无运行记录。'),
      ) : h('div', { style: { display: 'grid', gap: 14 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.15))', padding: '10px 14px', borderRadius: 8 } },
          h('div', null,
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #999)', display: 'block' } }, '运行编号 (Run ID)'),
            h('code', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-brand-primary, #60a5fa)' } }, data.run_id),
          ),
          h('div', null,
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #999)', display: 'block' } }, '总目标 (Goal)'),
            h('div', { style: { fontSize: 13, fontWeight: 500 } }, data.goal),
          ),
          h('div', { style: { marginLeft: 'auto' } },
            h('span', { style: S.badge(data.status === 'active') }, data.status ? data.status.toUpperCase() : 'UNKNOWN'),
          ),
        ),
        h('div', { style: S.taskGrid },
          (data.tasks || []).map(task => h('div', { key: task.id, style: S.taskCard(task.phase) },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('span', { style: { fontWeight: 600, fontSize: 13 } }, `${task.id}: ${task.title}`),
              h('span', { style: S.phaseBadge(task.phase) }, phaseLabel(task.phase)),
            ),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', display: 'flex', gap: 12 } },
              h('span', null, `评审: ${task.review || 'none'}`),
              h('span', null, `修复轮次: ${task.fixes || 0}`),
              h('span', null, `依赖: ${(task.dependencies || []).join(', ') || '无'}`),
              h('span', null, `就绪: ${task.ready ? '是' : '否'}`),
              task.blocked_reason ? h('span', null, `阻塞原因: ${task.blocked_reason}`) : null,
              task.owner ? h('span', null, `负责人: ${task.owner}`) : null,
              task.attempts ? h('span', null, `测试/评审: ${task.attempts.tester || 0}/${task.attempts.reviewer || 0}`) : null,
              task.managed_execution ? h('span', null, '工作流管理执行') : null,
              task.in_scope?.length ? h('span', null, `范围: ${task.in_scope.join(', ')}`) : null,
              task.out_of_scope?.length ? h('span', null, `范围外: ${task.out_of_scope.join(', ')}`) : null,
            ),
          )),
        ),
        h('section', { style: { display: 'grid', gap: 8 } },
          h('h4', { style: { margin: 0, fontSize: 13 } }, '子代理观察（完成不等于任务通过）'),
          data.activity?.agents?.length ? data.activity.agents.map((agent, index) => h('div', { key: agent.native_id || agent.id || `${agent.task}-${agent.role}-${index}`, style: { ...S.taskCard('pending'), gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', alignItems: 'center' } },
            h('span', null, `${agent.role || '未知角色'} · ${agent.task || '未关联任务'}`),
            h('code', null, agent.native_id || '无原生子代理 ID'),
            h('span', null, agent.live ? agentStateLabel(agent.state) : `最后观察 · ${agentStateLabel(agent.state)}`),
            h('span', null, agent.usage ? `Token ${agent.usage.input_tokens ?? '?'} / ${agent.usage.output_tokens ?? '?'}` : 'Token 用量不可获取'),
            agent.note ? h('span', { style: S.subtitle }, agent.note) : null,
          )) : h('p', { style: S.subtitle }, '暂无可显示的子代理观察。'),
          data.activity?.note ? h('p', { style: S.subtitle }, data.activity.note) : null,
        ),
      ),
    );
  }

  const sessionWorkspace = new Map();
  function sessionCwdOf(ctx, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return '';
    const key = sessionId.trim();
    try {
      const sessions = ctx?.get?.('sessions') || ctx?.sessions;
      const list = sessions?.list;
      if (typeof list?.getSnapshot === 'function') {
        const snapshot = list.getSnapshot();
        const entry = snapshot?.byId?.[key];
        if (typeof entry?.cwd === 'string' && entry.cwd) {
          sessionWorkspace.set(key, entry.cwd);
          return entry.cwd;
        }
      }
    } catch {}
    return sessionWorkspace.get(key) || '';
  }

  function ConversationDashboard({ ctx, sessionId, controller }) {
    const sessionKey = typeof sessionId === 'string' ? sessionId.trim() : '';
    const [cwd, setCwd] = React.useState(() => sessionCwdOf(ctx, sessionKey));

    React.useEffect(() => {
      let alive = true;
      const sync = () => {
        if (alive && sessionKey) {
          const next = sessionCwdOf(ctx, sessionKey);
          if (next) setCwd(next);
        }
      };
      sync();
      let unsubscribe;
      try {
        const sessions = ctx?.get?.('sessions') || ctx?.sessions;
        const list = sessions?.list;
        if (typeof list?.subscribe === 'function') unsubscribe = list.subscribe(sync);
      } catch {}
      return () => { alive = false; try { unsubscribe?.(); } catch {} };
    }, [ctx, sessionKey]);

    const selectionKey = JSON.stringify([sessionKey, cwd]);
    const [selection, setSelection] = React.useState({ key: selectionKey, run: '' });
    const run = selection.key === selectionKey ? selection.run : '';
    React.useEffect(() => {
      if (selection.key !== selectionKey) setSelection({ key: selectionKey, run: '' });
    }, [selectionKey]);

    const statusInfo = useStatus(cwd, run, sessionKey);
    const data = statusInfo.data;

    const formState = controller ? React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot) : null;
    const isGlobalEnabled = formState?.enabled ?? false;
    const projectRow = cwd && formState?.projects ? formState.projects.find(p => samePath(p.path, cwd)) : null;
    const isProjectEnabled = (isGlobalEnabled && (projectRow?.enabled ?? false)) ?? false;

    const [expandedAgentId, setExpandedAgentId] = React.useState(null);

    const agents = data?.activity?.agents || [];
    const activeAgentsCount = activeActivityCount(agents);
    const tasks = data?.tasks || [];
    const completedTasksCount = tasks.filter(t => t.phase === 'done').length;
    const progressPercent = tasks.length > 0 ? Math.round((completedTasksCount / tasks.length) * 100) : 0;
    const totalTokens = agents.reduce((acc, a) => {
      acc.in += (a.usage?.input_tokens || 0);
      acc.out += (a.usage?.output_tokens || 0);
      return acc;
    }, { in: 0, out: 0 });

    const roleColors = {
      planner: { color: '#818cf8', bg: 'rgba(99, 102, 241, 0.15)', border: 'rgba(99, 102, 241, 0.3)', icon: '📐' },
      dev: { color: '#34d399', bg: 'rgba(16, 185, 129, 0.15)', border: 'rgba(16, 185, 129, 0.3)', icon: '💻' },
      tester: { color: '#fbbf24', bg: 'rgba(245, 158, 11, 0.15)', border: 'rgba(245, 158, 11, 0.3)', icon: '🧪' },
      reviewer: { color: '#c084fc', bg: 'rgba(139, 92, 246, 0.15)', border: 'rgba(139, 92, 246, 0.3)', icon: '🔍' },
      scribe: { color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.15)', border: 'rgba(59, 130, 246, 0.3)', icon: '📝' },
    };

    const renderAgentCard = (agent, index) => {
      const agentId = agent.native_id || agent.id || `${agent.task}-${agent.role}-${index}`;
      const isExpanded = expandedAgentId === agentId;
      const roleMeta = roleColors[agent.role] || { color: '#94a3b8', bg: 'rgba(255,255,255,0.08)', border: 'rgba(255,255,255,0.12)', icon: '🤖' };
      const roleDesc = ROLES[agent.role]?.name || agent.role || '未知角色';
      const isLive = agent.live === true && !['completed', 'failed', 'cancelled', 'stopped', 'ended_unknown'].includes(agent.state);

      return h('div', {
        key: agentId,
        style: {
          background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.22))',
          border: `1px solid ${isLive ? roleMeta.border : 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08))'}`,
          borderRadius: 8,
          padding: '12px 14px',
          display: 'grid',
          gap: 8,
          transition: 'all 0.2s ease',
          boxShadow: isLive ? `0 0 12px ${roleMeta.bg}` : 'none',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { fontSize: 16 } }, roleMeta.icon),
            h('span', {
              style: {
                fontSize: 12,
                fontWeight: 600,
                color: roleMeta.color,
                background: roleMeta.bg,
                padding: '2px 8px',
                borderRadius: 4,
              },
            }, roleDesc),
            agent.task ? h('span', { style: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-text-primary, #e2e8f0)' } }, `任务 #${agent.task}`) : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            isLive ? h('span', {
              style: {
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#22c55e',
                boxShadow: '0 0 8px rgba(34, 197, 94, 0.8)',
              },
            }) : null,
            h('span', {
              style: {
                fontSize: 11,
                fontWeight: 600,
                color: isLive ? '#22c55e' : 'var(--dsw-alias-text-secondary, #94a3b8)',
                background: isLive ? 'rgba(34, 197, 94, 0.12)' : 'rgba(255, 255, 255, 0.06)',
                padding: '2px 6px',
                borderRadius: 4,
              },
            }, agentStateLabel(agent.state)),
          ),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-text-secondary, #94a3b8)', flexWrap: 'wrap', gap: 6 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', null, '实例 ID:'),
            h('code', { style: { fontSize: 11, color: 'var(--dsw-alias-brand-primary, #60a5fa)', background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 4 } }, agent.native_id || agent.id || 'native-subagent'),
          ),
          h('div', null,
            agent.usage ? `Tokens: ${agent.usage.input_tokens ?? '?'} In / ${agent.usage.output_tokens ?? '?'} Out` : 'Token 消耗统计中',
          ),
        ),
        agent.note || agent.observation ? h('div', { style: { marginTop: 4 } },
          h('button', {
            type: 'button',
            style: {
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--dsw-alias-brand-primary, #60a5fa)',
              fontSize: 11,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            },
            onClick: () => setExpandedAgentId(isExpanded ? null : agentId),
          }, isExpanded ? '▲ 收起观察产物' : '▼ 查看观察产物与指令'),
          isExpanded ? h('div', {
            style: {
              marginTop: 6,
              padding: '8px 10px',
              borderRadius: 6,
              background: 'rgba(0, 0, 0, 0.35)',
              fontSize: 11,
              lineHeight: 1.5,
              fontFamily: 'monospace',
              color: 'var(--dsw-alias-text-primary, #cbd5e1)',
              whiteSpace: 'pre-wrap',
              maxHeight: 200,
              overflowY: 'auto',
            },
          }, agent.note || agent.observation || '无额外观察记录。') : null,
        ) : null,
      );
    };

    return h('div', {
      style: {
        flex: '1 1 0',
        minHeight: 0,
        overflowY: 'auto',
        padding: '20px 24px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        color: 'var(--dsw-alias-text-primary, #e2e8f0)',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))', paddingBottom: 14 } },
        h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 700 } }, '🤖 AI Loop 协同工作流看板'),
            data?.status ? h('span', { style: S.badge(data.status === 'active') }, data.status.toUpperCase()) : null,
          ),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #94a3b8)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', null, `工作区: ${cwd || '未定位到当前会话工作区'}`),
            isProjectEnabled ? h('span', { style: { color: '#22c55e', fontSize: 11, background: 'rgba(34,197,94,0.1)', padding: '1px 6px', borderRadius: 4 } }, '已激活') : h('span', { style: { color: '#f59e0b', fontSize: 11, background: 'rgba(245,158,11,0.1)', padding: '1px 6px', borderRadius: 4 } }, '未激活'),
          ),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          statusInfo.runs.length ? h('select', {
            value: run,
            style: { ...S.input, width: 'auto', minWidth: 160 },
            onChange: e => setSelection({ key: selectionKey, run: e.target.value }),
          },
            h('option', { value: '' }, '当前活跃运行'),
            statusInfo.runs.map(r => h('option', { key: r.run_id, value: r.run_id }, `${r.run_id} · ${r.status || 'status'}`)),
          ) : null,
          h('button', {
            type: 'button',
            style: S.btn(false),
            disabled: statusInfo.loading,
            onClick: statusInfo.refresh,
          }, statusInfo.loading ? '正在刷新…' : '🔄 刷新看板'),
        ),
      ),

      !isProjectEnabled && cwd ? h('div', {
        style: {
          background: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 8,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { fontSize: 20 } }, '⚡'),
          h('div', null,
            h('div', { style: { fontSize: 13, fontWeight: 600, color: '#f59e0b' } }, '当前工作区尚未启用 AI Loop 工作流'),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #94a3b8)', marginTop: 2 } }, '启用后将自动编排 5 大独立角色（Planner、Dev、Tester、Reviewer、Scribe）进行闭环工程开发。'),
          ),
        ),
        h('button', {
          type: 'button',
          style: S.btn(true),
          onClick: () => {
            if (cwd && controller) {
              controller.updateProject(cwd, r => ({ ...r, enabled: true }));
              controller.actions.save();
            }
          },
        }, '为此工作区一键激活 AI Loop'),
      ) : null,

      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 } },
        h('div', { style: S.dashCard },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, '活动子代理 (Live Agents)'),
            h('span', { style: { fontSize: 16 } }, '🚀'),
          ),
          h('div', { style: { fontSize: 22, fontWeight: 700, color: activeAgentsCount > 0 ? '#22c55e' : 'inherit' } }, `${activeAgentsCount} 运行中`),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, `历史累计派发 ${agents.length} 个子代理实例`),
        ),
        h('div', { style: S.dashCard },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, '任务闭环推进 (Pipeline)'),
            h('span', { style: { fontSize: 16 } }, '🎯'),
          ),
          h('div', { style: { fontSize: 22, fontWeight: 700 } }, `${completedTasksCount} / ${tasks.length} 完成`),
          h('div', { style: { width: '100%', height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden', marginTop: 4 } },
            h('div', { style: { width: `${progressPercent}%`, height: '100%', background: '#22c55e', transition: 'width 0.3s ease' } }),
          ),
        ),
        h('div', { style: S.dashCard },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, 'Token 消耗统计'),
            h('span', { style: { fontSize: 16 } }, '🪙'),
          ),
          h('div', { style: { fontSize: 22, fontWeight: 700 } }, `${((totalTokens.in + totalTokens.out) / 1000).toFixed(1)}k`),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, `输入 ${totalTokens.in} · 输出 ${totalTokens.out}`),
        ),
        h('div', { style: S.dashCard },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, '并发配额与状态'),
            h('span', { style: { fontSize: 16 } }, '⚡'),
          ),
          h('div', { style: { fontSize: 22, fontWeight: 700, color: 'var(--dsw-alias-brand-primary, #60a5fa)' } }, `${activeAgentsCount} / ${projectRow?.maxConcurrent || formState?.maxConcurrent || 3}`),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, data?.goal ? `目标: ${data.goal}` : '等待工作流任务启动'),
        ),
      ),

      h('div', { style: { display: 'grid', gap: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '👥 独立子代理调用与执行态看板'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, '自动感知原生派发生命周期'),
        ),
        agents.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 } },
          agents.map((agent, idx) => renderAgentCard(agent, idx)),
        ) : h('div', {
          style: {
            background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.15))',
            border: '1px dashed var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1))',
            borderRadius: 8,
            padding: '24px 16px',
            textAlign: 'center',
            display: 'grid',
            gap: 8,
          },
        },
          h('div', { style: { fontSize: 24 } }, '💤'),
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '当前暂无运行中的子代理'),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, '当工作流进入研发阶段时，系统将自动派发对应的独立子代理并在此实时呈现调用轨迹。'),
        ),
      ),

      tasks.length ? h('div', { style: { display: 'grid', gap: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '📑 DAG 任务推进阶段'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #94a3b8)' } }, `${tasks.length} 个任务节点`),
        ),
        h('div', { style: S.taskGrid },
          tasks.map(task => h('div', { key: task.id, style: S.taskCard(task.phase) },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('span', { style: { fontWeight: 600, fontSize: 13 } }, `${task.id}: ${task.title}`),
              h('span', { style: S.phaseBadge(task.phase) }, phaseLabel(task.phase)),
            ),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #888)', display: 'flex', flexWrap: 'wrap', gap: 10 } },
              h('span', null, `评审: ${task.review || 'none'}`),
              h('span', null, `修复轮次: ${task.fixes || 0}`),
              h('span', null, `依赖: ${(task.dependencies || []).join(', ') || '无'}`),
              task.attempts ? h('span', null, `测试/评审尝试: ${task.attempts.tester || 0}/${task.attempts.reviewer || 0}`) : null,
              task.blocked_reason ? h('span', { style: { color: '#ef4444' } }, `阻塞: ${task.blocked_reason}`) : null,
            ),
          )),
        ),
      ) : null,
    );
  }

  function SidebarDashboard(props) {
    const { controller, ctx, sessionId, initialWorkspacePath } = props;
    const resolvedPath = initialWorkspacePath || sessionCwdOf(ctx, sessionId);
    return h(Card, {
      ...props,
      controller,
      ctx,
      sessionId,
      initialWorkspacePath: resolvedPath,
      inSidebar: true,
    });
  }

  function SidebarTitle({ sessionId }) {
    const sessionKey = typeof sessionId === 'string' ? sessionId.trim() : '';
    const path = sessionWorkspace.get(sessionKey) || '';
    const state = useStatus(path, '', sessionKey);
    const agents = state.data?.activity?.agents ?? [];
    const active = activeActivityCount(agents);
    return h('span', { title: '在侧边栏打开 AI Loop 设置查看与配置' }, active ? `AI Loop · ${active} 个活动` : 'AI Loop 设置');
  }

  function CustomSelect({ label, value, choices, onChange, disabled }) {
    const options = choices.some(o => o.id === value) || !value ? choices : [...choices, { id: value, name: `${value}（当前不可用）` }];
    return h('label', { style: S.label },
      label,
      h('select', {
        value,
        disabled,
        style: S.input,
        onChange: e => onChange(e.target.value),
      }, options.map(o => h('option', { key: o.id, value: o.id }, o.name))),
    );
  }

  function RoleCard({ role, path, state, controller, catalog, disabled }) {
    const project = state.projects.find(row => samePath(row.path, path));
    const own = path === '' ? state.roles[role] : project?.roles?.[role];
    const value = { provider: '', model: '', reasoningEffort: '', ...state.roles[role], ...own };
    const update = patch => controller.setRole(role, path === '' ? { ...value, ...patch } : { ...own, ...patch }, path);
    const group = catalog.groups.find(item => item.id === value.provider);
    const model = group?.models.find(item => item.id === value.model);
    const selectedModel = value.enabled === false ? '__off' : value.model ?? '__off';
    const inherit = path ? [{ id: '', name: '继承全局配置' }] : [];
    const meta = ROLES[role] || { name: role, desc: '' };
    const hasOverride = path !== '' ? Boolean(own) : Boolean(state.roles[role]);

    return h('div', { style: S.roleCard },
      h('div', { style: S.roleHeader },
        h('div', null,
          h('div', { style: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)' } }, meta.name),
          meta.desc ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)' } }, meta.desc) : null,
        ),
        h('button', {
          type: 'button',
          style: S.btn(false),
          disabled: disabled || !hasOverride,
          onClick: () => controller.resetRole(role, path),
        }, path ? '重置继承' : '恢复默认'),
      ),
      h('div', { style: { display: 'grid', gap: 8 } },
        h(CustomSelect, {
          label: '模型提供方',
          value: value.provider ?? '',
          choices: [...inherit, ...catalog.groups.map(item => ({ id: item.id, name: item.name }))],
          disabled: disabled || catalog.status !== 'ready',
          onChange: provider => provider === '' && path ? controller.resetRole(role, path) : update({ provider, model: '', reasoningEffort: '' }),
        }),
        h(CustomSelect, {
          label: '模型选择',
          value: selectedModel,
          choices: [{ id: '__off', name: '关闭' }, ...inherit, ...(group?.models ?? []).map(item => ({ id: item.id, name: item.name }))],
          disabled: disabled,
          onChange: modelId => modelId === '__off'
            ? update({ enabled: false, provider: '', model: '', reasoningEffort: '' })
            : modelId === '' && path ? controller.resetRole(role, path)
              : modelId ? update({ enabled: true, provider: value.provider, model: modelId, reasoningEffort: '' })
                : update({ enabled: false, provider: '', model: '', reasoningEffort: '' }),
        }),
        h(CustomSelect, {
          label: '思考/推理强度',
          value: value.reasoningEffort ?? '',
          choices: [{ id: '', name: '使用继承值或默认' }, ...(model?.reasoning?.efforts ?? [])],
          disabled: disabled || !model,
          onChange: reasoningEffort => update({ reasoningEffort }),
        }),
      ),
    );
  }

  function Card(props) {
    const { controller, ctx, useWorkspaces, sessionId, initialWorkspacePath, inSidebar } = props;
    const state = React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot);

    const targetWorkspace = React.useMemo(() => {
      if (typeof initialWorkspacePath === 'string' && initialWorkspacePath.trim()) {
        return initialWorkspacePath.trim();
      }
      if (typeof sessionId === 'string' && sessionId.trim()) {
        const cwd = sessionCwdOf(ctx, sessionId.trim());
        if (cwd) return cwd;
      }
      return '';
    }, [initialWorkspacePath, sessionId, ctx]);

    const [path, setPath] = React.useState(targetWorkspace);
    const [newPathInput, setNewPathInput] = React.useState('');
    const [query, setQuery] = React.useState('');

    const userSelectedRef = React.useRef(false);
    React.useEffect(() => {
      if (!userSelectedRef.current && targetWorkspace) {
        setPath(targetWorkspace);
      }
    }, [targetWorkspace]);

    let workspacesItems = [];
    if (typeof useWorkspaces === 'function') {
      try {
        const snap = useWorkspaces(s => s);
        if (snap && Array.isArray(snap.items)) workspacesItems = snap.items;
      } catch {
        workspacesItems = [];
      }
    }

    React.useEffect(() => {
      const off = ctx.on?.('connection/reset', () => { controller.actions.discard(); setPath(''); });
      return () => { if (typeof off === 'function') off(); };
    }, [ctx, controller]);

    const catalog = useCatalog(ctx);
    const disabled = !state.writable || state.saving;
    const project = state.projects.find(row => samePath(row.path, path));

    const pathMap = new Map();
    for (const w of workspacesItems) pathMap.set(w.path, w.title || w.path);
    for (const p of state.projects) {
      const match = [...pathMap.keys()].find(k => samePath(k, p.path));
      if (!match) {
        pathMap.set(p.path, `${p.path}（已配置）`);
      }
    }
    if (path) {
      const match = [...pathMap.keys()].find(k => samePath(k, path));
      if (!match && state.projects.some(p => samePath(p.path, path))) {
        pathMap.set(path, `${path}（当前选择）`);
      }
    }

    const filtered = [...pathMap].filter(([val, title]) => `${title} ${val}`.toLowerCase().includes(query.toLowerCase()));

    const handleAddCustomPath = () => {
      const trimmed = newPathInput.trim();
      if (!trimmed) return;
      controller.updateProject(trimmed, row => ({ ...row, enabled: true }));
      setPath(trimmed);
      setNewPathInput('');
    };

    const formContent = h(SettingsForm, {
      state,
      labels: {
        unavailable: 'AI Loop 插件未加载，暂时无法配置。',
        readOnly: '当前部署的插件设置为只读模式。',
        saveFailed: '保存失败或配置已在其他位置更新。请保留当前修改，或放弃后重新读取。',
        save: '保存配置',
        saving: '保存中…',
      },
      onSave: () => controller.actions.save(),
      onDiscard: controller.actions.discard,
    },
    // 1. 全局工作流总控卡片
    h('div', { style: S.card },
      h('div', { style: S.cardHeader },
        h('div', null,
          h('h3', { style: S.title }, '⚡ AI Loop 核心总控'),
          h('p', { style: S.subtitle }, '统一管理 AI Loop 闭环执行引擎、子代理派发与原生工具挂载。'),
        ),
        h('span', { style: S.badge(state.enabled) }, state.enabled ? '已激活' : '已停用'),
      ),
      h('div', { style: S.row },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, fontWeight: 500 } },
          h('input', {
            type: 'checkbox',
            checked: state.enabled,
            disabled,
            style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-brand-primary, #2563eb)' },
            onChange: e => controller.edit('enabled', e.target.checked),
          }),
          '启用 AI Loop 全局主开关',
        ),
      ),
      h('p', { style: S.subtitle }, '提示：全局开关与具体项目开关同时启用后生效。新创建的工作区默认停用，避免非目标项目意外触发子代理。'),
    ),

    // 2. 配置范围与项目选择卡片
    h('div', { style: S.card },
      h('div', { style: S.cardHeader },
        h('div', null,
          h('h3', { style: S.title }, '📁 配置范围与项目绑定'),
          h('p', { style: S.subtitle }, '选择针对全局默认配置生效，还是针对指定工作区进行参数覆盖。'),
        ),
        path ? h('span', { style: S.badge(project?.enabled) }, project?.enabled ? '项目已启用' : '项目已停用') : null,
      ),
      h('div', { style: S.row },
        h('label', { style: { ...S.label, flex: '1 1 200px' } },
          '按名称/路径过滤项目',
          h('input', {
            type: 'search',
            value: query,
            placeholder: '输入关键词搜索…',
            style: S.input,
            onChange: e => setQuery(e.target.value),
          }),
        ),
        h('label', { style: { ...S.label, flex: '1 1 240px' } },
          '当前配置生效目标',
          h('select', {
            value: path,
            disabled: state.saving,
            style: S.input,
            onChange: e => {
              userSelectedRef.current = true;
              setPath(e.target.value);
            },
          },
          h('option', { value: '' }, '🌐 全局默认配置 (所有项目通用)'),
          filtered.map(([id, name]) => h('option', { key: id, value: id }, name))),
        ),
      ),
      // 添加自定义项目路径
      h('div', { style: { ...S.row, marginTop: 4, background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.15))', padding: '10px 12px', borderRadius: 8 } },
        h('input', {
          type: 'text',
          placeholder: '输入绝对路径手动绑定项目 (例如 D:/Projects/my-app)',
          value: newPathInput,
          style: { ...S.input, flex: '1 1 300px' },
          onChange: e => setNewPathInput(e.target.value),
        }),
        h('button', {
          type: 'button',
          style: S.btn(true),
          disabled: !newPathInput.trim() || disabled,
          onClick: handleAddCustomPath,
        }, '+ 添加并启用项目'),
      ),
      path ? h('div', { style: { ...S.row, justifyContent: 'space-between', background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.2))', padding: '10px 14px', borderRadius: 8 } },
        h('div', { style: { display: 'grid', gap: 4 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '当前选定项目：'),
          h('code', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary, #60a5fa)', overflowWrap: 'anywhere' } }, path),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, cursor: 'pointer', fontSize: 13 } },
            h('input', {
              type: 'checkbox',
              checked: project?.enabled ?? false,
              disabled,
              style: { accentColor: 'var(--dsw-alias-brand-primary, #2563eb)' },
              onChange: e => controller.updateProject(path, row => ({ ...row, enabled: e.target.checked })),
            }),
            '在此项目中激活 AI Loop 工作流与子代理',
          ),
        ),
        h('button', {
          type: 'button',
          style: { ...S.btn(false), color: 'var(--dsw-alias-state-error-primary, #f87171)', borderColor: 'rgba(248,113,113,0.3)' },
          disabled: disabled || !project,
          onClick: () => {
            userSelectedRef.current = true;
            controller.removeProject(path);
            setPath('');
          },
        }, '移除项目覆盖'),
      ) : null,
    ),

    // 4. 并发限制与角色模型矩阵卡片
    h('div', { style: S.card },
      h('div', { style: S.cardHeader },
        h('div', null,
          h('h3', { style: S.title }, path ? '⚙️ 项目独立模型与并发覆盖' : '🌐 全局默认模型与并发配置'),
          h('p', { style: S.subtitle }, '精确指派 5 大闭环角色的执行模型与推理深度，支持继承父代理或恢复全局设置。'),
        ),
        h('button', {
          type: 'button',
          style: S.btn(false),
          disabled: catalog.status === 'loading',
          onClick: catalog.retry,
        }, catalog.status === 'loading' ? '正在刷新模型…' : '🔄 刷新可用模型'),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } },
        h('label', { style: { ...S.label, maxWidth: 220 } },
          path ? '项目最大并发子代理数' : '全局最大并发子代理数',
          h('input', {
            type: 'number',
            min: 1,
            max: 16,
            placeholder: path ? '留空继承全局默认' : '默认 3 (1-16)',
            value: path ? project?.maxConcurrent ?? '' : state.maxConcurrent,
            disabled,
            style: S.input,
            onChange: e => {
              const text = e.target.value;
              if (!path) controller.actions.edit('maxConcurrent', text);
              else if (text === '' || numberValid(Number(text))) {
                controller.updateProject(path, row => {
                  const next = { ...row };
                  if (text === '') delete next.maxConcurrent;
                  else next.maxConcurrent = Number(text);
                  return next;
                });
              }
            },
          }),
        ),
        state.invalid ? h('p', { style: { color: 'var(--dsw-alias-state-error-primary, #f87171)', fontSize: 12, margin: 0 } }, '⚠️ 并发上限须为 1–16 的整数；提供方与模型需成对选择。') : null,
      ),
      // 5 大角色卡片网格
      h('div', { style: S.roleGrid },
        ...Object.keys(ROLES).map(role => h(RoleCard, {
          key: `${path}:${role}`,
          role,
          path,
          state,
          controller,
          catalog,
          disabled,
        })),
      ),
    ),

    // 底部操作栏辅助
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 12 } },
      h('button', {
        type: 'button',
        style: S.btn(false),
        disabled: state.saving || !state.dirty,
        onClick: controller.actions.discard,
      }, '放弃所有修改'),
    ));

    if (inSidebar) {
      return h('div', {
        style: {
          height: '100%',
          minHeight: 0,
          overflowY: 'auto',
          boxSizing: 'border-box',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
        },
      }, formContent);
    }
    return formContent;
  }

  function apply(ctx) {
    const controller = new Controller(ctx.configForms.get(CONFIG_ID));
    ctx.effect(() => () => controller.dispose(), 'ai-loop: configuration form');
    ctx.effect(() => ctx.configForms.whileServed([CONFIG_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: PACKAGE,
    }, props => h(Card, { ...props, controller, ctx })))), 'ai-loop: plugin settings');

    let hostedByBetterSidebar = false;
    let takeNativeDown = () => {};

    const hostNatively = () => {
      ctx.effect(() => {
        const disposers = [];
        disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: PACKAGE, inject: sessionId => ({ sessionId }),
        }, props => h(SidebarDashboard, { ...props, controller, ctx }))));
        disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: PACKAGE, inject: sessionId => ({ sessionId }),
        }, props => h(SidebarTitle, props))));
        takeNativeDown = () => disposers.forEach(dispose => dispose?.());
        return () => takeNativeDown();
      }, 'ai-loop: right sidebar native fallback');
    };

    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['betterSidebar'], tabCtx => {
          const betterSidebar = tabCtx.get?.('betterSidebar');
          if (!betterSidebar || typeof betterSidebar.registerTab !== 'function') return;
          hostedByBetterSidebar = true;
          takeNativeDown();
          tabCtx.effect(() => {
            const offTab = betterSidebar.registerTab({
              id: 'ai-loop-engineering:settings',
              title: () => 'AI Loop',
              description: () => 'AI Loop 工作流设置',
              icon: size => h('span', { style: { fontSize: size || 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, '🔄'),
              order: 25,
              single: true,
              component: tabProps => h(Card, {
                controller,
                ctx,
                sessionId: tabProps?.scope?.sessionId,
                initialWorkspacePath: tabProps?.scope?.cwd || sessionCwdOf(ctx, tabProps?.scope?.sessionId),
                inSidebar: true,
              }),
            });
            return () => {
              try { offTab?.(); } catch {}
              hostedByBetterSidebar = false;
              hostNatively();
            };
          }, 'ai-loop: betterSidebar tab');
        });
      } catch {}
    }

    if (!hostedByBetterSidebar) {
      hostNatively();
    }

    ctx.effect(() => {
      let offView = null;
      try {
        offView = ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'ai-loop-engineering:view',
          order: 32,
          label: () => '工作流',
        }, viewProps => h(ConversationDashboard, { ...viewProps, ctx, controller })));
      } catch (err) {
        console.warn('[ai-loop-engineering] conversation view registration failed:', err);
      }
      return () => {
        try { offView?.(); } catch {}
      };
    }, 'ai-loop: conversation view');
  }
  return { inject: ['slots', 'configForms', 'remote', 'remote.session'], apply, Controller, samePath, rolesValid, projectsValid, requestStatus, createStatusPollStore, RunDashboard, SidebarDashboard, SidebarTitle, activeActivityCount, useCatalog, RoleCard, Card, ConversationDashboard, sessionCwdOf };
}
});
