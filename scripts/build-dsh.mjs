import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BUNDLE, VERSION, assert, safePath, atomicWrite, args, allowArgs, mainModule, printResult } from './lib.mjs';
import { buildDshClient } from './build-dsh-client.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function collect(directory, prefix = '') {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const file = prefix ? prefix + '/' + name : name;
    const target = safePath(directory, name), stat = fs.lstatSync(target);
    assert(!stat.isSymbolicLink(), 'DSH 包不允许符号链接：' + file);
    if (stat.isDirectory()) entries.push(...collect(target, file));
    else {
      assert(stat.isFile(), 'DSH 包只允许普通文件：' + file);
      entries.push([file, fs.readFileSync(target)]);
    }
  }
  return entries;
}

export function buildDsh(output = 'dist/dsh', options = {}) {
  assert(output === 'dist/dsh' || output.startsWith('.release/'), '输出仅允许 dist/dsh 或 .release/ 下的验证目录');
  const target = safePath(BUNDLE, output);
  const source = safePath(BUNDLE, 'plugins/dsh');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  assert(manifest.version === VERSION, 'DSH 插件版本与核心不一致');
  const planned = new Map();
  for (const file of ['package.json', 'cordis.patch.yml', 'index.mjs', 'config.mjs', 'README.md', 'ROUTING.md']) {
    planned.set(file, fs.readFileSync(safePath(source, file)));
  }
  for (const [file, bytes] of collect(safePath(source, 'skills'))) planned.set('skills/' + file, bytes);
  for (const [file, bytes] of collect(safePath(BUNDLE, 'core'))) planned.set('core/' + file, bytes);
  planned.set('client.js', Buffer.from(buildDshClient()));
  const lock = { version: VERSION, harness: 'dsh', files: [...planned].map(([file, bytes]) => ({ path: file, hash: digest(bytes) })).sort((a, b) => a.path.localeCompare(b.path)) };
  planned.set('bundle.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n'));
  const lockPath = path.join(target, 'bundle.json');
  const previous = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
  if (fs.existsSync(target)) {
    const owned = new Set(['bundle.json', ...(previous?.files || []).map(item => item.path)]);
    assert(previous || fs.readdirSync(target).length === 0, 'DSH 输出目录已有未登记文件，停止覆盖');
    for (const [file] of collect(target)) assert(owned.has(file), 'DSH 输出含未登记文件，停止打包：' + file);
    for (const item of previous?.files || []) {
      const file = safePath(target, item.path);
      assert(fs.existsSync(file) && digest(fs.readFileSync(file)) === item.hash, '旧 DSH 产物被修改或缺失，停止覆盖：' + item.path);
    }
  }
  const changed = [...planned].filter(([file, bytes]) => !fs.existsSync(safePath(target, file)) || !fs.readFileSync(safePath(target, file)).equals(bytes));
  if (options.check) assert(!changed.length, 'DSH 产物与源码不一致，请重新构建');
  else {
    for (const [file, bytes] of changed) atomicWrite(safePath(target, file), bytes);
    for (const item of previous?.files || []) if (!planned.has(item.path)) fs.unlinkSync(safePath(target, item.path));
  }
  return { status: options.check ? 'checked' : 'built', version: VERSION, output: target, files: planned.size, changed: changed.map(([file]) => file) };
}

// npm-compatible deterministic tarball; no installation scripts or build authorization needed.
export function tarball(entries) {
  const blocks = [];
  const field = (header, offset, length, value) => {
    const bytes = Buffer.from(value);
    assert(bytes.length <= length, 'tar 文件名或字段过长');
    bytes.copy(header, offset);
  };
  const octal = (value, size) => {
    const text = value.toString(8);
    assert(text.length < size, 'tar 文件超出字段范围');
    return text.padStart(size - 1, '0') + '\0';
  };
  const names = new Set();
  for (const [file, bytes] of entries) {
    assert(typeof file === 'string' && !file.includes('\\') && !file.startsWith('/') && !file.split('/').some(part => !part || part === '.' || part === '..'), 'tar 路径无效');
    assert(!names.has(file), 'tar 路径重复'); names.add(file);
    const name = 'package/' + file, header = Buffer.alloc(512);
    if (Buffer.byteLength(name) <= 100) field(header, 0, 100, name);
    else {
      const split = name.lastIndexOf('/');
      field(header, 0, 100, name.slice(split + 1)); field(header, 345, 155, name.slice(0, split));
    }
    field(header, 100, 8, octal(0o644, 8));
    field(header, 108, 8, octal(0, 8)); field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(bytes.length, 12)); field(header, 136, 12, octal(0, 12));
    header.fill(32, 148, 156); header[156] = 48;
    field(header, 257, 6, 'ustar\0'); field(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function packDsh() {
  const built = buildDsh();
  const bytes = tarball(collect(built.output));
  const name = `ai-loop-dsh-${VERSION}.tgz`;
  atomicWrite(safePath(BUNDLE, 'downloads/' + name), bytes);
  return { name, files: built.files, bytes: bytes.length, sha256: digest(bytes) };
}

export function cli(argv) {
  const options = args(argv); allowArgs(options, ['out', 'check', 'pack', 'help']);
  assert(!options._.length && [options.check, options.pack].every(value => value === undefined || value === true), '参数无效');
  assert(!options.pack || !options.out && !options.check, '--pack 不与 --out 或 --check 同时使用');
  if (options.help) return { usage: 'node scripts/build-dsh.mjs [--out .release/DIRECTORY | --check | --pack]' };
  return options.pack ? packDsh() : buildDsh(options.out, options);
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
