4.7.0 为当前版本；4.6.0 与 4.5.0 的发布和安装说明保留为历史版本。

# AI Loop DeepSeek Harness 插件

适配 DeepSeek Harness **0.2.1-rc.2** 的原生 Cordis 插件。包中包含 `core/` 通用流程、角色和记忆脚本；项目内只保存自己的 `.ai-loop/` 资料。

## 安装

当前版本为 **4.7.0**：[v4.7.0 Release](https://github.com/murenyu1/ai-loop-engineering/releases/tag/v4.7.0) 提供[下载 DSH 插件](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.7.0/ai-loop-dsh-4.7.0.tgz)及 [SHA256SUMS](https://github.com/murenyu1/ai-loop-engineering/releases/download/v4.7.0/SHA256SUMS)。4.6.0、4.5.0、4.4.3 和 DSH 4.3.0 预览版保留在历史发布页。

维护者也可从仓库构建安装包：

```powershell
node scripts/build-dsh.mjs --pack
dsh plugin --profile YOUR_PROFILE add ./downloads/ai-loop-dsh-4.7.0.tgz
```

命令应从源包根目录执行。用户拿到独立 tgz 后，可在其所在目录运行第二条命令并调整文件路径。预构建包没有安装脚本，不需要构建授权。使用 DSH 自带插件管理器安装到实际使用的 profile；不要把桌面安装目录当项目根目录或手动复制进应用程序资源。

若桌面版没有把 `dsh` 加入 PATH，可使用安装目录内的入口，例如：

```powershell
& 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --version
& 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile YOUR_PROFILE add .\downloads\ai-loop-dsh-4.7.0.tgz
```

实际 profile 需与桌面正在使用的一致。插件安装涉及 profile 配置和依赖登记，请从正常用户终端操作；脚本不会修改 `settings.json`、应用安装资源或权限。

## 使用与设置

打开 DSH 的 AI Loop 插件页面，先开启插件总开关，再从 DSH 已有工作区中选择项目并保存启用状态。未登记项目默认停用，路径按精确根目录匹配，子目录不会自动继承。

读取旧配置时仍按旧版 `enabled` 判断开关；首次保存会迁移为 `schemaVersion: 2`，用 `workflowEnabled` 保存新开关，并将旧版仍识别的 `enabled` 原子置为 `false`，避免 4.4.3 忽略新字段后继续派发。未知 schema 版本会拒绝运行。

模型设置提供全局默认、项目覆盖及恢复全局继承；planner、dev、tester、reviewer、scribe 每个角色都可选择“关闭”。新建或未配置角色默认关闭，项目级关闭覆盖全局开启；旧版显式 provider/model 路由仍视为开启。关闭角色不会创建替代代理，也不会开始新调用。运行中的子代理如原生运行时未提供公开、可确认的取消能力，看板会标为“待停止”，它可能继续消耗资源。并发限制与 DSH 原生容量共同生效。

右侧栏 AI Loop 面板从插件只读状态路由读取 `.ai-loop/` 核心状态和最后一次代理观察；路由只接受设置中精确启用的项目，并通过 DSH Connection 请求校验。观察包含真实 childId 和已知状态，`completed` 只表示子代理执行结束，不代表任务通过；token 用量不可见时明确显示不可获取。多个运行时要求用户选择，不会静默挑选。状态读取错误会原样显示，不回退执行 shell。右侧标题显示活动数量并提示看板入口；共享轮询按会话、工作区和运行去重，只有最后一个订阅卸载时才取消请求，隐藏页面暂停刷新。面板接入使用 DSH 的 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 插槽；本轮尚未在原生桌面界面实测显示。

在项目会话中要求“使用 AI Loop 工作流处理这个需求”。技能会指向包内 `core/WORKFLOW.md` 和 `ROUTING.md`，从短索引、活跃任务及交接记录恢复必要信息；恢复入口不能代替用户对新任务的授权。

`ai_loop_delegate` 要求传入当前 run、task 与 attempt，并由核心只读校验运行状态、阶段和托管批次；同一 run/task/role 只要已有非终态观察（包括旧 attempt 或过期观察），就拒绝重复派发，避免插件重载后重复启动。角色任务需明确文件范围、目标和验收；实际模型能力不足时报告错误，不静默换模型。叶子子代理不能再次通过本插件派发。子代理遇到需要额外审批的操作应交回主代理处理，不能绕过 DSH 沙箱或权限。

正式运行前可调用 `ai_loop_plan` 启动真实原生 planner。它使用独立 `plan_id`，计划保存到 `.ai-loop/plans/<plan_id>/plan.json`，不创建 run/task、不执行检查或修改源码；planner 完成后，主代理调用 `ai_loop_observe` 传 `plan_id` 读取 childId、父子上下文、终态及原生返回 payload，并通过获准的原生文件工具保存到同目录证据文件。用户确认计划后再创建正式运行。多子项目工作区的 `ai_loop_prepare`、`ai_loop_delegate`、`ai_loop_observe`、`ai_loop_status` 与 Web 状态路由都传递 `project_path`；同名 run 的执行身份、观察和状态按子项目隔离，并发额度共享工作区上限。

## 验收

维护者执行 `node tests/all.mjs`，并用 `node scripts/build-dsh.mjs --check` 检查产物。可用 `dsh --profile web --dump-config` 检查原生组合层。

静态测试、宿主加载、原生界面显示及保存、实际模型调用分别验收。文件存在或接口注册成功不能证明真实模型已调用；安装版和开发者网站版本不同也可能需要进一步适配。

官方参考：[插件打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[原生子代理](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subagent)、[插件设置表单](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)。
