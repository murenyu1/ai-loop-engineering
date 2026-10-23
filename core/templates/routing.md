4.6.0 独立证据运行用 activity.mjs 登记 requested/running/completed、真实 native_id/context、当前 revision/attempt 和 reports/ 内原生证据。报告 execution_id 绑定本次完成记录；整体评审另用 final 和当前 event_seq。缺少原生工具或角色时待复核，不能只靠角色文件或 execution 字段通过。

## 调度与上下文

本工作流明确要求：已批准的 standard/full 任务只使用用户已开启的原生 loop-* 子代理；新配置默认关闭，关闭角色由主代理完成必要工作，独立评审不可执行时保留待复核。主代理负责需求、计划、调度、难点定位、证据与最终验收；简单 lite 任务可直接处理，不为每个机械步骤启动代理。子代理不得继续派发。最多同时运行配置中的并发数；同一工作区开发、测试与评审按依赖串行，只读研究可安全并行。

启用分工时同时生成原生 ai-loop 技能：Codex `.agents/skills/ai-loop/SKILL.md`，Claude Code `.claude/skills/ai-loop/SKILL.md`。该技能明确请求原生委派，避免仅列出角色却没有调用要求。新会话可显式调用 Codex `$ai-loop` 或 Claude Code `/ai-loop`；也可直接要求“使用原生子代理按 AI Loop 工作流完成任务”。

先运行本部署 `scripts/doctor.mjs --project ROOT --harness HARNESS`；有 CLI 时加 `--probe --native` 检查真实配置层/provider，dispatch=blocked 时停止派发。再用原生工具确认角色已发现。Codex 选择 loop-* 原生角色；只有工具明确支持模型参数且未加载固定角色配置时才显式传入模型/强度，使用新上下文与完整任务包，不依赖全历史 fork 后换模型。Claude Code 使用 Agent/Task 等当前客户端实际提供的原生工具选择对应 subagent_type，不能仅靠 prompt 自称角色，也不以 Bash 启动独立 CLI 代替当前会话的原生子代理。禁止静默降级为同代理自检，独立评审要求不变。

派发任务包包含：项目绝对路径、角色与运行路径、任务编号、目标、owner、in_scope/out_of_scope、批准范围、必要用户/项目/技能规则、输入路径与摘要、依赖、revision、验收命令。managed_execution 任务还包含核心当前 tester/reviewer attempt；返回报告须带同批次，不替换旧报告的编号。仅范围互斥且核心检查通过的开发任务可并行，未知范围串行；验证评审等待写入收敛。只返回角色 JSON 摘要与证据路径，长日志存文件；不复制整段聊天、全部角色和历史。

## 用户选择与中途切换

新配置的五个子代理默认关闭；用户开启后选择模型和强度。显式 balanced 预设仍启用角色。set 支持 --enabled false 或 --model off，off 不作为真实模型；项目显式关闭优先，主会话由宿主选择器控制。不能把推荐值说成已确认值。可用本部署 `models.mjs configure` 的逐项问答，或由 AI 收集选择后提供 JSON；非交互调用必须明确给 preset/input。

用户可随时说“把开发代理换成 MODEL，思考强度 high”。主代理执行 `models.mjs set --project ROOT --harness HARNESS --role dev --model MODEL --effort high` 预演，按已有授权加 `--apply`。支持 main 及五个子角色；`--effort inherit` 省略强度（Codex main 必须明确）。模型支持的强度、账户可用模型须在当前客户端核对，配置校验不证明可调用。

更改默认作用于原生重载后的下一次派发。Codex 固定角色文件会影响模型解析，不能承诺仅传 spawn.model 就覆盖角色；未证实热加载时新会话确认。Claude Code 已有 agents 目录通常监测改动；首次建目录、add-dir 等情形需重开；环境变量与调用参数仍可能覆盖。主代理模型用客户端原生选择器切换；Claude Code 主模型建议不会写 settings.json。

对正在运行的代理：先说明当前执行者保持原配置；用户要求立即切换时，在安全边界停止，保存 checkpoint、已做工作和证据，重载后以新代理接续同任务。用 replaces 关联原记录；不能清零修复计数、重建运行或降低验收。真正支持运行中模型切换的客户端，须有原生调用结果才报告生效。遇到 deny 立即停止，不通过重派或换模型绕过。

执行者遇到架构判断、需求不清或首次针对性修复仍失败时返回 PARTIAL/BLOCKED 与证据；主代理先定位、拆小，再交回执行者。必要升级只针对难点，不把所有角色永久换成强模型，不自动放宽重试预算。

## 运行状态与分层验收

- 原生发现：新会话核对 loop-*。Codex 项目信任、配置层与 profile；Claude Code `/agents`、版本与设置来源。未知版本不承诺兼容。
- 原生执行：真实调用后保存 native_id。Codex 子代理面板或 CLI `/subagents`；Claude Code `/tasks` 查看状态及可用的模型/强度信息。完成条目可能移除，需保存 transcript；界面显示受客户端版本影响。
- 本地台账：通过 `agents.mjs record/status` 记录 requested/running/waiting/completed/failed/stopped、配置摘要和切换关系。主代理在派发、返回、阻塞、停止时更新，并向用户简短说明角色与状态；此文件是最后观察，不冒充实时 UI。
- 模型与界面证据：只记录原生返回/日志/UI 能观察到的模型、强度、可见性，保存项目运行 reports 内的证据；不能要求代理自报“我是什么模型”作为证明。台账仅做证据关联，不自动验证内容语义。无法获得实际模型时保持 unverified。
- 安装 `--check` 只验文件和配置；doctor 不调用模型。必须将配置一致、原生发现、实际执行、模型证据、UI 可见分别报告。测试 PASS/独立评审仍由 loop.mjs 的原证据门控制。

模型和思考强度决定成本与延迟，但无真实用量不能报告节省比例。可靠上下文指标接近 80% 时提醒并保存交接，指标不可得不编造百分比。
