# 调度协议

根据运行平台读取对应路由规范：
- DSH 环境：读取插件根目录的 `ROUTING.md`（配置项通过 DSH 原生插件设置或 `ai-loop-models` 管理）。
- Codex / Claude Code / 独立工作流：读取本目录的 `templates/routing.md`。

各平台负责模型与原生代理适配；独立评审必须使用独立上下文，记录真实调用标识，无法观察的有效模型保持 unverified。

独立包 4.7.0 已携带 Codex/Claude 项目安装器和 doctor；按完整 SETUP 识别宿主、预演和安装，再新会话确认原生角色发现并实际只读委派。Cursor/Pi/generic 仅有入口适配，缺少原生执行能力时停止多代理验收。没有实际插件的 DSH 不读取假定存在的插件路由，而应使用 DSH 插件或明确能力缺口。

4.7.0 独立证据流程使用 activity.mjs，详见 scripts/README.md：先 requested，原生启动后登记 native_id/context，观察终态后登记 evidence。不得仅凭角色文件、配置或 execution 声明通过；final 整体评审使用当前 event_seq 作为 attempt。
