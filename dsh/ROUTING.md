# DSH 工作流路由

原生技能：`ai-loop` 负责工作流与项目记忆，`ai-loop-models` 负责 DSH 插件设置。核心协议与脚本由发行包 `core/` 复用；项目仅保留 `.ai-loop/` 数据。

`ai_loop_delegate` 是 DSH 原生工具注册，参数必须包含 `run`、`task`、`role`、`attempt`、简短名称与完整任务。它从会话工作区查精确开关，要求角色已开启，并调用核心只读 `dispatchCheck` 核实 run 仍 active、任务阶段和 managed tester/reviewer 批次；随后预检角色模型，以 spawn 独立上下文执行。相同 run/task/role 只要仍有非终态执行者，即使 attempt 不同也拒绝重派。子代理不递归派发，结果由 DSH 原生生命周期回传，插件并发计数仅在原生 activation 结算时释放。

插件宿主只读取固定的包内技能、角色资源；不提供项目文件写入、命令执行或权限升级工具。项目操作使用 DSH 原生工具和审批沙箱。DSH 0.2.1-rc.2 的原生子代理审批策略固定为 never，受阻操作交回主代理；此插件不修改这个策略。

全局 `enabled` 与精确项目条目开关共同生效，未知工作区停用。模型配置为全局默认与项目角色覆盖；provider/model 成对覆盖，思考强度可以单独覆盖，未覆盖值继承全局、显式空值恢复父模型继承。设置保存后的后续派发使用新值，已有执行保留其启动时配置。

运行看板由 DSH 原生侧栏插槽 `sidebar.right.pane.tab` 和 `sidebar.right.pane.tab.title` 挂载，设置页保留模型配置。侧栏传入的 sessionId 在 host `sessions.get(id)` 可用时由 `header.cwd` 绑定工作区；会话 root 已知时拒绝不匹配项目、未启用项目不回退。会话未知时需要用户手动选择一个已启用工作区。客户端对同源 `/plugins/ai-loop-engineering/state` 发 GET；服务端注册精确路由，先调用 `connection.requestRejection(req)`，再只读取设置中精确启用的工作区。多个运行会返回候选列表，前端要求显式选择；错误文本保留用于诊断，不执行 shell 回退。状态摘要展示任务状态、最后一次核心观察和内存中的真实 childId。`completed` 只代表子代理结束，不等于任务通过；token 用量未知时显示不可获取。隐藏页面停止轮询，恢复可见时立即刷新。DSH host 只读核心代理台账，不直接写项目；主代理收到 childId 后须通过工作流获准的原生记录路径登记观察。无论内存 map 是否因重载丢失，只要核心台账仍是非终态，就阻止同 run/task/role 重派；观察过期不等于原生执行者已结束。

原生右侧栏插槽及同源 fetch 传输参考已安装 `dsh-better-sidebar` 实现和 `dsh-agent-teams` 的 `src/web-routes.ts`。代码层已覆盖这些接口，但本轮没有在运行中的 DSH 桌面界面实测插槽显示。
