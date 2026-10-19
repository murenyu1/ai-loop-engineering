---
name: ai-loop-models
description: 用户要求查看或方便地修改 AI Loop 子代理的模型、思考深度、并发数、全局默认、项目覆盖或恢复默认时使用。
---

# AI Loop 模型设置

插件根目录是本文件上两级目录。始终在已确认的项目上下文执行插件 `scripts/plugin-models.mjs`，不把源包或插件目录当目标项目。

1. 用 `status --project ROOT` 展示当前有效配置和来源（global / project）；需要模型列表时用 `list` 读取当前 Codex 原生 model/list 的模型和支持强度。列表不可得时询问用户实际可用模型；预设不是可用性证明，不静默替换模型。
2. 用户已明确角色、模型或强度时直接采用；其余保留。否则用简短选择让主人选角色（planner/reviewer/dev/tester/scribe）、模型和思考深度；main 属于原生主会话选择，不声称文件修改会切换当前主模型。并发数可一起选择。
3. 默认修改全局（安装一次，后续项目复用），用户只想影响当前项目时 `--scope project`。先显示当前/拟改配置与范围，已明确选择的普通修改不重复确认。全局设置可能影响后续其他项目派发，应在展示中说明。
4. 单角色：`set --project ROOT --scope global --role dev --model MODEL_ID --effort high`；只改思考深度可省略 model。首次完整配置用 `configure --input JSON`；只有用户明确选择预设时才用 `--preset balanced`。并发用 `set --concurrency N`。默认预演，确认字段符合用户要求后同命令加 `--apply`。
5. `reset --project ROOT --scope project` 预演撤销本工具拥有的项目覆盖，`--apply` 后继承全局。保留备份；不覆盖未登记或人工改动的 loop-* 文件。已有旧项目模型文件发生碰撞时先合并，不能删除它们强行接管。
6. 写入原生 agents 配置必须在正常用户宿主进程中执行，遵守平台审批。遇 deny 停止，不能通过提权绕过。无需修改 settings.json，也不默认修改主模型或全局并发配置。
7. 配置用于原生重载后的下一次派发；当前执行者先安全停止并保存交接。提示新会话核对角色发现，用原生记录检查实际模型/思考强度。配置成功、原生发现、推理生效分别报告，未知保持 unverified。

命令帮助：`node PLUGIN/scripts/plugin-models.mjs --help`。交互终端 configure 可以逐项输入；聊天中由 AI 收集选择，不能运行等待输入的终端向导。
