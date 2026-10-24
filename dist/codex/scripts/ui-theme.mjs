// 两端共享视觉语义；宿主主题负责背景与文字对比度。
export const UI_THEME = Object.freeze({ accent: '#3b82f6', success: '#22c55e', danger: '#ef4444', warning: '#eab308', radius: 10, space: 12, font: 13, indent: 14, graphNodeWidth: 220, graphNodeHeight: 104, graphGapX: 32, graphGapY: 36, graphRoles: Object.freeze({ planner: '#818cf8', dev: '#34d399', tester: '#fbbf24', reviewer: '#c084fc', scribe: '#60a5fa' }) });
export const UI_PAGES = Object.freeze(['工作流配置', '工作流看板']);
export function themeCss() {
  const values = Object.entries(UI_THEME).filter(([, value]) => typeof value !== 'object').map(([name, value]) => `--loop-${name}:${typeof value === 'number' ? value + 'px' : value}`);
  for (const [role, color] of Object.entries(UI_THEME.graphRoles)) values.push(`--loop-role-${role}:${color}`);
  return values.join(';');
}
