# 跨平台工作流一致性改进

- 目标：把参考项目有用的任务协作设计落实到共享核心、DSH 与 Codex，并建立 Git 交接。
- 批准范围：用户已确认中文实施方案；核心、两端适配、回归、构建和本地 Git 提交。没有修改 settings.json。
- 本机基准：`af69241`，保存开始改进前的 4.3.1 源码；它是本地根提交，不是远端发布提交。
- 当前分支：`codex/workflow-sync`。远端接续边界见 [README.md](README.md)。
- 本机完整执行记录：`.ai-loop/runs/workflow-sync/`（不随 Git 共享）。

## 设计与归属

- core：保留已有 DAG、快照、修复上限、真实独立评审门禁；增强任务范围、批次与状态投影。开发者负责 `core/scripts/loop.mjs` 和核心回归。
- DSH：核对实际宿主 bridge/slots；移除 shell 状态回退；增加受工作区限制的只读状态与运行选择、侧栏展示。开发者负责 DSH 源码与回归。
- Codex/集成：复用同一核心，完善角色任务包、接手协议、Git 二进制规则与开发入口。主代理负责文档、Git、集成与构建。

## 参考与取舍

参考：https://github.com/NanmiCoder/dsh-agent-teams （2026-10-20 阅读 README、docs/usage.md、docs/quality-gates.md）。吸收磁盘状态、依赖、执行批次、任务范围、结构化质量门禁与恢复机制。保留本项目已经具备的质量门；按宿主真实能力适配，不把 DSH 原生服务移植到 Codex，也不以提示词代替状态机验证。

## 验证与交接

源码已完成并冻结。完整集成验证、构建与独立复审的实际结果随本主题最终集成提交说明保存，用 `git log -1 --format=full` 核对；本节的设计与定向结果不替代全量验证，也不表示已发布。

- 核心：`validateSpec`、`summary`、`finish`、`begin`、`record`；定向 20 通过、0 失败、3 个 Windows 符号链接用例跳过。并发开发死锁已通过 finish/developed 汇合解决，包含双任务直至 complete 的回归。
- DSH：`apply` 的状态路由、`requestStatus`、`RunDashboard`、`SidebarDashboard`；定向 21/21 通过。包括鉴权、工作区限制、一个活跃加一个历史运行、项目切换旧响应、轮询清理、模型目录与侧栏注册。
- Git：`devStatus` 与发行清单；两项回归通过，八个原有压缩包的 Git blob 与本机原字节一致。
- Codex：路由与技能、通用角色复用共享契约；没有新建 DSH 专属的 Codex 面板，也没有改模型配置。
- 原始本机日志在 `.ai-loop/diagnostics/core-update.log`、`dsh-update.log`，完整集成证据在 `.ai-loop/runs/workflow-sync/reports/`；它们不随 Git 上传，跨克隆应读取提交说明和本摘要。

真实 DSH 桌面面板显示、实际模型调用与新版插件安装尚未验收；两端本机安装副本未自动更新。下一步是在目标宿主安装 4.4.0 候选并分别验收；远端接续需等待 Git 网络可用。不得因此把本轮单元测试当作原生验收。

已发现：全局 `* text eol=lf` 会把 ZIP 二进制当文本归一化；本轮改为自动文本识别并显式标记压缩包为 binary，后续提交重新按原始工作区字节保存。

二进制修复已在 `52a4705` 提交，保留工作区原始安装包字节。回看基准 `af69241` 时只用作源码基线，不使用其中经错误归一化的 ZIP 安装包。

Git 网络在普通及获准提权执行下均连接失败；远端未 fetch、未 merge、未 push。两个客户端使用本机相同目录可查看本地 Git 和本记录；不同机器暂不能靠远端获取本轮内容。

## 设计映射

| 参考设计 | 本项目实现及边界 |
|---|---|
| 任务 DAG | 复用 core 依赖与 done 门禁，新增统一 dependencies/ready/blocked_reason 投影；并行开发 finish 到 developed 后串行验证 |
| 任务合同 | 已有 acceptance/checks/review；新增 owner/in_scope/out_of_scope，范围只用于冲突判断，不是文件写入拦截或实际变更审计 |
| 执行批次 | managed_execution 按 tester/reviewer 分别维护 attempt；旧批次拒收，旧任务保持原契约；开发执行者的安全停止仍依赖原生生命周期 |
| 质量门禁 | 保留快照、日志、验证结果、独立评审、最多三次修复和最终完整验证；未实现自动修复任务生成 |
| 持久通信 | 复用已存在 mail/inbox 与事件，磁盘消息不具备身份鉴别或自动唤醒能力 |
| 角色复用与调度 | 依照核心就绪状态由主代理调度；未实现跨宿主常驻成员池或后台自动领取，避免虚构平台共有能力 |
| 磁盘状态驱动 UI | DSH 从共享核心读取；Codex 使用核心脚本与原生代理界面，不注入 DSH 的 UI 插槽 |
| 恢复与归档 | 复用 memory/checkpoint/work_units，关闭运行保留历史；Git 交接补充跨克隆摘要，不能恢复尚未落盘聊天 |

本轮源码候选统一为 4.4.0，避免覆盖已有 4.3.1 包版本。构建与测试不代表新版本已安装或发布。
