# 配置 AI Loop Engineering

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

正常安装不创建、追加或删除项目根规范；不修改 settings.json、原生代理、hook、权限、模型或 Git。部署文件不要手改；修改源包后预演升级。不要从部署副本反向安装，以清单 source 定位原始源包。

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

脚本不调用模型，loading 始终是 unverified，不伪造平台实测。无法观察自动加载时标注未验证并显式启动，例如：

> 请读取 `.codex/ai-loop/AGENTS.md`，按工作流处理：这里填写需求。

Claude/Cursor/Pi 使用表中各自入口。DSH/generic 每次新会话显式给入口，除非已经验证可靠的原生注入。

运行产物统一在项目 `.ai-loop/runs/<run_id>/`。恢复请求用 bootstrap --intent continue 发现运行：用户指定优先，唯一候选定位，多个候选先澄清。先 status 与 session/checkpoint，再按需读计划、报告；交接过期先合并，实际源码与证据仍需核对，新需求创建新运行。跨工具沿用原 run_id、修复计数与证据，切换工具不会使 self 变成 independent。开发期间只使用当前平台部署中的脚本和角色，升级才读原始源包。安装后在已有授权内基于实际资料建立项目知识、保存交接；索引模板存在不代表语义整理完成。

## 没有 Node.js

说明脚本未运行，不自行下载运行时。用户明确选择指令模式后，显式读取原始源包 WORKFLOW.md 与当前角色，手动维护产物；轮数、状态和证据门仅为指令约束，不声称脚本安装或强制校验已经通过。仍遵守 deny 和审批规则。
