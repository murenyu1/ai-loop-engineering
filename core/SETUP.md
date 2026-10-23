# 通用工作流安装入口

先识别当前会话的 harness，再区分仅使用协议与原生多代理安装。Markdown 角色、记忆目录或初始化成功都不能证明原生子代理已经可用。

- 仓库源码：读取上一级 SETUP.md；项目安装器位于 adapters/project/scripts/，根 scripts/ 提供兼容命令。不存在 plugins/ 目录。
- 独立 workflow ZIP：解压根 SETUP.md 包含完整安装说明；scripts/install.mjs、scripts/doctor.mjs 已随包提供，无需另取仓库适配器。
- Codex / Claude Code：按完整 SETUP 配置用户选择的原生模型角色，在当前宿主确认发现角色，再实际委派只读任务，保存真实 ID 与调用结果。
- DSH：使用 DSH 插件实现原生 spawn；通用入口不假装具备该能力。
- 未实现原生适配的环境：明确报告缺口；需要独立评审时保留待复核，不改用同代理扮演。

不修改 settings.json、信任、权限或项目根规则。涉及审批按用户与项目规范执行。没有 Node.js 时说明脚本证据门不可执行，不以指令模式绕过拒绝。
