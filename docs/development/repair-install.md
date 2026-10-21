# 三端修复与安装：4.4.2

日期：2026-10-21。基准：`778fc1b`，分支：`codex/workflow-sync`。用户已确认整体检查、修复、验证及两端安装方案。本机运行：`.ai-loop/runs/repair-install/`。

## 实现

- core：新运行 schema 2 阻止旧核心误写；旧 schema 1 保持可读，安全旧记录可继续写；新契约旧记录须显式 migrate。迁移确认旧执行者停止，保留 run_id、计数、报告、历史事件与原状态备份，并覆盖写入失败回滚。修复更早版本比较和 schema 1 的 finish 半升级问题。
- core CLI：公开增量信箱参数统一为 `--after-id`，补 CLI 回归。
- Codex：恢复项目默认前先校验全局继承配置，失败不删除项目覆盖；补 MCP 错误返回和升级角色路径保留模型回归。
- DSH：项目仅调强度不再固定继承模型；选择父智能体继承时成对清除提供方和模型；补实际 RoleCard 交互回归。
- 提示词：已有批准不重复请求；测试代理可保存指定原始日志；普通诊断与正式快照评审分开；共享核心明确平台模型工具与记忆/运行 schema 区别。

- 发行：DSH 全部文本产物统一 LF，补 CRLF 源码与 Git LF 检出摘要一致性回归，避免两端拉取后完整性校验失败。

## 安装与证据边界

- Codex 原生安装器已安装 4.4.2；全局及当前项目原生角色路径已迁移，保留原模型 profile。doctor 为 configured，issues 为空。当前会话曾验证 4.4.1 技能发现；最终 4.4.2 文件与 doctor 另行核对，新版本原生发现仍以重载结果为准。
- 实际启动已安装 Codex 设置 MCP，初始化返回 4.4.2，发现六个工具，settings.read 成功。已安装文件与发行清单逐项摘要一致。
- DSH 通过原生插件管理器离线更新现有 desktop profile 到 4.4.2，downloaded=0，禁用安装脚本；已安装包文件摘要与发行清单一致。
- DSH peer 检查报告其他已安装插件的缺项，未列出 AI Loop；未擅自安装依赖。普通 Node 缺少 DSH 宿主模块解析环境，不能以其导入失败证明宿主失败。原生 CLI 明确禁止启动由 Electron 独占管理的 desktop profile；未绕过此限制。
- 实际 DSH 桌面侧栏、设置保存、真实模型派发及两端有效模型仍需原生客户端验收，不能由 SDK doubles 或模型自述代替。Codex hooks 信任仍由原生用户审核，不修改信任缓存。
- 安装完成时设置文件、DSH配置与模型选择基线一致。后续恢复检查发现 desktop/cordis.patch.yml 已变化，来源未确认，保留当前值；settings.json 与模型选择仍未变化。

## 验证与接手

安装前回归为 152 项：146 通过、0 失败、6 项 Windows 符号链接限制跳过。后续独立诊断新增两项兼容修复及迁移失败注入回归；最终全量测试及独立评审结果以本阶段 Git 提交说明和本机 reports 记录为准，不用此前通过结果代替。

本机证据：`reports/preinstall-all.log`、`release-4.4.2.json`、`codex-install.json`、`profiles-applied-4.4.2.json`、`dsh-install-4.4.2.log`、`installed-verification.json`、`codex-doctor.json`。这些文件可能包含本机路径，不随 Git 分享。

接手先确认两端安装版本，重载原生客户端后验收 UI 与实际派发；现有旧运行用 status 检查，必要时按核心 migrate 帮助迁移，不直接改状态。Git 远端历史接续仍遵守 README，未强推或自动合并无关历史。4.4.2 为本地候选，尚未发布。

原生规范核对：[Codex 子代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[插件打包及钩子信任](https://developers.openai.com/plugins/build/plugins)。
