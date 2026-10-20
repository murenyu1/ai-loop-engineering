# AI Loop Engineering

4.4.0 本地候选增加跨平台任务契约、DSH 工作流面板与 Git 交接。候选源码与下列已发布版本分开；真实宿主验收和远端同步状态见 [当前交接](docs/development/workflow-sync.md)。

让 AI 按“计划 → 开发 → 验证 → 评审 → 交接”推进项目，并从已保存的记录恢复中断任务。当前源码候选版本为 **4.4.0**，通用核心需要 Node.js 18+，不依赖第三方 npm 包；原生插件使用对应宿主提供的运行接口。

## 选择适合你的版本

| 用途 | 获取方式 | 内容 |
|---|---|---|
| 在不同 AI 开发工具中使用共用流程 | [通用工作流 4.3.1](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.3.1/ai-loop-workflow-4.3.1.zip) | 共用流程、角色、状态和分页记忆工具；不含 Codex 插件 |
| 在 Codex 中一次安装，并在插件详情页设置 | [Codex 插件 4.3.1](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.3.1/ai-loop-codex-4.3.1.zip) | Codex 插件、原生设置、工作区管理和所需核心 |
| 在 DeepSeek Harness 中使用原生插件 | [DSH 插件 4.3.0 预览版](https://github.com/murenyu1/ai-loop-engineering/releases/download/dsh-v4.3.0/ai-loop-dsh-4.3.0.tgz)，见 [安装说明](plugins/dsh/README.md) | 面向 0.2.1-rc.2 的插件、原生角色调度、设置和所需核心 |
| 修改工作流或开发其他客户端插件 | 本仓库源码 | core、平台适配器、插件源码、测试和构建工具 |

两个包在 [v4.3.1 Releases](https://github.com/murenyu1/ai-loop-engineering/releases/tag/v4.3.1) 的 Assets 中分别提供下载。Codex 用户只需插件包；其他工具可选通用工作流包。校验文件为 [SHA256SUMS](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.3.1/SHA256SUMS)。GitHub 自动提供的 Source code 压缩包包含仓库源码，主要供开发维护使用。

## 功能

- **跨聊天续接**：项目记录保存任务状态、决定、验证证据和交接。新聊天从短索引、未关闭工作单元、事件和改动位置恢复，再核对当前文件，不需要每次扫描全部源码。
- **中断可恢复**：工作开始前记录 planned，完成后记录 done 或 blocked。突然中断后，新聊天先检查记录和实际文件；未落盘的聊天内容无法恢复。
- **长记录分页**：知识和交接自动分片，按需分页读取；文档超过阅读预算时保留完整正文，不靠截断丢内容。
- **验收有依据**：测试和评审绑定代码快照，旧报告不能证明新代码已通过；独立评审要求客户端提供真正独立的上下文。
- **Codex 原生设置**：在 Codex 插件详情页配置 planner、reviewer、dev、tester、scribe 的模型与支持的思考深度，调整并发、全局或项目范围，并可恢复项目对全局默认的继承。
- **工作区管理**：打开插件设置即可读取 Codex 已保存的本机工作区，按项目名称和目录直接选择；选择只读取，启用和模型配置由用户分别应用。

Codex 插件的模型设置通过本地 stdio MCP 的 `openai/settings` 集成到插件详情页。页面可见性取决于当前 Codex 客户端对原生插件设置的支持和功能开关；原生界面需在实际客户端验收，自动测试不能证明页面一定显示。主会话模型继续由 Codex 原生选择器控制。设置在原生重载后的后续代理派发中生效，已运行代理不热切换。

## Codex 安装与使用

1. 下载并解压 [Codex 插件 4.3.1](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.3.1/ai-loop-codex-4.3.1.zip)，安装并登录 Codex，并准备 Node.js 18+。
2. 在解压后的插件目录，以正常用户终端预演和安装：

   ```powershell
   node scripts/install-plugin.mjs --project .
   node scripts/install-plugin.mjs --project . --apply
   ```

   插件安装到当前用户的 Codex 插件范围。桌面版 CLI 不在 PATH 时安装器会尝试定位；特殊安装可将 `AI_LOOP_CODEX_CLI` 设为 Codex 可执行文件路径。安装成功不等于当前聊天已经加载新版本。

3. 打开 Codex 的 AI Loop Engineering 插件详情页，直接在“Codex 工作区”下拉框选择项目，无需查找或填写路径。选择仅查看该项目的模型和启用状态；新项目默认停用。调整开关后点击“应用工作区开关”，模型、支持的思考深度和并发调整后点击“应用模型配置”。选中工作区后，配置范围默认“仅当前工作区”；需要修改所有继承项目的默认值时，可明确选择“全局默认”。
4. 项目范围的配置覆盖全局默认；使用恢复动作后，项目重新继承全局配置。主会话模型仍在 Codex 自身模型选择器里修改。保存后对下一次原生重载后的派发生效。
5. 工作区列表读取不依赖钩子。自动恢复入口需要在 Codex 原生 `/hooks` 页面审核并信任 SessionStart；它只在用户启用的精确根目录生效。选择工作区不会自动信任钩子。

若插件详情页没有显示设置，先确认安装版本和客户端当前提供的插件设置入口；客户端功能开关可能限制显示。不要通过浏览器管理面板或修改私有功能开关、`settings.json`、信任缓存来代替原生设置。用户可在插件详情页直接检查字段是否出现及保存后能否保留。

执行应用或恢复动作后，退出并重新进入插件详情页，读取最新结果。编辑期间若配置被其他窗口修改，先点击“放弃未应用草稿”，再重新进入页面；服务不会覆盖这次外部修改。普通下拉字段修改后会自动重新读取相应模型支持的思考深度。

## 通用工作流

DeepSeek Harness 用户可从 [DSH 独立预览发布](https://github.com/murenyu1/ai-loop-engineering/releases/tag/dsh-v4.3.0) 下载 `.tgz` 和该包的 SHA256SUMS，用 DSH 插件管理器安装到实际使用的 profile；也可按 [DSH 插件说明](plugins/dsh/README.md) 从源码构建。DSH 预览发布与上述 Codex / 通用工作流发布分别提供下载。

下载并解压通用工作流 ZIP 到固定目录，不必复制进每个项目。让当前 AI：

> 使用这里的 AI Loop 工作流完成当前需求。先读取目标项目规则和工作流目录中的 `WORKFLOW.md`，再按阶段读取角色与记忆协议，并遵守当前工具的权限规则。

有 Node.js 时，可从工作流目录运行：

```text
node scripts/memory.mjs bootstrap --project 项目绝对路径
```

通用包提供共享协议和状态工具；各客户端的自动入口、模型配置和原生子代理选择由对应适配器负责。没有 Node.js 时可按协议手动维护记录，但不能声称脚本检查已执行。命令接口见 `scripts/README.md`。

## 源码结构

```text
core/                  共用流程、角色、记忆协议与平台无关状态工具
adapters/project/      多客户端项目安装兼容适配器
plugins/codex/         Codex 插件源代码、技能、MCP 设置和钩子
plugins/dsh/           DeepSeek Harness 原生插件、角色调度和设置
dist/codex/            从插件源码构建的可安装目录
dist/dsh/              DSH 可安装目录，发行时打包为 tgz
scripts/               构建、发行和上传清单工具
tests/                 维护者检查
downloads/             本机生成的通用包、插件包与校验文件
```

`core/` 是共享工作流的权威源码；插件源码与通用工作流分开，Codex 插件通过构建流程带上所需核心副本。新增其他客户端插件时，在 `plugins/<harness>/` 增加独立源码，再生成对应的 `dist/<harness>/`，使用户能分别识别和下载。发行包不包含个人模型配置、工作区名单、项目任务记忆、日志、缓存或测试夹具。

维护者命令：

```text
node tests/all.mjs
node scripts/build-release.mjs
node scripts/build-dsh.mjs --pack
node scripts/publish-files.mjs --list
```

`publish-files.mjs --list` 只列出允许发布的文件，不会上传。维护者按授权上传源码，并在 Releases 的版本标签下分别附加通用工作流 ZIP、Codex 插件 ZIP 和校验文件。

Windows 配置写入前会检查所有者，避免由 CodexSandboxOffline/Online 身份创建受保护配置。请从正常用户终端运行配置入口；不改 `settings.json`，不批量重置 ACL。已有异常需用 `windows.mjs inspect` 定位，再只对确认异常的目录做有备份的精确修复；插件不能保证操作系统或其他程序永远不产生权限问题。

旧项目安装和迁移见 [SETUP.md](SETUP.md)，版本记录见 [CHANGES.md](CHANGES.md)。文件完整性、插件详情页可见性、钩子信任、原生角色发现和真实模型调用分别验收。
## 两端维护与接手

DSH、Codex 与通用工作流共享 `core/`。源码维护与跨客户端交接从 [开发入口](docs/development/README.md) 开始；在仓库根执行 `node scripts/dev-status.mjs` 查看本地版本。`.ai-loop/` 保存本机运行资料，共享决策和验证摘要随 Git 提交。首次远端历史接续尚待联网完成，具体限制见开发入口。
