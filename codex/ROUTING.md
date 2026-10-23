# 插件原生代理调度

4.6.0 独立证据运行统一用 activity.mjs 保存原生调用观察（旧 agents.mjs 仅兼容旧台账）。派发前登记 requested 与当前 attempt/revision；当前会话原生工具启动后同步 running、native_id 与不同父子上下文；真实返回保存到 reports/ 后同步 completed/evidence，报告带 execution_id。整体评审另登记 task=final、attempt=status.event_seq。原生工具不可用、角色未发现或 doctor 阻断时明确待复核，不启动另一个 CLI 冒充。此协议核对带证据的观察，不证明调用者无法伪造日志，也不自动认证实际模型。

插件模式仅从已安装插件读取核心、技能与角色。项目内保存 .ai-loop 资料，不要求旧版 install.json、项目 .codex 工作流副本或 .agents 技能。

## 派发前检查

1. 从当前插件执行 scripts/plugin.mjs doctor --project ROOT。结果 dispatch=blocked 时停止，报告 issues 与 windows.issues，不换入口绕过。scripts/doctor.mjs 在有效插件项目标记下也会走相同检查。
2. doctor 校验插件摘要、全局模型或项目覆盖与目录实际所有者。只读检查可在 CodexSandboxOffline/Online 下执行；其 warnings 仅提醒配置写入须回到正常宿主用户。真实目录所有者异常和 ACL 不可读仍会阻断。正常沙箱身份不等于所有者异常，不据此重置权限。
3. dispatch=requires-native-verification 仅说明配置允许进入原生验收。检查当前原生工具能否选择对应 loop-*；不可用就报告并等待原生重载，不用通用角色或独立 CLI 冒充当前会话子代理。
4. 模型与强度从 scripts/plugin-models.mjs status --project ROOT 读取；固定角色配置优先，不声称派发参数必定覆盖。实际模型、执行结果和界面分别记录，未知保持 unverified。

## 分工与运行

主代理负责需求、计划、调度、难点与最终验收。standard/full 的已批准任务只使用已开启的原生 loop-*；派发前读取 plugin-models status 逐角色检查 enabled，关闭角色不调用也不换其他子代理，必要工作由主代理完成；lite 可由主代理处理。子代理不继续派发。开发仅在核心范围检查通过时并行，未声明范围则串行；测试与评审等待写入收敛，遵守配置并发上限。

任务包包含项目绝对路径、插件角色路径、run/task 编号、目标、owner、in_scope/out_of_scope、依赖、批准范围、必要项目规则、输入与验收。新工作流可使用 managed_execution；tester/reviewer 接收核心当前角色 attempt 和 revision，报告原样返回，旧批次拒收。派发后记录真实原生标识并等待结果；客户端没有关闭接口时不把关闭作为验收条件，不用 interrupt 冒充关闭。原生工具状态为实时依据，agents.mjs 台账只记录最后观察。

接续同任务时先核对原生执行者和 work_units，避免重复派发；接管须先停止旧执行者并确认静止。核心批次校验不能阻止旧进程继续写文件。mail/inbox 持久保存角色交接，不冒充 Codex 原生实时消息或自动唤醒。

并行开发者停止写入后使用核心 finish 进入 developed；所有开发写入收敛后，由主代理按核心阶段逐项验证与评审，不能让多个 developing 任务互相等待验证。

## 配置与切换

模型设置通过插件 ai-loop-models 技能或 scripts/plugin-models.mjs 预演和应用；受保护配置写入、安装与所有者修复必须由正常宿主用户执行。只读 doctor 不授予写入权限，不更改沙箱策略或任何 deny。

修改默认只影响原生重载后的后续派发，当前执行者不热切换。主会话模型使用 Codex 原生选择器；必要时保存交接并接续同一任务，不清零修复计数。钩子信任通过 Codex 原生审核，不修改信任缓存。

4.5.0 角色策略：未配置默认全部关闭，设置模型菜单的“关闭”映射 enabled=false，不把它当模型 ID。保存保留原模型，关闭或仅改自动入口不依赖模型目录。doctor dispatch=disabled 时由主代理继续工作，不能调用已发现但已关闭的角色；保留的原生文件不是启用证据。运行中停止需原生确认，independent 要求不能自动降级。包内 MCP thread 看板不启动 HTTP；真实客户端渲染、实际模型及 UI 仍分别验收。
