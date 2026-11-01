import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPlugin } from '../codex/scripts/install-plugin.mjs';
import { BUNDLE } from '../scripts/lib.mjs';

const locationParts = ['plugins', 'local', 'ai-loop-engineering', 'plugins', 'ai-loop-engineering'];
const hash = content => crypto.createHash('sha256').update(content).digest('hex');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-install-safety-'));
  const home = path.join(parent, 'home'), project = path.join(parent, 'project'), source = path.join(parent, 'source');
  for (const directory of [home, project, source]) fs.mkdirSync(directory);
  fs.cpSync(path.join(BUNDLE, 'dist/codex'), source, { recursive: true });
  const marketplaceMetadata = path.join(parent, 'marketplace-metadata.json');
  const metadata = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'codex/marketplace.json'), 'utf8'));
  metadata.plugins[0].version = JSON.parse(fs.readFileSync(path.join(source, 'bundle.json'), 'utf8')).version;
  fs.writeFileSync(marketplaceMetadata, JSON.stringify(metadata));
  t.after(() => {
    assert.equal(path.dirname(parent), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(parent).startsWith('ai-loop-install-safety-'));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { parent, home, project, source, marketplaceMetadata, target: path.join(home, ...locationParts) };
}

const options = f => ({ home: f.home, source: f.source, marketplaceMetadata: f.marketplaceMetadata });

function readLock(source) {
  return JSON.parse(fs.readFileSync(path.join(source, 'bundle.json'), 'utf8'));
}

function writeLock(source, lock) {
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(lock, null, 2) + '\n');
}

function addPackageFile(source, relative, content) {
  const target = path.join(source, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  const lock = readLock(source);
  lock.files.push({ path: relative, hash: hash(content) });
  lock.files.sort((a, b) => a.path.localeCompare(b.path));
  writeLock(source, lock);
}

test('升级遇到与新包同路径的未登记文件时拒绝覆盖，即使字节完全相同', t => {
  const f = fixture(t);
  fs.cpSync(f.source, f.target, { recursive: true });
  const relative = 'skills/user-owned.md', content = Buffer.from('用户保留的内容\n');
  const lock = readLock(f.source);
  const registered = lock.files[0].path;
  const registeredSource = path.join(f.source, ...registered.split('/'));
  fs.appendFileSync(registeredSource, '升级后的登记内容');
  lock.files[0].hash = hash(fs.readFileSync(registeredSource));
  writeLock(f.source, lock);
  addPackageFile(f.source, relative, content);
  const preview = installPlugin(f.project, options(f));
  assert.equal(preview.status, 'dry-run', '校验通过的已登记文件应允许升级预演');
  assert.ok(preview.changes.includes(path.join(f.target, ...registered.split('/'))));

  const userFile = path.join(f.target, ...relative.split('/'));
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, content);

  assert.throws(() => installPlugin(f.project, options(f)), /已有未登记文件/);
  assert.deepEqual(fs.readFileSync(userFile), content);
});

test('新包清单路径、重复项、摘要及内容摘要均在写入前校验', t => {
  const cases = [
    ['路径越界', lock => { lock.files[0].path = '../escape'; }],
    ['锁文件别名', lock => { lock.files[0].path = 'Bundle.json'; }],
    ['重复路径', lock => { lock.files.push({ ...lock.files[0] }); }],
    ['缺少摘要', lock => { delete lock.files[0].hash; }],
    ['摘要格式错误', lock => { lock.files[0].hash = 'bad'; }],
  ];
  for (const [name, mutate] of cases) {
    const f = fixture(t);
    const lock = readLock(f.source);
    mutate(lock);
    writeLock(f.source, lock);
    assert.throws(() => installPlugin(f.project, options(f)), undefined, name);
    assert.equal(fs.existsSync(f.target), false, `${name}不应留下部分安装文件`);
  }

  const f = fixture(t);
  const file = path.join(f.source, ...readLock(f.source).files[0].path.split('/'));
  fs.appendFileSync(file, 'tampered');
  assert.throws(() => installPlugin(f.project, options(f)), /摘要不符/);
  assert.equal(fs.existsSync(f.target), false, '源包摘要不符不应留下部分安装文件');
});

test('空目标预演列出安装变更但不创建目标文件', t => {
  const f = fixture(t);
  const result = installPlugin(f.project, options(f));
  assert.equal(result.status, 'dry-run');
  assert.ok(result.changes.some(file => file.endsWith(path.join(...locationParts, 'bundle.json'))));
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.existsSync(path.join(f.home, 'settings.json')), false);
});
