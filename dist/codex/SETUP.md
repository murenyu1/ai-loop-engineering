4.6.0 本地候选尚未发布或安装。通用 ZIP 现在包含项目安装适配器及全部依赖，按下文识别 harness 并预演。原生独立运行使用 schema 4 执行证据门，实际调用须在当前会话验收；历史下载链接仅供历史版本。

4.5.0 已作为统一版本发布：[GitHub Release](https://github.com/murenyu1/ai-loop-engineering/releases/tag/v4.5.0)。新配置的五个子代理默认关闭，用户选择模型后启用；现有显式配置保留。Codex 使用统一保存和包内会话看板资源，DSH 使用原生会话插槽。设置页显示、真实模型调用和停止能力须分别在宿主客户端验收；安装不修改 settings.json。4.4.3 及更早下载入口保留为历史版本。

# 配置 AI Loop Engineering

DeepSeek Harness 原生插件见 [dsh/README.md](dsh/README.md)，针对本机 0.2.1-rc.2 接口适配，从共用 `core/` 构建独立 `.tgz`。它与下文旧式 `--harness dsh` 显式入口安装器是两种路径；插件通过 DSH 原生管理器加载，项目只保存 `.ai-loop/`。插件的宿主加载、界面和实际模型调用须分别验收。

Codex 插件 4.5.0 与通用工作流、DSH 插件统一收录在 [v4.5.0 Release](https://github.com/murenyu1/ai-loop-engineering/releases/tag/v4.5.0)，包名和校验文件见仓库 [README](README.md)。历史 4.3.1 通用工作流 / Codex 包、4.4.3 Release 与 DSH 4.3.0 预览包仍保留。Codex 使用插件详情页的原生 `openai/settings` 设置区；原生页面可见性需在实际客户端验收。维护者从仓库 `node scripts/build-release.mjs` 构建；用 `scripts/install-plugin.mjs --project ROOT` 预演、加 --apply 安装。插件提供核心，目标只保存 `.ai-loop/`；不适用下文旧式“源包位于目标内部”的约束。SessionStart 自动入口需要在 Codex 原生 `/hooks` 审核信任。安装成功不等于设置页可见、原生加载或实际模型已验证。

以下为 adapters/project/ 保留的旧式项目安装兼容说明。仓库的共用正文现在位于 core/，根 scripts/ 是兼容命令；安装器会从权威源码生成部署，不能把兼容转发脚本单独复制到目标。通用工作流独立 ZIP 不包含这些平台安装器。

Windows 下安装、生成原生角色和插件注册前做 windows.mjs inspect。受保护目录必须由正常用户宿主进程创建；检查发现 CodexSandboxOffline/Online 身份或异常 owner 时停止配置写入。不要为了安装修改 deny、关闭沙箱或批量重置 ACL。修复仅针对明确异常的目录自身，保留 SDDL 备份，再实测普通沙箱命令。

供 AI 在安装、升级、迁移时显式读取。目标：把通用协议部署到**当前 harness 的项目子目录**，通过其真实入口加载；根 `AGENTS.md` / `CLAUDE.md` 留给项目规则与 `/init`。安装不授予开发、提交或发布权限。

## 1. 定位与识别

1. 确认目标项目根目录与源包真实路径。源包必须在目标内部，目标不能等于源包或位于其内部；本包自己的 AGENTS.md 仅用于源包维护。
2. 读取适用的上级、项目根规范、当前平台已有规则和权限。命中 deny 立即停止，不换工具、入口或指令模式绕过。修改 settings.json 必须先具体说明并获得许可，默认流程不修改它。
3. **用户明确指定 harness 优先**，例如“根据 codex 的规范配置”即选择 codex；否则根据当前会话工具身份识别。已有 `.claude` / `.codex` 目录不能证明当前工具身份。信息矛盾或未知时询问，不猜。
4. 检查 `.ai-loop/install.json` 与现有原生配置，确定首次安装、schema 2 更新，还是 schema 1 根入口迁移。检查可用 Node.js ≥18，不安装依赖或调整权限。
5. 将识别结果显式传入 `--harness`。脚本也支持 `auto`：用户设定的 `AI_LOOP_HARNESS` 优先，其后采用唯一的会话环境提示；没有可靠提示或多个提示时停止，AI 应提供明确参数。环境提示不能代替有效加载验收。

## 2. 原生适配与边界

| harness | 核心部署 | 加载链 |
|---|---|---|
| codex | `.codex/ai-loop/` | `.codex/config.toml` 根级 `developer_instructions` 短提示 → 部署的 `AGENTS.md` → 当前阶段流程 |
| claude-code | `.claude/ai-loop/` | `.claude/rules/ai-loop.md` 无 paths 限制的项目规则 → 当前阶段流程 |
| cursor | `.cursor/ai-loop/` | `.cursor/rules/ai-loop.mdc`，`alwaysApply: true` → 当前阶段流程 |
| pi | `.pi/ai-loop/` | `.pi/APPEND_SYSTEM.md` 追加管理块 → 当前阶段流程 |
| dsh | `.dsh/ai-loop/` | **显式读取** `.dsh/ai-loop/ENTRY.md`；尚未确认原生项目自动注入 |
| generic | 如 `.mytool/ai-loop/` | `--entry .mytool/rules/ai-loop.md`；默认显式读取 |

- 不把 `.codex/AGENTS.md` 或任意子目录的 CLAUDE.md 当作天然全项目入口。Claude 只创建一条项目 rules 链，不同时生成 `.claude/CLAUDE.md`，避免重复加载。
- Codex 项目配置仅在受信任项目生效；核对所用版本、配置层级、profile、命令行覆盖和实际 `developer_instructions`。不修改 `model_instructions_file`，它不是追加入口。
- Claude 核对项目指令来源是否启用、规则是否被排除；Cursor 核对项目规则和 alwaysApply；Pi 核对项目资源信任、重载及个人 APPEND_SYSTEM 的优先级。
- 项目 Codex 字段会覆盖个人同名字段；项目 Pi APPEND_SYSTEM 会取代个人同名文件。安装器检测已知全局位置存在非空内容而项目尚无对应字段/文件时停止。AI 先展示需要保留的有效指令与拟合并内容，在现有授权内将其保留到项目相应位置，再预演。不要自动修改个人配置；其他 profile、启动参数及定制位置仍需人工核对。复制个人指令后，它们不会自动同步个人文件的后续更新。
- 未注册的同名 Claude/Cursor 规则文件不得直接覆盖；先展示差异，明确迁移/合并方法。已注册块或部署正文被人工改动、删除时停止覆盖，不删清单强行接管。
- DSH 必须确认具体产品及版本；有可靠原生机制时再扩展适配器。未知工具用独立子目录的 generic 显式入口，不宣称所有工具都自动加载。

## 3. 预演、安装、检查

在目标项目根执行，源包路径可替换。以 Codex 为例：

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --apply
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
```

首次命令只读预演，列出路径、动作与管理块，不输出已有个人规则全文。展示预演与冲突，按目标项目审批规则处理；已有明确授权覆盖变更时直接完成，不重复请求批准。`--apply` 与 `--check` 不同时使用。

安装器从原始源包复制核心文件与角色、脚本到当前平台部署目录，记录 schema 2 清单及摘要。仅更新当前平台，保留其他平台副本和 `.ai-loop/runs/`；切换工具须为新工具再配置一次。同参数同版本重复安装没有变化。清单的每个平台记录包含独立版本，顶层 version 不表示所有平台已经同步升级。

基础安装不创建、追加或删除项目根规范；默认不修改 settings.json、hook、权限、模型或 Git。选择模型分工时才生成原生代理配置。部署文件不要手改；模型切换使用 models.mjs，协议修改从源包预演升级。不要从部署副本反向安装，以清单 source 定位原始源包。

### Codex / Claude Code 原生代理与模型选择

当用户要求完整多代理工作流时，先询问使用推荐预设还是自定义 main / planner / reviewer / dev / tester / scribe 的模型、思考强度和并发数。展示全部请求值及实际生效边界，不能无声选择模型；已有明确选择不重复问。推荐预设只是起点，不代表账户可用性或成本已经验证。

| 角色 | Codex 推荐 | Claude Code 推荐 |
|---|---|---|
| 主代理 | gpt-6.1-sol / medium | opus / medium（原生选择器设置） |
| 计划、评审 | gpt-6.1-sol / high | opus / high |
| 开发、测试 | gpt-6-luna / high | sonnet / high |
| 记录 | gpt-6-luna / high | sonnet / medium |

主代理应使用可用的强模型；复杂任务可提高主代理强度。自定义可选用户实际可用的模型 ID，不静默替换；模型/强度是否支持、客户端版本、provider 和组织限制仍须原生验收。

用户选定 balanced 后，先预演再应用；Claude Code 替换 harness 参数：

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --model-routing balanced
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --model-routing balanced --apply
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
```

自定义方法：本机交互终端使用源包 `scripts/models.mjs configure --project ROOT --harness HARNESS` 逐项选择；加 --apply 才写入。AI 非交互工具先在聊天收集选择，再通过 `install.mjs --routing .ai-loop/routing-input.json` 预演与应用；完整 JSON 示例见 scripts/README.md。不能在非交互环境默认替用户选定预设。

原生导出与升级：

- Codex：按当前规范生成 `.codex/agents/loop-*.toml`，包含 name、description、developer_instructions、model 和可选 model_reasoning_effort；`.codex/config.toml` 仅管理主模型、强度和全局 agents 设置，不继续生成旧 `[agents.loop-*].config_file` 注册。项目需受信任；不自动授予信任。旧分工的管理块和部署摘要完好时可原地升级，移除清单拥有的旧生成文件；有人改动则停止。依据：[OpenAI 原生子代理规范](https://learn.chatgpt.com/docs/agent-configuration/subagents)。
- Claude Code：生成 `.claude/agents/loop-*.md`，采用 YAML name、description、model、effort 和叶子代理约束；不把共享角色 Markdown 直接当原生定义。主模型由用户用原生 `/model` 设置，不修改 settings.json。当前文档支持 per-agent effort，但旧客户端可能忽略字段，须检查版本与实际日志。依据：[Claude Code 原生子代理规范](https://code.claude.com/docs/en/sub-agents)。
- 两者均生成本部署 `ROUTING.md`；清单保存完整请求配置、摘要和 native_files。后续不带模型选项升级保留自定义选择。已有同名文件、其他文件声明同名代理、未注册 agents 设置或人工修改均停止接管；不覆盖个人配置。
- 同时生成原生调度技能：Codex `.agents/skills/ai-loop/SKILL.md`，Claude Code `.claude/skills/ai-loop/SKILL.md`。技能明确要求 standard/full 使用原生子代理，避免仅靠角色存在推断会自动调用。新会话显式使用 `$ai-loop` / `/ai-loop`，或直接要求使用原生子代理；同名现有技能不覆盖。
- Claude 的 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` 可强制全部代理使用同一模型，`CLAUDE_CODE_EFFORT_LEVEL` 可覆盖 effort；必须检查并告知，不能通过安装器偷偷修改环境或权限。调用参数和设置来源也需核对。
- 用 `claude auth status --text` 核对 provider；第三方兼容服务可能将 opus/sonnet 别名映射到同一后端，此时配置不同别名不等于真正使用不同模型。选择该服务实际支持的模型并取得运行证据，不能自动切换服务、写入密钥或更改 settings.json。

中途切换示例（BUNDLE 使用当前部署 home）：

```text
node BUNDLE/scripts/models.mjs status --project ROOT --harness codex
node BUNDLE/scripts/models.mjs set --project ROOT --harness codex --role dev --model MODEL --effort high
node BUNDLE/scripts/models.mjs set --project ROOT --harness codex --role dev --model MODEL --effort high --apply
```

自然语言提出同样有效，由主代理执行以上操作。配置默认用于原生重载后的下一次派发；当前运行者不因改文件而自动换模型。Codex 未验证热加载时新会话确认；Claude Code 已有 agents 目录通常自动监测，新目录、add-dir 等情形需重开。要求立即切换时先安全停止、checkpoint 并接续原任务，保留运行、修复计数和证据。main 的配置不追溯更改当前会话。详细调度协议见部署 ROUTING.md。

Cursor / Pi / DSH / generic 当前仅适配工作流入口，不宣称已经实现原生子代理、逐角色模型或原生运行 UI；完整多代理请求遇到这些平台须说明缺口，不能生成猜测的配置字段。

### 共享知识初始化与旧资料迁移

首次只创建 `.ai-loop/memory/index.md` 的待整理模板，不假定历史知识或测试已经验证；现有索引和知识保留，不按平台重复创建。启动后 AI 根据当前项目、已有文档与用户确认建立索引，详细文档按需生成，契约见 MEMORY.md。

旧 `.ai-loop/lessons.md` 先备份到输出的 lessons_migration.backup，再迁移到 memory/lessons.md。新旧内容不同时停止，不覆盖或删除任一份；迁移资料默认未索引，先读取并核对，通过 memory save 的 import_existing 建立条目。schema 2 升级不需要 --migrate；该参数只用于 schema 1 根入口迁移。

旧运行继续使用原状态与计数，首次 bootstrap 可提示 missing-checkpoint；读取原 session、相关事件和计划，用 checkpoint 补交接，旧正文留备份。不得重建运行或宣称历史信息已经全部恢复。

## 4. 旧版根入口迁移

schema 1 需要显式 `--migrate`，先预演再应用：

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --migrate
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --migrate --apply
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
```

迁移前验证所有旧管理块摘要。仅移除清单拥有且未被修改的块，**保留块外项目规则**；只有工作流正文的根文件删除，为 `/init` 留出位置。原清单与根文件备份在输出的 `.ai-loop/migrations/<id>/`，已有运行不重建、不清零。

旧入口曾被多个平台共用时，迁移会一次为**所有旧清单中已知平台及本次选择的平台**建立独立入口，否则移除共享块会破坏其他平台。预演必须展示这项例外。旧 generic 或非标准根入口需要明确映射与单独迁移方案，不自动猜测；根孤立管理块、损坏清单、冲突、符号链接和锁冲突均停止并保留现场，不通过换入口绕过。

## 5. 与项目 /init 共存

新项目可以先 `/init` 后安装，也可以先安装后 `/init`；空项目建议形成基本结构后生成有意义的项目规范。已存在根规范时遵从该工具对 /init 的实际行为，要求保留已有内容，不承诺命令必定覆盖或拒绝覆盖。

`/init` 用于项目技术栈、目录、构建、测试、约定；根规范**无需再导入工作流**。生成后检查是否把 `.codex/ai-loop`、`.claude/rules/ai-loop.md` 等重复写进根规范；若发生，展示差异并在授权内去掉重复的工作流正文/引用，保留项目要求。安装器不擅自清理没有自身管理标记的引用。

## 6. 启动与分层验收

安装完当前会话显式读取本平台入口、部署 WORKFLOW.md 入口和当前角色；不是全量读所有角色、源包及各平台副本。新会话按原生机制加载短入口，首次项目相关请求先运行本部署 memory.mjs bootstrap、读取共享记忆索引，再按请求读取资料或开发阶段正文；规则内容若已在上下文中，不重复调用读取。版本/阶段/任务变化时才补必要内容。不能保证模型绝不重复读文件。

| 层 | 验收 | 结果含义 |
|---|---|---|
| 文件结构 | 同参数 `--check` | 本平台文件与源包、摘要和配置一致 |
| 显式读取 | 当前 AI 读取入口、流程与所需角色 | 当前会话能访问内容 |
| 原生加载 | 新会话用工具诊断核对入口；无诊断时区分显式读取 | 仅证明观察到的工具/版本/会话 |
| 执行 | 已授权的小任务、状态、真实日志与证据 | 仅证明该任务的执行结果 |
| 代理与模型 | 原生工具发现 loop-*，真实启动与原生 ID，日志核对实际模型/强度 | 配置请求值与实际值分开；不可观察则 unverified |
| 原生 UI | Codex 子代理面板或 CLI /subagents；Claude /tasks | 仅证明观察到的客户端；任务条目可能完成后消失 |

首次派发前运行本部署 `scripts/doctor.mjs --project ROOT --harness HARNESS`；可加 `--probe` 只读探测 CLI 版本，`--native` 检查 Codex 本地配置层与技能发现、或 Claude 当前 provider。Codex 返回 disabledReason / dispatch_blocked 时先处理原生加载问题，不派发；不自动授予信任。该命令不调用模型、不改变信任或设置，输出独立验收层与原生检查步骤。原生代理工具缺失、角色未发现、模型被覆盖时先报告问题，不把文件完整当作验收成功。本部署 agents.mjs 记录派发和最后观察状态，不能替代 Codex 原生子代理状态界面；schema 与证据示例见 scripts/README.md。

脚本不调用模型，loading 始终是 unverified，不伪造平台实测。无法观察自动加载时标注未验证并显式启动，例如：

> 请读取 `.codex/ai-loop/AGENTS.md`，按工作流处理：这里填写需求。

Claude/Cursor/Pi 使用表中各自入口。DSH/generic 每次新会话显式给入口，除非已经验证可靠的原生注入。

运行产物统一在项目 `.ai-loop/runs/<run_id>/`。恢复请求用 bootstrap --intent continue 发现运行：用户指定优先，唯一候选定位，多个候选先澄清。先 status 与 session/checkpoint，再按需读计划、报告；交接过期先合并，实际源码与证据仍需核对，新需求创建新运行。跨工具沿用原 run_id、修复计数与证据，切换工具不会使 self 变成 independent。开发期间只使用当前平台部署中的脚本和角色，升级才读原始源包。安装后在已有授权内基于实际资料建立项目知识、保存交接；索引模板存在不代表语义整理完成。

## 没有 Node.js

说明脚本未运行，不自行下载运行时。用户明确选择指令模式后，显式读取原始源包 WORKFLOW.md 与当前角色，手动维护产物；轮数、状态和证据门仅为指令约束，不声称脚本安装或强制校验已经通过。仍遵守 deny 和审批规则。
