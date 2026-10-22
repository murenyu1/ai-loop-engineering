# 子代理控制与原生看板审查、实施方案

用户已于 2026-10-22 确认下述方案并授权实施。审查时的事实保留在本文；实现与交付状态见 [4.5.0 候选交接](agent-control-4.5.0.md)，不能把原始待确认措辞当成当前状态。

日期：2026-10-22。源码基准：49fa533，版本 4.4.3。当前阶段是调查和待确认方案，尚未修改工作流功能、安装副本或用户模型设置。仓库已有删除项 `dsh插件.txt`，保持原状。

## 已验证结果与边界

- Rainwood 正常宿主执行 `node tests/all.mjs`：退出码 0，158 项中 152 通过、0 失败、6 项因 Windows 符号链接限制跳过。原始日志：本机 `.validation/audit-20261022.log`。
- `node scripts/build-plugin.mjs --check`：退出码 0，47 个文件无差异。
- `node scripts/build-dsh.mjs --check`：退出码 0，27 个文件无差异。
- 在沙箱身份下先执行的 64 项针对性检查：57 通过、3 失败、4 跳过。3 项失败来自安装器明确要求正常用户宿主身份，随后由完整宿主验证覆盖；不把首次失败隐藏为通过。
- DSH 测试用 SDK 替身验证调用契约，客户端测试验证组件行为；这些结果不证明实际 DSH 桌面侧栏显示、真实模型执行或用户历史会话确实派发过代理。此次没有启动付费模型调用或独立评审代理。
- 本次另行修复了 Codex Windows 沙箱初始化：`.sandbox-bin` 原所有者已经是 Rainwood；服务以 LocalSystem 运行，目录受保护 DACL 缺少 SYSTEM 的 WRITE_DAC。备份后仅将该目录所有者改为 Administrators，访问规则逐字保留。普通沙箱读取及 Node 命令退出 0，刷新日志 errors=[]。备份留在项目集合根的 `codex-sandbox-repair.json`，不纳入插件发行；未改 settings.json。尚未验证未来版本升级后的长期表现。

## 现有派发机制

### core

`core/WORKFLOW.md` 定义计划、开发、验证、评审和交接；`core/scripts/loop.mjs` 维护任务状态、依赖、范围、快照、attempt 和修复次数。核心没有实际创建宿主代理的 API，角色文档也不会自行启动代理。standard/full 的原生分工主要靠宿主遵循路由；lite 可以主代理完成。独立评审必须是真实独立上下文。

核心报告检查不能认证报告作者身份，不能单靠 execution=independent 的声明证明真实独立执行。这一限制在现有文档中有说明；应让宿主观察记录补充证据。

### Codex

`codex/scripts/profiles.mjs` 写全局 `agents/loop-*.toml` 或项目 `.codex/agents/loop-*.toml`，模型记录分别在用户的 `ai-loop/models.json` 或项目 `.ai-loop/models.json`。宿主原生角色文件决定固定模型与强度；原生重载后由主代理使用当前客户端实际提供的代理工具派发。不能用 CLI 子进程或另建普通聊天冒充子代理。

原生角色路径与固定模型优先级符合当前官方自定义代理文档。但配置成功、角色已发现、实际调用及 UI 可见是四件不同的事。`adapters/project/scripts/agents.mjs` 的 agents.json 只是手工更新的最后观察台账，不是实时生命周期来源。

### DSH

`dsh/index.mjs:77` 注册 ai_loop_delegate。派发检查精确项目开关、深度、spawn 能力、模型路由和项目并发，再调用 subagents.startActivation，返回真实 childId，由原生 activation 交付结果并释放并发。子代理为独立上下文、叶角色；审批策略 never 的受阻工作交回主代理。这条调用路径没有用 shell 伪造代理。

## 发现与影响

| 优先级 | 事实及源码位置 | 影响与改进 |
|---|---|---|
| P1 | DSH 派发参数只有 role/description/prompt，见 dsh/index.mjs:80；生命周期结算只释放并发，见 :131 | 缺少 run/task/attempt 与 childId 的强关联，无法从看板可靠追踪哪个代理执行哪个任务。需要结构化派发契约、阶段与范围检查、重派去重及原生观察关联。 |
| P1 | 角色关闭没有数据语义。DSH config.mjs 的空角色返回 undefined；派发仍可继承父模型。Codex 路由要求五个角色都含模型，enabled=false 被校验拒绝 | 空模型不是关闭；必须从配置、调度、原生适配、展示四层支持关闭，不能只加下拉文案。 |
| P2 | dsh/client/index.mjs:683 注入 sessionId，:684 渲染时丢弃；SidebarDashboard 只从配置选项目 | 多会话或多工作区可能看不到当前会话的运行，甚至看到其他运行。应使用当前会话身份绑定工作区与运行，多候选明确选择。 |
| P2 | DSH RunDashboard :356 只映射 data.tasks；核心 summary :175 不返回代理；派发 output :87 仅文本 | 现有看板实际展示任务阶段，没有代理列表、模型观察、活动时间线；不能从未显示代理推断未调用。 |
| P2 | DSH :315 每个挂载实例独立固定 5 秒轮询 | 设置页和侧栏可重复请求；后台持续刷新，慢请求可能叠加。改为共享、可取消、可见性感知的数据订阅，事件能力不足时串行退避轮询。 |
| P2 | Codex settings-server.mjs 只有设置工具，未注册 UI 资源、运行看板和实时观察接口 | 目前没有可直接打开的 Codex 代理看板。需新增客户端公开支持的会话面板入口，并独立实测能力。 |
| P2 | 应用工作区开关调用 native-settings.mjs:226，只保存 workspaces.json；session-start.mjs 消费该开关；应用模型配置不会保存这个草稿 | 按钮有实际作用，但两套保存路径容易让用户误解。开关主要控制自动入口，不能声称关闭后所有已发现技能及角色都被宿主禁用。 |
| P3 | core/README.md 仍称 4.4.0 本地候选并引用旧下载入口 | 容易把实现、候选和发行版本混淆；此次更新同时同步说明。 |

以上说明存在可复现的设计缺口，不等于已经定位用户某次 DSH 会话的唯一根因。具体历史实例还需对应会话、插件加载状态、实际工具调用与生命周期记录。

## 建议行为

### 角色开关与默认值

1. planner/dev/tester/reviewer/scribe 都增加明确 enabled 布尔值；新安装、无配置及新出现的角色默认 false。显示名称为“关闭”，不把它作为模型 ID 传给宿主。关闭时不要求模型可用，也不探测或请求该角色模型。
2. 开启后再选择当前宿主实际支持的模型和推理强度。DSH 如保留继承父模型，须明确标注“启用并继承主会话模型”，与关闭、继承全局配置分开。
3. 项目显式 enabled=false 优先于全局启用；项目无覆盖时继承全局。保留已有用户明确配置的模型，迁移缺失配置为关闭；提供显式“全部关闭”。不能静默替换用户已选模型。
4. 配置版本必须升级，并明确旧适配器的拒绝写入边界。不能让旧版本忽略 enabled 后重新调用；升级同一运行的参与端前先停止旧执行者。
5. 派发前检查 enabled，关闭角色零次进入原生 spawn/LLM 调用。并发只统计真实排队/运行的执行者；禁用角色不会占位或触发自动替代代理。
6. 全部关闭后工作流仍可由主代理执行。规划、实现、必要验证及记录由主代理承担；独立评审未执行必须明确显示。新方案按实际能力声明验收；既有任务若要求 independent 而 reviewer 关闭，保留待复核，不能自动降成 self 或跳过门禁。
7. 关闭运行中角色先阻止新派发，再通过公开原生控制请求停止，待确认后标记停用；缺少控制能力时显示“待停止/无法确认”，不能宣称已停止或此后立刻零消耗。关闭后的零子代理 token 指没有该角色的新推理调用，不代表主会话、既有在途请求或插件元数据零 token。
8. Codex 项目角色文件移除可能回退到同名全局角色，不能把删除 TOML 当禁用。必须检查项目有效策略；插件不能承诺禁止用户在工作流之外直接使用宿主代理工具。

### 设置简化

保留项目自动入口的选择能力，将含义明确为“此工作区自动加载 AI Loop”。移除独立“应用工作区开关”按钮，合并为一个“保存设置”动作，并显示已保存/未保存/保存失败。只改工作区开关时不要求模型列表可用。跨配置保存先预检、后提交，失败回滚并保留草稿；切换工作区本身保持只读。DSH 总开关与精确项目授权语义继续明确展示。

### 看板与观察数据

共享任务状态继续以 core state 为权威；新增跨宿主的观察结构，包含 run/task/role/attempt、会话与原生代理 ID、请求模型、实际观察模型、状态、起止时间、最近活动、来源与过期时间。代理结束不直接把任务标 PASS。宿主重载、重派和旧批次报告要能辨认，失去连接展示“未知/观察已过期”。

宿主实时状态与持久任务记录分别标记。实时视图通过原生能力读取；持久化经已有授权写入路径或原生受控工具完成，不借宿主 fs 给项目增加绕过审批的写入接口。token 只显示宿主可靠提供的数据，区分输入/输出/缓存及累计值；缺失显示“不可获取”，不使用字符数估算。

推荐布局：

```text
AI Loop                 当前会话 · 当前运行
执行中 1 · 等待 1 · 已关闭 3 · 待复核 1

[代理] [任务] [活动]
开发    执行中   模型/强度   已运行 00:42
测试    等待开发完成
评审    已关闭   未执行独立评审

选中代理：任务、原生 ID、实际模型证据、最近活动
          打开原生会话（宿主支持时）
```

- DSH：右侧 AI Loop 页签作为主入口，绑定 sessionId；会话标题提供轻量活动数量与“打开看板”。宽屏详情可用 conversation.view 独立页签；初版不同时复制到三处。组件直接渲染插件数据，通过宿主原生连接传输；无需另启服务器、输入端口或打开浏览器。
- Codex：优先采用 MCP Apps 资源和 thread entrypoint，在会话内容面板中打开。沿用本地 stdio 服务，不额外开 localhost GUI。当前设置服务器须补资源协商、只读状态和 UI 生命周期。官方扩展描述了会话面板，但当前客户端是否接受本地插件该能力仍须最小探针实测，不能凭文档保证右栏可用；不依赖私有开关。
- Codex 能力探针是实施首阶段。若当前客户端不支持，先交付状态接口和原生代理观察，明确报告该面板目标尚未完成，并展示公开能力范围内的本地文件侧栏方案供选择；不把外部浏览器替代品当达标。
- core：提供平台中立的配置、观察和 status 输出，复用到各宿主；自身不假装拥有客户端侧栏能力。
- 打开/刷新看板不调用模型、不把完整日志持续注入主会话。共享订阅按可见性启停，断线可恢复，切换会话丢弃旧响应，多运行不擅自选择。

## 参考实现及采用范围

- [DSH Agent Teams 客户端](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/src/client/index.tsx)：会话标题入口、turnTail 摘要和右侧 tab，配合 [activity-monitor](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/src/client/activity-monitor.ts) 的共享观察与轮询；参考会话绑定与活动展示，不引入另一套任务权威状态。
- [billion-context DSH 客户端](https://github.com/ranxianglei/billion-context/blob/main/src/agent/dsh-native-client.ts)：conversation.view 页签可参考，但当前实现嵌入代理服务的 Web UI，依赖动态 origin 和 iframe；不照搬这部分。
- [dsh-git-graph 客户端](https://github.com/zhu1090093659/dsh-web/blob/dev/packages/dsh-git-graph/src/client/index.ts)：按 sessionId 获取工作区和监听变化；[共享 SSE](https://github.com/zhu1090093659/dsh-web/blob/dev/packages/dsh-git-graph/src/client/sse-leader.ts) 提醒避免多个页签建立重复长连接。仓库本次 API 默认分支为 dev，用户给的是 main 页面，具体实现以读取的 dev 源码为准。
- [OpenAI 自定义子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)：原生 TOML、模型优先级及权限继承。
- [OpenAI 插件扩展](https://developers.openai.com/plugins/build/extensions) 与 [MCP Extensions 会话入口规范](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#thread-entrypoint)：采用公开协商与会话入口，客户端显示独立验收。
- [MCP Apps 标准](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)：采用资源桥与能力协商，保持无 UI 客户端仍能读取结构化状态。

## 等待确认的实施范围

1. 能力验证：在隔离配置中验证 Codex 本地会话面板入口；核对当前 DSH SDK 的会话、生命周期、取消与客户端插槽。使用确定性工具和模拟任务验证 UI，不偷偷发起模型推理。必须真实推理验收时单独标明使用的角色与范围。
2. 核心及兼容适配：修改 core/WORKFLOW.md、core/scripts/loop.mjs，新增平台中立角色策略/观察模块及 CLI；修改 adapters/project/scripts/routing.mjs、models.mjs、agents.mjs 与必要安装校验。保留范围、快照、attempt 和独立评审门禁，提供显式兼容迁移。
3. Codex：修改 codex/scripts/native-settings.mjs、settings-server.mjs、profiles.mjs、plugin-models.mjs、plugin.mjs、session-start.mjs，新增包内会话面板资源，更新构建白名单。实现关闭默认、项目有效策略、统一保存与原生观察。
4. DSH：修改 dsh/config.mjs、index.mjs、client/index.mjs。增加角色门禁与结构化派发；将当前会话、任务和 activation 关联，原生侧栏展示真实活动，复用共享订阅。
5. 技能、路由和文档：同步两端 ai-loop / ai-loop-models 技能、ROUTING、core README、使用说明和本次共享交接，消除“必须调用所有角色”与“默认关闭”的矛盾。
6. 测试与交付：补充禁用零派发、继承优先级、旧配置迁移、关闭中停止、任务/会话隔离、并发、重载恢复、未知模型/usage、统一保存失败回滚、多视图共享订阅和客户端能力缺失回归。执行 node tests/all.mjs、两端构建检查，生成本地三端候选包；实际 UI、真实调用及有效模型分别验收。

预计超过 3 个文件，等待用户确认上述方案后编码。此次方案不修改 settings.json，不代替用户提交 Git、覆盖真实安装副本或发布 GitHub。该文档是审查与方案，不是已实现声明，也不是真实独立评审结果。
