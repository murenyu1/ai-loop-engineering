#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');

const [,, action, target] = process.argv;

function runGit(args) {
  const res = spawnSync('git', args, {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function showHelp() {
  console.log(`
AI Loop 多环境并行工作树 (Git Worktree) 管理工具

用法:
  node scripts/worktree.mjs list
      列出当前已挂载的所有工作树

  node scripts/worktree.mjs add <dsh|codex|custom_name> [branch]
      在工作区根目录下创建隔离的工作树，如:
      - node scripts/worktree.mjs add dsh (默认绑定 dev/dsh)
      - node scripts/worktree.mjs add codex (默认绑定 dev/codex)

  node scripts/worktree.mjs remove <dsh|codex|custom_name>
      安全卸载并移除指定的工作树目录
`);
}

if (!action || action === 'help' || action === '--help') {
  showHelp();
  process.exit(0);
}

if (action === 'list') {
  console.log('--- 当前活跃的 Git Worktrees ---');
  runGit(['worktree', 'list']);
} else if (action === 'add') {
  if (!target) {
    console.error('错误: 请指定工作树目标标识（如 dsh 或 codex）');
    process.exit(1);
  }
  const treeDir = path.resolve(WORKSPACE_ROOT, `ai-loop-engineering-${target}`);
  const branch = process.argv[4] || (target === 'dsh' ? 'dev/dsh' : (target === 'codex' ? 'dev/codex' : `feature/${target}`));

  console.log(`[Worktree] 正在创建工作树: ${treeDir} -> 分支 [${branch}]`);
  if (fs.existsSync(treeDir)) {
    console.log(`[提示] 目标目录 ${treeDir} 已存在，跳过创建。`);
  } else {
    runGit(['worktree', 'add', treeDir, branch]);
    console.log(`\n[成功] 已创建独立环境工作树！`);
    console.log(`您现在可以让 ${target.toUpperCase()} 直接打开并工作在目录:\n  ${treeDir}\n`);
  }
} else if (action === 'remove') {
  if (!target) {
    console.error('错误: 请指定要移除的工作树标识（如 dsh 或 codex）');
    process.exit(1);
  }
  const treeDir = path.resolve(WORKSPACE_ROOT, `ai-loop-engineering-${target}`);
  console.log(`[Worktree] 正在安全卸载工作树: ${treeDir}`);
  runGit(['worktree', 'remove', '--force', treeDir]);
  console.log(`[成功] 工作树已移除。`);
} else {
  showHelp();
  process.exit(1);
}
