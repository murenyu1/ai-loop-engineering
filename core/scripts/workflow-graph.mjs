// Shared read-only projection for DSH and Codex. Keep this function self-contained
// so hosts can inject its source into their embedded UI without another runtime.
export function createWorkflowGraph(data, { collapsedTasks = [] } = {}) {
  const run = data?.run ?? {}, tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const agents = Array.isArray(data?.activity?.agents) ? data.activity.agents : [];
  const workflow = run.workflow ?? data?.spec?.workflow;
  const collapsed = new Set(collapsedTasks), nodes = [], edges = [], warnings = [];
  const labels = { planner: '计划', dev: '开发', tester: '测试', reviewer: '评审', scribe: '记录' };
  const states = { active: '进行中', complete: '已完成', pending: '待开始', developing: '开发中', developed: '待验证', verifying: '验证中', tested: '待评审', reviewing: '评审中', done: '已通过', needs_fix: '待修复', blocked: '阻塞', PASS: '验证通过', FAIL: '验证失败', APPROVED: '已批准', REJECTED: '已拒绝', requested: '已请求', running: '运行中', waiting: '等待中', completed: '已结束', failed: '失败', stopped: '已停止', unknown: '未知' };
  const stageStatus = (task, role) => {
    if (role === 'planner') return '计划';
    if (role === 'dev') return task.phase === 'developing' ? '开发中' : ['developed', 'verifying', 'tested', 'reviewing', 'done'].includes(task.phase) ? '已交付' : states[task.phase] ?? task.phase ?? '待开始';
    if (role === 'tester') return states[task.verification?.status] ?? task.verification?.status ?? (task.phase === 'verifying' ? '验证中' : ['tested', 'reviewing', 'done'].includes(task.phase) ? '已通过' : '待开始');
    if (role === 'reviewer') return states[task.assessment?.status] ?? task.assessment?.status ?? (task.review === 'none' ? '无需评审' : task.phase === 'reviewing' ? '评审中' : task.phase === 'done' ? '已通过' : '待开始');
    return states[task.phase] ?? task.phase ?? '待开始';
  };
  const width = 220, height = 104, gapX = 32, gapY = 36, margin = 24;
  const add = node => { nodes.push({ width, height, ...node }); return node.id; };
  const edge = (source, target, kind) => { if (source && target && !edges.some(row => row.source === source && row.target === target && row.kind === kind)) edges.push({ id: `${kind}:${source}:${target}`, source, target, kind }); };
  const runId = 'run';
  add({ id: runId, kind: 'main', label: '主 agent', status: states[run.status] ?? run.status ?? '未知', x: margin, y: margin, agents: [] });
  const workflowNodes = workflow?.nodes, workflowEdges = workflow?.edges;
  const visibleStageIds = new Map(), systemStageIds = new Map(), taskCards = new Map();
  if (Array.isArray(workflowNodes) && Array.isArray(workflowEdges) && workflowNodes.length) {
    const ids = new Set(workflowNodes.map(item => item.id));
    const outgoing = new Map([...ids].map(id => [id, []]));
    const indegree = new Map([...ids].map(id => [id, 0]));
    const validEdges = [];
    for (const link of workflowEdges) {
      if (!ids.has(link.from) || !ids.has(link.to) || link.from === link.to) { warnings.push(`流程边 ${link.from} → ${link.to} 引用无效。`); continue; }
      if (outgoing.get(link.from).includes(link.to)) { warnings.push(`流程边 ${link.from} → ${link.to} 重复。`); continue; }
      outgoing.get(link.from).push(link.to); indegree.set(link.to, indegree.get(link.to) + 1); validEdges.push(link);
    }
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id), levels = new Map(queue.map(id => [id, 1]));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor];
      for (const child of outgoing.get(id)) {
        levels.set(child, Math.max(levels.get(child) ?? 1, levels.get(id) + 1));
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) queue.push(child);
      }
    }
    if (queue.length !== ids.size) warnings.push('流程图包含循环；循环部分已省略。');
    const valid = new Set(queue), byNode = new Map(workflowNodes.map(item => [item.id, item]));
    const foldableTasks = new Set();
    for (const taskId of collapsed) {
      if (!workflowNodes.some(item => item.task === taskId && valid.has(item.id))) continue;
      const hasCrossTaskEdge = validEdges.some(link => valid.has(link.from) && valid.has(link.to) && byNode.get(link.from).task !== byNode.get(link.to).task && (byNode.get(link.from).task === taskId || byNode.get(link.to).task === taskId));
      if (hasCrossTaskEdge) warnings.push(`任务 ${taskId} 与其他任务交错连接，已保留必要阶段，无法整体折叠。`);
      else foldableTasks.add(taskId);
    }
    const layoutIds = new Set(queue.filter(id => !foldableTasks.has(byNode.get(id).task)));
    const layoutEdges = [];
    const layoutEdge = (from, to) => { if (from && to && from !== to && !layoutEdges.some(link => link.from === from && link.to === to)) layoutEdges.push({ from, to }); };
    for (const task of tasks) if (workflowNodes.some(item => item.task === task.id && valid.has(item.id))) layoutIds.add(`$task:${task.id}`);
    for (const link of validEdges) {
      if (!valid.has(link.from) || !valid.has(link.to)) continue;
      const from = byNode.get(link.from), to = byNode.get(link.to);
      const source = foldableTasks.has(from.task) ? `$task:${from.task}` : from.id;
      const target = foldableTasks.has(to.task) ? `$task:${to.task}` : to.id;
      layoutEdge(source, target);
    }
    for (const task of tasks) {
      const taskId = `$task:${task.id}`;
      if (!layoutIds.has(taskId)) continue;
      if (foldableTasks.has(task.id)) continue;
      const ownNodes = workflowNodes.filter(item => item.task === task.id && valid.has(item.id));
      const ownIds = new Set(ownNodes.map(item => item.id));
      const entries = ownNodes.filter(item => !validEdges.some(link => link.to === item.id && ownIds.has(link.from)));
      for (const item of entries) layoutEdge(taskId, item.id);
    }
    const layoutOut = new Map([...layoutIds].map(id => [id, []])), layoutDegree = new Map([...layoutIds].map(id => [id, 0]));
    for (const link of layoutEdges) { if (!layoutOut.has(link.from) || !layoutOut.has(link.to)) continue; layoutOut.get(link.from).push(link.to); layoutDegree.set(link.to, layoutDegree.get(link.to) + 1); }
    const layoutQueue = [...layoutDegree].filter(([, degree]) => degree === 0).map(([id]) => id), layoutRank = new Map(layoutQueue.map(id => [id, 1]));
    for (let cursor = 0; cursor < layoutQueue.length; cursor++) { const id = layoutQueue[cursor]; for (const child of layoutOut.get(id)) { layoutRank.set(child, Math.max(layoutRank.get(child) ?? 1, layoutRank.get(id) + 1)); layoutDegree.set(child, layoutDegree.get(child) - 1); if (!layoutDegree.get(child)) layoutQueue.push(child); } }
    if (layoutQueue.length !== layoutIds.size) warnings.push('含任务节点的流程出现循环；无法定位的节点已省略。');
    const layoutValid = new Set(layoutQueue), layoutRows = new Map();
    for (const id of layoutQueue) { const row = layoutRank.get(id) ?? 1; if (!layoutRows.has(row)) layoutRows.set(row, []); layoutRows.get(row).push(id); }
    const maxColumns = Math.max(1, ...[...layoutRows.values()].map(row => row.length));
    const contentWidth = maxColumns * width + (maxColumns - 1) * gapX;
    for (const [row, idsAtRow] of layoutRows) {
      const rowWidth = idsAtRow.length * width + (idsAtRow.length - 1) * gapX;
      const rowStart = margin + (contentWidth - rowWidth) / 2;
      idsAtRow.forEach((id, col) => {
      const task = tasks.find(value => id === `$task:${value.id}`);
      if (task) {
        const cardId = `task:${task.id}`;
        add({ id: cardId, kind: 'task', taskId: task.id, label: task.title ?? task.id, status: states[task.phase] ?? task.phase ?? '待开始', x: rowStart + col * (width + gapX), y: margin + row * (height + gapY), agents: foldableTasks.has(task.id) ? agents.filter(agent => agent.task === task.id) : [] });
        taskCards.set(task.id, cardId);
      } else {
        const item = byNode.get(id), task = tasks.find(value => value.id === item.task), taskId = item.task;
        if (foldableTasks.has(taskId)) return;
        const cardId = `workflow:${item.id}`, matching = agents.filter(agent => agent.task === taskId && agent.role === item.role), latest = matching.slice().sort((a, b) => String(a.updated_at ?? '').localeCompare(String(b.updated_at ?? ''))).at(-1);
        const status = !task ? taskId === 'final' ? states[latest?.state] ?? (latest ? '待观察' : '等待全部任务') : states[latest?.state] ?? (item.role === 'planner' ? '按需规划' : '阶段结束时记录') : stageStatus(task, item.role);
        add({ id: cardId, kind: 'stage', taskId, role: item.role, label: item.label ?? labels[item.role] ?? item.role, taskLabel: task?.title ?? task?.id ?? taskId, status, x: rowStart + col * (width + gapX), y: margin + row * (height + gapY), agents: matching });
        visibleStageIds.set(item.id, cardId); visibleStageIds.set(`${taskId}:${item.role}`, cardId);
      }
      });
    }
    const display = id => id.startsWith('$task:') ? taskCards.get(id.slice(6)) : visibleStageIds.get(id);
    for (const link of layoutEdges) { const source = display(link.from), target = display(link.to); if (source && target) edge(source, target, 'workflow'); }
    for (const id of layoutIds) if (layoutValid.has(id) && !layoutEdges.some(link => link.to === id)) { const target = display(id); if (target) edge(runId, target, 'workflow'); }
    const maxX = Math.max(margin + width, ...nodes.map(node => node.x + width));
    nodes[0].x = (maxX + margin) / 2 - width / 2;
  } else {
    const count = Math.max(1, tasks.length), xOf = index => margin + index * (width + gapX);
    const centerX = margin + (count - 1) * (width + gapX) / 2;
    const hasRunTask = tasks.some(task => task.id === 'run'), hasFinalTask = tasks.some(task => task.id === 'final');
    const planId = 'system:planner', finalTest = 'system:final-tester', finalReview = 'system:final-reviewer', scribe = 'system:scribe';
    const planAgents = hasRunTask ? [] : agents.filter(agent => agent.task === 'run' && agent.role === 'planner');
    add({ id: planId, kind: 'stage', taskId: 'run', role: 'planner', label: '总体计划', status: states[planAgents.at(-1)?.state] ?? '按需规划', x: centerX, y: margin + height + gapY, agents: planAgents });
    systemStageIds.set('run:planner', planId);
    nodes[0].x = centerX;
    edge(runId, planId, 'workflow');
    const byId = new Map(tasks.map(task => [task.id, task])), dependencies = new Map();
    for (const task of tasks) {
      const refs = task.dependencies ?? task.depends_on ?? [], validRefs = [];
      for (const ref of refs) {
        if (!byId.has(ref) || ref === task.id) { warnings.push(`任务 ${task.id} 依赖 ${ref} 不存在或无效。`); continue; }
        if (!validRefs.includes(ref)) validRefs.push(ref); else warnings.push(`任务 ${task.id} 的依赖 ${ref} 重复。`);
      }
      dependencies.set(task.id, validRefs);
    }
    const pending = new Map(tasks.map(task => [task.id, dependencies.get(task.id).length]));
    const ready = [...pending].filter(([, degree]) => degree === 0).map(([id]) => id), ranks = new Map(ready.map(id => [id, 0]));
    for (let cursor = 0; cursor < ready.length; cursor++) {
      const parent = ready[cursor];
      for (const task of tasks) if (dependencies.get(task.id).includes(parent)) {
        ranks.set(task.id, Math.max(ranks.get(task.id) ?? 0, (ranks.get(parent) ?? 0) + 1));
        pending.set(task.id, pending.get(task.id) - 1);
        if (pending.get(task.id) === 0) ready.push(task.id);
      }
    }
    if (ready.length !== tasks.length) warnings.push('任务依赖包含循环；循环部分按首层展示。');
    for (const task of tasks) if (!ranks.has(task.id)) ranks.set(task.id, 0);
    const step = height + gapY, taskStartY = task => margin + (2 + (ranks.get(task.id) ?? 0) * 6) * step;
    tasks.forEach((task, index) => {
      const taskNode = `task:${task.id}`, x = xOf(index), y = taskStartY(task);
      const taskAgents = agents.filter(agent => agent.task === task.id);
      const details = collapsed.has(task.id) ? taskAgents : taskAgents.filter(agent => !['planner', 'dev', 'tester', 'reviewer'].includes(agent.role));
      add({ id: taskNode, kind: 'task', taskId: task.id, label: task.title ?? task.id, status: states[task.phase] ?? task.phase ?? '待开始', x, y, agents: details });
      const parents = dependencies.get(task.id);
      const activeParents = parents.filter(parent => (ranks.get(parent) ?? 0) < (ranks.get(task.id) ?? 0));
      if (!activeParents.length) edge(planId, taskNode, 'workflow');
      for (const parent of parents) {
        if (!activeParents.includes(parent)) { warnings.push(`循环依赖边 ${parent} → ${task.id} 已省略。`); continue; }
        edge(collapsed.has(parent) ? `task:${parent}` : `stage:${parent}:reviewer`, taskNode, 'dependency');
      }
      if (collapsed.has(task.id)) return;
      let previous = taskNode;
      for (let index = 0; index < ['planner', 'dev', 'tester', 'reviewer'].length; index++) {
        const role = ['planner', 'dev', 'tester', 'reviewer'][index];
        const id = `stage:${task.id}:${role}`;
        const evidence = agents.filter(agent => agent.task === task.id && agent.role === role).sort((a, b) => (a.attempt ?? -1) - (b.attempt ?? -1) || String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')));
        add({ id, kind: 'stage', taskId: task.id, role, label: labels[role], status: stageStatus(task, role), x, y: y + (index + 1) * step, agents: evidence });
        visibleStageIds.set(`${task.id}:${role}`, id);
        edge(previous, id, 'workflow'); previous = id;
      }
    });
    const leaves = tasks.filter(task => !tasks.some(child => dependencies.get(child.id).includes(task.id) && (ranks.get(child.id) ?? 0) > (ranks.get(task.id) ?? 0)));
    const finalY = Math.max(margin + step * 3, ...tasks.map(task => taskStartY(task) + 5 * step));
    const finalTestAgents = hasFinalTask ? [] : agents.filter(agent => agent.task === 'final' && agent.role === 'tester'), finalReviewAgents = hasFinalTask ? [] : agents.filter(agent => agent.task === 'final' && agent.role === 'reviewer'), scribeAgents = hasRunTask ? [] : agents.filter(agent => agent.task === 'run' && agent.role === 'scribe');
    add({ id: finalTest, kind: 'stage', taskId: 'final', role: 'tester', label: '整体验证', status: states[finalTestAgents.at(-1)?.state] ?? '等待全部任务', x: centerX, y: finalY, agents: finalTestAgents });
    add({ id: finalReview, kind: 'stage', taskId: 'final', role: 'reviewer', label: '整体评审', status: states[finalReviewAgents.at(-1)?.state] ?? '等待整体验证', x: centerX, y: finalY + height + gapY, agents: finalReviewAgents });
    add({ id: scribe, kind: 'stage', taskId: 'run', role: 'scribe', label: '统一记录', status: states[scribeAgents.at(-1)?.state] ?? '阶段结束时记录', x: centerX, y: finalY + 2 * (height + gapY), agents: scribeAgents });
    systemStageIds.set('final:tester', finalTest); systemStageIds.set('final:reviewer', finalReview); systemStageIds.set('run:scribe', scribe);
    for (const task of leaves) edge(collapsed.has(task.id) ? `task:${task.id}` : `stage:${task.id}:reviewer`, finalTest, 'workflow');
    edge(finalTest, finalReview, 'workflow'); edge(finalReview, scribe, 'workflow');
  }
  // A call edge is shown only when both observations exist and the child's
  // parent_id exactly matches an observed native/context/session identifier.
  const observedStage = agent => {
    if (Array.isArray(workflowNodes) && workflowNodes.length) return visibleStageIds.get(`${agent.task}:${agent.role}`) ?? visibleStageIds.get(`workflow:${agent.task}:${agent.role}`);
    if (tasks.some(task => task.id === agent.task)) return visibleStageIds.get(`${agent.task}:${agent.role}`);
    return systemStageIds.get(`${agent.task}:${agent.role}`);
  };
  for (const child of agents) {
    const parentId = child.context?.parent_id;
    if (!parentId) continue;
    const parent = agents.find(agent => agent !== child && [agent.native_id, agent.context?.id, agent.session_id].includes(parentId));
    if (!parent) continue;
    const parentStage = observedStage(parent), childStage = observedStage(child);
    if (parentStage && childStage) edge(parentStage, childStage, 'call');
  }
  const maxX = Math.max(margin + width, ...nodes.map(node => node.x + width));
  const maxY = Math.max(margin + height, ...nodes.map(node => node.y + height));
  return { nodes, edges, width: maxX + margin, height: maxY + margin, warnings: [...new Set(warnings)], theme: { accent: '#3b82f6', radius: 10, space: 12, font: 13, indent: 14, roleColors: { planner: '#818cf8', dev: '#34d399', tester: '#fbbf24', reviewer: '#c084fc', scribe: '#60a5fa' } }, legend: [{ kind: 'workflow', label: '阶段交接' }, { kind: 'dependency', label: '任务依赖' }, { kind: 'call', label: '真实代理调用' }] };
}
