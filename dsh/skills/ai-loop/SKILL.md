---
name: ai-loop
description: 在已启用的项目中使用 AI Loop 工作流进行任务规划、开发、测试验证、独立评审、记录与跨会话恢复。
---

# DSH AI Loop 工作流规范

本技能用于在 DeepSeek Harness (DSH) 环境中执行结构化、自包含的 AI Loop 工程开发。
共享核心目录：`{{CORE}}`（为插件资源，非目标项目；目标项目运行数据持久化于项目本地的 `.ai-loop/` 目录中）。

## 核心安全与执行准则

1. **用户与环境限制优先**：命中配置 `deny` 立即停止，严禁切换工具、代理或更改权限绕行。
2. **多文件变更预先确认**：涉及 3 个及以上文件改动时，必须先给出中文实施方案，获得用户明确确认后再编码；已批准且范围未变的任务不重复确认。
3. **设置修改限制**：严禁擅自修改 `settings.json`；如需修改必须事先向用户说明具体内容并获许可。
4. **Git 与记录分工**：
   - Git 负责源码版本管理、分支与代码提交；
   - AI Loop 负责执行状态、意图、架构决策依据、未决问题与独立验证证据链；严禁未经授权擅自提交代码。
5. **项目物理隔离存储**：
   - 单项目运行（指定子项目路径 `project_path` 且非根目录）的数据保存在子项目本地 `<project>/.ai-loop/`；
   - 跨项目或根目录运行保存在工作区根目录 `.ai-loop/`；
   - 恢复与状态查询统一支持 `--project-path` 筛选。

## 会话启动与前运行规划

1. **项目启动核验**：首次处理项目请求时，调用 `node "{{CORE}}/scripts/memory.mjs" bootstrap --project ROOT --intent new|continue|inspect` 读取项目长期记忆与运行状态。
   - `new`：明确的新需求，启动前运行规划；
   - `continue`：延续既有活跃运行（用户明确指定优先，唯一活跃自动定位，多候选请用户选择）；
   - `inspect`：只读了解现状与架构，不启动开发流程。
2. **前运行轻量规划 (Pre-run Planning)**：
   - 复杂或多模块任务在正式冻结运行前，先梳理出任务分解、互斥文件范围（`in_scope`/`out_of_scope`）、依赖拓扑（`depends_on`）、验收标准（`acceptance`）与自动化检查命令（`checks`）；
   - 方案草案向用户呈现并获得确认后，再调用 `loop.mjs create` 创建正式运行，避免生成无效废弃运行。

## 角色分工与执行模式

- **分级模式**：
  - `lite`：简单低风险任务，由主代理单代理闭环完成方案、实现与自检；
  - `standard`：普通功能开发，包含计划、开发、测试与评审；
  - `full`：关键核心或高风险任务，必须通过独立的自动化测试验证与独立评审（`independent`）。
- **角色定位**：
  - `planner`（计划）：运行级角色，输出方案草案与 DAG 任务拆分；
  - `dev`（开发）：任务级角色，遵循最小改动原则，互斥文件范围的任务可并行开发；完成写入后调用 `finish --task ID` 汇聚；
  - `tester`（测试）：任务级角色，在代码快照（`revision`）上执行真实命令并沉淀日志于 `reports/`；
  - `reviewer`（评审）：任务级角色，对代码快照及测试证据进行真实缺陷与风险审查；
  - `scribe`（记录）：运行级共享角色（`task: "run"`），在阶段收敛、交付或会话中断前增量保存长期知识与交接状态。

## DSH 原生子代理派发流程

在 `standard`/`full` 模式下派发已在 DSH 插件设置中开启的角色子代理时，严格遵循以下四步闭环：

```
[1. ai_loop_prepare] ──> 获取一次性凭据及 requested 结构
        │
        ▼
[2. 原生工具记录]   ──> 将 requested 补充当前 revision，调用 activity.mjs record 保存
        │
        ▼
[3. ai_loop_delegate] ─> 传入 execution 参数，DSH spawn 启动独立子代理
        │
        ▼
[4. ai_loop_observe]  ─> 读取真实观察，落盘到 reports/ 并通过 activity.mjs 同步 running/终态
```

- **参数约束**：`run` 与 `task` 必须严格匹配；普通阶段传正式 task id；`run` 级 planner/scribe 传 `task: "run"`；整体验收传 `task: "final"`。
- **批次与凭据**：tester/reviewer 必须传入当前任务的整数 `attempt`（final 传核心 `event_seq`）；凭据一次性有效，不可跨会话复用。
- **叶节点约束**：子代理为叶节点，DSH 原生审批策略为 never，受阻操作由子代理报告回传主代理，严禁子代理再次派发。
- **独立性底线**：独立评审报告必须携带 `execution_id`；若缺少原生执行条件，如实标记为待复核或自检（`self`），严禁口头扮演或冒充独立通过。
- **持续交接**：在工作单元完成、会话中断、更换 Harness 或上下文达到 80% 时，立即生成 `checkpoint.json`，确保无缝续接。
