# AI Loop Engineering

让 AI 按“计划 → 开发 → 验证 → 评审 → 交接”推进项目，并在换聊天后按记录接着做。当前版本 **4.2.0**；脚本需要 Node.js 18+，不依赖第三方 npm 包。

## 我应该下载哪个？

| 你的用途 | 下载 | 包含什么 |
|---|---|---|
| 在不同 AI 开发工具中使用共用流程 | [通用工作流 ZIP](https://github.com/murenyu1/ai-loop-engineering/raw/refs/heads/main/downloads/ai-loop-workflow-4.2.0.zip) | 流程、角色、状态和分页记忆工具；不含 Codex 插件 |
| 在 Codex 中一次安装，用界面管理模型和项目 | [Codex 插件 ZIP](https://github.com/murenyu1/ai-loop-engineering/raw/refs/heads/main/downloads/ai-loop-codex-4.2.0.zip) | 可安装插件、管理面板、工作区启动钩子，已含所需核心 |
| 修改本项目或开发其他客户端插件 | [完整仓库](https://github.com/murenyu1/ai-loop-engineering/archive/refs/heads/main.zip) | 单份核心、适配器源码、测试和构建工具 |

下载后解压再使用；校验值见 [SHA256SUMS](downloads/SHA256SUMS)。Codex 用户只需插件包，无需另装通用包。完整仓库 ZIP 用于维护开发，内容比精简发行包多。

## 可以解决什么问题？

- **任务可续接**：每个项目保存自己的任务状态、决策、检查证据和交接。新聊天先读短索引和必要代码位置，避免每次重新扫描全部源码。
- **中断有线索**：开发单元开始前记 planned，结束后记 done / blocked。突然中断后，新聊天能看到尚未关闭的单元，再核对实际改动。
- **长记录不截断**：知识和交接自动分片、分页读取，短索引只负责导航，完整正文仍保留。
- **验收有证据**：测试和评审绑定代码快照，旧报告不能直接证明新代码通过；独立评审使用真正的独立上下文。
- **Codex 可视化配置**：在本机面板选择各子角色模型、支持的思考深度和并发；支持全局默认、项目覆盖和撤销覆盖。
- **按工作区启用**：登记项目目录并打开开关后，已信任的启动钩子在新会话提供恢复入口。未启用的项目不注入。

恢复能力以已落盘资料为限，不能恢复尚未记录的聊天内容；发现旧任务不等于获得新的开发或发布授权。

## Codex：首次安装

先安装并登录 Codex，确认有 Node.js 18+。在普通用户终端中进入解压后的 **Codex 插件目录**，运行：

```powershell
node scripts/install-plugin.mjs --project .
node scripts/install-plugin.mjs --project . --apply
```

第一行预演，第二行调用 Codex 原生插件管理命令安装到用户范围。安装一次供本机各项目使用，无需往每个项目复制工作流。Windows 桌面版 CLI 不在 PATH 时会自动定位；特殊安装可设置 AI_LOOP_CODEX_CLI 为真实 Codex 可执行文件路径。

也可以直接把仓库作为 Codex 插件市场添加：

```text
codex plugin marketplace add https://github.com/murenyu1/ai-loop-engineering
codex plugin add ai-loop-engineering@ai-loop-engineering
```

直接从市场安装后，在插件文件夹运行 open-console.ps1，或运行该文件夹的 `node scripts/console.mjs`。新开聊天核对技能加载；安装成功不等于当前已打开的聊天立即加载新版本。

### 打开模型和工作区管理面板

在插件包内右键运行 open-console.ps1，或执行：

```text
node scripts/console.mjs
```

浏览器会打开只监听本机的管理面板。启动地址中 # 后的临时凭据不要分享。无需在聊天中发送设置指令，也无需远程部署。使用页尾“关闭管理服务”退出；重新运行入口即可打开新面板。

1. 在“工作区”输入项目真实绝对路径，点击登记，按需启用或关闭。
2. 选择工作区，再选择“全局默认”或“当前项目覆盖”。模型列表和支持的思考深度从当前 Codex 原生服务读取；列表不可用时显示错误，不冒充已验证模型。
3. 修改角色模型、思考深度与并发，点击保存。项目覆盖可点击恢复全局默认；主会话模型继续使用 Codex 自身的模型选择器。
4. 设置作用于原生重载后的后续派发，已有代理保持启动时配置。新会话核对角色发现和实际调用结果。

面板遇到人工修改或未登记的同名角色文件会停止覆盖，需先合并。全局保存影响其他项目的后续派发，项目保存仅影响选中项目。

### 新聊天自动恢复入口

首次使用需在 Codex 原生钩子管理中审核并信任本插件的 SessionStart 定义；CLI 使用 /hooks。安装和工作区开关不会替代这次信任；更新钩子后可能需要重新审核，组织策略也可能禁用非托管钩子。参见 [Codex 官方 hooks 文档](https://learn.chatgpt.com/docs/hooks)。

启用工作区并信任钩子后，在该**精确项目根目录**新开聊天，直接说“继续实现登录接口”即可。钩子只注入短入口与运行提示，AI 按需读取摘要和改动位置，不在每次启动全量加载代码和历史。子目录不自动继承登记，避免误启用嵌套项目。

原生插件详情页的按钮是聊天入口，当前公开清单没有任意设置表单。本项目模型控件位于本机面板。未信任钩子时，仍可在聊天中显式使用 AI Loop。

## 通用工作流：如何使用

解压通用 ZIP 到固定目录，向当前开发工具说明：

> 使用这里的 AI Loop 工作流完成当前需求。先读取目标项目规则，以及工作流目录中的 WORKFLOW.md；按阶段读取角色和记忆协议，遵守当前工具的权限与审批规则。

有 Node.js 时，可先发现当前项目记录：

```text
node 工作流目录/scripts/memory.mjs bootstrap --project 项目绝对路径
```

通用包提供协议和本地工具，客户端自动入口、模型配置和原生子代理选择由适配器负责。没有 Node.js 时可按协议手动维护记录，不能声称脚本检查已执行。详细接口见通用包 scripts/README.md。

## 设计与源码分区

```text
core/                  共用流程、角色、记忆协议与平台无关状态工具
plugins/codex/         Codex 源码、技能、模型/工作区面板与启动钩子
adapters/project/      原有多客户端项目安装兼容实现
scripts/               构建/发行工具与旧命令兼容入口
tests/                 维护者回归检查
dist/codex/            自动构建的可安装插件，含所需核心副本
downloads/             两种独立 ZIP 与 SHA256 校验值
```

只维护一份 core/；dist/codex/ 是生成物，不应手动修改。以后新增客户端插件放 plugins/<harness>/，构建到 dist/<harness>/，分别提供下载。发行包不含用户模型配置、工作区名单、任务记忆、日志、缓存或测试夹具。

维护者在仓库根执行：

```text
node tests/all.mjs
node scripts/build-release.mjs
node scripts/publish-files.mjs --list
```

最后一行只生成上传白名单，不联网提交。测试、构建工具和必要文档属于维护源码；本机 .ai-loop/、.release/、.validation/、依赖目录和临时输出不会上传。

## 从 4.1 升级与 Windows 权限

更新插件后保留原项目运行、记忆和模型选择。旧的项目复制入口仍可能优先，先检查并明确迁移；不要删除旧入口或模型文件强行接管。旧脚本不能写新版 schema 2 记忆，避免混用。

安装器和面板在写原生配置前检查 Windows 所有者，拒绝让 CodexSandboxOffline/Online 创建受保护目录。请从正常用户终端运行配置入口；不改 settings.json，不批量重置 ACL。既有异常需用 windows.mjs inspect 定位，只对明确异常目录做有备份的精确修复。插件无法保证操作系统或其他程序永远不产生权限问题。

旧项目安装和迁移见 [SETUP.md](SETUP.md)，版本变更见 [CHANGES.md](CHANGES.md)。实际模型、原生执行、界面和新会话钩子应分别以当前客户端证据验收。

