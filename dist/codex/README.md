4.6.0 本地候选尚未发布/安装。原生角色及技能保留 Codex 调度方式，新独立评审要求关联真实调用证据；看板显示子项目归属。下文 4.5.0 下载为历史版本。

# AI Loop Codex 插件 4.5.0

本插件包与通用工作流、DSH 插件统一收录在 [v4.5.0 Release](https://github.com/murenyu1/ai-loop-engineering/releases/tag/v4.5.0)：[下载 Codex 插件](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.5.0/ai-loop-codex-4.5.0.zip)；完整性校验使用该 Release 的 [SHA256SUMS](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.5.0/SHA256SUMS)。4.4.3 及更早下载仍作为历史版本保留。插件预检使用 `node PLUGIN/scripts/plugin.mjs doctor --project ROOT`；兼容 `doctor.mjs` 也会识别插件项目。配置检查、原生执行、实际模型和界面分别验收。

在 Codex 插件详情页直接管理 AI Loop 子代理模型和工作区，并在不同本地项目使用同一套开发闭环、分页记忆与中断恢复流程。插件包包含运行所需核心，无需另装通用工作流。

## 安装

需要已登录的 Codex 和 Node.js 18+。解压插件包后，在插件目录以正常用户终端执行：

```powershell
node scripts/install-plugin.mjs --project .
node scripts/install-plugin.mjs --project . --apply
```

先预演，再安装。安装器使用 Codex 原生插件管理命令，不修改 `settings.json` 或钩子信任缓存。安装后新开聊天，核对技能是否加载。

升级后用新插件的 doctor 检查角色引用。若仍指向旧缓存目录，先读取当前 global/project 模型配置，再用新插件的 configure 和相同配置预演、应用，仅更新受管理角色路径；不要重新套用预设覆盖用户模型。已有项目覆盖须分别更新，之后原生重载并验证实际角色调用。

## 在插件详情页配置

打开 Codex 的 AI Loop Engineering 插件详情页，使用原生设置区：

1. 在“Codex 工作区”中选择已有项目，选项显示项目名称和目录。选择只读；新工作区默认停用。工作区开关与子代理模型共用“应用”保存。
2. 选择“全局默认”或“仅当前工作区”范围；选中工作区后默认“仅当前工作区”。planner、reviewer、dev、tester、scribe 的模型菜单均可选“关闭”；未配置时所有角色默认关闭。仅开启角色会检查模型和支持的思考深度。设置与并发先暂存，点击“应用”后统一保存。
3. 项目覆盖只用于所选项目；使用恢复动作后项目继承全局默认。主会话模型仍由 Codex 自身选择器控制。

配置在原生重载后的后续派发中生效，已有代理不会热切换。模型配置成功、原生代理发现和真实推理生效是不同的验收状态。

插件工具栏提供线程入口“AI Loop 代理看板”。看板只读取已登记工作区的运行状态、最后一次代理观察和任务记录，不启动 HTTP 服务、不连接外部浏览器、不调用模型；观察可能过期，不能当作实时执行保证。MCP App 已完成包内资源注册，具体 Codex 桌面版本是否显示线程标签与正常渲染仍须在客户端验收。

应用、恢复后，退出并重新进入插件详情页查看最新结果。遇到其他窗口同时修改配置时，点击“放弃未应用草稿”后重新进入，避免覆盖外部修改。

插件详情页的设置入口取决于当前 Codex 客户端支持和功能开关。实际插件页面仍需在所用客户端验收；静态检查或自动测试不能证明页面已经显示。若设置区缺失，请核对当前插件版本和 Codex 页面状态；不建议用浏览器面板、私有功能开关、`settings.json` 或信任缓存绕过。

## 新聊天继续项目

设置页只读 Codex 保存的本机项目列表，保留旧 AI Loop 工作区配置；不存在或不可用的目录不会列入选项。选择工作区不会写配置，应用按钮才保存。本机列表适配 `CODEX_HOME/.codex-global-state.json` 中的项目记录与旧根目录列表；这是桌面版本兼容层，文件缺失、损坏或格式改变会在设置页明确提示，并保留仍存在的旧工作区供选择。插件不会修改此文件。

自动恢复入口仍需在 Codex 原生 `/hooks` 页面审核并信任 SessionStart。安装插件和选择工作区不会代替信任审核；入口只对用户启用的精确项目根目录生效，子目录不自动继承。

每个项目只保存自己的 `.ai-loop/` 运行资料。中断后可恢复已落盘的摘要、未关闭工作单元、事件和改动定位；未记录的聊天内容无法恢复。选择工作区不授予提交、发布或越权权限。Windows 受保护配置需由正常用户宿主创建；不批量调整权限。

通用工作流、源码布局和历史版本包见[项目首页](https://github.com/murenyu1/ai-loop-engineering)；[v4.4.3 Release](https://github.com/murenyu1/ai-loop-engineering/releases/tag/v4.4.3) 提供上一正式版本。
