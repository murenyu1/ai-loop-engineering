# AI Loop Engineering

4.1 支持 Codex 全局插件、分页记忆、带代码定位的交接与中断恢复。保留 Codex / Claude Code 项目安装方式和原生子代理配置；新增全局默认、项目模型覆盖及恢复默认。实际模型和原生加载仍须单独验收。

## Codex 安装一次，所有本地项目可用

推荐 Codex 用户使用插件，不必再把源包复制进每个目标项目。Node.js ≥18，无第三方依赖。在源包目录执行：

```text
node scripts/build-plugin.mjs
node scripts/install-plugin.mjs --project .
node scripts/install-plugin.mjs --project . --apply
```

最后一步应由正常用户宿主进程执行，安装器会先检查 Windows 所有者，再调用 Codex 原生插件管理命令注册用户级市场和安装插件；不手改缓存或 settings.json。CLI 不在 PATH 时自动定位 Windows 桌面版，也可用 AI_LOOP_CODEX_CLI 指定真实程序路径。

安装后新开项目聊天，发送“使用 AI Loop 工作流继续当前项目”或“打开 AI Loop 模型设置”。插件按需加载，项目只保存自己的 `.ai-loop/`；各项目任务、记忆和报告互不混用。首次全局模型分工需选择模型/思考强度，以后所有项目复用；可随时说“把开发代理改为 MODEL、思考深度 high，仅当前项目”或“当前项目恢复全局模型设置”。

也可以直接从 GitHub 安装：

```text
codex plugin marketplace add https://github.com/murenyu1/ai-loop-engineering
codex plugin add ai-loop-engineering@ai-loop-engineering
```

本仓库包含可直接安装的 plugins/ai-loop-engineering；plugin/ 是维护模板，scripts/build-plugin.mjs 从当前源包生成并核对摘要。仅打包运行必需文件，不含个人配置、任务记录、日志或测试夹具。GitHub 市场目录在 .agents/plugins/marketplace.json。

旧项目保留原来的 .ai-loop/runs 和 memory。插件首次使用先预演初始化，不删除旧部署或规则；旧入口与项目模型优先级需要核对。旧版本脚本不能写新版 schema 2 记忆，先升级/迁移当前入口，避免混用。跨聊天会先读摘要、未关闭工作单元和必要改动，无法恢复尚未落盘的讨论。

Windows 配置前用 `node scripts/windows.mjs inspect --project 目标项目`；发现受保护目录由沙箱账户拥有时先备份并针对性修复，不能批量重置 ACL。插件减少项目 .codex 写入，但不能保证 Codex 或系统权限永远不出现故障。

以下章节介绍保留的逐项目安装方式；插件用户不需要再执行。

安装、原生角色发现、真实调用、实际模型与界面显示需要分层验收。Codex 项目信任、Claude 第三方模型映射与客户端重载条件会影响运行；文件检查通过不代表全部能力已经生效。

可复制到开发项目中的通用 AI 开发闭环：**计划 → 实现 → 验证 → 评审 → 修复**。按任务风险分级，按阶段读取角色，限制无效重试，通过持久状态恢复任务。

核心协议统一维护，各 harness 使用独立的原生加载入口。根 `AGENTS.md` / `CLAUDE.md` 保存项目规范，工作流部署到 `.codex`、`.claude`、`.cursor`、`.pi` 等子目录，不占用 `/init` 的根文件。

## 一次配置当前工具

新建目录和进行中的项目采用同一种放置方式：把完整 `ai-loop-engineering/` 文件夹复制到**目标项目的子目录**，然后在**目标项目根目录**打开 AI。不要在源包目录中配置，也不要只复制 README。目录示例：

```text
你的项目/                       ← 在这里打开 AI、执行本文命令
├── ai-loop-engineering/        ← 完整源包
│   ├── README.md
│   ├── SETUP.md
│   └── ...
└── 现有源码、项目规则等          ← 新建目录可以暂时没有
```

在 **AI 聊天输入框**发送以下提示词；这不是终端命令：

> 请读取 `./ai-loop-engineering/SETUP.md`，为当前目标项目按 **codex** 的规范配置完整 AI Loop 工作流，包括原生子代理和逐角色模型分工。先检查已有项目规则与配置，让我选择主代理和各子代理的模型、思考强度及并发数，再预演并按确认结果应用。保留现有源码、项目规范和运行记录；遇到配置冲突先展示具体原因与合并方案。安装后分别报告文件一致性、原生角色发现、真实调用、实际模型证据和界面显示，不把文件安装成功当作全部验收通过。

Claude Code 用户把提示词中的 **codex** 改为 **claude-code**。已有明确的模型选择时可以在同一条消息里给出，不需要重新问一遍。基础入口安装与完整多代理安装不同：**不启用模型分工的普通 install 命令不会生成原生子代理或 ai-loop 技能**。

Cursor、Pi、DSH 和 generic 当前只支持工作流入口，不能按这两个平台的方式配置原生多模型子代理。使用这些工具时，把提示词改为“仅配置工作流入口”，并核对具体工具名与版本；能力不足时应明确报告。安装步骤与冲突处理见 [SETUP.md](SETUP.md)。默认不修改 settings.json，不安装依赖、插件或 hook。

配置后再检查启动条件：

1. **Codex**：通过原生客户端确认目标项目受信任，再新开会话；未信任时项目配置会被跳过，不能靠反复安装解决。以 `doctor --native` 的配置层诊断为准。[官方加载规则](https://learn.chatgpt.com/docs/config-file/config-basic)
2. **Claude Code**：首次生成 `.claude/agents/` 后新开会话，运行 `/agents` 确认五个 `loop-*` 已发现；已有目录的定义改动通常自动检测，首次创建目录、add-dir 等情形仍需重开。[官方重载说明](https://code.claude.com/docs/en/sub-agents)
3. 在新会话发送：`$ai-loop 请使用原生子代理完成：你的需求`（Codex），或 `/ai-loop 请完成：你的需求`（Claude Code）。也可自然语言明确要求“使用原生子代理按 AI Loop 工作流完成”。lite 小任务允许主代理直接完成；要验收代理调用，请明确要求一次只读子代理任务。
4. 观察真实运行：Codex 子代理面板或 CLI `/subagents`，Claude Code `/tasks`。本地台账是最后观察记录，不等于原生实时面板。

**一次配置只覆盖选定工具。** 换其他工具时再配置对应入口，已有配置互不覆盖；运行记录共享。未知工具与 DSH 默认显式加载，不能保证任意 harness 都自动读取。

## 配置后目录与读取方式

以 Codex 为例：

```text
项目/
├── AGENTS.md                     # 项目规范，可由 /init 生成；安装不创建
├── CLAUDE.md                     # 需要时由项目/Claude 生成；安装不创建
├── .codex/
│   ├── config.toml               # 追加短 developer_instructions，保留其他内容
│   ├── agents/                   # 启用分工时生成 loop-*.toml 原生定义
│   └── ai-loop/
│       ├── AGENTS.md             # 工作流入口，由短提示指向
│       ├── WORKFLOW.md           # 从源包部署，按阶段读取
│       ├── MEMORY.md             # 持久知识与恢复协议
│       ├── ROUTING.md            # 启用分工时生成各角色请求配置与派发规则
│       ├── SETUP.md
│       ├── agents/               # 所需角色按需读取
│       └── scripts/              # 状态工具与接口
├── ai-loop-engineering/          # 原始源包；修改与升级来源
└── .ai-loop/
    ├── install.json              # 平台路径、独立版本、摘要
    ├── memory/                   # 项目知识索引及按需生成的知识文档
    └── runs/<run_id>/            # 状态、计划、交接、检查点与报告
```

| 工具 | 工作流部署 | 原生加载入口 |
|---|---|---|
| Codex | `.codex/ai-loop/` | `.codex/config.toml` 的 developer_instructions → 部署 AGENTS.md |
| Claude Code | `.claude/ai-loop/` | `.claude/rules/ai-loop.md` |
| Cursor | `.cursor/ai-loop/` | `.cursor/rules/ai-loop.mdc`，alwaysApply: true |
| Pi | `.pi/ai-loop/` | `.pi/APPEND_SYSTEM.md` |
| DSH | `.dsh/ai-loop/` | 显式读取 `.dsh/ai-loop/ENTRY.md` |
| 其他工具 | 如 `.mytool/ai-loop/` | 明确指定的子目录 Markdown 入口；默认显式读取 |

放在子目录本身不保证加载。Codex 依靠项目配置短提示，而不是假定 `.codex/AGENTS.md` 自动生效；Claude 只配置项目 rules，不再生成第二份 `.claude/CLAUDE.md`。项目根规范和本平台工作流规则承担不同职责，不需要相互导入。

Codex 需要受信任项目与有效的项目配置；Claude 的 project 指令来源及规则需启用；Cursor/Pi 需要版本支持、相应规则或资源信任。个人 Codex 同名字段、Pi 同名提示可能被项目配置覆盖，安装会检测已知位置的非空内容，先保留再配置；其他配置层与启动覆盖在 SETUP 中核对。

原生子代理：Codex 使用 `.codex/agents/loop-*.toml`，Claude Code 使用 `.claude/agents/loop-*.md`。Codex 子代理面板 / CLI `/subagents` 与 Claude Code `/tasks` 用于观察运行；界面由客户端提供，入口文件不能保证 UI 显示。Cursor/Pi/DSH/generic 当前只适配工作流入口，原生模型分工未实现，不能宣称等价支持。

源包是更新来源，各平台部署是安装器维护的运行副本。正常开发只读取当前平台副本，不重复读取源包、其他平台或全部角色。这减少配置导致的重复加载，不能保证模型绝不重读。

## 各类项目配置方法

### 新建项目或空目录

1. 创建项目目录，把源包复制到子目录，不把源包自身当目标项目。
2. 使用开头的完整配置提示词，明确 harness，选择模型后配置当前工具。
3. 用 `/init` 生成项目根规范；空项目先形成基本结构再初始化通常更有实际内容。也可以先 `/init` 再安装，两种顺序都可。
4. 检查根规范只保存项目信息，不重复粘贴工作流正文或导入原生工作流入口。
5. 完成上文的信任、重开会话和原生角色发现检查，再给出开发需求与验收。安装本身不需要 Git 仓库；不要为了安装而自动初始化 Git。

安装与开发可合并授权：

> 请读取 `./ai-loop-engineering/SETUP.md`，按当前 harness 配置工作流，保留根文件给项目初始化。随后了解项目并按工作流实现：这里填写需求。先按适用规则确认方案与验收。

安装不自动授权应用初始化、依赖安装、Git 初始化、提交或发布；这些按开发任务和现有规则处理。

### 进行中的项目

保留已有源码、未提交修改与根规范，把源包复制进去，发送：

> 请读取 `./ai-loop-engineering/SETUP.md`，按 **codex** 配置完整工作流、原生子代理与模型分工，先让我确认各角色模型与强度。保留根 AGENTS.md / CLAUDE.md、现有源码、未提交修改及已有运行；需要改动原生模型字段时先展示差异。了解当前实现和测试基线，完成加载验收后，再为这项需求创建新运行：这里填写需求。

不需要重跑 `/init`；已有项目规范继续生效。先区分已有测试失败与本次改动引入的问题，明确不能执行的检查和必要回归。此前开发历史不能补写成已通过工作流验证。

### 已完成、已发布或维护期项目

可以只配置入口，暂不创建开发运行：

> 请读取 `./ai-loop-engineering/SETUP.md`，仅配置当前 harness 的工作流，保留项目规范与运行记录，报告变更与实际验证层级。

维护时用新 run_id：

> 请使用本平台 AI Loop 入口，了解现有版本、兼容要求与验证基线，为这项维护需求创建新运行：这里填写需求。

安装不重新认证历史版本，不改写已完成运行。需要完全保持项目文件原样时仅预演；预演不代表已经安装。

### 已有根规范、原生规则或另一套工作流

- 现有根 AGENTS.md / CLAUDE.md 原样保留，不追加新工作流块。
- Codex 保留项目 developer_instructions 既有正文，追加短管理块，其他 TOML 字段和注释保持；Pi 保留已有项目 APPEND_SYSTEM 的块外正文。
- 同名 `.claude/rules/ai-loop.md` / `.cursor/rules/ai-loop.mdc` 若已有未注册内容，停止并展示合并方案，不能覆盖。
- 已部署文件或管理块被人工修改时停止；改动工作流请修改原始源包后升级。
- 其他工作流可能存在审批、角色、停止规则冲突，先明确本次采用的流程，保留旧文件不代表规则自动协调。
- `/init` 对现有文件的处理因工具与版本而异；要求它保留已有规范。生成后核对重复导入，展示差异后在授权内整理。

### 从旧版根入口升级

更新源包前保留其本地修改。schema 1 配置需要迁移：

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --migrate
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --migrate --apply
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
```

迁移验证旧块摘要，备份原清单与入口，仅移除安装器拥有且未被改动的旧管理块。块外项目规范保留；纯工作流根文件删除，为 `/init` 留出位置。备份路径见输出 `.ai-loop/migrations/<id>/`，运行不清零。

为防止移除旧共享块破坏其他平台，迁移会同时配置旧清单中所有已知平台及本次平台，预演中列明。旧 generic/非标准入口需先明确映射；孤立块、损坏记录或人工修改不能直接强制迁移。

## 手动安装与工具切换

Node.js ≥18，无第三方依赖。以下是**终端命令**，都在目标项目根执行。首次安装且已决定使用 balanced 预设时：

```bash
# 预演完整配置
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --model-routing balanced
# 应用同一预设
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --model-routing balanced --apply
# 只读检查
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
# 原生配置层、技能发现与 CLI 版本诊断，不调用模型
node ./.codex/ai-loop/scripts/doctor.mjs --project . --harness codex --probe --native
```

Claude Code 将前三条中的 harness 改为 `claude-code`，诊断命令为：

```bash
node ./.claude/ai-loop/scripts/doctor.mjs --project . --harness claude-code --probe --native
```

`--check` 只验文件一致性。doctor 若显示 `dispatch: blocked` 或原生 `disabledReason`，先处理具体加载问题，不能宣称子代理可运行。即使配置检查通过，仍需原生调用、实际模型与 UI 证据。没有 CLI 时，改用当前客户端的原生诊断并保留未验证项。

**升级时不要重复加 `--model-routing balanced`**，除非您想把全部角色重置为该预设。普通升级不带模型参数，会保留已选配置：

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --apply
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
```

首次安装不带模型参数时，上述命令只安装基础入口。Cursor、Pi、DSH 使用这个基础模式，替换 harness 即可。其他工具先核对具体产品及版本：

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness generic --entry .mytool/rules/ai-loop.md
```

`.mytool` 是独立工具子目录的占位名称；generic 不接受根文件或已知平台目录，不冒充原生自动加载。`auto` 可使用唯一环境提示，但 AI 应优先明确传入已识别的 harness。

切换工具时，在新工具发送 SETUP 配置请求；只新增/更新该工具副本，其他平台保留原版本。继续任务沿用原 run_id、状态与计数。升级多个平台要逐个平台预演和应用，不假定一次升级全部同步。

源包改名或移动后，从新源包路径运行安装器，更新 source 与当前平台副本；部署路径不变。整个项目搬家后核对路径、环境和入口，旧日志不证明新环境检查通过。

## 自己配置与切换各子代理模型

仅适用于已经实现原生适配的 `codex` / `claude-code`。可以在聊天中让 AI 操作，也可以自己执行命令。不要直接编辑生成的角色文件或安装清单，否则后续升级会因人工修改而停止。

| 命令中的 role | 对应职责 |
|---|---|
| main | 主代理：计划、管理、疑难决策与最终验收 |
| planner | 复杂任务计划 |
| reviewer | 独立评审 |
| dev | 开发与修复 |
| tester | 执行测试与收集证据 |
| scribe | 整理项目记忆与交接 |

### 首次自选：逐角色问答

在自己的交互终端执行其中一条；会逐项询问六个角色的模型、强度和并发数，回车保留显示值，完成后应用：

```bash
# Codex
node ./ai-loop-engineering/scripts/models.mjs configure --project . --harness codex --apply
# Claude Code
node ./ai-loop-engineering/scripts/models.mjs configure --project . --harness claude-code --apply
```

去掉 `--apply` 仅预演，预演不会保存问答结果，再次运行会重新询问。AI 的非交互工具不能代替您填写终端问答；此时在聊天里给出选择，让 AI 用下述 JSON 方式预演并应用同一份配置。

当前 balanced 预设如下，您可逐项替换为账户/provider 实际可用的模型；它不是模型支持能力或价格保证：

| 角色 | Codex 模型 / 强度 | Claude Code 模型 / 强度 |
|---|---|---|
| main | gpt-6.1-sol / medium | opus / medium（主会话用原生选择器设置） |
| planner、reviewer | gpt-6.1-sol / high | opus / high |
| dev、tester | gpt-6-luna / high | sonnet / high |
| scribe | gpt-6-luna / high | sonnet / medium |

进行中的 Codex 项目若已有不同的项目级 `model` / `model_reasoning_effort` 或 agents 配置，预设安装会停止覆盖。要保留现有主模型，在自定义配置中把 main 填为现有值；要改动既有冲突内容，让 AI 先展示并确认合并方案。不要通过删除清单或移除规则强行接管。

### 手动填写 JSON：可复用的配置

在目标项目中创建 `.ai-loop/` 目录，把以下内容保存为 UTF-8 的 `.ai-loop/routing-input.json`，再按需修改所有角色的 model / effort：

```json
{
  "schema_version": 1,
  "harness": "codex",
  "concurrency": 3,
  "main": {"model": "gpt-6.1-sol", "effort": "medium"},
  "roles": {
    "planner": {"model": "gpt-6.1-sol", "effort": "high"},
    "reviewer": {"model": "gpt-6.1-sol", "effort": "high"},
    "dev": {"model": "gpt-6-luna", "effort": "high"},
    "tester": {"model": "gpt-6-luna", "effort": "high"},
    "scribe": {"model": "gpt-6-luna", "effort": "high"}
  }
}
```

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --routing .ai-loop/routing-input.json
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --routing .ai-loop/routing-input.json --apply
```

Claude Code 同时将 JSON 的 harness 与命令参数改成 `claude-code`，将模型替换为该平台实际可用的模型。五个子角色必须完整提供；concurrency 为 1–8，Claude Code 中由调度者遵守，并非平台硬限制。JSON 的 `effort: null` 表示省略该字段；Codex main 必须明确强度。这里的 model 必须明确，不能写 inherit。

### 安装后查看与切换单个角色

Codex 示例，预演和应用使用同一组参数：

```bash
node ./.codex/ai-loop/scripts/models.mjs status --project . --harness codex
node ./.codex/ai-loop/scripts/models.mjs set --project . --harness codex --role dev --model gpt-6-luna --effort medium
node ./.codex/ai-loop/scripts/models.mjs set --project . --harness codex --role dev --model gpt-6-luna --effort medium --apply
# 只修改思考强度，保留该角色当前模型
node ./.codex/ai-loop/scripts/models.mjs set --project . --harness codex --role reviewer --effort high --apply
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
```

Claude Code 示例：

```bash
node ./.claude/ai-loop/scripts/models.mjs status --project . --harness claude-code
node ./.claude/ai-loop/scripts/models.mjs set --project . --harness claude-code --role tester --model sonnet --effort medium
node ./.claude/ai-loop/scripts/models.mjs set --project . --harness claude-code --role tester --model sonnet --effort medium --apply
# 换记录员模型，并省略单独的 effort 字段
node ./.claude/ai-loop/scripts/models.mjs set --project . --harness claude-code --role scribe --model haiku --effort inherit --apply
node ./ai-loop-engineering/scripts/install.mjs --project . --harness claude-code --check
```

替换 `--role` 即可配置其他角色；可以只传 `--model` 或只传 `--effort`。Codex 的字段校验接受 minimal/low/medium/high/xhigh/max/ultra，Claude Code 接受 low/medium/high/xhigh/max；**实际支持哪些强度取决于模型和客户端**。CLI 的 `--effort inherit` 对应 JSON 的 null，不保证自动关闭思考。

也可以直接在聊天中说：

> 请把当前项目的 dev 子代理换成 MODEL，思考强度 high；先显示预演，按我确认的结果应用，其他角色不变。

> 请把 tester 的思考强度改为 medium，保留当前模型，后续派发使用。

### 切换何时生效、如何确认

- 配置默认作用于**原生重载后的下一次派发**；已经运行的代理继续原配置，不会因为文件更新而自动换模型。需要立即换时，让主代理在安全边界停止、保存 checkpoint，再以新代理接续同一任务，保留 run_id 和修复次数。
- Codex 未验证热重载时，新开会话再确认角色；Claude Code 在已有 agents 目录中通常自动检测更新，首次创建目录等情形须重开。确认后才开始下一次派发。
- 修改 `main` 不会追溯切换当前主会话。Codex 用原生模型选择器核对；Claude 的 main 只保存调度建议，实际主模型/强度需用原生 `/model` 等入口设置。
- `models status` 显示请求配置，不证明实际模型。用原生调用结果、模型日志和运行面板核对。第三方兼容服务可能把 opus/sonnet/haiku 都映射到同一后端；不同别名不等于不同模型。还需检查 FORCE / EFFORT 环境覆盖，详见 SETUP。

## 当前会话、新会话与中断恢复

| 时机 | 读取内容 |
|---|---|
| 安装/升级/迁移 | 原始源包 SETUP.md、项目规范、当前平台配置 |
| 当前会话安装完成 | 显式读取本平台入口、部署 WORKFLOW.md 的入口与当前角色 |
| 后续新会话 | 原生入口加载短提示，bootstrap 与项目知识索引，再按请求读取任务和资料；未验证自动加载时显式读取 |
| 切换阶段 | 当前角色与必要输入；已有同版本内容直接复用 |
| 恢复同一任务 | continue 启动发现、status、交接检查点、当前计划及必要证据 |
| 排查问题 | 相关报告、差异及必要源码，不全量回灌历史 |

Codex 显式启动示例：

> 请读取 `.codex/ai-loop/AGENTS.md`，按工作流处理：这里填写需求。

Claude 使用 `.claude/rules/ai-loop.md`，Cursor 使用 `.cursor/rules/ai-loop.mdc`，Pi 使用 `.pi/APPEND_SYSTEM.md`。DSH/generic 在新会话中明确给出各自入口，直到有可靠原生注入且已验证。

恢复示例：

> 请使用本平台入口恢复运行 `这里填写 run_id`。先核对状态、session.md、当前快照与证据，再继续未完成步骤，保留修复次数。

新需求使用新运行；普通阻塞解决后按协议恢复，权限拒绝或明确停止的运行不能直接恢复。

## 项目记忆与任意新聊天

新版保留记录员 loop-scribe，并维护所有工具共享的项目知识。入口要求新会话首次处理项目相关请求时运行 bootstrap、读取短知识索引，再按需读取架构、决策、经验与当前任务。你可以直接说：

> 继续这个项目的开发。请先核对项目记录和未完成任务。

唯一可继续任务会被定位；多个候选列出选择；新需求新建运行，普通问答不启动开发。已完成/停止运行不重开，工具切换不清零计数。继续执行前仍核对真实源码与证据。

```text
.ai-loop/
├── memory/
│   ├── index.md            # 简短项目概览、重要约束、资料索引
│   ├── catalog.json        # 脚本维护的结构化知识与版本
│   ├── architecture.md     # 按实际需要创建
│   ├── decisions.md        # 决策、原因、撤销路线
│   ├── lessons.md          # 可核对经验
│   └── history/            # 被替换正文的备份
└── runs/<run_id>/
    ├── state.json          # 权威进度与计数
    ├── session.md          # 任务背景、未决问题、下一步
    ├── checkpoint.json     # 消费游标与交接 hash
    ├── handoffs/           # 旧交接备份
    ├── events.jsonl
    └── reports/
```

安装只创建空事实的索引模板，AI 根据实际项目和用户确认整理知识。接入进行中项目先建立可观察基线，不能猜出未保存的历史讨论。旧 .ai-loop/lessons.md 备份后迁移到 memory/lessons.md；新旧文档内容不同时停止合并，迁移不代表旧结论已验证。旧运行缺 checkpoint 时保留 session，补读并整理，不重建状态。

重要需求、约束与决策确认后立即保存短事件；阶段成果、阻塞、交付后批量整理知识与交接。换聊天、换工具、压缩前保存完整检查点；你也可以直接说“保存项目知识和当前交接，我要开新聊天”。普通工具调用不反复启动记录员。

知识标明确认/观察/待核对/已撤销，保留来源和适用范围。索引保持短，长日志与历史报告保留指针，详细资料按主题检索。来源变化、正文手改、事件未整理或引用缺失会被标出。

记录员是跨平台职责；支持且授权子 agent 时可独立执行，否则主 AI 执行。脚本保证结构、路径和基线校验，不能保证模型已记录所有重要聊天内容。恢复限于已落盘资料；尚未保存的信息无法保证恢复，自动入口加载仍需实际平台验收。

使用契约见 [MEMORY.md](MEMORY.md)，命令与输入见 [脚本接口](scripts/README.md)。源包更新后，为正在使用的每个 harness 分别预演和应用升级，不能假定旧部署会获得新入口。

## 特殊情况与验证范围

源包维护验证命令：

```bash
node tests/all.mjs
```

自动测试覆盖新目录/已有项目的 Codex 与 Claude Code 安装、启动读取、自定义 JSON、模型与强度切换、升级保留设置及脚本证据闭环。测试不会调用真实模型或观察原生 UI；受环境限制而跳过的用例必须如实报告。

手动原生验收脚本 `tests/native-smoke.mjs` 可复用，但不在默认测试中运行；使用方法见 `node tests/native-smoke.mjs --harness codex --inspect`（只读检查本地协议）或把命令改为 `--harness codex` / `--harness claude-code`（实际模型调用）。临时现场生成在 `.validation/`，不作为发布源码保留。真实运行仍需逐层核对项目加载、模型映射、实际强度和 UI，不以固定日期的历史报告替代当前环境验收。

单仓库先确定仓库统一根还是子项目边界，读取上级规则，不混用两套运行目录；子项目安装要求源包位于该子项目内。非 Git 项目也能使用文件快照，不自动初始化 Git。

没有 Node.js 时说明脚本未运行，用户明确选择指令模式后显式读取源包协议与角色，手工记录；不声称脚本校验或强制次数门已经生效。冲突、符号链接、路径越界和锁冲突时停止并保留现场，不通过删除清单、换工具或入口绕过。

`--check` 只证明文件配置一致；显式读取、平台新会话加载、真实任务执行分别验收。未实测的平台、独立上下文、测试和 token 数值不能宣称已经验证。实际加载条件与验收步骤见 [SETUP.md](SETUP.md)，状态接口见 [scripts/README.md](scripts/README.md)。

快照排除 `.git/`、`.ai-loop/`、原始源包及已注册平台部署正文；根规范与部署外的原生配置/规则仍参与快照。证据仅覆盖声明范围，升级核心或改变环境后需评估旧证据适用性。

## 源包结构与质量成本

```text
ai-loop-engineering/
├── README.md / SETUP.md       # 使用与配置
├── AGENTS.md / CLAUDE.md      # 源包维护规范，不复制成项目根入口
├── WORKFLOW.md / MEMORY.md   # 开发与记忆协议的维护来源
├── agents/                   # 5 个角色，按需读取
├── scripts/                  # 安装器、适配器、状态工具
├── templates/                # 初始知识索引模板，不填充虚构事实
├── tests/                    # 源包校验，不部署到各平台
└── commands/orchestrate.md   # 可选 Claude 命令壳，默认不安装
```

小任务走短流程；跨模块与高风险任务增加计划和检查。共享角色不是原生代理定义，独立评审须有真实独立执行者，否则明确自检或待复核。持久状态避免重复派发，证据绑定快照，代码没变且证据完整时复用检查。

节省 token 需要同类任务比较实际总输入输出、返工、耗时及成功率，不承诺固定比例。

## 机制参考

- [Codex 配置参考](https://developers.openai.com/codex/config-reference/) 与 [项目配置](https://developers.openai.com/codex/config-basic/)
- [Claude Code memory 与项目 rules](https://code.claude.com/docs/en/memory)
- [Cursor project rules](https://cursor.com/docs/rules)
- [Pi 项目配置与追加提示](https://pi.dev/docs/latest/configuration)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；此包不宣称其自动注入已经确认
- [Superpowers](https://github.com/obra/superpowers)、[wshobson/agents](https://github.com/wshobson/agents)、[GSD Core](https://github.com/open-gsd/gsd-core)、[Aider 仓库索引](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md)

借鉴按需加载、证据验证、短流程和上下文预算，不以热度代替实测，也不要求一并安装其他框架。
