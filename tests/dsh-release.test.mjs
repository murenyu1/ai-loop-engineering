import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { BUNDLE, VERSION, safePath } from '../scripts/lib.mjs';
import { buildDsh, packDsh, tarball } from '../scripts/build-dsh.mjs';

function untar(bytes, root) {
  const tar = gunzipSync(bytes), names = [];
  const text = (header, start, size) => header.subarray(start, start + size).toString().replace(/\0.*$/s, '');
  for (let offset = 0; tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    const prefix = text(header, 345, 155);
    const name = (prefix ? prefix + '/' : '') + text(header, 0, 100);
    assert.ok(name.startsWith('package/'));
    assert.equal(header[156], 48);
    const saved = parseInt(text(header, 148, 8).trim(), 8);
    const copy = Buffer.from(header); copy.fill(32, 148, 156);
    assert.equal(copy.reduce((a, b) => a + b, 0), saved);
    const size = parseInt(text(header, 124, 12), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    const file = name.slice(8), target = safePath(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size));
    names.push(file); offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

test('DSH tgz 可复现、可独立运行核心且只携带登记源码', t => {
  const first = packDsh(), second = packDsh();
  assert.deepEqual(first, second);
  const bytes = fs.readFileSync(path.join(BUNDLE, 'downloads', first.name));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), first.sha256);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-dsh-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unpacked = path.join(root, 'bundle'); fs.mkdirSync(unpacked);
  const names = untar(bytes, unpacked);
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json')));
  assert.equal(manifest.name, 'dsh-plugin-ai-loop-engineering');
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.scripts, undefined);
  assert.ok(names.includes('skills/ai-loop/SKILL.md'));
  assert.ok(names.includes('skills/ai-loop-models/SKILL.md'));
  assert.ok(names.includes('core/scripts/memory.mjs'));
  assert.ok(!names.some(file => /(?:^|\/)(?:node_modules|\.ai-loop|tests|\.git|settings.json|models.json)(?:\/|$)/.test(file)));
  const lock = JSON.parse(fs.readFileSync(path.join(unpacked, 'bundle.json')));
  assert.deepEqual(new Set(names), new Set(['bundle.json', ...lock.files.map(item => item.path)]));
  for (const item of lock.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(safePath(unpacked, item.path))).digest('hex'), item.hash);
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const result = spawnSync(process.execPath, [path.join(unpacked, 'core/scripts/memory.mjs'), 'bootstrap', '--project', project], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).active_count, 0);
  assert.equal(buildDsh(undefined, { check: true }).status, 'checked');
});

test('DSH 构建拒绝越界、混入个人文件与被改动的产物', () => {
  assert.throws(() => buildDsh('plugins/dsh'), /输出仅允许/);
  assert.throws(() => buildDsh('.release/../core'), /路径须为规范/);
  buildDsh();
  const unowned = path.join(BUNDLE, 'dist/dsh/private-test.txt');
  fs.writeFileSync(unowned, 'private');
  try { assert.throws(() => packDsh(), /未登记文件/); }
  finally { fs.unlinkSync(unowned); }
  const target = path.join(BUNDLE, 'dist/dsh/README.md'), previous = fs.readFileSync(target);
  fs.writeFileSync(target, 'human edit');
  try { assert.throws(() => buildDsh(), /旧 DSH 产物被修改/); }
  finally { fs.writeFileSync(target, previous); }
});

test('DSH tar 路径校验和长文件名可供标准解包器读取', t => {
  assert.throws(() => tarball([['../private', Buffer.from('bad')]]), /tar 路径无效/);
  assert.throws(() => tarball([['a', Buffer.alloc(0)], ['a', Buffer.alloc(0)]]), /tar 路径重复/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-dsh-tar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = 'core/' + 'a'.repeat(90) + '/file.txt';
  assert.deepEqual(untar(tarball([[name, Buffer.from('content')]]), root), [name]);
  assert.equal(fs.readFileSync(safePath(root, name), 'utf8'), 'content');
});
