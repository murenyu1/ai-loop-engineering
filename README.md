# AI Loop Engineering

可复制到开发项目中的通用 AI 开发闭环：**计划 → 实现 → 验证 → 评审 → 修复**。按任务风险分级，按阶段读取角色，限制无效重试，通过持久状态恢复任务。

核心协议统一维护，各 harness 使用独立的原生加载入口。根 `AGENTS.md` / `CLAUDE.md` 保存项目规范，工作流部署到 `.codex`、`.claude`、`.cursor`、`.pi` 等子目录，不占用 `/init` 的根文件。

## 一次配置当前工具

把完整 `ai-loop-engineering/` 文件夹复制到**目标项目的子目录**，在目标项目打开 AI，发送：

> 请读取 `./ai-loop-engineering/SETUP.md`，根据 codex 的规范配置 ai-loop-engineering 工作流。

使用 Claude Code、Cursor、Pi 时替换工具名；也可写“根据当前 harness 的规范配置”，AI 根据会话身份选择，不根据已有目录猜测。安装步骤、冲突处理和验收都在 [SETUP.md](SETUP.md)。默认不修改 settings.json，不安装依赖、插件、hook 或原生子代理。

**一次配置只覆盖选定工具。** 换其他工具时再配置对应入口，已有配置互不覆盖；运行记录共享。未知工具与 DSH 默认显式加载，不能保证任意 harness 都自动读取。

## 配置后目录与读取方式

以 Codex 为例：

```text
项目/
├── AGENTS.md                     # 项目规范，可由 /init 生成；安装不创建
├── CLAUDE.md                     # 需要时由项目/Claude 生成；安装不创建
├── .codex/
│   ├── config.toml               # 追加短 developer_instructions，保留其他内容
│   └── ai-loop/
│       ├── AGENTS.md             # 工作流入口，由短提示指向
│       ├── WORKFLOW.md           # 从源包部署，按阶段读取
│       ├── MEMORY.md             # 持久知识与恢复协议
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

源包是更新来源，各平台部署是安装器维护的运行副本。正常开发只读取当前平台副本，不重复读取源包、其他平台或全部角色。这减少配置导致的重复加载，不能保证模型绝不重读。

## 各类项目配置方法

### 新建项目或空目录

1. 创建项目目录，把源包复制到子目录，不把源包自身当目标项目。
2. 使用开头的配置提示词安装当前工具。
3. 用 `/init` 生成项目根规范；空项目先形成基本结构再初始化通常更有实际内容。也可以先 `/init` 再安装，两种顺序都可。
4. 检查根规范只保存项目信息，不重复粘贴工作流正文或导入原生工作流入口。
5. 给出开发需求和验收，按项目规则实施。

安装与开发可合并授权：

> 请读取 `./ai-loop-engineering/SETUP.md`，按当前 harness 配置工作流，保留根文件给项目初始化。随后了解项目并按工作流实现：这里填写需求。先按适用规则确认方案与验收。

安装不自动授权应用初始化、依赖安装、Git 初始化、提交或发布；这些按开发任务和现有规则处理。

### 进行中的项目

保留已有源码、未提交修改与根规范，把源包复制进去，发送：

> 请读取 `./ai-loop-engineering/SETUP.md`，按当前 harness 配置工作流，原样保留根 AGENTS.md / CLAUDE.md 与项目设置。了解当前实现、未提交修改和测试基线，再为这项需求创建新运行：这里填写需求。

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

Node.js ≥18，无第三方依赖。在目标项目根执行：

```bash
# 预演
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex
# 写入
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --apply
# 只读检查
node ./ai-loop-engineering/scripts/install.mjs --project . --harness codex --check
```

替换为 claude-code、cursor、pi、dsh 即配置对应平台。其他工具先核对具体产品及版本：

```bash
node ./ai-loop-engineering/scripts/install.mjs --project . --harness generic --entry .mytool/rules/ai-loop.md
```

`.mytool` 是独立工具子目录的占位名称；generic 不接受根文件或已知平台目录，不冒充原生自动加载。`auto` 可使用唯一环境提示，但 AI 应优先明确传入已识别的 harness。

切换工具时，在新工具发送 SETUP 配置请求；只新增/更新该工具副本，其他平台保留原版本。继续任务沿用原 run_id、状态与计数。升级多个平台要逐个平台预演和应用，不假定一次升级全部同步。

源包改名或移动后，从新源包路径运行安装器，更新 source 与当前平台副本；部署路径不变。整个项目搬家后核对路径、环境和入口，旧日志不证明新环境检查通过。

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
└── tests/                    # 源包校验，不部署到各平台
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
