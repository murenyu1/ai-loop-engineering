#!/usr/bin/env node
'use strict';

/**
 * 可选的 Claude Code / Cursor Write、Edit 前置路径检查，需手动注册。
 * 只允许真实项目根下 test-reports/ 或 .ai-loop/runs/<run_id>/reports/ 的文件。
 * 合法输入静默退出 0，保留平台权限检查；异常或越界输出拒绝 JSON，退出 2。
 * 这不是文件系统沙箱：不保护 Bash 等其他工具，也不能消除检查后的路径竞态。
 */
const fs = require('node:fs');
const path = require('node:path');

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function deny(reason) {
  return { allowed: false, reason };
}

function realDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label} 必须是明确的绝对目录路径`);
  }
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) throw new Error(`${label} 不是目录`);
  return root;
}

// 未创建的报告目录也可验证：解析最近的真实祖先，再拼接不存在的部分。
function resolveRealPath(target) {
  let parent = target;
  const missing = [];
  while (true) {
    let stat;
    try {
      stat = fs.lstatSync(parent);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      missing.unshift(path.basename(parent));
      parent = next;
      continue;
    }
    // realpath 会拒绝 dangling symlink；符号链接的实际落点仍需通过目录边界检查。
    const real = fs.realpathSync(parent);
    const realStat = stat.isSymbolicLink() ? fs.statSync(real) : stat;
    if (missing.length && !realStat.isDirectory()) {
      throw new Error('报告路径的父路径不是目录');
    }
    if (!missing.length && !realStat.isFile()) {
      throw new Error('报告路径必须指向普通文件，不能指向目录或特殊文件');
    }
    return path.resolve(real, ...missing);
  }
}

function checkReportPath(input, env = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return deny('hook 输入必须是 JSON 对象');
  }
  if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') {
    return deny('本 hook 仅检查 Write/Edit，不支持该工具；不能用它保护 Bash 或其他工具');
  }
  const filePath = input.tool_input && input.tool_input.file_path;
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return deny('缺少有效的 tool_input.file_path');
  }
  // 不能先消掉 .. 再检查：symlink/../ 的实际文件系统落点可能与 path.resolve 不同。
  if (filePath.split(/[\\/]/).includes('..')) {
    return deny('报告路径不能包含父目录穿越片段 ..');
  }
  const basename = path.basename(filePath);
  if (/[\\/]$/.test(filePath) || basename === '.' || basename === '..') {
    return deny('报告路径必须包含文件名，不能指向目录');
  }
  try {
    const roots = [];
    if (env.CLAUDE_PROJECT_DIR !== undefined && env.CLAUDE_PROJECT_DIR !== '') {
      roots.push(realDirectory(env.CLAUDE_PROJECT_DIR, 'CLAUDE_PROJECT_DIR'));
    }
    if (input.cwd !== undefined) roots.push(realDirectory(input.cwd, 'cwd'));
    if (!roots.length) return deny('缺少项目根目录；必须提供 CLAUDE_PROJECT_DIR 或 cwd');
    if (roots.some((root) => root !== roots[0])) {
      return deny('CLAUDE_PROJECT_DIR 与 cwd 指向不同真实目录，项目根存在歧义');
    }
    const root = roots[0];
    const target = resolveRealPath(path.resolve(root, filePath));
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return deny('报告路径不在当前真实项目根目录内');
    }
    const parts = relative.split(path.sep);
    const legacyReport = parts[0] === 'test-reports' && parts.length >= 2;
    const runReport = parts[0] === '.ai-loop' && parts[1] === 'runs'
      && RUN_ID.test(parts[2] || '') && parts[3] === 'reports' && parts.length >= 5;
    if (!legacyReport && !runReport) {
      return deny('只允许写当前项目 test-reports/ 或 .ai-loop/runs/<合法 run_id>/reports/ 内的报告文件');
    }
    return { allowed: true };
  } catch (error) {
    return deny(`无法验证报告真实路径，已拒绝：${error.message}`);
  }
}

function evaluateHook(raw, env = {}) {
  try {
    return checkReportPath(JSON.parse(raw), env);
  } catch (error) {
    return deny(`hook JSON 输入无效，已拒绝：${error.message}`);
  }
}

function rejectionOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function runHook(runtime = process) {
  return new Promise((resolve) => {
    let raw = '';
    let responded = false;
    function finish(result) {
      if (responded) return;
      responded = true;
      if (!result.allowed) {
        runtime.exitCode = 2;
        runtime.stdout.write(`${JSON.stringify(rejectionOutput(result.reason))}\n`);
      }
      resolve(result);
    }
    runtime.stdin.setEncoding('utf8');
    runtime.stdin.on('data', (chunk) => { raw += chunk; });
    runtime.stdin.on('error', (error) => finish(deny(`读取 hook 输入失败，已拒绝：${error.message}`)));
    runtime.stdin.on('end', () => finish(evaluateHook(raw, runtime.env)));
  });
}

module.exports = { checkReportPath, evaluateHook, rejectionOutput, runHook };
if (require.main === module) runHook();
