import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { assert, rootPath, codexExecutable, VERSION } from './lib.mjs';

const cache = new Map();
export async function getNativeModels(project) {
  assert(process.env.AI_LOOP_NATIVE_MODEL_PROBE !== '1', '模型探测子进程不再发起探测');
  const root = rootPath(project), previous = cache.get(root);
  if (previous && previous.until > Date.now()) return previous.promise;
  const promise = probe(root);
  cache.set(root, { until: Date.now() + 30000, promise });
  try { return await promise; } catch (error) { cache.delete(root); throw error; }
}

async function probe(root) {
  const child = spawn(codexExecutable(), ['--strict-config', 'app-server', '--stdio'], {
    cwd: root, env: { ...process.env, AI_LOOP_NATIVE_MODEL_PROBE: '1' }, windowsHide: true, shell: false,
  });
  const pending = new Map(), lines = createInterface({ input: child.stdout });
  let sequence = 0, failure;
  const fail = error => { failure = error; for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex 模型服务已退出')));
  child.stdin.on('error', fail);
  child.stderr.resume(); // 不保存个人 provider 配置或凭据。
  lines.on('line', line => {
    try {
      const value = JSON.parse(line), item = pending.get(value.id);
      if (item) { pending.delete(value.id); value.error ? item.reject(new Error('原生请求失败：' + item.method)) : item.resolve(value.result); }
    } catch { /* 忽略诊断行 */ }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')); }, 15000);
    pending.set(id, { method, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'ai_loop_settings_models', version: VERSION }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const models = [], seen = new Set(); let cursor;
    for (let page = 0; page < 32; page++) {
      const result = await request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      assert(Array.isArray(result?.data), '原生模型列表格式无效');
      for (const item of result.data) {
        const id = item.model || item.id;
        const efforts = (item.supportedReasoningEfforts || item.supported_reasoning_efforts || []).map(value => typeof value === 'string' ? value : value.reasoningEffort || value.reasoning_effort).filter(Boolean);
        if (typeof id === 'string' && efforts.length && !models.some(value => value.id === id)) models.push({ id, name: item.displayName || item.display_name || id, efforts, default_effort: item.defaultReasoningEffort || item.default_reasoning_effort });
      }
      cursor = result.nextCursor || result.next_cursor;
      if (!cursor) { assert(models.length, 'Codex 未返回可配置的模型与思考强度'); return { models, effective_model: 'unverified' }; }
      assert(!seen.has(cursor), '原生模型分页游标重复'); seen.add(cursor);
    }
    throw new Error('原生模型分页超出安全读取范围');
  } finally {
    fail(new Error('模型探测结束')); lines.close(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
