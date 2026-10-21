# 调度协议

根据运行平台读取对应路由规范：
- DSH 环境：读取插件根目录的 `ROUTING.md`（配置项通过 DSH 原生插件设置或 `ai-loop-models` 管理）。
- Codex / Claude Code / 独立工作流：读取本目录的 `templates/routing.md`。

各平台负责模型与原生代理适配；独立评审必须使用独立上下文，记录真实调用标识，无法观察的有效模型保持 unverified。
