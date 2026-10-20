# 插件原生代理调度

插件模式仅从已安装插件读取核心、技能与角色。项目内保存 .ai-loop 资料，不要求旧版 install.json、项目 .codex 工作流副本或 .agents 技能。

## 派发前检查

1. 从当前插件执行 scripts/plugin.mjs doctor --project ROOT。结果 dispatch=blocked 时停止，报告 issues 与 windows.issues，不换入口绕过。scripts/doctor.mjs 在有效插件项目标记下也会走相同检查。
2. doctor 校验插件摘要、全局模型或项目覆盖与目录实际所有者。只读检查可在 CodexSandboxOffline/Online 下执行；其 warnings 仅提醒配置写入须回到正常宿主用户。真实目录所有者异常和 ACL 不可读仍会阻断。正常沙箱身份不等于所有者异常，不据此重置权限。
3. dispatch=requires-native-verification 仅说明配置允许进入原生验收。检查当前原生工具能否选择对应 loop-*；不可用就报告并等待原生重载，不用通用角色或独立 CLI 冒充当前会话子代理。
4. 模型与强度从 scripts/plugin-models.mjs status --project ROOT 读取；固定角色配置优先，不声称派发参数必定覆盖。实际模型、执行结果和界面分别记录，未知保持 unverified。

## 分工与运行

主代理负责需求、计划、调度、难点与最终验收。standard/full 的已批准任务使用原生 loop-* 分工；lite 可由主代理处理。子代理不继续派发。同一工作区开发、测试、评审依次执行，只读任务可安全并行，遵守配置并发上限。

任务包包含项目绝对路径、插件角色路径、目标、批准范围、必要项目规则、输入与验收。派发后记录真实原生标识并等待结果；客户端没有关闭接口时不把关闭作为验收条件，不用 interrupt 冒充关闭。原生工具状态为实时依据，agents.mjs 台账只记录最后观察。

## 配置与切换

模型设置通过插件 ai-loop-models 技能或 scripts/plugin-models.mjs 预演和应用；受保护配置写入、安装与所有者修复必须由正常宿主用户执行。只读 doctor 不授予写入权限，不更改沙箱策略或任何 deny。

修改默认只影响原生重载后的后续派发，当前执行者不热切换。主会话模型使用 Codex 原生选择器；必要时保存交接并接续同一任务，不清零修复计数。钩子信任通过 Codex 原生审核，不修改信任缓存。
