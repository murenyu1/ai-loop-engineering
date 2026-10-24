# 三版本看板与工作区定位优化交接

状态：本文在开发写入收敛后、最终验收前冻结。最终自动测试和独立评审结果见本机运行 `dashboard-workspaces-20261024` 的 reports；真实宿主验收单列。日期：2026-10-24。

## 已批准目标与边界

用户确认全面检查并优化 DSH 提交 `a297b98` 的看板、历史和动态派发体验，并把此前 DSH 的工作区级入口改进补到 Codex：自动发现工作区、以工作区选择对象，并在宿主提供可靠上下文时定位当前聊天。实施按三版本共享契约、平台分别适配的方案执行。

本轮基准为 `a297b98`（本地 `dev/codex` 与 `dev/dsh` 均以此为 HEAD）。当前改动由主代理负责 `codex/` 及 Codex 定向测试，`dev_dsh` 负责 `core/`、`dsh/` 及其定向测试；生成产物由主代理统一构建。此交接只记录已读到的差异与证据，不代替运行状态文件。

## 已发现问题与当前实现

- DSH 白屏：planner 定位到 `ConversationDashboardView` 展开观察时将对象作为 React 子节点渲染。当前 `dsh/client/index.mjs` 将对象观察格式化为 JSON 文本；最终真实 DSH 渲染回归仍需确认。
- DSH 会话切换：旧实现遇到新聊天工作区未知时会保留前一聊天的 cwd。当前 `ConversationDashboardView` 将 cwd 与 session key 成对保存，并在新聊天未定位时清空，避免沿用旧工作区。
- 派发隔离：`core/scripts/activity.mjs` 的 `dispatchCheck` 现在只接受正式 task id；`recordActivity` 将方向限制为最多 64 字符的展示标签，并按正式任务和角色防止未确认执行者重复登记；已绑定的 `session_id` 不允许更改。planner 指出方向标签不应拆分正式任务或绕过任务锁。任意多方向都须落在有效任务/依赖策略内，最终行为待全量测试与评审确认。
- 共享历史：`core/scripts/dashboard.mjs` 的 `chatHistory` 按宿主和 `context.parent_id` 过滤运行，并分页；未绑定聊天的旧活动只计数，不归属给当前聊天。
- Codex 工作区：`codex/scripts/codex-workspaces.mjs` 的 `readCodexWorkspaces` 只读 Codex 本机项目状态与已登记工作区，校验目录并拒绝符号链接；`native-settings.mjs` 首次读取时按插件工作区定位初选，用户显式选择后不重置选择。
- Codex 聊天定位：`codex/scripts/session-start.mjs` 的 `startupContext` 在可信 `SessionStart` 输入带有效 `session_id` 时输出 `AI_LOOP_CHAT_CONTEXT={root,session}`；`codex/skills/ai-loop/SKILL.md` 要求登记父聊天时使用真实 session，并仅在用户请求看板时将 root/session 原样传入。`settings-server.mjs` 的 runs/status/history 路由接受真实工作区和 session，历史按父聊天隔离。

## 关键限制

Codex 宿主给线程看板入口的空参数请求不含可验证的当前聊天 ID，因此不能凭工作区、插件 cwd、活跃工作区列表或旧缓存推断当前聊天。自动发现的工作区只代表候选根目录；它本身不证明当前聊天归属。缺少 SessionStart 上下文时，看板只能让用户选择工作区并查看工作区运行。旧运行没有父聊天绑定时会留在未归属计数中。

`codex://threads/GUID` 目前只验证了 VM 中的 `ui/open-link` 请求，真实 Codex 宿主打开会话尚未验收。`.ai-loop/runs/dashboard-workspaces-20261024/reports/codex-preview.png` 是测试夹具预览，不是真实宿主截图，也不能证明看板已完全等效 DSH。

## 验证证据

- `.ai-loop/runs/dashboard-workspaces-20261024/reports/native-settings-host.log`：Codex 原生设置定向用例 30/30 通过，耗时约 63.7 秒。
- `reports/codex-protocol.log`：`tests/settings-server.test.mjs` 定向用例 12/12 通过；`tests/release.test.mjs` 的启动钩子用例 1/1 通过。真实 loop-dev 返回 DSH/核心定向用例 59/59 通过，原生报告存于 `reports/dev-native.json`。
- `.ai-loop/runs/dashboard-workspaces-20261024/reports/build-first.log` 记录 4.6.2 三个包的构建清单与哈希，但该构建早于本轮后续改动，必须在代码收敛后重新构建。
- `.ai-loop/runs/dashboard-workspaces-20261024/reports/codex-targeted.log` 是首轮沙箱运行的旧失败日志：多个配置写入用例触发 Windows 目录所有者保护，主代理报告 38 项中 21 项失败。它不能作为当前实现的回归结果；在满足原生权限约束的验证环境中重跑，或明确记录受限原因。
- 全量 `node tests/all.mjs`、收敛后构建、最终独立评审及真实 Codex/DSH 宿主检查均待完成。不得用上述局部结果声称全量或宿主验收通过。

## 下一步

首次独立评审拒绝了候选，原始报告保存在本机 `reports/review-core.json` 与 `reports/review-codex.json`：DSH 聊天页没有呈现读取错误；Codex 无效上下文别名遮蔽有效原生聊天 UUID；宿主 `ui/open-link` 返回 `isError` 时仍提示已请求打开。修复按原运行的 fix1 继续，不重置计数，需在新快照完成全量验证和独立复评。此前一次验证因 `tests/layout.test.mjs` 遗留临时发行目录使快照变化而记 BLOCKED；现已补自清理，原夹具保留归档，未把旧报告改成 PASS。

1. 等 Codex 与 DSH/core 实现收敛，确认方向调度、历史分页、会话切换和异常显示的实际差异。
2. 汇总并保存定向测试原始输出，运行 `node tests/all.mjs`；按结果修复并重验。
3. 执行 `node scripts/build-release.mjs`，核对 DSH、Codex 与通用包内容。
4. 进行独立代码评审及真实宿主验收，特别检查 DSH 展开观察与换聊天场景、Codex 看板工作区选择和由真实 session 触发的导航。

相关源码入口：`core/scripts/dashboard.mjs`、`core/scripts/activity.mjs`、`dsh/client/index.mjs`、`codex/scripts/codex-workspaces.mjs`、`codex/scripts/native-settings.mjs`、`codex/scripts/session-start.mjs`、`codex/scripts/settings-server.mjs`、`codex/ui/agent-dashboard.html`。
