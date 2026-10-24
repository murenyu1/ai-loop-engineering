import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE, sourceRelative } from '../scripts/lib.mjs';
import { buildPlugin } from '../scripts/build-plugin.mjs';

function importsExist(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) importsExist(file);
    else if (entry.name.endsWith('.mjs')) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:from\s*|import\s*\()(['"])(\.{1,2}\/[^'"\n]+)\1/g)) {
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[2])), file + ' -> ' + match[2]);
      }
    }
  }
}

test('三端同级源码的根定位、资源映射和相对导入保持有效', () => {
  assert.equal(BUNDLE, path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  for (const directory of ['core', 'codex', 'dsh', 'scripts', 'adapters']) importsExist(path.join(BUNDLE, directory));
  assert.equal(sourceRelative(BUNDLE, 'scripts/plugin.mjs'), 'codex/scripts/plugin.mjs');
  assert.equal(sourceRelative(BUNDLE, 'scripts/install.mjs'), 'adapters/project/scripts/install.mjs');
  assert.equal(sourceRelative(BUNDLE, 'plugin/plugin.json'), 'codex/plugin.json');
  assert.equal(sourceRelative(BUNDLE, 'WORKFLOW.md'), 'core/WORKFLOW.md');
  assert.ok(!fs.existsSync(path.join(BUNDLE, 'plugins')));
});

test('Codex打包后两层源码与三层兼容适配器导入均能在包内解析', t => {
  const relative = '.release/layout-' + process.pid;
  const output = path.resolve(BUNDLE, relative);
  assert.equal(path.dirname(output), path.resolve(BUNDLE, '.release'));
  assert.equal(fs.existsSync(output), false, '测试目录已存在，拒绝覆盖');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const built = buildPlugin(relative);
  importsExist(built.output);
});
