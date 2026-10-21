---
name: ai-loop
description: 在已启用项目中使用 AI Loop 工作流开发、测试、独立评审、记录和恢复任务。
---

# DSH AI Loop 工作流

共享核心目录：`{{CORE}}`。它是插件资源，不是目标项目。项目根目录取 DSH 会话原始工作区，只在 `.ai-loop/` 保存项目运行数据。安装插件不会自动启用任意项目；总开关与精确路径项目开关均须启用。

1. 项目规则、权限和用户要求优先。命中 deny 立即停止，不切换工具、代理、权限或平台绕过；修改 settings.json 前取得具体许可。已有方案确认不重复询问。
2. 先读共享核心 `WORKFLOW.md`、`MEMORY.md` 和当前阶段角色，按阶段读取。区分明确新需求、继续既有任务和只读检查，不能发现唯一任务就擅自执行。
3. 通过 DSH 原生 read、write、edit、pwsh/bash 等工具读取与更新项目资料、运行核心脚本，保留其审批与沙箱。核心命令为 `node "{{CORE}}/scripts/memory.mjs" bootstrap --project ROOT --intent new|continue|inspect`。索引缺失时按 MEMORY.md 和脚本帮助在已授权范围初始化资料；不复制工作流资源或改项目根规范。不要调用 Codex 专属 plugin.mjs、settings MCP 或 CLI。
4. 恢复只读取必要 state/session/checkpoint、未关闭工作单元和游标之后事件；核对文件与验证的适用性，保留中断记录。重要工作单元按 `loop.mjs progress` 保存 planned 与 done/blocked，阶段结束保存交接。
5. standard/full 且当前任务已授权子代理时使用 `ai_loop_delegate`，角色是 planner、dev、tester、reviewer、scribe。它使用 DSH 原生 spawn 创建真正独立上下文，模型由插件设置决定；任务需完整自包含，包含文件范围、授权、验收要求和关键路径。独立评审不能用主代理自检冒充。lite 或用户要求单代理时直接执行并如实标记。
6. 原生结果自动回传；用 DSH 原生 send_message/list_agents 等可用控制工具协作。遵守插件项目并发与 DSH 原生容量上限。角色子代理不得继续派发；其原生审批策略为 never，遇到需要审批的操作交回主代理，不能另起宿主进程绕过。
7. 需要调整开关、角色模型或并发时加载 ai-loop-models 技能。未知模型、provider、强度必须说明错误，不静默替换。运行时只报告实际可获取的模型和验证结果，无法获取 token 数值就明确标记不可用。
