import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { install } from './install.mjs';
import { installed } from './models.mjs';
import { capabilities, selectHarness } from './adapters.mjs';
import { assert, safePath, args, allowArgs, mainModule, codexExecutable, VERSION } from './lib.mjs';
import { inspectWindows } from './windows.mjs';

export function diagnose(options) {
  const harness = selectHarness(options.harness);
  const { root, manifest, record } = installed(options.project, harness);
  const issues = [];
  let integrity = 'unverified';
  if (!record) issues.push('当前 harness 尚未安装');
  else {
    try {
      install({ project: root, bundle: safePath(root, manifest.source), harness,
        ...(record.key.startsWith('generic:') ? { harness: 'generic', entry: record.entry } : {}), check: true, ...(options.env ? { env: options.env } : {}) });
      integrity = 'pass';
    } catch (error) { integrity = 'fail'; issues.push(error.message); }
  }
  if (!record?.model_routing) issues.push('未启用原生模型分工；角色 Markdown 不能证明原生代理已注册');
  const env = options.env || process.env;
  if (harness === 'claude-code') {
    if (env.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL)) issues.push('使用第三方兼容服务；opus/sonnet 等别名可能映射相同后端，不能据此证明多模型分工');
    if (env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === '1') issues.push('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 会强制模型；先让用户处理该覆盖，再派发');
    if (env.CLAUDE_CODE_EFFORT_LEVEL) issues.push('CLAUDE_CODE_EFFORT_LEVEL 会覆盖角色 effort；实际值必须核对');
    if (env.CLAUDE_CODE_SUBAGENT_MODEL) issues.push('存在 CLAUDE_CODE_SUBAGENT_MODEL；覆盖顺序与版本有关，请核对原生实际模型');
  }
  let runtime = null;
  if (options.probe) {
    assert(['codex', 'claude-code'].includes(harness), '版本探测仅支持 codex / claude-code');
    const name = harness === 'codex' ? codexExecutable() : 'claude';
    const child = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false });
    runtime = { executable: name, exit_code: child.status, version_output: child.stdout?.trim() || null, error: child.error?.message || child.stderr?.trim() || null };
    if (child.status !== 0) issues.push('CLI 版本探测失败；不能据此宣称该客户端可运行');
  }
  const windows = inspectWindows(root);
  if (windows.issues.length) issues.push('Windows 所有者/访问权限预检未通过，先处理 windows.issues；不修改沙箱策略');
  return { harness, capabilities: capabilities(harness), configuration: integrity, runtime, issues, windows,
    native_discovery: 'unverified', execution: 'unverified', effective_model: 'unverified', ui_visibility: 'unverified',
    acceptance: harness === 'codex' ? [
      '受信任项目中新开会话，确认发现 loop-* 自定义代理及 ai-loop 技能；项目配置、profile 与启动参数均须核对',
      '明确要求 loop-dev 完成只读小任务；记录真实代理 ID 与原生调用结果',
      '在子代理面板或 CLI /subagents 查看运行状态；从原生记录核对模型与强度',
    ] : harness === 'claude-code' ? [
      '新会话运行 /agents 确认发现 loop-*；已有 agents 目录的改动可自动检测，首次创建等情况需重开',
      '用 Agent/Task 等实际提供的原生工具选择 loop-dev 执行只读小任务，不误用 Bash 启动 CLI 冒充原生子代理',
      '/tasks 查看子代理状态、模型与强度；任务完成后条目可能短暂保留，以原生 transcript 留证',
      '核对当前版本是否支持 effort；未知字段可能被忽略，文件检查不能证明生效',
      '用 claude auth status --text 核对实际 provider；第三方服务须核对不同角色别名是否映射不同后端',
    ] : ['该适配器只配置工作流入口；原生子代理、模型和 UI 需要产品级适配后另验'],
    note: '本工具检查配置与可选 CLI 版本，不调用模型、不修改信任/权限、不证明原生加载或界面显示。',
  };
}
export async function inspectNative(project, harness) {
  const { root } = installed(project, harness);
  if (harness === 'claude-code') {
    const result = spawnSync('claude', ['auth', 'status', '--text'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false });
    const address = /^Anthropic base URL:\s*(\S+)/mi.exec(result.stdout || '')?.[1];
    let origin = null;
    try { if (address) origin = new URL(address).origin; } catch { /* 不输出未知原始认证文本 */ }
    return { exit_code: result.status, provider_origin: origin, third_party_provider: origin ? origin !== 'https://api.anthropic.com' : 'unknown',
      native_discovery: 'unverified', effective_model: 'unverified',
      note: '只读认证方式/provider 诊断，不输出凭据；不能仅凭别名证明不同后端模型。' };
  }
  assert(harness === 'codex', '本地原生协议检查仅支持 codex / claude-code');
  const child = spawn(codexExecutable(), ['--strict-config', 'app-server', '--stdio'], { cwd: root, windowsHide: true, shell: false });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  let failure = null;
  // 不持久化全量 config/read 或 stderr，避免导出个人 provider 配置/凭据。
  child.stderr.resume();
  child.on('error', error => {
    failure = error;
    for (const finish of pending.values()) finish({ error: { message: error.message } });
    pending.clear();
  });
  child.stdin.on('error', () => {});
  lines.on('line', line => {
    try { const value = JSON.parse(line); if (value.id && pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } } catch { /* 仅处理协议 JSON */ }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')); }, 15000);
    pending.set(id, value => { clearTimeout(timeout); resolve(value); });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    const init = await request('initialize', { clientInfo: { name: 'ai_loop_doctor', version: VERSION }, capabilities: { experimentalApi: true } });
    assert(!init.error, '原生协议初始化失败：' + (init.error?.message || 'unknown'));
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const config = await request('config/read', { cwd: root, includeLayers: true });
    assert(!config.error, '原生配置读取失败：' + (config.error?.message || 'unknown'));
    const layers = config.result?.layers?.map(layer => ({ name: layer.name, disabledReason: layer.disabledReason ?? layer.disabled_reason ?? null })) || [];
    const blocked = layers.filter(layer => layer.name?.type === 'project' && layer.disabledReason);
    const skills = await request('skills/list', { cwds: [root], forceReload: true });
    const models = await request('model/list', { limit: 100 });
    return { project_config: blocked.length ? 'disabled' : 'inspect-layers', dispatch_blocked: blocked.length > 0,
      config_model: config.result?.config?.model || null, config_effort: config.result?.config?.model_reasoning_effort || null, layers,
      ai_loop_skill: skills.result?.data?.flatMap(item => item.skills || []).filter(skill => ['ai-loop', 'ai-loop-models'].includes(skill.name) || skill.name?.startsWith('ai-loop-engineering:')).map(skill => ({ name: skill.name, path: skill.path, enabled: skill.enabled })) || [],
      skills_error: skills.error || null, native_agents: 'unverified', effective_model: 'unverified',
      models: models.result?.data?.map(item => ({ id: item.model || item.id, name: item.displayName || item.display_name, efforts: item.supportedReasoningEfforts || item.supported_reasoning_efforts || [], default_effort: item.defaultReasoningEffort || item.default_reasoning_effort })) || [], models_error: models.error || null, models_next_cursor: models.result?.nextCursor || null,
      note: '只读本地配置与技能发现；不授予项目信任，不调用模型，不证明子代理启动或 UI。config_model 是有效配置值，不是实际推理证据。' };
  } finally { lines.close(); child.kill(); }
}
export async function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'harness', 'probe', 'native', 'help']);
  assert(!options._.length && [options.probe, options.native].every(value => value === undefined || value === true), '参数无效');
  if (options.help) return { usage: 'doctor.mjs --project ROOT --harness codex|claude-code [--probe] [--native]' };
  const report = diagnose(options);
  report.dispatch = report.configuration === 'pass' ? 'requires-native-verification' : 'blocked';
  if (options.native) {
    try {
      report.native = await inspectNative(options.project, report.harness);
      if (report.native.dispatch_blocked) {
        report.dispatch = 'blocked';
        report.issues.push('原生客户端禁用了项目配置；查看 native.layers 中的 disabledReason，先由用户处理信任/配置来源问题，不派发');
      }
      if (report.native.third_party_provider === true) report.issues.push('原生 CLI 当前使用第三方兼容服务；多模型路由与强度须取得该服务的真实运行证据');
    }
    catch (error) { report.native = { error: error.message, status: 'unverified' }; }
  }
  return report;
}
if (mainModule(import.meta.url)) {
  try { console.log(JSON.stringify(await cli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`操作停止：${error.message}`); process.exitCode = 1; }
}
