import fs from 'node:fs';
import crypto from 'node:crypto';
import { assert, safePath, jsonFile } from './lib.mjs';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const prefix = '.ai-loop/memory/';
export function loadCatalog(root, item) {
  if (item.content === null) return { schema_version: 1, revision: 0, documents: {} };
  const value = jsonFile(item.target);
  if (value.schema_version !== 2) return value;
  const result = { ...value, schema_version: 1, documents: {} };
  assert(value.documents && typeof value.documents === 'object', '知识分片目录无效');
  for (const [name, document] of Object.entries(value.documents)) {
    assert(['index', 'architecture', 'decisions', 'lessons'].includes(name) && Array.isArray(document.shards), '知识分片文档无效');
    const entries = [];
    for (const shard of document.shards) {
      assert(typeof shard.path === 'string' && shard.path.startsWith(prefix + 'data/') && /^[a-f0-9]{64}$/.test(shard.hash), '知识分片路径或摘要无效');
      const target = safePath(root, shard.path);
      assert(fs.existsSync(target) && digest(fs.readFileSync(target)) === shard.hash, '知识分片缺失或被修改，请保留现场恢复：' + shard.path);
      const content = jsonFile(target);
      assert(Array.isArray(content.entries), '知识分片条目格式无效');
      entries.push(...content.entries);
    }
    result.documents[name] = { ...document, entries };
    if (document.page_shards?.length) {
      const pages = [];
      for (const shard of document.page_shards) {
        assert(typeof shard.path === 'string' && shard.path.startsWith(prefix + 'data/') && /^[a-f0-9]{64}$/.test(shard.hash), '知识分页目录分片路径无效');
        const target = safePath(root, shard.path);
        assert(fs.existsSync(target) && digest(fs.readFileSync(target)) === shard.hash, '知识分页目录分片丢失或变化');
        const content = jsonFile(target);
        assert(Array.isArray(content.pages), '知识分页目录格式无效');
        pages.push(...content.pages);
      }
      result.documents[name].pages = pages;
    }
    delete result.documents[name].shards;
    delete result.documents[name].page_shards;
    delete result.documents[name].entry_count;
  }
  return result;
}

// 分片和旧视图均不可变；目录最后发布。突然中断最多留下未引用片段，不覆盖旧目录。
export function encodeCatalog(root, value, stage) {
  const output = { ...value, schema_version: 2, documents: {} };
  for (const [name, document] of Object.entries(value.documents)) {
    const shards = [];
    let group = [], size = 0;
    const flush = () => {
      if (!group.length) return;
      const content = JSON.stringify({ entries: group }, null, 2) + '\n';
      const hash = digest(content), relative = `${prefix}data/${name}-${hash}.json`;
      stage(relative, content);
      shards.push({ path: relative, hash, count: group.length });
      group = []; size = 0;
    };
    for (const entry of document.entries) {
      const length = Buffer.byteLength(JSON.stringify(entry, null, 2)) + 100;
      assert(length < 800000, '单条知识过大，请拆为有意义的独立条目；原资料未改动');
      if (size + length > 800000) flush();
      group.push(entry); size += length;
    }
    flush();
    const { entries, pages, ...metadata } = document;
    const pageShards = [];
    for (let start = 0; start < (pages?.length || 0); start += 128) {
      const content = JSON.stringify({ pages: pages.slice(start, start + 128) }, null, 2) + '\n';
      const hash = digest(content), relative = `${prefix}data/${name}-pages-${hash}.json`;
      stage(relative, content); pageShards.push({ path: relative, hash });
    }
    output.documents[name] = { ...metadata, entry_count: entries.length, shards, ...(pageShards.length ? { page_shards: pageShards } : {}) };
  }
  return JSON.stringify(output, null, 2) + '\n';
}

export function splitText(content, limit) {
  const parts = [];
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(offset + limit, content.length);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    parts.push(content.slice(offset, end)); offset = end;
  }
  return parts;
}
export function pagedView(content, base, limit, stage) {
  const key = digest(content);
  return splitText(content, limit).map((part, index) => {
    const relative = `${base}/${key}/${String(index + 1).padStart(4, '0')}.md`;
    stage(relative, part);
    return { path: relative, hash: digest(part) };
  });
}
export function verifyPages(root, pages = []) {
  assert(Array.isArray(pages), '正文分页格式无效');
  const issues = [];
  for (const page of pages) {
    assert(typeof page.path === 'string' && page.path.startsWith('.ai-loop/') && /^[a-f0-9]{64}$/.test(page.hash), '正文分页路径或摘要无效');
    const target = safePath(root, page.path);
    if (!fs.existsSync(target)) issues.push({ type: 'missing-page', path: page.path });
    else {
      assert(fs.statSync(target).isFile(), '正文分页不是普通文件');
      if (digest(fs.readFileSync(target)) !== page.hash) issues.push({ type: 'edited-page', path: page.path });
    }
  }
  return issues;
}
