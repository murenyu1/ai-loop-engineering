import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUNDLE, assert, safePath, args, allowArgs, mainModule, printResult } from './lib.mjs';

const directories = ['core', 'adapters/project', 'scripts', 'tests', 'plugins/codex', 'dist/codex'];
const files = ['.gitignore', '.gitattributes', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'SETUP.md', 'CHANGES.md'];
const extensions = /\.(?:md|mjs|js|json|yaml|yml|toml|ps1|html|css)$/;
export function publishFiles() {
  const selected = new Set(files.filter(relative => fs.existsSync(safePath(BUNDLE, relative))));
  function walk(relative) {
    const target = safePath(BUNDLE, relative), stat = fs.lstatSync(target);
    assert(!stat.isSymbolicLink(), '发行文件不能包含链接：' + relative);
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) walk(relative + '/' + name);
    else {
      assert(stat.isFile() && extensions.test(relative) && !/(?:^|\/)(?:\.env[^/]*|node_modules|history|reports|\.ai-loop|\.validation)(?:\/|$)/.test(relative), '非发行文件，停止上传：' + relative);
      selected.add(relative);
    }
  }
  for (const directory of directories) if (fs.existsSync(safePath(BUNDLE, directory))) walk(directory);
  // 仅发行时映射市场元数据，不在当前源包工作区创建受保护 .agents 目录。
  const mapping = new Map([...selected].map(relative => [relative, relative]));
  mapping.set('.agents/plugins/marketplace.json', 'plugins/codex/marketplace.json');
  for(const name of ['ai-loop-workflow-4.2.0.zip','ai-loop-codex-4.2.0.zip','SHA256SUMS']) {
    const relative='downloads/'+name;
    if(fs.existsSync(safePath(BUNDLE,relative))) mapping.set(relative,relative);
  }
  return [...mapping].sort(([a], [b]) => a.localeCompare(b)).map(([relative, source]) => {
    const bytes = fs.readFileSync(safePath(BUNDLE, source));
    const binary=relative.endsWith('.zip');
    const content = binary ? bytes.toString('base64') : new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    const data = binary ? bytes : Buffer.from(content);
    const sha = crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    return { path: relative, mode: '100644', type: 'blob', sha, content, encoding:binary?'base64':'utf-8' };
  });
}
export function cli(argv) {
  const options = args(argv); allowArgs(options, ['batch', 'limit', 'list', 'help']);
  assert(!options._.length, '不接受位置参数');
  if (options.help) return { usage: 'publish-files.mjs [--list | --batch N --limit N]', note: '只生成安全发行清单，不联网、不提交。排除个人配置、运行资料、日志和缓存；GitHub 提交由已授权的上传工具执行。' };
  const entries = publishFiles();
  if (options.list) return entries.map(({ content, ...item }) => item);
  const batch = Number(options.batch || 0), limit = Number(options.limit || 5);
  assert(Number.isInteger(batch) && batch >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 20, '发行批次无效');
  return { total: entries.length, entries: entries.slice(batch * limit, (batch + 1) * limit) };
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
