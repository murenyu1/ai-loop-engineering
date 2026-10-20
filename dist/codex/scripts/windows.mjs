import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, rootPath, safePath, atomicWrite, args, allowArgs, mainModule, printResult } from './lib.mjs';

const sandboxAccount = name => /\\CodexSandbox(?:Offline|Online)$/i.test(name || '');
export function assessOwners(data, options = {}) {
  const issues = [], warnings = [];
  const purpose = options.purpose || 'inspect';
  assert(['inspect', 'configure'].includes(purpose), 'Windows 预检 purpose 须为 inspect / configure');
  if (sandboxAccount(data.user)) (purpose === 'configure' ? issues : warnings).push({ type: 'sandbox-creator', action: '请在正常用户宿主进程执行配置写入，避免沙箱账户成为受保护目录所有者' });
  for (const item of data.paths) {
    if (item.error) issues.push({ type: 'acl-unreadable', path: item.path, detail: item.error });
    else if (item.exists && sandboxAccount(item.owner)) issues.push({ type: 'sandbox-owner', path: item.path, owner: item.owner, action: '先备份 ACL，再由宿主当前用户修复此目录自身的 owner；不递归重置 ACL' });
  }
  return { ...data, purpose, status: issues.length ? 'needs-repair' : 'ready', issues, warnings, sandbox_execution: 'unverified' };
}
const probe = String.raw`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
$who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$paths = @($env:AI_LOOP_PROJECT, (Join-Path $env:AI_LOOP_PROJECT '.codex'), (Join-Path $env:AI_LOOP_PROJECT '.agents'), (Join-Path $env:AI_LOOP_PROJECT '.git'), (Join-Path $env:AI_LOOP_USERHOME '.sandbox-bin'), (Join-Path $env:AI_LOOP_USERHOME 'agents'), (Join-Path $env:AI_LOOP_USERHOME 'plugins'), (Join-Path $env:AI_LOOP_USERHOME 'plugins/local'))
$items = foreach ($target in $paths) {
  if (Test-Path -LiteralPath $target) {
    try { $acl = [System.IO.Directory]::GetAccessControl($target); @{path=$target; exists=$true; owner=$acl.Owner; protected=$acl.AreAccessRulesProtected} }
    catch { @{path=$target; exists=$true; error=$_.Exception.Message} }
  } else { @{path=$target; exists=$false} }
}
@{user=$who; paths=@($items)} | ConvertTo-Json -Depth 5 -Compress
`;
function runPS(code, env) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
  assert(result.status === 0, 'Windows 权限检查/修复失败：' + (result.error?.message || result.stderr?.trim() || result.status));
  return result.stdout.trim();
}
export function inspectWindows(project, options = {}) {
  const root = rootPath(project);
  if (process.platform !== 'win32') return { status: 'not-windows', issues: [], sandbox_execution: 'unverified' };
  for (const relative of ['.codex', '.agents', '.git']) safePath(root, relative);
  const home = path.resolve(options.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  for (const relative of ['.sandbox-bin', 'agents', 'plugins', 'plugins/local']) safePath(home, relative);
  return assessOwners(JSON.parse(runPS(probe, { AI_LOOP_PROJECT: root, AI_LOOP_USERHOME: home })), options);
}
export function repairOwner(project, target, options = {}) {
  assert(process.platform === 'win32', '所有者修复仅适用于 Windows');
  const root = rootPath(project), info = inspectWindows(root, options);
  assert(!sandboxAccount(info.user), '不能在沙箱账户中修复所有者；请由正常用户宿主进程执行');
  const absolute = path.resolve(target);
  const known = info.paths.find(item => path.resolve(item.path).toLowerCase() === absolute.toLowerCase());
  assert(known && known.exists && !known.error && sandboxAccount(known.owner), '仅修复检查中明确发现由沙箱账户拥有的已知目录，不推测或扩大范围');
  assert(!fs.lstatSync(absolute).isSymbolicLink(), '目标不能是链接');
  if (!options.apply) return { status: 'dry-run', target: absolute, old_owner: known.owner, new_owner: info.user, recursion: false, dacl: 'preserved' };
  const backup = safePath(root, `.ai-loop/permissions/owner-${Date.now()}.json`);
  const code = String.raw`
$ErrorActionPreference = 'Stop'
$acl = [System.IO.Directory]::GetAccessControl($env:AI_LOOP_TARGET)
$who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($who -match '\\CodexSandbox(Offline|Online)$' -or $acl.Owner -ne $env:AI_LOOP_EXPECTED_OWNER) { throw '账户或所有者已变化，停止修复' }
@{path=$env:AI_LOOP_TARGET; owner=$acl.Owner; sddl=$acl.Sddl; new_owner=$who} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:AI_LOOP_BACKUP -Encoding UTF8
& icacls.exe $env:AI_LOOP_TARGET /setowner $who
if ($LASTEXITCODE -ne 0) { throw '仅修改所有者失败；可能需要管理员授权，未重置 ACL' }
`;
  atomicWrite(backup, '');
  runPS(code, { AI_LOOP_TARGET: absolute, AI_LOOP_BACKUP: backup, AI_LOOP_EXPECTED_OWNER: known.owner });
  const after = inspectWindows(root, options);
  assert(after.paths.find(item => path.resolve(item.path).toLowerCase() === absolute.toLowerCase())?.owner === info.user, '修复后所有者未符合预期');
  return { status: 'owner-repaired', target: absolute, backup, after, sandbox_execution: 'unverified', next: '重新执行一条普通沙箱命令验证；所有者检查不能证明完整沙箱可用' };
}
export function cli(argv) {
  const options = args(argv);
  allowArgs(options, ['project', 'target', 'apply', 'help']);
  const [command] = options._;
  assert(options._.length <= 1 && (options.apply === undefined || options.apply === true), '参数无效');
  if (options.help) return { usage: 'windows.mjs inspect|repair --project ROOT [--target EXACT_DIRECTORY] [--apply]' };
  if (command === 'inspect') return inspectWindows(options.project);
  assert(command === 'repair' && typeof options.target === 'string', '修复需显式指定 repair --target EXACT_DIRECTORY');
  return repairOwner(options.project, options.target, options);
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
