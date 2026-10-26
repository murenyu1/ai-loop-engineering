import fs from 'node:fs';
import path from 'node:path';
import { assert, rootPath, safePath, validId, jsonFile, writeJson, locked } from './lib.mjs';

const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const runDir = (base, run) => safePath(base, `.ai-loop/runs/${validId(run)}`);
const stateFile = (base, run) => safePath(runDir(base, run), 'state.json');

export function projectBase(project, projectPath = '.') {
  const root = rootPath(project);
  return projectPath === '.' ? root : safePath(root, projectPath);
}

export function newRunBase(project, { project_path = '.', snapshot_paths = [] } = {}) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const selected = normalize(project_path), scope = selected.replace(/\/+$/, '') + '/';
  const shared = snapshot_paths.some(value => normalize(value) !== selected && !normalize(value).startsWith(scope));
  return project_path !== '.' && !shared ? projectBase(project, project_path) : rootPath(project);
}

function indexFile(root) {
  return safePath(root, '.ai-loop/storage-index.json');
}

export function discoverRecordBases(project) {
  const root = rootPath(project), bases = [root];
  const add = base => {
    if (!bases.some(item => samePath(item, base)) && fs.existsSync(safePath(base, '.ai-loop/runs'))) bases.push(base);
  };
  const index = indexFile(root);
  if (fs.existsSync(index)) {
    const data = jsonFile(index);
    assert(data && data.schema_version === 1 && Array.isArray(data.projects), '项目存储索引格式无效');
    for (const item of data.projects) {
      assert(typeof item === 'string' && item !== '.' && !path.isAbsolute(item), '项目存储索引路径无效');
      add(projectBase(root, item));
    }
  }
  if (!fs.existsSync(root)) return bases;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ['.git', '.ai-loop', 'node_modules'].includes(entry.name)) continue;
    add(safePath(root, entry.name));
  }
  return bases;
}

export function registerProjectBase(project, projectPath) {
  const root = rootPath(project);
  if (!projectPath || projectPath === '.' || samePath(projectBase(root, projectPath), root)) return;
  if (projectPath.split('/').length === 1) return;
  locked(root, 'storage-index', () => {
    const file = indexFile(root);
    const data = fs.existsSync(file) ? jsonFile(file) : { schema_version: 1, projects: [] };
    assert(data.schema_version === 1 && Array.isArray(data.projects), '项目存储索引格式无效');
    if (!data.projects.some(item => samePath(item, projectPath))) data.projects.push(projectPath);
    data.projects.sort();
    writeJson(file, data);
  });
}

function matchesProject(base, root, run, projectPath) {
  const file = stateFile(base, run);
  if (!fs.existsSync(file)) return false;
  try {
    const state = jsonFile(file);
    if (!samePath(base, root) && (state.project_path ?? '.') === '.') return false;
    return projectPath === undefined || samePath(state.project_path ?? '.', projectPath);
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
    return samePath(base, root) && projectPath === '.';
  }
}

export function resolveRunBase(project, run, projectPath, options = {}) {
  const root = rootPath(project);
  validId(run);
  if (projectPath !== undefined) assert(typeof projectPath === 'string' && projectPath.length > 0, '项目路径无效');
  if (options.create) {
    const spec = options.spec ?? { project_path: projectPath ?? '.', snapshot_paths: [] };
    const base = newRunBase(root, spec);
    assert(!fs.existsSync(runDir(base, run)), '目标运行目录已存在，不能覆盖已有记录或中断现场；请核对记录或选择其他运行编号');
    const collision = [root, projectBase(root, spec.project_path ?? '.')].find(candidate => fs.existsSync(stateFile(candidate, run)) && matchesProject(candidate, root, run, spec.project_path ?? '.'));
    assert(!collision, '同一项目中的运行编号已存在，不能覆盖或重置');
    return base;
  }
  const bases = projectPath === undefined ? discoverRecordBases(root) : [...new Map([projectBase(root, projectPath), root].map(item => [process.platform === 'win32' ? item.toLowerCase() : item, item])).values()];
  const matches = bases.filter(base => fs.existsSync(stateFile(base, run)) && matchesProject(base, root, run, projectPath));
  assert(matches.length > 0, `运行不存在：${run}`);
  assert(matches.length === 1, `多个项目存在同编号运行 ${run}；必须提供 project_path 选择项目`);
  return matches[0];
}

export function runPathsAt(base, run) {
  const directory = runDir(base, run);
  return {
    base,
    directory,
    state: safePath(directory, 'state.json'),
    spec: safePath(directory, 'spec.json'),
    events: safePath(directory, 'events.jsonl'),
    mailbox: safePath(directory, 'mailbox'),
  };
}

export function runPaths(project, run, projectPath) {
  const base = resolveRunBase(project, run, projectPath);
  return runPathsAt(base, run);
}

export function runFile(project, run, relative, projectPath) {
  const directory = runDir(resolveRunBase(project, run, projectPath), run);
  return safePath(directory, relative);
}

export function relativeRunPath(project, run, relative, projectPath) {
  const root = rootPath(project);
  return path.relative(root, runFile(root, run, relative, projectPath)).split(path.sep).join('/');
}
