import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { devStatus } from '../scripts/dev-status.mjs';
import { publishFiles } from '../scripts/publish-files.mjs';

test('Git 概览只读取本地引用并保留含空格的改动路径', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init');
  fs.writeFileSync(path.join(root, 'file with spaces.txt'), 'before');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
  fs.writeFileSync(path.join(root, 'file with spaces.txt'), 'after');
  const index = fs.readFileSync(path.join(root, '.git/index'));
  const view = devStatus(root);
  assert.equal(view.status, 'local');
  assert.equal(view.upstream, null);
  assert.equal(view.divergence, null);
  assert.deepEqual(view.changes, [{ status: ' M', path: 'file with spaces.txt' }]);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  git('mv', 'file with spaces.txt', "new ' name.txt");
  assert.equal(devStatus(root).changes[0].previous_path, 'file with spaces.txt');
});

test('发行清单包括共享交接，二进制 Git 属性不会转换安装包', () => {
  const files = publishFiles().map(item => item.path);
  assert.ok(files.includes('docs/development/README.md'));
  assert.ok(files.includes('docs/development/workflow-sync.md'));
  assert.ok(!files.some(file => file.startsWith('.ai-loop/') || file.startsWith('.codex/')));
  const attributes = execFileSync('git', ['check-attr', 'text', '--', 'downloads/package.zip', 'downloads/package.tgz'], { encoding: 'utf8', windowsHide: true });
  assert.match(attributes, /package\.zip: text: unset/);
  assert.match(attributes, /package\.tgz: text: unset/);
});
