import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BUNDLE, mainModule, printResult } from './lib.mjs';

// 只读，不 fetch、不切分支、不修改 index，也不输出用户配置或凭据。
export function devStatus(root = BUNDLE) {
  const raw = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const git = (...args) => raw(...args).trim();
  let branch;
  try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); }
  catch { return { status: 'unavailable', reason: 'Git 不可用、仓库没有提交或当前目录不是 Git 仓库；请检查实际环境。', handoff: 'docs/development/README.md' }; }
  const commit = git('rev-parse', 'HEAD');
  const changes = [];
  const entries = raw('status', '--porcelain=v1', '-z', '--untracked-files=normal').split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const item = { status: entry.slice(0, 2), path: entry.slice(3) };
    if (/[RC]/.test(item.status)) item.previous_path = entries[++i];
    changes.push(item);
  }
  let upstream = null, divergence = null;
  try { upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'); }
  catch { /* 独立本地分支没有上游；不能解释为已同步。 */ }
  if (upstream) {
    const [ahead, behind] = git('rev-list', '--left-right', '--count', `HEAD...${upstream}`).split(/\s+/).map(Number);
    divergence = { ahead, behind, source: 'local-refs-only' };
  }
  return { status: 'local', branch, commit, upstream, divergence, changes, history: git('log', '-6', '--format=%h %s').split('\n'), handoff: 'docs/development/README.md', handoff_exists: fs.existsSync(`${root}/docs/development/README.md`), warning: '只反映本机 Git，不证明远端已同步、测试已通过或安装副本已更新。' };
}
if (mainModule(import.meta.url)) printResult(() => devStatus());
