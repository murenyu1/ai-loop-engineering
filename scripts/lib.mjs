import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const VERSION = '3.1.0';
export const BUNDLE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function validId(value) {
  assert(typeof value === 'string' && ID.test(value), '编号须为 1–64 个字母、数字、点、下划线或连字符，且以字母或数字开头');
  return value;
}
export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export function rootPath(value) {
  assert(typeof value === 'string' && value, '必须显式提供 --project 路径，不能猜测目标项目');
  const root = fs.realpathSync(path.resolve(value));
  assert(fs.statSync(root).isDirectory(), '目标项目必须是目录');
  return root;
}
// 避免配置路径通过任何已有符号链接落到其他位置。
export function safePath(root, relative) {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative), '路径必须是项目内相对路径');
  assert(!relative.includes('\\'), '配置路径请使用正斜杠');
  assert(!relative.split('/').some(part => !part || part === '.' || part === '..'), '路径须为规范相对路径，不能包含空段、. 或 ..');
  const target = path.resolve(root, relative);
  assert(inside(root, target) && target !== root, '路径不能越出项目或指向项目根');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) || isLink(current)) {
      assert(!fs.lstatSync(current).isSymbolicLink(), `配置路径含符号链接：${relative}`);
    }
  }
  return target;
}
function isLink(target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export function jsonFile(target) {
  const stat = fs.statSync(target);
  assert(stat.isFile() && stat.size <= 1024 * 1024, 'JSON 输入必须是普通文件且不超过 1 MiB');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
export function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function writeJson(target, value) {
  atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
}
export function locked(root, name, action) {
  const directory = safePath(root, '.ai-loop');
  fs.mkdirSync(directory, { recursive: true });
  const lock = safePath(root, `.ai-loop/${name}.lock`);
  let descriptor;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有操作持有锁；先确认是否仍在运行，不要自动删除锁');
    throw error;
  }
  try { return action(); } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}
export function args(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) result._.push(arg);
    else {
      const name = arg.slice(2);
      assert(/^[a-z]+(?:-[a-z]+)*$/.test(name) && !Object.hasOwn(result, name), `重复或非法参数：${arg}`);
      const next = argv[index + 1];
      result[name] = next && !next.startsWith('--') ? argv[++index] : true;
    }
  }
  return result;
}
export function allowArgs(options, names) {
  for (const key of Object.keys(options)) assert(key === '_' || names.includes(key), `未知参数：--${key}`);
}
export function mainModule(meta) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(meta);
}
export function printResult(action) {
  try { console.log(JSON.stringify(action(), null, 2)); }
  catch (error) {
    console.error(`操作停止：${error.message}`);
    process.exitCode = 1;
  }
}
