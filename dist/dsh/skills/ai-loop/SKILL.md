---
name: ai-loop
description: 在已启用项目中使用 AI Loop 工作流开发、测试、独立评审、记录和恢复任务。
---

# DSH AI Loop 工作流

原生派发登记流程：先 ai_loop_prepare 取得当前主会话一次性凭据，将返回输入补充 revision，经原生工具用 activity record 保存；再将返回 id 作为 ai_loop_delegate.execution。凭据在启动前消费，插件重载后失效，旧 requested 不能重派。启动失败/中断须先核对原生执行者，不能自动删除登记。

4.6.0：主/叶角色分开，叶角色只执行已分配任务，不再派发。lite 或用户要求单代理时主代理执行；standard/full 只派发已开启角色，缺少独立 reviewer 时待复核。新证据运行在派发前经原生工具 activity record 登记 requested（含当前 attempt、revision），将其 id 作为 ai_loop_delegate.execution。返回 childId 后调用 ai_loop_observe，保存真实返回到 reports/ 内，通过原生写入/脚本同步 running、context、completed 和 evidence，报告携带 execution_id。插件宿主不直接写项目；未登记/未知终态不能视为完成，冷恢复先核对原生运行时，不删除旧记录重派。整体评审用 task=final、attempt=当前核心 event_seq。

复杂任务可由一个 `run` 级 planner 提出拆分建议，由主代理审定正式任务并统一派发；简单任务直接由主代理计划。`run` 级 task 只派发 planner/scribe，`final` 只派发整体 tester/reviewer。批准 spec 可选 `workflow.nodes/edges` 描述无环流程分支与汇合，供看板呈现；它不代替 depends_on、阶段状态、当前 revision 或证据门禁。多个方向使用独立正式 task 和互斥范围；验证与评审在写入收敛后按快照顺序进行。scribe 默认每个 run 共用，在阶段成果、阻塞和交付时批量记录。只有匹配的原生父子上下文观察能形成真实调用连线。

项目根仍取会话工作区；子项目归属用 spec.project_path，快照默认覆盖该子目录，必要共享依赖用 snapshot_paths。恢复可用 --project-path 筛选，记录保持集中于工作区 .ai-loop/runs/，不额外开启子目录工作区。

共享核心目录：`{{CORE}}`。它是插件资源，不是目标项目。项目根目录取 DSH 会话原始工作区，只在 `.ai-loop/` 保存项目运行数据。安装插件不会自动启用任意项目；总开关与精确路径项目开关均须启用。

1. 项目规则、权限和用户要求优先。命中 deny 立即停止，不切换工具、代理、权限或平台绕过；修改 settings.json 前取得具体许可。已有方案确认不重复询问。
2. 先读共享核心 `WORKFLOW.md`、`MEMORY.md` 和当前阶段角色，按阶段读取。区分明确新需求、继续既有任务和只读检查，不能发现唯一任务就擅自执行。
3. 通过 DSH 原生 read、write、edit、pwsh/bash 等工具读取与更新项目资料、运行核心脚本，保留其审批与沙箱。核心命令为 `node "{{CORE}}/scripts/memory.mjs" bootstrap --project ROOT --intent new|continue|inspect`。索引缺失时按 MEMORY.md 和脚本帮助在已授权范围初始化资料；不复制工作流资源或改项目根规范。不要调用 Codex 专属 plugin.mjs、settings MCP 或 CLI。
4. 恢复只读取必要 state/session/checkpoint、未关闭工作单元和游标之后事件；核对文件与验证的适用性，保留中断记录。重要工作单元按 `loop.mjs progress` 保存 planned 与 done/blocked，阶段结束保存交接。
5. standard/full 且当前任务已授权子代理时使用 `ai_loop_delegate`，角色是 planner、dev、tester、reviewer、scribe。必须从当前状态读取并传入精确 `run` 和 `task`：普通阶段使用正式 task id；run 级 planner/scribe 使用 `task: "run"`；整体 tester/reviewer 使用 `task: "final"`。tester/reviewer 传入该任务当前 attempt，final 取核心 event_seq，run 级 planner/scribe 传入 `0`。核心会拒绝非 active 运行、阶段不符、批次过期和同任务同角色的在途重复派发。只有已在 DSH 模型设置开启的角色能派发。工具使用 DSH 原生 spawn 创建独立上下文；任务需完整自包含，包含文件范围、授权、验收要求和关键路径。独立评审不能用主代理自检冒充。工具返回真实 childId 后，主代理须通过工作流授权的原生记录机制写入 `activity`（初始 `requested`，再按运行时观察更新），不得由插件宿主 fs 直接写项目；旧的非终态观察会阻止再次派发，即使观察已过期也先核对原生状态。lite 或用户要求单代理时直接执行并如实标记。
6. 原生结果自动回传；用 DSH 原生 send_message/list_agents 等可用控制工具协作。遵守插件项目并发与 DSH 原生容量上限。角色子代理不得继续派发；其原生审批策略为 never，遇到需要审批的操作交回主代理，不能另起宿主进程绕过。
7. 需要调整开关、角色模型或并发时加载 ai-loop-models 技能。未知模型、provider、强度必须说明错误，不静默替换。运行时只报告实际可获取的模型和验证结果，无法获取 token 数值就明确标记不可用。
