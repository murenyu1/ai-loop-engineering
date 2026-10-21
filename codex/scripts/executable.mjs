import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { assert } from '../../scripts/lib.mjs';
export function codexExecutable() {
  if (process.env.AI_LOOP_CODEX_CLI) {
    const executable = path.resolve(process.env.AI_LOOP_CODEX_CLI);
    assert(fs.existsSync(executable) && fs.statSync(executable).isFile(), 'AI_LOOP_CODEX_CLI 指定的程序不存在');
    return executable;
  }
  if (process.platform !== 'win32') return 'codex';
  const found = spawnSync('where.exe', ['codex'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const first = found.stdout?.trim().split(/\r?\n/).find(item => item.toLowerCase().endsWith('.exe'));
  if (first) return first;
  const bin = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'OpenAI/Codex/bin');
  if (!fs.existsSync(bin)) return 'codex';
  const candidates = fs.readdirSync(bin).map(name => path.join(bin, name, 'codex.exe')).filter(item => fs.existsSync(item) && fs.statSync(item).isFile());
  candidates.sort((a,b) => fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  return candidates[0] || 'codex';
}
