import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createWorkflowGraph } from '../core/scripts/workflow-graph.mjs';
import { create, validateSpec, status, begin } from '../core/scripts/loop.mjs';
import { dispatchCheck, recordActivity } from '../core/scripts/activity.mjs';
import { bootstrap } from '../core/scripts/memory.mjs';

const task = { id: 'task1', title: '任务一', acceptance: ['完成'], review: 'self', checks: [{ id: 'all', command: 'node tests/all.mjs' }] };
const spec = workflow => ({ goal: '图测试', tasks: [task], workflow });
const workflow = { nodes: [{ id: 'plan', task: 'run', role: 'planner' }, { id: 'dev', task: 'task1', role: 'dev' }, { id: 'scribe', task: 'run', role: 'scribe' }], edges: [{ from: 'plan', to: 'dev' }, { from: 'dev', to: 'scribe' }] };

test('同一任务的阶段交接不作为跨任务依赖，反向依赖与图循环仍拒绝', () => {
  const internal = { nodes: [{ id: 'dev', task: 'task1', role: 'dev' }, { id: 'test', task: 'task1', role: 'tester' }, { id: 'review', task: 'task1', role: 'reviewer' }], edges: [{ from: 'dev', to: 'test' }, { from: 'test', to: 'review' }] };
  assert.deepEqual(validateSpec(spec(internal)).workflow, internal);
  assert.throws(() => validateSpec(spec({ ...internal, edges: [...internal.edges, { from: 'review', to: 'dev' }] })), /循环/);
  const tasks = [{ ...task, id: 'a' }, { ...task, id: 'b', depends_on: ['a'] }];
  const nodes = [{ id: 'a', task: 'a', role: 'dev' }, { id: 'b', task: 'b', role: 'dev' }];
  assert.doesNotThrow(() => validateSpec({ goal: '依赖', tasks, workflow: { nodes, edges: [{ from: 'a', to: 'b' }] } }));
  assert.throws(() => validateSpec({ goal: '依赖', tasks, workflow: { nodes, edges: [{ from: 'b', to: 'a' }] } }), /反向/);
});

test('4.6.4已有同任务流程记录可只读恢复，spec和state不被迁移或重写', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-legacy-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '.ai-loop/runs/legacy'); fs.mkdirSync(directory, { recursive: true });
  const definition = { ...task, id: 'audit' };
  const old = { goal: '旧记录', tasks: [definition], max_fixes: 3, ignore_paths: [], workflow: { nodes: [{ id: 'test', task: 'audit', role: 'tester' }, { id: 'review', task: 'audit', role: 'reviewer' }], edges: [{ from: 'test', to: 'review' }] } };
  const state = { schema_version: 4, version: '4.6.4', run_id: 'legacy', goal: old.goal, status: 'active', max_fixes: 3, event_seq: 1, spec_hash: crypto.createHash('sha256').update(JSON.stringify(old)).digest('hex'), tasks: [{ id: 'audit', title: definition.title, review: 'self', phase: 'pending', fixes: 0 }] };
  fs.writeFileSync(path.join(directory, 'spec.json'), JSON.stringify(old)); fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ seq: 1, type: 'created' }) + '\n'); fs.writeFileSync(path.join(directory, 'session.md'), '保留旧交接');
  const before = ['spec.json', 'state.json', 'events.jsonl', 'session.md'].map(file => fs.readFileSync(path.join(directory, file)));
  assert.equal(status(root, 'legacy').run_id, 'legacy');
  assert.equal(bootstrap(root, { intent: 'continue' }).selected.run_id, 'legacy');
  for (const [index, file] of ['spec.json', 'state.json', 'events.jsonl', 'session.md'].entries()) assert.deepEqual(fs.readFileSync(path.join(directory, file)), before[index]);
});

test('workflow spec 校验唯一任务角色绑定、有效引用及无环拓扑', () => {
  assert.deepEqual(validateSpec(spec(workflow)).workflow, workflow);
  assert.throws(() => validateSpec(spec({ nodes: [...workflow.nodes, { id: 'dev2', task: 'task1', role: 'dev' }], edges: workflow.edges })), /task\+role/);
  assert.throws(() => validateSpec(spec({ nodes: workflow.nodes, edges: [...workflow.edges, { from: 'scribe', to: 'plan' }] })), /循环/);
  assert.throws(() => validateSpec(spec({ nodes: [{ id: 'bad', task: 'run', role: 'dev' }], edges: [] })), /run 级/);
});

test('主代理可登记运行级计划和共享记录，运行级开发被拒绝', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.txt'), 'run');
  const run = create(root, spec(workflow), 'graph1').run_id;
  assert.equal(status(root, run).workflow.nodes.length, 3);
  assert.equal(dispatchCheck(root, run, 'run', 'planner').task.id, 'run');
  assert.equal(dispatchCheck(root, run, 'run', 'scribe').task.id, 'run');
  assert.throws(() => dispatchCheck(root, run, 'run', 'dev'), /运行级/);
  assert.throws(() => dispatchCheck(root, run, 'task1', 'tester'), /图未声明/);
  assert.equal(recordActivity(root, run, { id: 'scribe-1', task: 'run', role: 'scribe', harness: 'codex', state: 'requested', summary: '记录阶段成果' }).task, 'run');
});

test('旧版未声明 workflow 的正式 task run 仍可作为开发任务', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-legacy-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.txt'), 'run');
  const run = create(root, { goal: '旧任务兼容', tasks: [{ ...task, id: 'run' }] }, 'legacy1').run_id;
  begin(root, run, 'run', 'development');
  assert.equal(dispatchCheck(root, run, 'run', 'dev').task.id, 'run');
  assert.throws(() => validateSpec({ goal: '不能歧义', tasks: [{ ...task, id: 'run' }], workflow }), /保留 run 与 final/);
});

test('旧版正式 task run/final 与虚拟系统节点不重名且观察只归属一次', () => {
  const tasks = [{ ...task, id: 'run', title: '正式 run' }, { ...task, id: 'final', title: '正式 final' }];
  const observations = [
    { id: 'run-planner', task: 'run', role: 'planner', state: 'completed' },
    { id: 'run-scribe', task: 'run', role: 'scribe', state: 'completed' },
    { id: 'final-tester', task: 'final', role: 'tester', state: 'completed' },
    { id: 'final-reviewer', task: 'final', role: 'reviewer', state: 'completed' }
  ];
  for (const collapsedTasks of [[], ['run'], ['final'], ['run', 'final']]) {
    const graph = createWorkflowGraph({ run: { tasks }, activity: { agents: observations } }, { collapsedTasks });
    const ids = graph.nodes.map(node => node.id), byId = new Map(graph.nodes.map(node => [node.id, node]));
    assert.equal(new Set(ids).size, ids.length, `node id 必须唯一（折叠 ${collapsedTasks.join(',')}）`);
    for (const id of ['system:planner', 'system:final-tester', 'system:final-reviewer', 'system:scribe', 'task:run', 'task:final']) assert.ok(byId.has(id), `缺少 ${id}`);
    assert.ok(!byId.get('system:planner').agents.some(agent => agent.id === 'run-planner'));
    assert.ok(!byId.get('system:final-tester').agents.some(agent => agent.id === 'final-tester'));
    assert.ok(!byId.get('system:final-reviewer').agents.some(agent => agent.id === 'final-reviewer'));
    if (collapsedTasks.includes('run')) assert.ok(!byId.has('stage:run:planner') && byId.get('task:run').agents.some(agent => agent.id === 'run-planner'));
    else assert.ok(byId.get('stage:run:planner').agents.some(agent => agent.id === 'run-planner'));
    if (collapsedTasks.includes('final')) assert.ok(!byId.has('stage:final:tester') && byId.get('task:final').agents.some(agent => agent.id === 'final-tester'));
    else assert.ok(byId.get('stage:final:tester').agents.some(agent => agent.id === 'final-tester'));
    assert.ok(byId.get('task:run').agents.some(agent => agent.id === 'run-scribe'));
    for (const observation of observations) {
      const stageAttachments = graph.nodes.filter(node => node.kind === 'stage' && node.agents.some(agent => agent.id === observation.id)).length;
      assert.ok(stageAttachments <= 1, `${observation.id} 在 stage.agents 中不得重复归属`);
    }
    for (const edge of graph.edges.filter(item => item.kind === 'workflow' || item.kind === 'dependency')) assert.ok(byId.get(edge.target).y > byId.get(edge.source).y, `${edge.id} 必须从上向下`);
  }
});

test('纵向图展示总体计划、任务阶段、汇总阶段及依赖分支，尺寸与主题共用', () => {
  const twoTasks = [task, { ...task, id: 'task2', title: '任务二', depends_on: ['task1'] }];
  const graph = createWorkflowGraph({ run: { goal: '图测试', status: 'active', tasks: twoTasks }, activity: { agents: [] } });
  assert.ok(graph.nodes.some(node => node.label === '总体计划'));
  assert.ok(graph.nodes.some(node => node.label === '整体验证'));
  assert.ok(graph.nodes.some(node => node.label === '整体评审'));
  assert.ok(graph.nodes.some(node => node.label === '统一记录'));
  assert.ok(graph.edges.some(edge => edge.kind === 'dependency' && edge.source === 'stage:task1:reviewer' && edge.target === 'task:task2'));
  assert.equal(graph.nodes[0].x, (graph.width - graph.nodes[0].width) / 2);
  assert.equal(graph.nodes[0].height, 104);
  assert.equal(graph.theme.roleColors.dev, '#34d399');
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const link of graph.edges) assert.ok(byId.get(link.target).y > byId.get(link.source).y, `${link.id} 必须从上向下`);
});

test('图函数序列化后仍能独立运行，供 Codex 和 DSH 注入', () => {
  const source = `(${createWorkflowGraph.toString()})({run:{tasks:[]},activity:{agents:[]}})`;
  const graph = vm.runInNewContext(source);
  assert.equal(graph.nodes[0].label, '主 agent');
  assert.deepEqual(JSON.parse(JSON.stringify(graph.theme.roleColors)), { planner: '#818cf8', dev: '#34d399', tester: '#fbbf24', reviewer: '#c084fc', scribe: '#60a5fa' });
});

test('跨任务交错显式 DAG 布局、折叠转换都保留节点且保持边向下', () => {
  const tasks = [{ ...task, id: 'a', title: '任务 A' }, { ...task, id: 'b', title: '任务 B' }];
  const explicit = { nodes: [{ id: 'a-dev', task: 'a', role: 'dev' }, { id: 'b-dev', task: 'b', role: 'dev' }, { id: 'a-test', task: 'a', role: 'tester' }, { id: 'b-test', task: 'b', role: 'tester' }, { id: 'merge', task: 'final', role: 'reviewer' }], edges: [{ from: 'a-dev', to: 'b-dev' }, { from: 'b-dev', to: 'a-test' }, { from: 'a-test', to: 'b-test' }, { from: 'b-test', to: 'merge' }] };
  const input = { run: { tasks, workflow: explicit }, activity: { agents: [] } };
  for (const collapsedTasks of [[], ['a'], ['b'], ['a', 'b']]) {
    const graph = createWorkflowGraph(input, { collapsedTasks });
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    for (const id of ['workflow:a-dev', 'workflow:b-dev', 'workflow:a-test', 'workflow:b-test', 'workflow:merge']) assert.ok(byId.has(id), `${collapsedTasks.join(',')} 必须保留 ${id}`);
    assert.ok(graph.nodes.some(node => node.id === 'task:a' && node.kind === 'task'));
    assert.ok(graph.nodes.some(node => node.id === 'task:b' && node.kind === 'task'));
    for (const edge of graph.edges.filter(item => item.kind !== 'call')) assert.ok(byId.get(edge.target).y > byId.get(edge.source).y, `${edge.id} 必须从上向下`);
    for (let i = 0; i < graph.nodes.length; i++) for (let j = i + 1; j < graph.nodes.length; j++) {
      const a = graph.nodes[i], b = graph.nodes[j];
      const separated = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(separated, `节点 ${a.id} 与 ${b.id} 重叠`);
    }
    assert.ok(!graph.warnings.some(message => /流程.*循环/.test(message)));
    if (collapsedTasks.length) assert.ok(graph.warnings.some(message => /无法整体折叠/.test(message)));
  }
  const aligned = createWorkflowGraph(input);
  const rowCounts = new Map();
  for (const node of aligned.nodes) rowCounts.set(node.y, [...(rowCounts.get(node.y) ?? []), node]);
  for (const row of rowCounts.values()) if (row.length === 1 && row[0].id !== 'main') assert.equal(row[0].x, (aligned.width - row[0].width) / 2);
});

test('不与其他任务交错的显式任务可以安全折叠为汇总卡', () => {
  const explicit = { nodes: [{ id: 'a', task: 'task1', role: 'dev' }, { id: 'b', task: 'task1', role: 'tester' }], edges: [{ from: 'a', to: 'b' }] };
  const folded = createWorkflowGraph({ run: { tasks: [task], workflow: explicit }, activity: { agents: [] } }, { collapsedTasks: ['task1'] });
  assert.ok(folded.nodes.some(node => node.taskId === 'task1' && node.kind === 'task'));
  assert.ok(!folded.nodes.some(node => node.taskId === 'task1' && node.kind === 'stage'));
  assert.ok(!folded.warnings.some(message => /无法整体折叠/.test(message)));
});

test('显式图循环安全警告，不进入循环节点布局', () => {
  const explicit = { nodes: [{ id: 'a', task: 'task1', role: 'dev' }, { id: 'b', task: 'task1', role: 'tester' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
  const cyclic = createWorkflowGraph({ run: { tasks: [task], workflow: explicit }, activity: { agents: [] } });
  assert.ok(cyclic.warnings.some(message => /循环/.test(message)));
  assert.ok(cyclic.nodes.length < 5);
});

test('旧任务图的缺失依赖与循环显示警告且保持有限布局', () => {
  const graph = createWorkflowGraph({ run: { tasks: [{ ...task, depends_on: ['missing', 'task2'] }, { ...task, id: 'task2', depends_on: ['task1'] }] }, activity: { agents: [] } });
  assert.ok(graph.warnings.some(message => /不存在/.test(message)));
  assert.ok(graph.warnings.some(message => /循环/.test(message)));
  assert.ok(graph.nodes.length < 20);
});

test('仅有匹配真实父子上下文的角色观察会生成调用边', () => {
  const nodes = [{ id: 'dev', task: 'task1', role: 'dev' }, { id: 'tester', task: 'task1', role: 'tester' }];
  const graph = createWorkflowGraph({ run: { tasks: [task], workflow: { nodes, edges: [{ from: 'dev', to: 'tester' }] } }, activity: { agents: [{ id: 'a', task: 'task1', role: 'dev', native_id: 'native-a', context: { id: 'ctx-a', parent_id: 'main' }, state: 'completed' }, { id: 'b', task: 'task1', role: 'tester', native_id: 'native-b', context: { id: 'ctx-b', parent_id: 'native-a' }, state: 'running' }] } });
  assert.ok(graph.edges.some(edge => edge.kind === 'call' && edge.source === 'workflow:dev' && edge.target === 'workflow:tester'));
});
