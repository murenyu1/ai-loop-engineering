# AI Loop 通用工作流 4.7.1

本版本提供共享流程、状态/记忆工具及独立包中的项目安装适配器，安装状态以用户本机为准。原生角色配置、实际调用、有效模型和 UI 必须分别验收。

## 安装与 harness 识别

独立 ZIP 解压后包含 SETUP.md、scripts/install.mjs、scripts/doctor.mjs 及所需依赖，先让当前 AI 读取 SETUP。明确用户指定的 harness 优先，否则按真实会话工具识别，不能看目录名猜测。

按项目部署时，将解压包放在目标项目内的独立源目录，例如 PROJECT/ai-loop-engineering/，目标必须是外层 PROJECT。先预演：

```text
node ai-loop-engineering/scripts/install.mjs --project PROJECT --harness codex
```

用户选定角色模型后，使用 SETUP 的模型分工步骤预演/应用，按项目规则确认。基础安装不自动选模型或启用角色。检查配置后，在当前客户端新会话通过真实原生工具执行只读小任务，保存原生 ID、返回及证据；文件存在和 doctor 通过不能替代实际调用。

| 环境 | 项目安装与原生调度 |
|---|---|
| Codex | 生成原生 TOML 角色与技能；受信任项目中新会话发现 loop-*，使用当前会话原生委派工具 |
| Claude Code | 生成原生 agents 与技能；用当前版本 Agent/Task 等真实工具调用 |
| DeepSeek Harness | 完整调度使用 DSH 插件；通用项目入口本身不提供 spawn 后端 |
| Cursor / Pi / generic | 已有工作流入口适配，原生多代理尚未实现；不能承诺完整多代理验收 |

没有 Node.js 18+ 时只能维护同等字段的指令模式记录，不声称已执行脚本证据门，也不能因此绕过权限。只使用协议时可从固定目录读取 WORKFLOW/MEMORY，但这不等于安装了原生子代理。

## 运行与证据

项目资料写入目标 .ai-loop/。新独立评审运行自动使用 schema 4；报告必须关联本批次 completed 原生观察、不同父子上下文、代码快照和原生证据。整体评审另有 final 执行记录。详见 scripts/README.md。

多项目工作区创建运行声明 project_path 和必要 snapshot_paths，单项目记录保存在子项目 .ai-loop/runs/，跨项目记录保存在工作区根；旧记录保持原位置。用 memory.mjs bootstrap --project ROOT --project-path 子目录 --intent continue 筛选。共享依赖须显式纳入快照，旧记录不自动移动。
