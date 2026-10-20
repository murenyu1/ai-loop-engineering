import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../../../scripts/memory.mjs';
import { resolveProfile } from '../../../scripts/profiles.mjs';
import { inspectWindows } from '../../../scripts/windows.mjs';
import { assert, BUNDLE, sourceRelative, VERSION, rootPath, safePath, atomicWrite, jsonFile, args, allowArgs, mainModule, printResult } from '../../../scripts/lib.mjs';
import { digest } from '../../../scripts/memory-store.mjs';

export function initialize(project, options = {}) {
  const root = rootPath(project);
  assert(root !== fs.realpathSync(BUNDLE), '源包或插件根不能作为目标项目');
  const marker = safePath(root, '.ai-loop/plugin.json');
  const content = JSON.stringify({ schema_version: 1, plugin: 'ai-loop-engineering', version: VERSION }, null, 2) + '\n';
  const changes = [];
  const index = safePath(root, '.ai-loop/memory/index.md');
  if (!fs.existsSync(index)) {
    assert(!fs.existsSync(safePath(root, '.ai-loop/memory/catalog.json')), '已有目录元信息但索引缺失，先合并恢复，不重置');
    changes.push({ path: index, content: fs.readFileSync(safePath(BUNDLE, sourceRelative(BUNDLE, 'templates/memory-index.md')), 'utf8') });
  }
  if (fs.existsSync(marker)) {
    const old = jsonFile(marker);
    assert(old.schema_version === 1 && old.plugin === 'ai-loop-engineering', '已有插件标记无效，停止覆盖');
  }
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== content) changes.push({ path: marker, content });
  if (options.apply) for (const change of changes) atomicWrite(change.path, change.content);
  return { status: options.apply ? 'initialized' : 'dry-run', changes: changes.map(item => item.path), legacy_deployment: fs.existsSync(safePath(root, '.ai-loop/install.json')), warning: '保留旧入口和运行记录；首次使用核对入口冲突，已有验证需按实际代码与核心版本核对' };
}
export function pluginDoctor(project, options = {}) {
  const root = rootPath(project), windows = inspectWindows(root, { home: options.home, purpose: 'inspect' }), issues = [];
  const lockPath = path.join(BUNDLE, 'bundle.json');
  if (!fs.existsSync(lockPath)) issues.push('缺少打包摘要；请从源包 build-plugin 生成插件');
  else {
    const record = jsonFile(lockPath);
    for (const item of record.files) {
      const target = safePath(BUNDLE, item.path);
      if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== item.hash) issues.push('插件文件缺失或变化：' + item.path);
    }
  }
  const models = resolveProfile(root, { home: options.home });
  if (!models.profile) issues.push('未配置全局或项目子代理模型；使用 ai-loop-models 设置');
  else {
    if (models.scope === 'global') for (const role of ['planner', 'reviewer', 'dev', 'tester', 'scribe']) if (fs.existsSync(safePath(root, `.codex/agents/loop-${role}.toml`))) issues.push('项目原生角色会覆盖全局设置，先迁移或登记项目覆盖：loop-' + role);
    const base = models.scope === 'global' ? path.dirname(path.dirname(models.path)) : root;
    for (const [relative, expected] of Object.entries(models.native)) {
      const target = safePath(base, relative);
      if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== expected) issues.push('原生模型文件缺失或变化：' + relative);
    }
    if (path.resolve(models.bundle) !== path.resolve(BUNDLE)) issues.push('原生代理引用了其他插件路径；用模型 configure 预演后更新，再重载');
  }
  const blocked = issues.length > 0 || windows.issues.length > 0;
  return { version: VERSION, mode: 'plugin', status: blocked ? 'needs-check' : 'configured', configuration: issues.length ? 'fail' : 'pass', dispatch: blocked ? 'blocked' : 'requires-native-verification', issues, windows, models: { scope: models.scope, path: models.path, profile: models.profile }, memory: bootstrap(root), native_discovery: 'unverified', execution: 'unverified', effective_model: 'unverified', ui_visibility: 'unverified' };
}
export function cli(argv) {
  const options = args(argv); allowArgs(options, ['project', 'apply', 'help']);
  assert(options._.length <= 1 && (options.apply === undefined || options.apply === true), '参数无效');
  if (options.help) return { usage: 'plugin.mjs init|doctor --project ROOT [--apply]' };
  if (options._[0] === 'init') return initialize(options.project, options);
  assert(options._[0] === 'doctor', '未知插件命令');
  return pluginDoctor(options.project);
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
