import { UI_THEME } from '../../core/scripts/ui-theme.mjs';
import { createWorkflowGraph } from '../../core/scripts/workflow-graph.mjs';
/** Browser-only factory. The release wraps it in DSH's lazy CommonJS loader. */
export function createPlugin(require, theme = UI_THEME, graphBuilder = createWorkflowGraph) {
  const React = require('react');
  const { SettingsForm, SettingsFormModel } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const PACKAGE = 'dsh-plugin-ai-loop-engineering';
  const CONFIG_ID = 'ai-loop-engineering';
  const emptyStore = { subscribe: () => () => {}, getSnapshot: () => null };
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
  const safeParseJson = (str, fallback) => {
    try { return str ? JSON.parse(str) : fallback; }
    catch { return fallback; }
  };
  const numberValid = value => Number.isInteger(value) && value >= 1 && value <= 32;
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
        enabled: safeParseJson(this.form.field('schemaVersion').text || '0', 0) === 2
          ? safeParseJson(this.form.field('workflowEnabled').text, false)
          : safeParseJson(this.form.field('enabled').text, false),
        maxConcurrent: this.form.field('maxConcurrent').text,
        roles: safeParseJson(this.form.field('roles').text, {}),
        projects: safeParseJson(this.form.field('projects').text, []),
      }));
      this.saved = clone(this.store.getSnapshot());
    }
    savedSnapshot() {
      const current = this.store.getSnapshot();
      if (!current.dirty) this.saved = clone(current);
      return this.saved;
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
      color: 'var(--dsw-alias-text-primary, CanvasText)',
      background: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 18%, transparent))',
      borderRadius: theme.radius,
      padding: '16px 20px',
      display: 'grid',
      gap: theme.space,
      marginBottom: 16,
    },
    cardHeader: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 18%, transparent))',
      paddingBottom: 12,
    },
    title: {
      margin: 0,
      fontSize: 15,
      fontWeight: 600,
      color: 'var(--dsw-alias-text-primary, CanvasText)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    subtitle: {
      margin: 0,
      fontSize: 12,
      color: 'var(--dsw-alias-text-secondary, GrayText)',
      lineHeight: 1.5,
    },
    badge: active => ({
      fontSize: 11,
      fontWeight: 500,
      padding: '2px 8px',
      borderRadius: 12,
      background: active ? 'rgba(74, 222, 128, 0.12)' : 'rgba(156, 163, 175, 0.12)',
      color: active ? 'var(--dsw-alias-state-success-primary, #4ade80)' : 'var(--dsw-alias-text-secondary, GrayText)',
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
      color: 'var(--dsw-alias-text-primary, CanvasText)',
      background: 'var(--dsw-alias-bg-layer-2, Canvas)',
      border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, CanvasText 18%, transparent))',
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
      border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, CanvasText 18%, transparent))',
      background: primary ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-bg-layer-2, Canvas)',
      color: primary ? '#ffffff' : 'var(--dsw-alias-text-primary, CanvasText)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      transition: 'all 0.15s ease',
    }),
    roleGrid: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr)',
      gap: 14,
    },
    roleCard: {
      background: 'var(--dsw-alias-bg-layer-2, Canvas)',
      border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 18%, transparent))',
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
      color: 'var(--dsw-alias-text-secondary, GrayText)',
    },
    dashCard: {
      color: 'var(--dsw-alias-text-primary, CanvasText)',
      background: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 18%, transparent))',
      borderRadius: 10,
      padding: '16px 20px',
      display: 'grid',
      gap: 14,
      marginBottom: 16,
    },
    taskGrid: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr)',
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
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
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

  async function requestStatus(fetcher, path, run, sessionId, signal, page = {}) {
    const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://dsh.internal/';
    const url = new URL('/plugins/ai-loop-engineering/state', base);
    if (path) url.searchParams.set('project', path);
    if (sessionId) url.searchParams.set('session', sessionId);
    if (run) url.searchParams.set('run', run);
    if (page.after) url.searchParams.set('after', page.after);
    if (page.limit) url.searchParams.set('limit', String(page.limit));
    const response = await fetcher(url.href, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok || parsed.error) {
      const error = new Error(parsed.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return parsed;
  }

  function tokenUsageLabel(usage) {
    if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return 'Token 用量不可获取';
    const input = usage.input_tokens == null ? '不可获取' : String(usage.input_tokens);
    const output = usage.output_tokens == null ? '不可获取' : String(usage.output_tokens);
    const partial = usage.input_tokens == null || usage.output_tokens == null;
    return `Tokens: ${input} In / ${output} Out${partial ? '（部分数据）' : ''}`;
  }

  function statusMessage(state) {
    if (state.loading) return '正在加载当前聊天的运行状态…';
    if (state.errorStatus === 403) return `无权读取此工作区：${state.error || '访问被拒绝'}`;
    if (state.error) return `读取运行状态失败：${state.error}`;
    return '当前聊天在此工作区暂无关联运行记录。';
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
      entry.state = { ...entry.state, loading: !entry.loaded, refreshing: Boolean(entry.loaded), error: null };
      notify(entry);
      try {
        const data = await requestStatus(fetcher, params.path, params.run, params.sessionId, abort.signal);
        if (entry.abort !== abort) return;
        entry.loaded = true;
        entry.state = { loading: false, refreshing: false, data: data.run_id ? data : null, history: data.chat_history ?? null, runs: Array.isArray(data.runs) ? data.runs : [], error: null, errorStatus: null };
      } catch (error) {
        if (entry.abort !== abort) return;
        if (error?.name === 'AbortError') return;
        const denied = error?.status === 403;
        entry.state = { ...entry.state, loading: false, refreshing: false, ...(denied ? { data: null, history: null, runs: [] } : {}), error: error instanceof Error ? error.message : String(error), errorStatus: error?.status ?? null };
      } finally {
        if (entry.abort === abort) {
          entry.abort = undefined;
          notify(entry);
          schedule(entry, params);
        }
      }
    };
    const get = params => entries.get(keyOf(params))?.state ?? { loading: false, data: null, history: null, runs: [], error: null };
    const subscribe = (params, listener) => {
      const key = keyOf(params);
      let entry = entries.get(key);
      if (!entry) {
        entry = { state: { loading: false, data: null, history: null, runs: [], error: null }, listeners: new Set(), timer: undefined, abort: undefined, visibility: undefined };
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
    const loadHistory = (params, after) => requestStatus(fetcher, params.path, '', params.sessionId, undefined, { after, limit: 20 });
    return { get, subscribe, refresh, loadHistory };
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
    return { ...state, refresh: () => statusPollStore.refresh(params), loadHistory: after => statusPollStore.loadHistory(params, after) };
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
        runInfo.runs.length ? h('label', { style: S.label }, '选择运行', h('select', { value: run, style: S.input, onChange: event => setSelection({ key: selectionKey, run: event.target.value }) }, h('option', { value: '' }, '请选择运行'), runInfo.runs.map(row => h('option', { key: row.run_id, value: row.run_id }, `${row.project_path || "."} / ${row.run_id} · ${row.status || '未知'} · ${row.goal || ''}`)))) : null,
      ),
      !path ? h('div', { role: 'status', style: { color: 'var(--dsw-alias-text-secondary, GrayText)', fontSize: 13, padding: '12px 0' } }, '请选择一个已启用的工作区。') : runInfo.loading || !data ? h('div', {
        role: runInfo.loading ? 'status' : runInfo.error ? 'alert' : 'status',
        style: { color: runInfo.error ? '#fca5a5' : 'var(--dsw-alias-text-secondary, GrayText)', fontSize: 13, padding: '12px 0' },
      }, statusMessage(runInfo),
      ) : h('div', { style: { display: 'grid', gap: 14 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', background: 'var(--dsw-alias-bg-layer-2, Canvas)', padding: '10px 14px', borderRadius: 8 } },
          h('div', null,
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)', display: 'block' } }, '运行编号 (Run ID)'),
            h('code', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-brand-primary, #60a5fa)' } }, data.run_id),
          ),
          h('div', null,
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)', display: 'block' } }, '总目标 (Goal)'),
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
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)', display: 'flex', gap: 12 } },
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
          h('span', null, tokenUsageLabel(agent.usage)),
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
        sessionWorkspace.delete(key);
        return '';
      }
    } catch {}
    return sessionWorkspace.get(key) || '';
  }

  function agentSessionId(agent) {
    if (agent?.harness && agent.harness !== 'dsh') return '';
    return [agent?.session_id, agent?.context?.id, agent?.native_id].find(value => typeof value === 'string' && value.trim() && !value.startsWith('/')) || '';
  }
  async function openAgentSession(ctx, parentSessionId, agent) {
    const childId = agentSessionId(agent);
    if (!childId) return false;
    parentSessionId = agent?.context?.parent_id || agent?.parent_id || parentSessionId;
    try {
      const sessions = ctx?.get?.('sessions') || ctx?.sessions;
      const workspaces = ctx?.get?.('workspaces') || ctx?.workspaces;
      const layout = ctx?.get?.('layout') || ctx?.layout;
      if (sessions?.openSubagent) {
        if (typeof sessions.refreshSubagents === 'function' && parentSessionId) {
          try { await sessions.refreshSubagents(parentSessionId); } catch {}
        }
        const retained = sessions.subagentAddress?.(childId);
        if (!parentSessionId && !retained) return false;
        const result = await sessions.openSubagent(retained && (!parentSessionId || retained.parentSessionId === parentSessionId)
          ? retained
          : { parentSessionId, childSessionId: childId, mode: 'continuable' });
        if (result === false || result?.ok === false || result?.isError) return false;
        layout?.selectPanel?.(null);
        return true;
      }
      if (typeof sessions?.open === 'function') {
        const result = await sessions.open(childId);
        if (result === false || result?.ok === false || result?.isError) return false;
        layout?.selectPanel?.(null);
        return true;
      }
      if (typeof workspaces?.openSession === 'function') {
        if (!parentSessionId) return false;
        const result = await workspaces.openSession({ parentSessionId, childSessionId: childId, mode: 'continuable' });
        if (result === false || result?.ok === false || result?.isError) return false;
        return true;
      }
    } catch (err) {
      console.warn('[AI Loop] 切换子代理会话失败:', err);
    }
    return false;
  }

  const ComponentBase = React.Component || class {};
  class SafeErrorBoundary extends ComponentBase {
    constructor(props) {
      super(props);
      this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
      return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
      console.error('[AI Loop] 看板渲染异常:', error, errorInfo);
    }
    render() {
      if (this.state.hasError) {
        return h('div', {
          style: {
            padding: '24px',
            color: '#f87171',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '8px',
            margin: '20px',
            boxSizing: 'border-box'
          }
        },
          h('h3', { style: { margin: '0 0 8px 0', fontSize: '15px' } }, '⚠️ AI Loop 看板加载遇到异常'),
          h('div', { style: { fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', marginBottom: '12px' } }, String(this.state.error?.message || this.state.error)),
          h('button', {
            type: 'button',
            style: S.btn(true),
            onClick: () => this.setState({ hasError: false, error: null })
          }, '重试加载看板')
        );
      }
      return this.props.children;
    }
  }

  function ConversationDashboardView({ ctx, sessionId, controller, workspacePath }) {
    const sourceSessionKey = typeof sessionId === 'string' ? sessionId.trim() : '';
    const [cwdState, setCwdState] = React.useState(() => ({ sessionKey: sourceSessionKey, cwd: sessionCwdOf(ctx, sourceSessionKey) }));
    const sessionCwd = cwdState.sessionKey === sourceSessionKey ? cwdState.cwd : sessionCwdOf(ctx, sourceSessionKey);
    const cwd = workspacePath === undefined ? sessionCwd : workspacePath;
    const sessionKey = sourceSessionKey && (workspacePath === undefined || samePath(cwd, sessionCwd)) ? sourceSessionKey : '';

    React.useEffect(() => {
      let alive = true;
      const sync = () => {
        if (alive && sourceSessionKey) {
          const next = sessionCwdOf(ctx, sourceSessionKey);
          setCwdState({ sessionKey: sourceSessionKey, cwd: next });
        } else if (alive) {
          setCwdState({ sessionKey: sourceSessionKey, cwd: '' });
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
    }, [ctx, sourceSessionKey]);

    const selectionKey = JSON.stringify([sessionKey, cwd]);
    const [selection, setSelection] = React.useState({ key: selectionKey, run: '' });
    const run = selection.key === selectionKey ? selection.run : '';
    React.useEffect(() => {
      if (selection.key !== selectionKey) setSelection({ key: selectionKey, run: '' });
    }, [selectionKey]);

    const statusInfo = useStatus(cwd, run, sessionKey);
    const data = statusInfo.data;
    const dashboardMessage = !cwd ? '请选择工作区，或等待当前聊天关联工作区。'
      : statusInfo.loading ? (sessionKey ? '正在加载当前聊天的运行历史…' : '正在加载所选工作区的运行记录…')
        : statusInfo.errorStatus === 403 ? `无权读取当前工作区：${statusInfo.error || '访问被拒绝'}`
          : statusInfo.error && !data ? `${sessionKey ? '读取聊天运行历史失败' : '读取工作区运行记录失败'}：${statusInfo.error}`
            : !data ? (sessionKey ? '当前聊天暂无关联运行记录。' : '所选工作区暂无运行记录。') : null;
    const [olderHistory, setOlderHistory] = React.useState(() => ({ key: selectionKey, runs: [], nextAfter: null, loading: false }));
    const historyDenied = statusInfo.errorStatus === 403;
    const historyScope = React.useRef({ key: selectionKey, denied: historyDenied, generation: 0 });
    if (historyScope.current.key !== selectionKey || historyScope.current.denied !== historyDenied) {
      historyScope.current = { key: selectionKey, denied: historyDenied, generation: historyScope.current.generation + 1 };
    }
    const historyGeneration = historyScope.current.generation;
    const older = !historyDenied && olderHistory.key === selectionKey && (olderHistory.generation ?? 0) === historyGeneration ? olderHistory : { key: selectionKey, generation: historyGeneration, runs: [], nextAfter: historyDenied ? null : statusInfo.history?.next_after ?? null, loading: false };
    React.useEffect(() => {
      if (historyDenied || olderHistory.key !== selectionKey || (olderHistory.generation ?? 0) !== historyGeneration) setOlderHistory({ key: selectionKey, generation: historyGeneration, runs: [], nextAfter: historyDenied ? null : statusInfo.history?.next_after ?? null, loading: false });
    }, [selectionKey, historyGeneration, historyDenied]);
    React.useEffect(() => {
      if (!historyDenied && statusInfo.history?.next_after) setOlderHistory(current => current.key === selectionKey && (current.generation ?? 0) === historyGeneration ? { ...current, nextAfter: statusInfo.history.next_after } : current);
    }, [selectionKey, historyGeneration, historyDenied, statusInfo.history?.next_after]);
    const historyRuns = [...new Map([...(statusInfo.runs ?? []), ...older.runs].map(item => [item.run_id, item])).values()];
    const loadOlder = async () => {
      if (historyDenied || !older.nextAfter || older.loading) return;
      setOlderHistory(current => ({ ...current, key: selectionKey, generation: historyGeneration, loading: true }));
      try {
        const page = await statusInfo.loadHistory(older.nextAfter);
        if (historyScope.current.generation !== historyGeneration || historyScope.current.denied) return;
        const found = page.chat_history;
        setOlderHistory(current => current.key === selectionKey && (current.generation ?? 0) === historyGeneration ? {
          ...current,
          runs: [...new Map([...current.runs, ...(found?.rounds ?? []).map(round => round.run)].map(item => [item.run_id, item])).values()],
          nextAfter: found?.next_after ?? null,
          loading: false,
        } : current);
      } catch {
        setOlderHistory(current => current.key === selectionKey && (current.generation ?? 0) === historyGeneration ? { ...current, loading: false } : current);
      }
    };

    const formStore = controller?.store ?? emptyStore;
    const formState = React.useSyncExternalStore(formStore.subscribe, formStore.getSnapshot, formStore.getSnapshot);
    const savedFormState = controller?.savedSnapshot?.() ?? formState;
    const isGlobalEnabled = savedFormState?.enabled ?? false;
    const projectRow = cwd && savedFormState?.projects ? savedFormState.projects.find(p => samePath(p.path, cwd)) : null;
    const isProjectEnabled = (isGlobalEnabled && (projectRow?.enabled ?? false)) ?? false;

    const [expandedAgentId, setExpandedAgentId] = React.useState(null);
    const [filterMode, setFilterMode] = React.useState('all'); // 'all' | 'active'
    const [navigationError, setNavigationError] = React.useState('');
    const [collapsedTasks, setCollapsedTasks] = React.useState([]);
    const [zoom, setZoom] = React.useState(1);
    const [drag, setDrag] = React.useState(null);
    const [selectedNodeId, setSelectedNodeId] = React.useState('');
    const canvasRef = React.useRef(null);

    const agents = data?.activity?.agents || [];
    const activeAgentsCount = activeActivityCount(agents);
    const tasks = data?.tasks || [];
    const completedTasksCount = tasks.filter(t => t.phase === 'done').length;
    const totalTokens = agents.reduce((acc, a) => {
      acc.in += (a.usage?.input_tokens || 0);
      acc.out += (a.usage?.output_tokens || 0);
      return acc;
    }, { in: 0, out: 0 });
    const measuredAgents = agents.filter(agent => agent.usage && (agent.usage.input_tokens != null || agent.usage.output_tokens != null));
    const totalUsageLabel = measuredAgents.length ? `${totalTokens.in} 输入 / ${totalTokens.out} 输出${measuredAgents.length < agents.length || measuredAgents.some(agent => agent.usage.input_tokens == null || agent.usage.output_tokens == null) ? '（部分数据）' : ''}` : 'Token 用量不可获取';

    const roleColors = {
      planner: { color: '#818cf8', bg: 'rgba(99, 102, 241, 0.15)', border: 'rgba(99, 102, 241, 0.35)', icon: '📐' },
      dev: { color: '#34d399', bg: 'rgba(16, 185, 129, 0.15)', border: 'rgba(16, 185, 129, 0.35)', icon: '💻' },
      tester: { color: '#fbbf24', bg: 'rgba(245, 158, 11, 0.15)', border: 'rgba(245, 158, 11, 0.35)', icon: '🧪' },
      reviewer: { color: '#c084fc', bg: 'rgba(139, 92, 246, 0.15)', border: 'rgba(139, 92, 246, 0.35)', icon: '🔍' },
      scribe: { color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.15)', border: 'rgba(59, 130, 246, 0.35)', icon: '📝' },
    };

    // 组织一轮轮的任务与挂载的子 agent
    const roundIndex = Math.max(0, historyRuns.findIndex(round => round.run_id === data?.run_id));
    const taskGroups = React.useMemo(() => {
      const groups = [];
      const assignedAgentIds = new Set();

      tasks.forEach((task, index) => {
        const taskIdStr = String(task.id);
        const matchedAgents = agents.filter(a => {
          if (!a.task) return false;
          const aTaskId = String(a.task);
          return aTaskId === taskIdStr;
        });
        matchedAgents.forEach(a => assignedAgentIds.add(a.native_id || a.id));
        groups.push({
          round: roundIndex + 1,
          task,
          agents: matchedAgents,
        });
      });

      // 未归属具体任务的子 agent（如全局规划、整体记录等）
      const unassignedAgents = agents.filter(a => !assignedAgentIds.has(a.native_id || a.id));
      if (unassignedAgents.length > 0) {
        groups.push({
          round: roundIndex + 1,
          task: { id: 'workflow', title: '全局协作与支撑阶段', phase: 'developing' },
          agents: unassignedAgents,
          isGlobal: true,
        });
      }

      return groups;
    }, [tasks, agents, roundIndex]);

    const displayedGroups = React.useMemo(() => {
      if (filterMode === 'active') {
        return taskGroups.filter(g => g.agents.some(a => a.live === true) || (g.task.phase !== 'done' && g.task.phase !== 'pending'));
      }
      return taskGroups;
    }, [taskGroups, filterMode]);

    const renderAgentNode = (agent, index) => {
      const agentId = agent.native_id || agent.id || `agent-${index}`;
      const isExpanded = expandedAgentId === agentId;
      const roleMeta = roleColors[agent.role] || { color: '#94a3b8', bg: 'rgba(255,255,255,0.08)', border: 'rgba(255,255,255,0.15)', icon: '🤖' };
      const roleDesc = ROLES[agent.role]?.name || agent.role || '未知角色';
      const isLive = agent.live === true && !['completed', 'failed', 'cancelled', 'stopped', 'ended_unknown'].includes(agent.state);
      const direction = agent.direction || (typeof agent.task === 'string' && agent.task.includes('#') ? agent.task.split('#')[1] : null);
      const childId = agentSessionId(agent);
      const openSession = () => {
        if (!childId) { setNavigationError('此记录没有真实子代理会话 ID，无法打开聊天。'); return; }
        openAgentSession(ctx, sessionKey, agent).then(opened => setNavigationError(opened ? '' : '未能打开子代理聊天，请确认 DSH 会话仍可用。'));
      };

      return h('div', {
        key: agentId,
        role: 'treeitem',
        'aria-level': 3,
        'aria-label': `${roleDesc}${direction ? `，方向 ${direction}` : ''}，${agentStateLabel(agent.state)}；${childId ? '按回车进入子代理会话' : '没有可打开的真实子代理会话'}`,
        'aria-disabled': !childId,
        tabIndex: childId ? 0 : -1,
        onClick: openSession,
        onKeyDown: event => {
          if (childId && (event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
            event.preventDefault(); openSession();
          }
        },
        title: '点击直接进入该子 Agent 的独立聊天上下文',
        style: {
          background: 'var(--dsw-alias-bg-layer-2, Canvas)',
          border: `1.5px solid ${isLive ? roleMeta.color : roleMeta.border}`,
          borderRadius: 10,
          padding: '12px 14px',
          display: 'grid',
          gap: 8,
          cursor: 'pointer',
          minWidth: 0,
          width: '100%',
          maxWidth: '100%',
          overflowWrap: 'anywhere',
          boxSizing: 'border-box',
          position: 'relative',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: isLive ? `0 0 16px ${roleMeta.bg}, inset 0 0 8px ${roleMeta.bg}` : '0 2px 8px rgba(0,0,0,0.2)',
        },
      },
        // 顶部角色与状态
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 16 } }, roleMeta.icon),
            h('span', {
              style: {
                fontSize: 12,
                fontWeight: 700,
                color: roleMeta.color,
                background: roleMeta.bg,
                padding: '2px 8px',
                borderRadius: 4,
              },
            }, roleDesc),
            direction ? h('span', {
              style: {
                fontSize: 11,
                fontWeight: 600,
                color: '#38bdf8',
                background: 'rgba(56, 189, 248, 0.15)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                padding: '1px 6px',
                borderRadius: 4,
              },
            }, `方向: ${direction}`) : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            isLive ? h('span', {
              style: {
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#22c55e',
                boxShadow: '0 0 8px rgba(34, 197, 94, 0.9)',
                animation: 'pulse 1.5s infinite',
              },
            }) : null,
            h('span', {
              style: {
                fontSize: 11,
                fontWeight: 600,
                color: isLive ? '#22c55e' : 'var(--dsw-alias-text-secondary, GrayText)',
                background: isLive ? 'rgba(34, 197, 94, 0.12)' : 'color-mix(in srgb, CanvasText 6%, transparent)',
                padding: '2px 6px',
                borderRadius: 4,
              },
            }, agentStateLabel(agent.state)),
          ),
        ),

        // 实例信息与进入快捷指示
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)', gap: 6 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
            h('span', null, 'ID:'),
            h('code', { style: { fontSize: 11, color: 'var(--dsw-alias-brand-primary, #60a5fa)', background: 'color-mix(in srgb, CanvasText 6%, Canvas)', padding: '1px 4px', borderRadius: 4 } },
              (agent.native_id || agent.id || 'agent').slice(0, 14),
            ),
          ),
          h('div', {
            style: {
              color: 'var(--dsw-alias-brand-primary, #60a5fa)',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
            },
          }, '💬 进入上下文 ↗'),
        ),

        // Token 统计
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 } },
          tokenUsageLabel(agent.usage),
        ),

        // 观察产物与指令
        h('div', {
          style: { marginTop: 2 },
          onClick: e => e.stopPropagation(),
        },
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
              background: 'color-mix(in srgb, CanvasText 6%, Canvas)',
              fontSize: 11,
              lineHeight: 1.5,
              fontFamily: 'monospace',
              color: 'var(--dsw-alias-text-primary, CanvasText)',
              whiteSpace: 'pre-wrap',
              maxHeight: 180,
              overflowY: 'auto',
            },
          }, typeof agent.note === 'string' ? agent.note : agent.note ? JSON.stringify(agent.note, null, 2) : agent.observation ? JSON.stringify(agent.observation, null, 2) : '观察数据不可获取。') : null,
        ),
      );
    };

    return h('div', {
      style: {
        width: '100%',
        height: '100%',
        minHeight: '100%',
        flex: '1 1 auto',
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: theme.space,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        color: 'var(--dsw-alias-text-primary, CanvasText)',
        background: 'var(--dsw-alias-bg-canvas, Canvas)',
      },
    },
      // 顶部导航栏
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 18%, transparent))', paddingBottom: 14 } },
        h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 } }, '工作流看板'),
            data?.status ? h('span', { style: S.badge(data.status === 'active') }, data.status.toUpperCase()) : null,
          ),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, GrayText)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', null, `工作区: ${cwd || '未定位到当前会话工作区'}`),
            h('span', null, sessionKey ? '当前聊天范围' : '工作区范围'),
            isProjectEnabled ? h('span', { style: { color: '#22c55e', fontSize: 11, background: 'rgba(34,197,94,0.1)', padding: '1px 6px', borderRadius: 4 } }, '已激活') : h('span', { style: { color: '#f59e0b', fontSize: 11, background: 'rgba(245,158,11,0.1)', padding: '1px 6px', borderRadius: 4 } }, '未激活'),
          ),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', background: 'color-mix(in srgb, CanvasText 6%, transparent)', borderRadius: 6, padding: 2 } },
            h('button', {
              type: 'button',
              style: {
                border: 'none',
                background: filterMode === 'all' ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'transparent',
                color: filterMode === 'all' ? '#fff' : 'var(--dsw-alias-text-secondary, GrayText)',
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
              },
              onClick: () => setFilterMode('all'),
            }, `当前运行任务 (${taskGroups.length})`),
            h('button', {
              type: 'button',
              style: {
                border: 'none',
                background: filterMode === 'active' ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'transparent',
                color: filterMode === 'active' ? '#fff' : 'var(--dsw-alias-text-secondary, GrayText)',
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
              },
              onClick: () => setFilterMode('active'),
            }, '仅看活动任务'),
          ),
          historyRuns.length ? h('select', {
            'aria-label': sessionKey ? '选择当前聊天的历史运行轮次' : '选择工作区运行',
            value: run,
            style: { ...S.input, width: 'auto', minWidth: 160 },
            onChange: e => setSelection({ key: selectionKey, run: e.target.value }),
          },
            h('option', { value: '' }, sessionKey ? '选择当前聊天轮次' : '选择工作区运行'),
            historyRuns.map((r, index) => h('option', { key: r.run_id, value: r.run_id }, `第 ${index + 1} 轮 · ${r.run_id} · ${r.status || '未知'}`)),
          ) : null,
          older.nextAfter ? h('button', { type: 'button', style: S.btn(false), disabled: older.loading, onClick: loadOlder }, older.loading ? '正在加载历史…' : '加载更早运行') : null,
          h('button', {
            type: 'button',
            style: S.btn(false),
            disabled: statusInfo.loading,
            onClick: statusInfo.refresh,
          }, statusInfo.loading ? '正在刷新…' : '🔄 刷新看板'),
        ),
      ),

      navigationError ? h('div', { role: 'alert', style: { color: '#fca5a5', fontSize: 12 } }, navigationError) : null,

      // 未激活提醒
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
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, GrayText)', marginTop: 2 } }, '启用后将自动编排独立角色，支持多方向任务动态分解与闭环开发。'),
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

      statusInfo.history?.unbound_count > 0 ? h('div', {
        role: 'note',
        style: { color: 'var(--dsw-alias-text-secondary, GrayText)', fontSize: 11 },
      }, `${statusInfo.history.unbound_count} 个旧运行含未绑定当前聊天的活动，已从历史中隐藏。`) : null,

      dashboardMessage ? h('div', {
        role: statusInfo.error ? 'alert' : 'status',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 14px',
          borderRadius: 8,
          border: `1px solid ${statusInfo.error ? 'rgba(248,113,113,0.35)' : 'rgba(148,163,184,0.2)'}`,
          background: statusInfo.error ? 'rgba(127,29,29,0.18)' : 'rgba(148,163,184,0.08)',
          color: statusInfo.error ? '#fca5a5' : 'var(--dsw-alias-text-secondary, GrayText)',
          fontSize: 13,
        },
      },
        h('span', null, dashboardMessage),
        statusInfo.error ? h('button', {
          type: 'button',
          style: S.btn(false),
          onClick: statusInfo.refresh,
        }, '重试') : null,
      ) : null,

      statusInfo.error && data ? h('p', { role: 'alert', style: S.subtitle }, `后台刷新失败，保留上次内容：${statusInfo.error}`) : null,

      // 与 Codex 一致，以单行概览让任务图成为主要内容。
      h('p', { style: { margin: 0, color: 'var(--dsw-alias-text-secondary, GrayText)', fontSize: 12 } },
        `任务完成 ${completedTasksCount}/${tasks.length} · 正在运行 ${activeAgentsCount} · 代理调用 ${agents.length} · ${totalUsageLabel}`,
      ),

      // Shared core projection; DSH adds only host-compatible canvas interactions.
      !dashboardMessage ? (() => {
        const graphTasks = filterMode === 'active' ? taskGroups.filter(group => group.agents.some(agent => agent.live === true) || !['done', 'pending'].includes(group.task.phase)).flatMap(group => tasks.some(task => task.id === group.task.id) ? [group.task] : []) : tasks;
        const graph = graphBuilder({ run: { ...(data ?? {}), tasks: graphTasks }, spec: data?.spec ?? { workflow: data?.workflow }, activity: data?.activity ?? { agents } }, { collapsedTasks });
        const selectedNode = graph.nodes.find(node => node.id === selectedNodeId) ?? graph.nodes.find(node => node.kind === 'stage' && node.agents?.length) ?? null;
        const roleColor = { main: graph.theme?.accent ?? theme.accent ?? '#3b82f6', task: graph.theme?.accent ?? theme.accent ?? '#3b82f6', ...graph.theme?.roleColors };
        const toggleTask = taskId => setCollapsedTasks(current => current.includes(taskId) ? current.filter(id => id !== taskId) : [...current, taskId]);
        const setScale = next => setZoom(Math.max(0.35, Math.min(1.5, Math.round(next * 100) / 100)));
        const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
        const canvasWidth = graph.width * zoom, canvasHeight = graph.height * zoom;
        const edgePath = edge => {
          const from = nodeById.get(edge.source), to = nodeById.get(edge.target);
          if (!from || !to) return null;
          const x1 = from.x + from.width / 2, y1 = from.y + from.height;
          const x2 = to.x + to.width / 2, y2 = to.y;
          const bend = Math.max(18, (y2 - y1) / 2);
          return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
        };
        const onPointerDown = event => {
          if (event.target !== event.currentTarget && event.target?.dataset?.canvasBackground !== 'true') return;
          setDrag({ x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop });
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
        };
        const onPointerMove = event => {
          if (!drag) return;
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
        };
        const onPointerUp = () => setDrag(null);
        const fitCanvas = () => {
          const rect = canvasRef.current?.getBoundingClientRect?.();
          const fit = rect ? Math.min(1, rect.width / graph.width) : 1;
          setScale(fit);
          if (canvasRef.current) {
            canvasRef.current.scrollLeft = Math.max(0, (graph.width * fit - rect.width) / 2);
            canvasRef.current.scrollTop = 0;
          }
        };
        const detailAgents = selectedNode?.agents ?? [];
        return h('section', { style: { display: 'grid', gap: theme.space ?? 12, minWidth: 0, color: 'var(--dsw-alias-text-primary, CanvasText)' } },
          h('p', { style: { margin: 0, color: 'var(--dsw-alias-text-secondary, GrayText)', fontSize: 12 } }, '从上到下展示阶段交接与任务依赖；点线仅表示已记录的真实代理调用。代理结束不等于任务通过。'),
          h('div', { role: 'toolbar', 'aria-label': '工作流画布控制', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
            h('button', { type: 'button', style: S.btn(false), 'aria-label': '缩小画布', onClick: () => setScale(zoom - 0.1) }, '缩小'),
            h('span', { 'aria-live': 'polite', style: { minWidth: 48, textAlign: 'center', fontSize: 12 } }, `${Math.round(zoom * 100)}%`),
            h('button', { type: 'button', style: S.btn(false), 'aria-label': '放大画布', onClick: () => setScale(zoom + 0.1) }, '放大'),
            h('button', { type: 'button', style: S.btn(false), onClick: fitCanvas }, '适应画布'),
            h('button', { type: 'button', style: S.btn(false), onClick: () => { setScale(1); if (canvasRef.current) { canvasRef.current.scrollLeft = 0; canvasRef.current.scrollTop = 0; } } }, '重置'),
            h('button', { type: 'button', style: S.btn(false), onClick: () => setCollapsedTasks([]) }, '全部展开'),
            h('button', { type: 'button', style: S.btn(false), onClick: () => setCollapsedTasks(tasks.map(task => task.id)) }, '全部收起'),
          ),
          graph.warnings?.length ? h('div', { role: 'status', style: { color: '#fbbf24', fontSize: 12 } }, graph.warnings.join(' ')) : null,
          h('div', {
            role: 'region', 'aria-label': `当前聊天运行关系图，第 ${roundIndex + 1} 轮`, tabIndex: 0,
            onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
            ref: canvasRef,
            onKeyDown: event => { if (event.target !== event.currentTarget) return; if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(event.key)) event.preventDefault(); const step = 48; if (event.key === 'ArrowLeft') event.currentTarget.scrollLeft -= step; else if (event.key === 'ArrowRight') event.currentTarget.scrollLeft += step; else if (event.key === 'ArrowUp') event.currentTarget.scrollTop -= step; else if (event.key === 'ArrowDown') event.currentTarget.scrollTop += step; else if (event.key === '+' || event.key === '=') setScale(zoom + 0.1); else if (event.key === '-') setScale(zoom - 0.1); },
            style: { minWidth: 0, maxWidth: '100%', height: 'min(60vh, 640px)', minHeight: 300, overflow: 'auto', border: '1px solid color-mix(in srgb, var(--dsw-alias-text-primary, CanvasText) 18%, transparent)', borderRadius: theme.radius ?? 10, background: 'radial-gradient(color-mix(in srgb, var(--dsw-alias-text-primary, CanvasText) 16%, transparent) 1px, transparent 1px), var(--dsw-alias-bg-canvas, Canvas)', backgroundSize: '20px 20px', cursor: drag ? 'grabbing' : 'grab', touchAction: 'none' },
          },
            h('div', { 'data-canvas-background': 'true', style: { position: 'relative', width: canvasWidth, height: canvasHeight, minWidth: canvasWidth, minHeight: canvasHeight, margin: '0 auto' } },
              h('div', { style: { position: 'absolute', inset: 0, width: graph.width, height: graph.height, transform: `scale(${zoom})`, transformOrigin: 'top left' } },
                h('svg', { 'aria-hidden': true, width: graph.width, height: graph.height, viewBox: `0 0 ${graph.width} ${graph.height}`, style: { position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' } },
                  graph.edges.map(edge => h('path', { key: edge.id, d: edgePath(edge), fill: 'none', stroke: 'currentColor', strokeOpacity: 0.4, strokeWidth: 1.5, strokeDasharray: edge.kind === 'call' ? '2 4' : edge.kind === 'dependency' ? '6 4' : undefined })),
                ),
                graph.nodes.map(node => {
                  const color = roleColor[node.role] ?? (node.kind === 'main' || node.kind === 'task' ? roleColor.main : '#94a3b8');
                  const isCollapsed = node.kind === 'task' && collapsedTasks.includes(node.taskId);
                  const canCollapse = node.kind === 'task' && node.taskId;
                  return h('article', {
                    key: node.id, 'data-node-id': node.id, role: 'button', tabIndex: 0, 'aria-label': `${node.label} · ${node.status}`,
                    onClick: () => setSelectedNodeId(node.id),
                    onKeyDown: event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedNodeId(node.id); } },
                    style: { position: 'absolute', left: node.x, top: node.y, width: node.width, height: node.height, padding: 10, boxSizing: 'border-box', overflow: 'hidden', border: `1px solid ${selectedNodeId === node.id ? color : 'color-mix(in srgb, var(--dsw-alias-text-primary, CanvasText) 22%, transparent)'}`, borderTop: `3px solid ${color}`, borderRadius: theme.radius ?? 10, background: 'var(--dsw-alias-bg-layer-1, Canvas)', color: 'var(--dsw-alias-text-primary, CanvasText)', display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 4, boxShadow: selectedNodeId === node.id ? `0 0 0 1px ${color}` : undefined },
                  },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, minWidth: 0 } },
                      h('strong', { style: { color: 'var(--dsw-alias-text-primary, CanvasText)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: node.label }, node.label),
                      canCollapse ? h('button', { type: 'button', 'aria-label': isCollapsed ? '展开任务阶段' : '折叠任务阶段', style: { ...S.btn(false), padding: '1px 6px', flex: '0 0 auto' }, onClick: event => { event.stopPropagation(); toggleTask(node.taskId); } }, isCollapsed ? '＋' : '−') : null,
                    ),
                    h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-text-primary, CanvasText)', overflow: 'hidden', textOverflow: 'ellipsis', overflowWrap: 'anywhere' }, title: node.status }, node.status),
                    h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)' } }, node.agents?.length ? `${node.agents.length} 次真实调用 · 选择查看` : node.kind === 'stage' ? '尚无调用' : node.taskId ? `任务 ${node.taskId}` : data?.run_id ?? ''),
                  );
                }),
              ),
            ),
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)' } }, '实线：阶段交接', '虚线：任务依赖', '点线：真实调用'),
          selectedNode ? h('section', { className: 'workflow-node-details', 'aria-label': `${selectedNode.label}调用详情`, style: S.dashCard },
            h('strong', { style: { color: roleColor[selectedNode.role] ?? roleColor.main } }, `${selectedNode.label} · ${detailAgents.length} 次真实调用`),
            detailAgents.length ? detailAgents.map((agent, index) => {
              const id = agent.native_id || agent.id || `agent-${index}`;
              const childId = agentSessionId(agent);
              const expanded = expandedAgentId === id;
              return h('article', { key: id, style: { padding: `${theme.space ?? 12}px 0`, borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 18%, transparent))' } },
                h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                  h('strong', null, `${ROLES[agent.role]?.name ?? agent.role ?? '代理'} · ${agentStateLabel(agent.state)}`),
                  childId ? h('button', { type: 'button', style: S.btn(false), onClick: () => openAgentSession(ctx, sessionKey, agent).then(opened => setNavigationError(opened ? '' : '未能打开子代理聊天，请确认 DSH 会话仍可用。')) }, '进入子代理聊天') : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, GrayText)' } }, '未记录可导航的聊天标识'),
                ),
                h('p', { style: { margin: '4px 0', fontSize: 12 } }, agent.summary ?? agent.observation?.summary ?? '暂无摘要'),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)' } }, tokenUsageLabel(agent.usage)),
                h('button', { type: 'button', style: { ...S.btn(false), display: 'block', marginTop: 6 }, onClick: () => setExpandedAgentId(expanded ? null : id) }, expanded ? '收起观察详情' : '查看观察详情'),
                expanded ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto', margin: '6px 0', fontSize: 11 } }, typeof agent.note === 'string' ? agent.note : agent.note ? JSON.stringify(agent.note, null, 2) : agent.observation ? JSON.stringify(agent.observation, null, 2) : '观察数据不可获取。') : null,
              );
            }) : h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, GrayText)' } }, selectedNode.kind === 'stage' ? '此阶段尚无派发记录。' : '此节点暂无代理调用。'),
          ) : null,
          h('details', { className: 'workflow-all-agents', style: { ...S.dashCard, padding: theme.space ?? 12 } },
            h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, `全部代理调用 (${agents.length})`),
            agents.map((agent, index) => {
              const id = agent.native_id || agent.id || `agent-${index}`;
              const childId = agentSessionId(agent);
              return h('article', { key: id, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 18%, transparent))' } },
                h('span', { style: { fontSize: 12 } }, `${ROLES[agent.role]?.name ?? agent.role ?? '代理'} · ${agent.task ?? '运行级'} · ${agentStateLabel(agent.state)} · ${agent.summary ?? '暂无摘要'}`),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)' } }, tokenUsageLabel(agent.usage)),
                childId ? h('button', { type: 'button', style: S.btn(false), onClick: () => openAgentSession(ctx, sessionKey, agent).then(opened => setNavigationError(opened ? '' : '未能打开子代理聊天，请确认 DSH 会话仍可用。')) }, '进入聊天') : null,
              );
            }),
          ),
        );
      })() : null,
    );
  }

  function ConversationDashboard(props) {
    return h(SafeErrorBoundary, null, h(ConversationDashboardView, props));
  }

  function SidebarDashboard(props) {
    const { controller, ctx, sessionId, initialWorkspacePath } = props;
    const sessions = ctx?.get?.('sessions') || ctx?.sessions;
    const sessionCwd = React.useSyncExternalStore(listener => sessions?.list?.subscribe?.(listener) || (() => {}), () => sessionCwdOf(ctx, sessionId), () => '');
    const resolvedPath = sessionId ? sessionCwd : initialWorkspacePath || '';
    const selectionKey = JSON.stringify([sessionId || '', resolvedPath]);
    const [selection, setSelection] = React.useState(() => ({ key: selectionKey, path: resolvedPath }));
    const workspaces = ctx?.get?.('workspaces') || ctx?.workspaces;
    const snapshot = React.useSyncExternalStore(listener => workspaces?.list?.subscribe?.(listener) || (() => {}), () => workspaces?.list?.getSnapshot?.() ?? null, () => null);
    const hooked = typeof props.useWorkspaces === 'function' ? props.useWorkspaces(value => value) : null;
    const source = hooked ?? snapshot;
    const ready = source?.phase === 'ready' && source?.state === 'idle' && !source?.error && Array.isArray(source.items);
    const rows = [...new Map((Array.isArray(source?.items) ? source.items : Array.isArray(source) ? source : []).filter(row => typeof row?.path === 'string').map(row => [row.path.replace(/\\/g, '/').toLowerCase(), row])).values()];
    const desired = selection.key === selectionKey ? selection.path : resolvedPath;
    const path = ready && !rows.some(row => samePath(row.path, desired)) ? '' : desired;
    const changePath = value => setSelection({ key: selectionKey, path: value });
    React.useEffect(() => { if (ready && desired !== path) changePath(path); }, [ready, desired, path, selectionKey]);
    const state = React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot);
    const saved = controller.savedSnapshot?.() ?? state;
    const [page, setPage] = React.useState('settings');
    return h('section', { style: { fontSize: theme.font, minWidth: 0, height: '100%', overflowY: 'auto', overflowX: 'auto', padding: theme.space, color: 'var(--dsw-alias-text-primary, CanvasText)', background: 'var(--dsw-alias-bg-canvas, Canvas)' } },
      h('h2', { style: S.title }, 'AI Loop 工作流'),
      h('label', { style: S.label }, '工作区选择', h('select', { value: path, disabled: state.saving || !ready, style: S.input, onChange: event => changePath(event.target.value) },
        h('option', { value: '' }, '全局默认 · 请选择工作区'),
        rows.map(row => { const enabled = saved.enabled && saved.projects.some(project => samePath(project.path, row.path) && project.enabled); return h('option', { key: row.path, value: row.path }, `${enabled ? '🟢' : '🔴'} ${row.title || row.name || row.path}`); }))),
      h('nav', { 'aria-label': '工作流页面', style: { ...S.row, margin: '12px 0' } },
        [['settings', '工作流配置'], ['dashboard', '工作流看板']].map(([key, label]) => h('button', { key, type: 'button', style: S.btn(page === key), 'aria-pressed': page === key, onClick: () => setPage(key) }, label))),
      h('div', { hidden: page !== 'settings' }, h(Card, { ...props, controller, ctx, sessionId, initialWorkspacePath: resolvedPath, workspacePath: path, onWorkspaceChange: changePath })),
      h('div', { hidden: page !== 'dashboard' }, h(ConversationDashboard, { ...props, controller, ctx, sessionId, workspacePath: path })),
    );
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
          h('div', { style: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-text-primary, CanvasText)' } }, meta.name),
          meta.desc ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, GrayText)' } }, meta.desc) : null,
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
    const saved = controller.savedSnapshot?.() ?? state;

    const sessions = (() => { try { return ctx?.get?.('sessions') || ctx?.sessions; } catch { return ctx?.sessions; } })();
    const sessionKey = typeof sessionId === 'string' ? sessionId.trim() : '';
    const subscribedCwd = React.useSyncExternalStore(
      listener => sessions?.list?.subscribe?.(listener) || (() => {}),
      () => sessionKey ? sessionCwdOf(ctx, sessionKey) : '',
      () => '',
    );
    const activeSessionCwd = sessionKey ? subscribedCwd : initialWorkspacePath || '';
    const selectionKey = JSON.stringify([sessionKey, activeSessionCwd]);
    const [selection, setSelection] = React.useState(() => ({ key: selectionKey, path: activeSessionCwd }));
    const path = props.workspacePath === undefined ? (selection.key === selectionKey ? selection.path : activeSessionCwd) : props.workspacePath;
    const setPath = value => props.onWorkspaceChange ? props.onWorkspaceChange(value) : setSelection({ key: selectionKey, path: value });
    const [saveError, setSaveError] = React.useState('');

    const workspacesFromHook = typeof useWorkspaces === 'function' ? useWorkspaces(s => s) : null;
    const workspaceStore = (() => { try { return (ctx?.get?.('workspaces') || ctx?.workspaces)?.list; } catch { return ctx?.workspaces?.list; } })();
    const contextSnapshot = React.useSyncExternalStore(
      listener => workspaceStore?.subscribe?.(listener) || (() => {}),
      () => workspaceStore?.getSnapshot?.() ?? null,
      () => null,
    );
    const workspaceSnapshot = workspacesFromHook ?? contextSnapshot;
    const workspaceReady = Boolean(workspaceSnapshot && workspaceSnapshot.phase === 'ready' && workspaceSnapshot.state === 'idle' && !workspaceSnapshot.error && Array.isArray(workspaceSnapshot.items) && workspaceSnapshot.items.every(item => item && typeof item.path === 'string' && /^(?:[a-z]:[\\/]|\/)/i.test(item.path)));
    const effectiveWorkspaces = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : Array.isArray(workspaceSnapshot) ? workspaceSnapshot : [];

    React.useEffect(() => {
      const off = ctx.on?.('connection/reset', () => { controller.actions.discard(); setSelection({ key: selectionKey, path: '' }); });
      return () => { if (typeof off === 'function') off(); };
    }, [ctx, controller]);

    const catalog = useCatalog(ctx);
    const disabled = !state.writable || state.saving;
    const project = state.projects.find(row => samePath(row.path, path));

    const workspaceOptions = React.useMemo(() => {
      const list = [];
      const seen = new Set();
      if (effectiveWorkspaces.length > 0) {
        for (const ws of effectiveWorkspaces) {
          if (!ws || typeof ws.path !== 'string') continue;
          const wsPath = ws.path;
          if (seen.has(wsPath.toLowerCase())) continue;
          seen.add(wsPath.toLowerCase());
          const proj = saved.projects.find(row => samePath(row.path, wsPath));
          const isEn = Boolean(saved.enabled && proj?.enabled);
          const dot = isEn ? '🟢' : '🔴';
          const name = ws.title || ws.name || wsPath;
          list.push({ path: wsPath, label: `${dot} ${name} (${wsPath})`, enabled: isEn });
        }
      }
      return list;
    }, [effectiveWorkspaces, saved.projects, saved.enabled]);

    const formContent = h(SettingsForm, {
      state,
      labels: {
        unavailable: 'AI Loop 插件未加载，暂时无法配置。',
        readOnly: '当前部署的插件设置为只读模式。',
        saveFailed: '保存失败或配置已在其他位置更新。请保留当前修改，或放弃后重新读取。',
        save: '保存配置',
        saving: '保存中…',
      },
      onSave: () => {
        if (path && (!workspaceReady || !effectiveWorkspaces.some(workspace => samePath(workspace.path, path)))) {
          setSaveError('所选工作区已删除或列表尚未就绪，请重新选择后保存。');
          return;
        }
        setSaveError('');
        controller.actions.save();
      },
      onDiscard: controller.actions.discard,
    },
    saveError ? h('p', { role: 'alert', style: { color: theme.danger } }, saveError) : null,
    state.dirty ? h('p', { style: S.subtitle }, '有未保存修改；工作区红绿状态仍以保存结果为准。') : null,
    // 1. 全局工作流总控卡片
    h('div', { style: S.card },
      h('div', { style: S.cardHeader },
        h('div', null,
          h('h3', { style: S.title }, '工作流配置'),
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

    // 2. 配置范围与工作区选择卡片
    h('div', { style: S.card },
      h('div', { style: S.cardHeader },
        h('div', null,
          h('h3', { style: S.title }, '工作区与范围'),
          h('p', { style: S.subtitle }, '以 DSH 工作区为基本单位，独立管理每个工作区的工作流激活状态、角色模型与并发设置。'),
        ),
        path ? h('span', { style: S.badge(state.enabled && project?.enabled) }, state.enabled && project?.enabled ? '工作区已激活' : '工作区未激活') : null,
      ),
      props.workspacePath === undefined ? h('div', { style: S.row },
        h('label', { style: { ...S.label, flex: '1 1 100%' } },
          '工作区选择',
          h('select', {
            value: path,
            disabled: state.saving,
            style: S.input,
            onChange: e => setPath(e.target.value),
          },
          h('option', { value: '' }, '🌐 全局默认配置 (所有工作区通用)'),
          workspaceOptions.map(opt => h('option', { key: opt.path, value: opt.path }, opt.label))),
        ),
      ) : null,
      path ? h('div', { style: { ...S.row, justifyContent: 'space-between', alignItems: 'center', background: 'var(--dsw-alias-bg-layer-2, Canvas)', padding: '10px 14px', borderRadius: 8, marginTop: 8 } },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500 } },
          h('input', {
            type: 'checkbox',
            checked: project?.enabled ?? false,
            disabled,
            style: { accentColor: 'var(--dsw-alias-brand-primary, #2563eb)' },
            onChange: e => controller.updateProject(path, row => ({ ...row, enabled: e.target.checked })),
          }),
          '在此工作区中激活 AI Loop 工作流与子代理',
        ),
        project ? h('button', {
          type: 'button',
          style: { ...S.btn(false), color: 'var(--dsw-alias-state-error-primary, #f87171)', borderColor: 'rgba(248,113,113,0.3)' },
          disabled: disabled || !project,
          onClick: () => {
            controller.removeProject(path);
            setPath('');
          },
        }, '移除工作区覆盖') : null,
      ) : null,
    ),

    // 3. 并发限制与角色模型矩阵卡片
    h('div', { style: S.card },
      h('div', { style: S.cardHeader },
        h('div', null,
          h('h3', { style: S.title }, path ? '⚙️ 工作区独立模型与并发覆盖' : '🌐 全局默认模型与并发配置'),
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
              component: tabProps => h(SidebarDashboard, {
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

  }
  return { inject: ['slots', 'configForms', 'remote', 'remote.session', 'workspaces', 'sessions'], apply, Controller, samePath, rolesValid, projectsValid, requestStatus, tokenUsageLabel, statusMessage, createStatusPollStore, openAgentSession, agentSessionId, RunDashboard, SidebarDashboard, SidebarTitle, activeActivityCount, useCatalog, RoleCard, Card, ConversationDashboard, sessionCwdOf };
}
