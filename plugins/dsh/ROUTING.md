# DSH 工作流路由

原生技能：`ai-loop` 负责工作流与项目记忆，`ai-loop-models` 负责 DSH 插件设置。核心协议与脚本由发行包 `core/` 复用；项目仅保留 `.ai-loop/` 数据。

`ai_loop_delegate` 是 DSH 原生工具注册，只接受角色、简短名称与完整任务。它从会话原始工作区查精确开关，通过 workingDirectory 服务取得当前目录，使用受信任的角色设置预检模型，以 spawn 独立上下文执行。子代理不递归派发，结果由 DSH 原生生命周期回传，插件并发计数仅在原生 activation 结算时释放。

插件宿主只读取固定的包内技能、角色资源；不提供项目文件写入、命令执行或权限升级工具。项目操作使用 DSH 原生工具和审批沙箱。DSH 0.2.1-rc.2 的原生子代理审批策略固定为 never，受阻操作交回主代理；此插件不修改这个策略。

全局 `enabled` 与精确项目条目开关共同生效，未知工作区停用。模型配置为全局默认与项目角色覆盖；provider/model 成对覆盖，思考强度可以单独覆盖，未覆盖值继承全局、显式空值恢复父模型继承。设置保存后的后续派发使用新值，已有执行保留其启动时配置。

运行看板由 DSH 原生侧栏插槽 `sidebar.right.pane.tab` 和 `sidebar.right.pane.tab.title` 挂载，设置页仍保留模型配置。客户端对同源 `/plugins/ai-loop-engineering/state` 发 GET；服务端注册精确路由，先调用 `connection.requestRejection(req)`，再只读取设置中精确启用的工作区。请求不能指定其他目录。该路由只读取共享核心 `.ai-loop/` 数据，不创建插件自己的状态。多个运行会返回候选列表，前端要求显式选择；错误文本保留用于诊断，不执行 shell 回退。状态摘要展示核心提供的 `dependencies`、`ready`、`blocked_reason`、`owner` 和 `attempts` 字段。

原生右侧栏插槽及同源 fetch 传输参考已安装 `dsh-better-sidebar` 实现和 `dsh-agent-teams` 的 `src/web-routes.ts`。代码层已覆盖这些接口，但本轮没有在运行中的 DSH 桌面界面实测插槽显示。
