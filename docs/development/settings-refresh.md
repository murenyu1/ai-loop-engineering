# 设置响应修复与安装：4.4.3

日期：2026-10-21。基准：`07c0cf9`，分支：`codex/workflow-sync`。用户已确认修复、回归、过期记录整理、构建与本机安装方案。本机运行：`.ai-loop/runs/settings-refresh-4.4.3/`。

## 目标与文件归属

- 开发角色负责 `plugins/codex/scripts/native-settings.mjs` 及设置相关测试：切换工作区/范围后返回当前有效模型、强度、并发与独立草稿，直接验证 update 响应。
- 主代理负责核心与插件版本、说明、发行产物、安装、项目标记和知识引用整理。保留历史记录、模型选择和工作区启用状态；不修改 settings.json、ACL 或钩子信任。
- 测试与评审在写入收敛后执行，独立上下文与主代理自检分别标记。没有宿主证据的 UI、钩子触发与实际模型保持未验收。

## 实现

- `native-settings.mjs` 的 update 改为异步，完成输入预检和范围草稿切换后复用 read 生成当前 values/schema/layout；移除旧 lastValues 合并。模型设为继承时从当前原生目录读取默认强度，首次进入工作区及默认值变化均不使用猜测缓存。
- `settings-server.mjs` 等待 update 完成，并在输出声明中公开刷新后的 schema/layout，使模型及强度下拉约束随选择更新。
- `native-settings.test.mjs` 直接检查更新响应，覆盖无先前 read、不同项目配置、范围切换、草稿隔离恢复、开关和 null effort 默认强度变化；相关调用改为等待更新完成。协议测试覆盖异步返回，工作区测试保持非法输入与已移除项目的拒绝边界。
- 核心、Codex、DSH 源码候选与说明统一为 4.4.3；历史发布下载链接保留，不声明新版已公开发布。

## 已取得证据

- 新增两项设置回归对已安装 4.4.2 的不可变导入副本执行，均在断言处失败，证明可发现旧缺陷；未修改旧安装缓存。
- 安装前 `node tests/all.mjs`：156 项，150 通过、0 失败、6 项 Windows 无法创建符号链接跳过。另有 MCP 协议 6 项测试通过。
- `node scripts/build-release.mjs` 生成通用核心 ZIP、Codex ZIP 和 DSH tgz；包摘要见本机发行报告与 downloads/SHA256SUMS。
- Codex 已通过原生管理器安装 4.4.3，安装文件与发行清单的 46 项摘要一致；全局与项目原生角色路径已迁移，保留安装时最新模型选择，doctor configuration=pass。
- 已安装版本的独立 stdio MCP 进程验证 update 与随后 read 的 values/schema 一致，成功返回 7 个原生模型。工作区启用状态、两端 settings.json 及 DSH 配置摘要均保持不变。此项是主代理自检，不冒充客户端 UI 验收。
- 项目 plugin 标记从 4.3.0 同步到 4.4.3；三条历史知识明确标为被新阶段替代并保留原文，Schema 条目按现有声明式实现重新核对来源。memory inspect 返回 ready、无来源问题。
- 最终快照全量验证与真实独立评审由本阶段 Git 提交说明及本机 reports 记录，不以前述安装前结果代替最终证据。

## DSH 与验收边界

- DSH desktop 离线更新因缺少其他已安装插件 dshmarket 的注册表元数据而无法完成供应链检查，未关闭检查、未下载依赖。用户明确选择暂不升级 DSH，保留已安装 4.4.2；4.4.3 tgz 仅作为本地构建产物保留。
- Codex 原生设置页面显示和点击保存、SessionStart 的原生信任与实际触发、角色实际有效模型，以及 DSH 桌面加载与派发仍需客户端验收。未改 settings.json、ACL 或信任缓存，不以测试或模型自述证明这些项目。
- 用户级 Git ignore 读取权限警告不属于插件功能故障，未调整用户权限。六项符号链接分支仍未实测。

本机证据目录：本运行 reports/，重点为 red-baseline.log、preinstall-all.log、release.json、codex-install.json、profiles-migrated.json、installed-doctor.json、installed-smoke.json、dsh-install.log。个人路径、配置内容和完整日志不随共享交接提交。

## 后续接手

先核对本文件、当前 Git、运行 state/session 与未关闭工作单元，再读取 `native-settings.mjs` 的设置值生成与 update、对应测试。版本发布仍需用户授权，本轮只处理本地候选与本机安装；不推送远端或发布 GitHub。
