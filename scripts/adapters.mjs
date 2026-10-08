import { assert } from './lib.mjs';

export const ADAPTERS = {
  codex: { home: '.codex/ai-loop', entry: '.codex/ai-loop/AGENTS.md', config: '.codex/config.toml', loader: 'developer-instructions', conditions: ['项目受信任；核对有效 developer_instructions，重开会话确认加载'] },
  'claude-code': { home: '.claude/ai-loop', entry: '.claude/rules/ai-loop.md', loader: 'project-rule', conditions: ['project 指令来源和项目 rules 未被禁用或排除'] },
  cursor: { home: '.cursor/ai-loop', entry: '.cursor/rules/ai-loop.mdc', loader: 'always-rule', conditions: ['当前 Cursor 版本支持项目 .mdc 规则；检查 alwaysApply'] },
  pi: { home: '.pi/ai-loop', entry: '.pi/APPEND_SYSTEM.md', loader: 'append-system', conditions: ['项目资源已获信任；/reload 或新会话确认 APPEND_SYSTEM 加载；核对个人同名文件的覆盖关系'] },
  dsh: { home: '.dsh/ai-loop', entry: '.dsh/ai-loop/ENTRY.md', loader: 'explicit', conditions: ['此目录只存工作流部署；DSH 原生项目注入尚未验证，必须显式读取入口'] },
};

export function selectHarness(requested, env = process.env) {
  const aliases = { claude: 'claude-code', 'claude_code': 'claude-code' };
  if (requested && requested !== 'auto') return aliases[requested] || requested;
  if (env.AI_LOOP_HARNESS) return aliases[env.AI_LOOP_HARNESS] || env.AI_LOOP_HARNESS;
  const hints = [
    [env.CODEX_THREAD_ID, 'codex'],
    [env.CLAUDECODE === '1', 'claude-code'],
    [env.CURSOR_AGENT === '1', 'cursor'],
  ].filter(([present]) => present).map(([, name]) => name);
  assert(hints.length === 1, '无法唯一识别当前 harness；请由 AI 根据用户指定及会话信息传入 --harness，不根据已有目录猜测');
  return hints[0];
}

export function adapterFor(harness, entry) {
  if (Object.hasOwn(ADAPTERS, harness)) {
    assert(!entry, '--entry 仅用于 generic');
    return { ...ADAPTERS[harness], key: harness, harness };
  }
  assert(harness === 'generic', '不支持的 harness；先核对官方加载方式，或使用 generic 显式入口');
  assert(typeof entry === 'string' && entry.endsWith('.md'), 'generic 需要 --entry 项目子目录中的 Markdown 入口');
  const parts = entry.split('/');
  const namespace = parts[0];
  assert(parts.length >= 2 && /^\.[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(namespace), 'generic 入口须位于明确的工具子目录，如 .mytool/rules/ai-loop.md');
  assert(!['.git', '.ai-loop', '.agents', '.codex', '.claude', '.cursor', '.pi', '.dsh'].includes(namespace), 'generic 不能占用已知平台或共享元数据目录');
  const home = namespace + '/ai-loop';
  return { key: 'generic:' + namespace.slice(1), harness: namespace.slice(1), home, entry, loader: 'explicit', conditions: ['入口加载机制由当前工具核对；默认显式读取，不宣称自动加载'] };
}

const tick = String.fromCharCode(96);
const code = value => tick + value + tick;

export function entryInstructions(adapter) {
  return [
    '## AI Loop Engineering',
    '',
    '- 本入口仅适用于 ' + code(adapter.harness) + '；当前会话不是该工具时，不沿此入口加载工作流。',
    '- 部署目录（相对项目根）：' + code(adapter.home) + '。仅使用当前 harness 的部署，不读取其他平台副本。',
    '- 新会话首次处理项目相关请求，运行 ' + code(adapter.home + '/scripts/memory.mjs bootstrap --project 项目根') + ' 并读取共享 ' + code('.ai-loop/memory/index.md') + '；已读且未变化时复用。',
    '- 开始开发时按阶段读取 ' + code(adapter.home + '/WORKFLOW.md') + '，需要角色时仅读取该部署的对应角色。',
    '- 当前会话已读取同版本流程和当前角色时复用上下文；版本、阶段或任务变化后按需重读，不重复回灌正文和历史。',
    '- 项目根 AGENTS.md / CLAUDE.md 等保存项目规范；用户要求、项目规范及平台权限优先。命中 deny 立即停止，不换工具或平台绕过。',
    '- 继续请求用 bootstrap --intent continue 定位任务；多个候选先澄清。再用 ' + code(adapter.home + '/scripts/loop.mjs') + ' 的 status、session.md 和必要资料核对，交接过期先更新；新需求使用新 run_id，不恢复已关闭运行。',
    '- 确认重要需求或决策后立即记事件；阶段成果、阻塞、交付、换聊天或压缩前按需用本部署 memory.mjs checkpoint / save 整理交接与共享知识。',
    '- 运行资料在项目 ' + code('.ai-loop/') + '；安装不接管 /init。脚本接口按需读 ' + code(adapter.home + '/scripts/README.md') + '。',
    '- 从源码包升级并预演；不直接编辑部署文件或计数。未执行检查不称通过，同代理复查标为 self。',
  ].join('\n');
}

export function codexBootstrap(adapter) {
  return 'AI Loop Engineering 入口：新会话首次处理项目相关请求时读取项目相对路径 ' + code(adapter.entry) + '。仅在当前会话未读取该入口或入口已更新时读取；已有项目规范和用户批准范围优先。不要读取其他 harness 的 AI Loop 部署。';
}
