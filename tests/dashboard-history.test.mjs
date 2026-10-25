import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create, begin } from '../scripts/loop.mjs';
import { recordActivity } from '../scripts/activity.mjs';
import { chatHistory } from '../scripts/dashboard.mjs';

test('无关运行的损坏JSON不阻断有效聊天历史，分页仍保持隔离并报告损坏数量', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-history-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = { goal: '历史隔离', tasks: [{ id: 't1', title: '方向', review: 'self', acceptance: ['聊天隔离'], checks: [{ id: 'c', command: 'node --version' }] }] };
  for (const [run, parent] of [['a1', 'A'], ['a2', 'A'], ['b1', 'B'], ['broken', 'B']]) {
    create(root, spec, run); begin(root, run, 't1', 'development');
    recordActivity(root, run, { id: 'dev', task: 't1', role: 'dev', harness: 'codex', state: 'requested', summary: run, context: { mode: 'independent', id: run + '-child', parent_id: parent } });
  }
  fs.writeFileSync(path.join(root, '.ai-loop/runs/broken/state.json'), '{broken-json');
  const first = chatHistory(root, { session_id: 'A', harness: 'codex', limit: 1 });
  assert.equal(first.rounds.length, 1); assert.equal(first.unreadable_count, 1); assert.ok(first.next_after);
  const second = chatHistory(root, { session_id: 'A', harness: 'codex', limit: 1, after: first.next_after });
  assert.deepEqual(new Set([...first.rounds, ...second.rounds].map(round => round.run.run_id)), new Set(['a1', 'a2']));
  assert.equal(second.unreadable_count, 1); assert.equal(second.next_after, null);
  assert.doesNotMatch(JSON.stringify(first), /b1|broken-json/);
});
