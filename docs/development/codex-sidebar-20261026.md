# Codex 标准协议定位与零自动消息

日期：2026-10-26；分支 dev/codex，基线 08622e3。用户已确认实施方案并授权 Git 提交；随后确认“工作流配置”按钮是误认，本轮不删除或改动该功能。未授权推送、发布或覆盖运行中的安装缓存，本轮不执行这些操作。

## 确认的原因

- 标准 `ui/notifications/tool-input` 使用 `params.arguments`，页面却直接读取 `params.root/session`。以前的通知测试也使用错误的平铺参数；有 `window.openai.toolInput` 的夹具掩盖了该问题。新增无兼容全局对象的标准宿主测试，修复前确实复现空工作区，修复后设置与看板共享定位。
- DSH 通过原生 scope.sessionId/cwd 和 sessions.get 获取归属。Codex 静态线程入口规范只保证空参数 `{}`，并没有承诺向 iframe 暴露聊天 ID 或目录。不能因为 iframe 属于当前聊天就认定它已获得聊天标识。SessionStart 给模型的上下文也不会自动进入 iframe。
- 自动消息来自 07adf7a 引入的页面消息回调链路；基线 08622e3 已删除新页面中的消息代码。本轮只读比对时，已安装页面与基线页面一致，不能断言磁盘缓存仍包含发送代码；仍运行的旧页面或旧服务需要重载，实际消息的发生时刻没有实机证据。

## 本轮修改

- 标准通知正确解包 arguments，仍兼容旧平铺参数和 window.openai 输入。arguments 为空或无效时不回退外层字段；不采信猜测的 threadId/cwd。完整空输入立即解除旧归属，局部输入不作为权威定位。
- 宿主 initialized 通知同步触发输入时不再重复发起定位。设置和看板继续共用单份工作区及聊天状态。
- 处理标准 ui/resource-teardown，确认关闭并停止轮询、解除监听、拒收在途旧请求。区分带 method 的宿主请求和普通响应，即使双向 RPC 的数字 ID 相同也不会误配。
- ai_loop.dashboard 不再声明或接受 binding，收到旧请求明确报停用错误且不返回 UI 资源。历史 binding 仅在无 UI 的 dashboard.read 保留兼容，不能用于打开新面板。
- 未定位和工作区范围的提示明确区分，不把工作区全部运行说成当前聊天历史。默认离线宿主夹具走标准通知，不依赖兼容全局对象。
- 开发入口标记自动消息定位交接为已废弃，避免以后恢复该错误设计。
- 候选递增为 4.6.4，同步共享核心和两端必要版本元数据，避免原生安装继续复用 4.6.3 缓存路径；前端握手版本由服务器注入共享 VERSION，避免独立硬编码。DSH 功能源码未改动，生成包仅同步版本。

## 验证与限制

原始日志：`.ai-loop/runs/codex-sidebar-20261026/reports/`。新增标准通知、两页共享归属、空输入、局部输入、关闭协议、双向请求 ID 碰撞、在途旧响应、兼容宿主和旧 binding 拒绝等回归。生命周期检查记录自动消息数为零。全量、构建与最终检查结果见本文件后续验证段。

真实 Codex 页面点击验收未执行。computer-use 技能明确禁止自动操作 ChatGPT 桌面应用 UI，因此停止该验证方式，未换工具绕过；离线协议验证不冒充实机验收。静态侧栏完全没有可信上下文时的自动定位仍未实现，插件现有公开协议不足以完成它，不能称本轮全面解决了该宿主能力缺口。

未修改 settings.json、ACL、钩子信任、宿主状态或 DSH 工作树中的未提交改动。不会通过发送消息、读取最近聊天或后台 cwd 猜测当前聊天归属。后续实机验收应关闭旧面板、使用原生安装器升级并重载服务，分别检查静态空入口和带真实参数的工具入口。

依据：[OpenAI UI 桥](https://developers.openai.com/plugins/build/chatgpt-ui)、[OpenAI MCP 线程入口规范](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#thread-entrypoint)、[MCP Apps 参数通知规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#notifications-host--view)。

## 最终源码验证

- 39 项侧栏与设置专项通过；新增标准通知用例先在旧实现复现未定位，再通过修复。
- 首轮沙箱全量结果为 299 项、229 通过、64 失败、6 跳过；失败日志保留，不当作通过。正常用户环境复测 300 项、294 通过、0 失败、6 项 Windows 符号链接权限跳过。
- 递增到 4.6.4 后，正常用户环境重新执行 `node tests/all.mjs`，300 项、294 通过、0 失败、6 跳过，退出码 0；最终日志为 `reports/final.log`。前一次正常用户验证保留为 `reports/all-host.log`。
- `node scripts/build-release.mjs`、`node scripts/build-plugin.mjs --check`、`node scripts/build-dsh.mjs --check` 和 `git diff --check` 全部退出 0；原始退出码另存 `reports/exit-codes.json`。
- 新增三个 4.6.4 安装包并更新 SHA256SUMS，历史 4.6.3 归档保留原始字节。Codex ZIP SHA256：`5e36d8e9757c9d6ea257e5f7f06ab7695dbc96dd76951d076f6198222332ce85`。
- 本轮为主代理实施、验证与源码自检，没有独立子代理评审，也没有客户端实机点击验收。Git 提交只交付本轮修复及候选产物，不代表静态侧栏的宿主上下文缺口已解决。

## 用户后续授权的本机安装

用户随后明确要求安装到 Codex。原生安装器预演通过，第一次应用在写入前被工作树及其 .git 文件的沙箱账户所有者检查阻断；正常用户首次 Set-Acl 也因权限不足失败。用户明确批准只修复这两个对象的所有者，保存完整 ACL 备份后，通过 Windows 管理员授权完成最小修复；原访问规则、继承状态和禁止删除子对象的规则均保持原样，没有递归修复或重置 ACL。

随后原生 marketplace add / plugin add 成功返回 4.6.4，新缓存目录版本为 4.6.4。安装后的 54 个受管文件及 bundle.json 与构建产物全部一致。全局角色原先仍引用 4.6.3，按原配置预演后更新五个受管角色和管理记录到新路径；五个文件摘要验证通过，原模型、思考强度、角色状态与并发配置哈希保持一致。管理器保留了角色配置备份。

完整安装日志、权限备份、可审查修复脚本及摘要结果只保存在本机 `.ai-loop/deployments/codex-4.6.4/`，不提交个人 ACL 和配置。未修改 settings.json、钩子信任或 DSH 安装，也未推送或发布。此次只完成安装及文件验证；当前聊天中的旧 MCP 进程、旧侧栏页面和原生角色仍需重载后验证，不声称已热更新或完成实机界面验收。静态空入口没有可信上下文时的自动定位限制仍然存在。
