/** Browser-only factory. The release wraps it in DSH's lazy CommonJS loader. */
export function createPlugin(require) {
  const React = require('react');
  const { SettingsForm, SettingsFormModel } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const PACKAGE = 'dsh-plugin-ai-loop-engineering';
  const CONFIG_ID = 'ai-loop-engineering';
  const ROLES = { planner: '计划', dev: '开发', tester: '测试', reviewer: '评审', scribe: '记录' };
  const emptyRole = () => ({ provider: '', model: '', reasoningEffort: '' });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const numberValid = value => Number.isInteger(value) && value >= 1 && value <= 16;
  const roleValid = role => object(role) && Object.keys(role).every(key => ['provider', 'model', 'reasoningEffort'].includes(key) && typeof role[key] === 'string')
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
        { field: 'maxConcurrent', format: value => String(value ?? 3), parse: text => numberValid(Number(text)) ? { kind: 'set', value: Number(text) } : undefined },
        jsonField('roles', {}, rolesValid), jsonField('projects', [], projectsValid),
      ]);
      this.actions = this.form.actions();
      this.store = this.form.bind(() => ({
        ...this.form.shell(),
        enabled: JSON.parse(this.form.field('enabled').text),
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
    const normalize = path => {
      const value = path.replace(/\\/g, '/').replace(/\/+$/, '') || (path ? '/' : '');
      return /^[A-Za-z]:\//.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
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
      const offs = [ctx.remote.$on('llm/adapters-updated', load), ctx.remote.$on('settings/document-updated', load), ctx.on('connection/reset', load)];
      return () => { active = false; generation += 1; offs.forEach(off => off()); };
    }, [ctx, revision]);
    return { ...state, retry: () => retry(value => value + 1) };
  }

  const styles = {
    section: { display: 'grid', gap: 14, paddingBlock: 12 },
    row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
    input: { font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-background-l1, transparent)', border: '1px solid var(--dsw-alias-border-l2, #888)', borderRadius: 6, padding: '7px 9px', minWidth: 120, maxWidth: '100%' },
    role: { display: 'grid', gap: 10, paddingBlock: 12, borderTop: '1px solid var(--dsw-alias-border-l2, #888)' },
    label: { display: 'grid', gap: 6, flex: '1 1 140px' },
    hint: { margin: 0, opacity: 0.75, fontSize: 13 },
  };
  function button(label, onClick, disabled) { return h('button', { type: 'button', onClick, disabled, style: styles.input }, label); }
  function select(label, value, choices, onChange, disabled) {
    const options = choices.some(option => option.id === value) || !value ? choices : [...choices, { id: value, name: `${value}（当前不可用）` }];
    return h('label', { style: styles.label }, label, h('select', { value, disabled, style: styles.input, onChange: event => onChange(event.target.value) },
      options.map(option => h('option', { key: option.id, value: option.id }, option.name))));
  }
  function RoleEditor({ role, path, state, controller, catalog, disabled }) {
    const project = state.projects.find(row => samePath(row.path, path));
    const own = path === '' ? state.roles[role] : project?.roles?.[role];
    const value = { ...emptyRole(), ...state.roles[role], ...own };
    const update = patch => controller.setRole(role, { ...value, ...patch }, path);
    const group = catalog.groups.find(item => item.id === value.provider);
    const model = group?.models.find(item => item.id === value.model);
    const inherit = [{ id: '', name: '继承父智能体' }];
    return h('div', { style: styles.role },
      h('div', { style: styles.row }, h('strong', null, ROLES[role]),
        h('span', { style: styles.hint }, path && !own ? '继承全局角色设置' : '角色设置'),
        button(path ? '恢复全局继承' : '恢复父模型继承', () => controller.resetRole(role, path), disabled || (path !== '' && !own))),
      h('div', { style: styles.row },
        select('提供方', value.provider ?? '', [...inherit, ...catalog.groups.map(item => ({ id: item.id, name: item.name }))], provider => update({ provider, model: '', reasoningEffort: '' }), disabled || catalog.status !== 'ready'),
        select('模型', value.model ?? '', [...inherit, ...(group?.models ?? []).map(item => ({ id: item.id, name: item.name }))], modelId => update({ model: modelId, reasoningEffort: '' }), disabled || !group),
        select('推理强度', value.reasoningEffort ?? '', [{ id: '', name: '使用继承值或模型默认' }, ...(model?.reasoning?.efforts ?? [])], reasoningEffort => update({ reasoningEffort }), disabled || !model)));
  }

  function Card({ controller, ctx, useWorkspaces }) {
    const state = React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot);
    const workspaces = useWorkspaces(snapshot => snapshot);
    const [path, setPath] = React.useState('');
    const [query, setQuery] = React.useState('');
    React.useEffect(() => ctx.on('connection/reset', () => { controller.actions.discard(); setPath(''); }), [ctx, controller]);
    const catalog = useCatalog(ctx);
    const disabled = !state.writable || state.saving;
    const project = state.projects.find(row => samePath(row.path, path));
    const paths = new Map();
    for (const row of workspaces.items) paths.set(row.path, row.title || row.path);
    for (const row of state.projects) if (![...paths.keys()].some(value => samePath(value, row.path))) paths.set(row.path, `${row.path}（已保存）`);
    const filtered = [...paths].filter(([value, title]) => `${title} ${value}`.toLowerCase().includes(query.toLowerCase()));
    const heading = (text, children) => h('section', { style: styles.section }, h('h3', { style: { margin: 0 } }, text), children);
    return h(SettingsForm, {
      state,
      labels: { unavailable: 'AI Loop 插件未加载，暂时无法配置。', readOnly: '当前部署的插件设置为只读。', saveFailed: '保存失败或配置已在其他位置更新。请保留当前修改，或放弃后重新读取。', save: '保存', saving: '保存中…' },
      onSave: () => controller.actions.save(), onDiscard: controller.actions.discard,
    },
    heading('工作流', h(React.Fragment, null,
      h('label', { style: styles.row }, h('input', { type: 'checkbox', checked: state.enabled, disabled, onChange: event => controller.edit('enabled', event.target.checked) }), '启用 AI Loop 总开关'),
      h('p', { style: styles.hint }, '总开关与项目开关同时开启才生效；新项目默认停用。设置通过 DSH 原生配置表单保存。'))),
    heading('配置范围', h(React.Fragment, null,
      h('label', { style: styles.label }, '筛选工作区', h('input', { type: 'search', value: query, placeholder: '按名称或路径筛选', style: styles.input, onChange: event => setQuery(event.target.value) })),
      select('全局默认或项目覆盖', path, [{ id: '', name: '全局默认' }, ...filtered.map(([id, name]) => ({ id, name }))], setPath, state.saving),
      path ? h(React.Fragment, null,
        h('p', { style: { ...styles.hint, overflowWrap: 'anywhere' } }, path),
        h('label', { style: styles.row }, h('input', { type: 'checkbox', checked: project?.enabled ?? false, disabled, onChange: event => controller.updateProject(path, row => ({ ...row, enabled: event.target.checked })) }), '在此项目启用 AI Loop'),
        button('移除此项目覆盖并停用', () => controller.removeProject(path), disabled || !project)) : null,
      workspaces.phase !== 'ready' ? h('p', { role: 'status', style: styles.hint }, workspaces.error ? '工作区列表读取失败，已保存项目仍可配置。' : '正在读取工作区列表…') : null)),
    heading(path ? '项目并发与角色' : '全局并发与角色', h(React.Fragment, null,
      h('label', { style: styles.label }, path ? '并发上限（留空继承全局）' : '并发上限（1–16）',
        h('input', { type: 'number', min: 1, max: 16, value: path ? project?.maxConcurrent ?? '' : state.maxConcurrent, disabled, style: styles.input,
          onChange: event => {
            const text = event.target.value;
            if (!path) controller.actions.edit('maxConcurrent', text);
            else if (text === '' || numberValid(Number(text))) controller.updateProject(path, row => { const next = { ...row }; if (text === '') delete next.maxConcurrent; else next.maxConcurrent = Number(text); return next; });
          } })),
      state.invalid ? h('p', { role: 'alert' }, '并发上限须为 1–16 的整数；提供方和模型需成对选择。') : null,
      h('div', { style: styles.row }, h('p', { role: 'status', style: styles.hint }, catalog.status === 'loading' ? '正在读取模型…' : catalog.status === 'error' ? '模型目录读取失败，已保存选择仍会保留。' : catalog.partial ? '部分提供方暂不可用，已保存选择仍会保留。' : '模型与推理强度取自 DSH 当前提供方目录。'), button('刷新模型', catalog.retry, catalog.status === 'loading')),
      ...Object.keys(ROLES).map(role => h(RoleEditor, { key: `${path}:${role}`, role, path, state, controller, catalog, disabled })),
      h('p', { style: styles.hint }, '项目角色可恢复全局继承；显式选择“继承父智能体”可覆盖全局模型。模型切换仅影响后续创建的子智能体。'))),
    button('放弃本次修改', controller.actions.discard, state.saving || !state.dirty));
  }

  function apply(ctx) {
    const controller = new Controller(ctx.configForms.get(CONFIG_ID));
    ctx.effect(() => () => controller.dispose(), 'ai-loop: configuration form');
    ctx.effect(() => ctx.configForms.whileServed([CONFIG_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: PACKAGE,
    }, props => h(Card, { ...props, controller, ctx })))), 'ai-loop: plugin settings');
  }
  return { inject: ['slots', 'configForms', 'remote', 'remote.session'], apply, Controller, samePath, rolesValid, projectsValid };
}
