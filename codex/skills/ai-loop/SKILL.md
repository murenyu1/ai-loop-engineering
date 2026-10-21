---
name: ai-loop
description: 用户要求使用 AI Loop 工作流开发、验证、评审、记录或继续项目任务时使用；项目存在 .ai-loop 记录且本次请求与其有关时恢复必要上下文。普通问答不启动开发，明确的新需求不擅自恢复旧任务。
---

# AI Loop 项目工作流

插件根目录是本 SKILL.md 上两级目录。脚本、角色、协议都从插件根读取，不复制进目标项目。目标项目必须依据当前工作区和用户请求确认，不能把插件根或源包当成目标。项目内只保存 `.ai-loop/` 运行资料。

1. 遵守项目与上级规则、现有权限。deny 立即停止，不换工具、代理、权限模式或平台绕过。修改 settings.json 前必须取得具体许可；安装和模型设置默认不改它。三个及以上文件改动先取得方案确认；已有确认不重复询问。
2. 新聊天首次处理项目相关请求，执行插件 `scripts/memory.mjs bootstrap --project ROOT`，读取共享 `memory/index.md`。若索引不存在，使用 `scripts/plugin.mjs init --project ROOT` 预演，再在已有任务授权内加 --apply 创建必要资料，不安装项目工作流副本，不修改项目 .codex 或根规范。已读同版本资料复用。
3. 用户命令明显延续唯一活跃任务时，用 `bootstrap --intent continue` 定位，不要求用户记住 run_id；明确新需求用 new，普通提问用 inspect。多个候选才澄清；用户明确指定运行优先。不能把“发现唯一任务”当作无条件执行授权。
4. 恢复先读取 state、session、checkpoint 中必要 details，查看 work_units 未关闭单元、游标之后事件；核对实际文件与旧验证适用性。pending 工作单元表示可能中断，不表示代码未改或测试通过。缺失/冲突先合并，保留原记录。任何聊天中尚未落盘的信息不能宣称已恢复。
5. 使用插件 WORKFLOW.md、MEMORY.md 和当前角色。原生 loop-* 已发现、模型已配置且本任务授权使用子代理时，standard/full 按角色执行；独立评审必须是真实独立上下文。首次未配置时使用 ai-loop-models 技能设置一次全局模型。不能用口头扮演或 shell 启动 CLI 冒充原生子代理。
6. 每个有意义的工作单元开始前用 `loop.mjs progress` 保存 planned，变更完成立即保存 done/blocked，重要需求和决策及时记 event。阶段结束再整理 checkpoint；不为每次普通工具调用写文档。交接包含改动文件、符号、原因、优先读取位置。长文档用 memory read/search，不全量加载。
7. 项目已有旧部署时保留其运行、模型和规则，先展示 `scripts/plugin.mjs init` 预演。plugin marker 只改变本次脚本来源，不移除旧入口；旧入口仍可能优先，必要迁移先说明具体差异。不要声称安装插件自动迁移旧项目。
8. 插件 doctor 检查文件完整性、全局模型/项目覆盖、Windows 所有者；原生发现、真实执行、有效模型与 UI 单独核对。Windows 受保护配置由正常用户宿主进程写入，不能在 sandbox 账户中创建后再批量改权限。遇到 OS 权限故障先诊断，修复不绕过配置 deny。

插件命令：`scripts/plugin.mjs init|doctor --project ROOT`；运行/交接接口见 `scripts/README.md`。模型与强度选择、全局默认、项目覆盖和恢复默认使用同插件 ai-loop-models 技能。安装一次不代表每个聊天强制加载，也不授予额外权限。

任务调度使用共享核心的 owner、in_scope/out_of_scope、dependencies 与 ready/blocked_reason；范围未知不并行写入。新任务选择 managed_execution 时，tester/reviewer 报告必须带核心当前角色 attempt 和代码 revision。先确认旧执行者停止再接管，不能只重派。磁盘 mail/inbox 保存语义交接，不替代原生消息、任务状态或真实独立评审。

插件设置直接读取 Codex 本机工作区列表，用户选择只读，应用开关后才保存启用状态，新工作区默认停用；不要求手填路径或单独登记。受信任的 SessionStart 钩子仅为用户启用的精确根目录提供恢复入口，不负责候选发现。必须尊重新命令意图，先恢复必要资料再行动。首次使用恢复入口需在 Codex 原生 `/hooks` 审核并信任钩子，不修改信任缓存或绕过审核。插件设置的实际显示与点击保存仍需在客户端页面验收，不能以自动测试代替。
