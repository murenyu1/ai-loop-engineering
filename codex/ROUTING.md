# Codex 工作流路由规范

本路由规范定义 Codex 宿主环境下 AI Loop 的原生角色调度、前运行规划、任务拓扑与证据链管理契约。

## 核心分工与前运行核验

1. **环境与可用性核验**：
   - 派发前执行 `scripts/plugin.mjs doctor --project ROOT`；若返回 `dispatch=blocked` 必须停止，报告具体阻塞原因，严禁换入口绕过；
   - 模型路由与思考深度从 `scripts/plugin-models.mjs status --project ROOT` 读取；关闭角色坚决不派发，必要逻辑由主代理闭环。
2. **前运行规划 (Pre-run Planning)**：
   - 复杂任务可先调用运行级 `planner`（`task: "run"`）给出任务拆分与 DAG 依赖草案；
   - 草案经用户明确确认后，再调用 `loop.mjs create` 创建正式 run 并派发任务。

## 角色执行模式与生命周期闭环

在 `standard`/`full` 模式下派发已开启角色时，严格执行四步闭环：
1. **状态预登记**：派发前主代理使用 `activity.mjs record` 登记 `requested` 状态，关联当前 `attempt` 与代码快照 `revision`；
2. **原生启动**：使用会话原生工具启动对应 `loop-*` 子代理，并同步 `running` 状态及真实 `native_id`；
3. **证据落盘**：子代理实际返回日志沉淀到本运行的 `reports/` 目录下；
4. **终态同步**：调用 `activity.mjs` 同步 `completed`/`failed` 状态，并在独立评审报告中绑定真实 `execution_id`。

**关键约束**：
- **终态判定依据**：原生工具返回的执行完毕仅代表子代理进程结束，不等于任务 `PASS` 或评审 `APPROVED`；必须以实际测试报告与代码审查结论为准；
- **执行互斥**：同一 `task` + `role` 严禁并发启动多个未终态执行者；
- **整体验收**：最终整体验收使用专用任务标识 `task: "final"`，attempt 传入核心 `status.event_seq`。

## 任务拓扑与收敛门禁

- **DAG 依赖管理**：多方向任务必须创建独立的正式 task 并声明互斥的 `in_scope` 文件范围；
- **并发写入与串行门禁**：并行开发任务可在各自范围内同时写入；开发停止后调用 `finish --task ID`；全部写入收敛后，测试与独立评审按快照严格串行执行；
- **流程可视化**：`spec.workflow.nodes/edges` 用于展示分支与汇聚拓扑，不替代核心 `depends_on` 依赖、阶段状态与快照门禁；
- **记录角色定位**：`scribe` 为运行级共享角色（`task: "run"`），在阶段收敛、交付前及中断前增量保存关键知识与交接状态；严禁复制源码或整段日志。
