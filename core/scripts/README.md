# 状态与记忆工具

## 4.6.0 原生执行证据与子项目

新建 `review: independent` 运行自动要求原生证据并使用 schema 4。旧运行保留原契约与历史，`legacy-unverified` 不表示已补验收。参与同一新运行的各端须升级到 4.6.0。

1. 派发前用原生工具写输入 JSON，`activity.mjs record` 登记 requested：`id/task/role/attempt/harness/revision/summary`。独立运行每次进入验证或评审都递增 attempt，即使未声明 managed_execution。
2. 通过宿主原生工具实际启动，登记 native_id 与 `context:{mode:"independent",id:"真实子上下文",parent_id:"真实父上下文"}`，先更新 running。
3. 原生工具观察完成后，把真实工具结果保存为本运行 reports/ 内非空文件，更新 completed 并传入 `evidence:{source:"native-log",path:"reports/native.json"}`，source 也可为 native-runtime/native-ui。核心计算文件摘要。
4. 报告带回 execution_id 和当前 attempt/revision；只有关联同运行/任务/角色/批次且 completed 的独立上下文证据才能通过。未知终态、过期快照、被改写证据均不能独立通过。
5. 所有任务 done 后，用 task=final 登记整体 tester/reviewer；其 attempt 为派发时 status.event_seq。最终独立评审关联 final 执行记录。若核心游标改变须重新取得本批证据，不能改旧编号。

这些是带证据的宿主观察，无法认证由有写权限的调用者自行伪造的工具日志；不可描述成密码学身份认证。真实模型和 UI 不可见时保持 unverified。

运行可声明 `project_path:"子目录"`，默认快照覆盖该子项目；共享依赖用 `snapshot_paths:["子目录","shared"]` 完整列出。所有路径相对工作区，不能越界或跟随链接。`project_path:"."` 为整个工作区。记录仍在工作区 `.ai-loop/runs/`；bootstrap 增加 --project-path 精确筛选，两个看板显示子项目归属。任务 in_scope 用于调度，不替代快照范围。

## 4.5.0 角色策略与代理观察

无配置时五个角色全部关闭。通用工作流使用 `roles.mjs status --project ROOT` 查看；`roles.mjs set --project ROOT --role dev --enabled true --model ID --apply` 明确开启，`--enabled false --apply` 关闭并保留模型。没有 `--apply` 只预演。插件使用自己的原生配置与继承，不能混用另一平台设置。

`activity.mjs check --project ROOT --run RUN --task TASK --role ROLE --attempt N` 先检查通用角色开关，再验证运行、阶段与批次；此命令本身不调用模型。`record --input JSON` 保存 requested/running/waiting/stop_requested/unknown/completed/failed/stopped，首次 requested 必须带 id/task/role/harness/summary。running 需要真实 native_id，同任务同角色尚未停止时不得重复派发。`status` 返回最后观察及过期标记；usage 缺失为 null，不估算 token。

新建运行可声明 `role_policy: {dev:{enabled:true,model:"所选模型"},reviewer:{enabled:false}}`。该策略进入方案摘要且使用运行 schema 3；旧核心拒绝读写，当前核心仍兼容旧运行。独立评审要求不会因角色关闭而降低；配置关闭不会立即终止已在运行的代理，须由原生控制确认。

Node.js 18+，仅标准库。脚本目录以本工作流解压目录为准，`ROOT` 是目标项目真实绝对路径。脚本只管理记录，不会替你执行测试命令、调用模型、提交或发布。项目规则和已批准范围优先。

## 发现与续接

```text
node scripts/memory.mjs bootstrap --project ROOT
node scripts/memory.mjs bootstrap --project ROOT --intent continue
node scripts/loop.mjs status --project ROOT --run RUN
node scripts/loop.mjs events --project ROOT --run RUN --after 0 --limit 20
node scripts/loop.mjs inbox --project ROOT --run RUN --role tester --task task1 --after-id mail-00012
```

bootstrap 返回短状态与候选，不自动执行任务。读取项目 `.ai-loop/memory/index.md`，然后按需读取运行的 session/checkpoint 与关键改动。只有多个候选且用户未指定时才澄清。

## 建立运行

先得到方案确认，把规范写入 JSON 文件：

```json
{"goal":"明确的项目目标","tasks":[{"id":"task1","title":"实现功能","owner":"dev","in_scope":["src/feature"],"out_of_scope":["src/core"],"managed_execution":true,"acceptance":["可验证的验收条件"],"review":"independent","checks":[{"id":"test","command":"项目的真实测试命令","expected_exit":0}]}],"max_fixes":3,"ignore_paths":[]}
```

```text
node scripts/loop.mjs create --project ROOT --run RUN --input 方案.json
node scripts/loop.mjs begin --project ROOT --run RUN --task task1 --phase development
node scripts/loop.mjs finish --project ROOT --run RUN --task task1
node scripts/loop.mjs snapshot --project ROOT --run RUN
```

工作单元前后用 progress --input JSON 保存 `{unit,task,stage,summary,files}`；stage 为 planned / done / blocked，先 planned 后关闭，同一 unit 不重复使用。done 不代表测试通过。

测试和评审报告必须带对应 revision、角色、结果及真实证据；通过 record 保存，最后 complete 绑定最终快照。不得直接改 state.json、清零修复次数或伪造独立评审；详细契约见 WORKFLOW.md 与 agents/loop-tester.md、agents/loop-reviewer.md。

并行任务的开发者完成写入后必须执行 `finish`，确认自己已停止修改文件后再进入 developed 等待验证；验证和评审仍串行进行。单任务可以继续从 developing 直接进入 verification。

任务可选声明 `owner`、`in_scope`、`out_of_scope`。`owner` 仅供协作识别，不构成身份鉴权；`out_of_scope` 是计划说明，不代表已完成范围审计。范围路径可用 `/` 结尾表示目录。开发可并行只在双方都声明非空且不重叠的 `in_scope` 时开放；比较按目录层级和大小写不敏感处理，范围缺失或相交即串行。状态摘要提供 `dependencies`、`ready`、`blocked_reason`、`managed_execution` 和当前 `attempts`；运行停止或完成后待办任务不会显示为 ready。

`managed_execution: true` 为任务启用按角色的执行批次：每次进入 verification / review 会递增对应 tester / reviewer 的 attempt。该角色报告必须带回当前整数 `attempt`，否则或值已过期会被拒绝。未启用该字段的旧任务和旧报告仍按原契约工作。

## 分页记忆与交接

先 inspect 获取当前 revision / hash，save 使用这些字段并发校验。知识正文和长交接由工具完整分片，搜索返回精确 read 参数与游标，不需一次读取全部正文。

```text
node scripts/memory.mjs --help
node scripts/loop.mjs --help
```

MEMORY.md 定义 save / checkpoint 的输入结构、来源、并发处理和分页读取。交接记录变更文件、关键符号、原因与优先读取位置。只有落盘的资料能够跨会话恢复；旧检查须核对当前代码才有效。

## 运行状态兼容

新建运行使用 `schema_version: 2`，旧核心只识别 schema 1，因此会拒绝写入新版运行。当前核心可以读取 schema 1 的历史运行；4.3.1 及更早且不含新版字段的安全旧运行仍可继续写入。候选版 4.4.0 的 schema 1 记录（包括 `owner`、范围、托管执行批次或 `developed` 阶段）仅可读取，写入前须显式迁移。先核实没有旧执行者仍在写入，再运行 `node scripts/loop.mjs migrate --project ROOT --run RUN --confirm-no-active-executors`。迁移在锁内保存原 state 备份，保留 run_id、修复计数、报告与历史事件，并追加迁移事件；不重置或改写任务状态。不要手工改写 state.json 的 schema 或阶段来绕过此门禁。`inbox` 的公开游标参数为 `--after-id`，其值是 `mail-00001` 这类邮件 ID。
