import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BUNDLE, ID, safePath, jsonFile, mainModule } from './lib.mjs';
import { listWorkspaces } from './workspaces.mjs';
import { resolveProfile } from './profiles.mjs';
import { roleEnabled } from './routing.mjs';

// 钩子只读已启用工作区的短状态；工作区列表由设置页直接读取 Codex 本机项目。
export function startupContext(input, options = {}) {
  if (!input || input.hook_event_name !== 'SessionStart' || typeof input.cwd !== 'string') return null;
  const home = options.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const workspaces = listWorkspaces(home);
  const exact = workspaces.find(item => item.root === input.cwd && item.exists);
  if (!exact) return null;
  if (!exact.enabled) return null;
  const workspace = exact;
  const root = workspace.root, runs = safePath(root, '.ai-loop/runs');
  const active = [];
  if (fs.existsSync(runs)) {
    const names = fs.readdirSync(runs).filter(name => ID.test(name));
    // 大量运行交给分页工具按需处理，启动入口不加载全部历史。
    if (names.length <= 30) for (const name of names) {
      const state = safePath(root, `.ai-loop/runs/${name}/state.json`);
      if (fs.existsSync(state) && jsonFile(state).status === 'active') active.push(name);
    }
  }
  const bundle = options.bundle || BUNDLE;
  const profile = resolveProfile(root, { home }).profile;
  const enabledRoles = profile ? Object.keys(profile.roles).filter(role => roleEnabled(profile.roles[role])) : [];
  const context = [
    '本工作区已由用户在 AI Loop 管理面板启用自动入口。',
    enabledRoles.length ? `已开启角色：${enabledRoles.join('、')}。每次派发前重新核对有效配置，其他角色不调用。` : '五个子代理当前全部关闭；由主代理完成必要工作，不自动选择模型或替代子代理。独立评审要求保留待复核。',
    `精确工作区：${JSON.stringify(root)}。插件根：${JSON.stringify(bundle)}。`,
    typeof input.session_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input.session_id)
      ? `AI_LOOP_CHAT_CONTEXT=${JSON.stringify({ root, session: input.session_id })}。这是本次 SessionStart 提供的真实父聊天标识。登记本聊天子代理时 context.parent_id 使用此 session；子代理 context.id/native_id 使用实际返回值。用户要求打开本聊天看板时，将此 root/session 原样传给 ai_loop.dashboard；缺少此上下文不得猜测或沿用其他聊天标识。`
      : '当前钩子未提供有效聊天标识；不可推断聊天归属，看板仅按工作区选择运行。',
    `处理项目开发、继续、验证请求时，使用 ${JSON.stringify(path.join(bundle,'skills/ai-loop/SKILL.md'))}；先读取项目规则与 .ai-loop/memory/index.md，再用插件 scripts/memory.mjs bootstrap --project ROOT 按需恢复。`,
    active.length ? `发现活跃运行：${active.map(name=>JSON.stringify(name)).join('、')}。唯一运行仅帮助定位，多个候选先澄清。` : '先用 bootstrap 查看运行状态，不为普通问答新建开发任务。',
    '用户下一条命令决定工作范围；读取必要交接、未关闭工作单元与改动位置，核对实际文件，不全量扫描代码。未落盘讨论无法恢复，历史验证不能当作当前通过。',
    '遵守项目权限；deny 立即停止。修改 settings.json 前取得明确允许。发现任务不等于执行授权，不自动提交或发布。',
  ].join('\n');
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
}
export async function cli() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text)>65536) throw new Error('钩子输入过大');
  }
  const output = startupContext(JSON.parse(text));
  if (output) console.log(JSON.stringify(output));
}
if (mainModule(import.meta.url)) cli().catch(error => { console.error('AI Loop 启动入口未加载：'+error.message); process.exitCode=1; });
