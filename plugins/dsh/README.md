# AI Loop DeepSeek Harness 插件

适配 DeepSeek Harness **0.2.1-rc.2** 的原生 Cordis 插件。包中包含 `core/` 通用流程、角色和记忆脚本；项目内只保存自己的 `.ai-loop/` 资料。

## 安装

历史 DSH 4.3.0 预览版可从 [已发布版本页](https://github.com/murenyu1/ai-loop-engineering/releases/tag/dsh-v4.3.0) 获取。当前源码候选为 4.4.0，尚未发布；不要把历史安装包当作本次更新结果。

维护者也可从仓库构建安装包：

```powershell
node scripts/build-dsh.mjs --pack
dsh plugin --profile web add ./downloads/ai-loop-dsh-4.4.0.tgz
```

命令应从源包根目录执行。用户拿到独立 tgz 后，可在其所在目录运行第二条命令并调整文件路径。预构建包没有安装脚本，不需要构建授权。使用 DSH 自带插件管理器安装到实际使用的 profile；不要把桌面安装目录当项目根目录或手动复制进应用程序资源。

若桌面版没有把 `dsh` 加入 PATH，可使用安装目录内的入口，例如：

```powershell
& 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --version
& 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile web add .\downloads\ai-loop-dsh-4.3.0.tgz
```

实际 profile 需与桌面正在使用的一致。插件安装涉及 profile 配置和依赖登记，请从正常用户终端操作；脚本不会修改 `settings.json`、应用安装资源或权限。

## 使用与设置

打开 DSH 的 AI Loop 插件页面，先开启插件总开关，再从 DSH 已有工作区中选择项目并保存启用状态。未登记项目默认停用，路径按精确根目录匹配，子目录不会自动继承。

模型设置提供全局默认、项目覆盖及恢复继承；planner、dev、tester、reviewer、scribe 使用 DSH 原生模型和支持的思考强度。未指定的角色配置继承主会话。保存仅影响之后派发的子代理，主会话仍使用 DSH 自身模型选择器。并发限制与 DSH 原生容量共同生效。

右侧栏 AI Loop 面板从插件只读状态路由读取 `.ai-loop/` 核心状态；路由只接受设置中精确启用的项目，并通过 DSH Connection 请求校验。多个运行时要求用户选择，不会静默挑选。状态读取错误会原样显示，不回退执行 shell。面板接入使用 DSH 的 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 插槽；本轮尚未在原生桌面界面实测显示。

在项目会话中要求“使用 AI Loop 工作流处理这个需求”。技能会指向包内 `core/WORKFLOW.md` 和 `ROUTING.md`，从短索引、活跃任务及交接记录恢复必要信息；恢复入口不能代替用户对新任务的授权。

`ai_loop_delegate` 按角色创建原生 spawn 子代理，独立评审使用独立上下文。角色任务需明确文件范围、目标和验收；实际模型能力不足时报告错误，不静默换模型。叶子子代理不能再次通过本插件派发。子代理遇到需要额外审批的操作应交回主代理处理，不能绕过 DSH 沙箱或权限。

## 验收

维护者执行 `node tests/all.mjs`，并用 `node scripts/build-dsh.mjs --check` 检查产物。可用 `dsh --profile web --dump-config` 检查原生组合层。

静态测试、宿主加载、原生界面显示及保存、实际模型调用分别验收。文件存在或接口注册成功不能证明真实模型已调用；安装版和开发者网站版本不同也可能需要进一步适配。

官方参考：[插件打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[原生子代理](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subagent)、[插件设置表单](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)。
