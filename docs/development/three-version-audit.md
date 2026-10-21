# 三端复查：4.4.0 候选

日期：2026-10-20。源码基准：`778fc1b`。范围：core、Codex 插件、DSH 插件。用户要求暂缓安装、先检查；本轮没有修复源码或更新用户实际安装副本。

## 发现

1. **P1，核心版本隔离不足，已复现。** `core/scripts/loop.mjs` 的 `load` 只接受/检查 schema 1，创建新版运行仍使用 schema 1。4.3.1 核心能读取 4.4.0 创建的 managed_execution 任务，并接受缺少 attempt 的 PASS，将任务置为 done；同一报告由 4.4.0 正确拒绝。文档要求两端统一升级，但没有硬性门禁。建议新契约使用旧核心会拒绝的 schema，保留旧运行读取和明确迁移路径；仅在新核心增加版本判断不能约束已安装旧核心。
2. **P2，核心信箱 CLI 游标不可用，已复现。** `core/scripts/loop.mjs:511,537` 使用 after_id；`core/scripts/lib.mjs` 参数解析仅接受连字符。`--after_id` 报非法参数，`--after-id` 报未知参数。建议统一公开参数为 `--after-id`，转换到内部 after_id，并增加 CLI 级回归。
3. **P2，DSH 项目单独调整强度会固定模型，已复现。** `plugins/dsh/client/index.mjs:405` 把全局合并后的有效值整体写回项目。仅修改 reasoningEffort 也会复制 provider/model，之后项目不再继承全局模型更新。建议从项目自身覆盖值生成补丁，并覆盖真实 RoleCard 交互测试。
4. **P2，DSH 选择模型继承生成非法配置，已复现。** `plugins/dsh/client/index.mjs:438` 清空 model 但保留 provider，导致 rolesValid=false、无法保存。建议继承动作成对处理 provider/model，区分继承父智能体与重置项目覆盖。
5. **P2，Codex 恢复默认存在部分成功风险，静态确认。** `plugins/codex/scripts/profiles.mjs:108,115` 先删除项目角色及模型记录，之后才解析全局 fallback；全局模型记录损坏时，错误发生在删除完成之后且不在回滚区间。虽已保存历史备份，用户仍可能收到失败却失去原项目覆盖。建议删除前解析校验 fallback，保持失败原子性。本轮该异常路径未完成正常宿主动态复现，不能称其已实测。

## 验证

- `node tests/all.mjs`：正常宿主退出码 0；145 项中 139 通过、0 失败、6 项因 Windows 符号链接限制跳过。
- 首次在沙箱账户运行有 32 项被 Windows 配置写入身份检查阻断；保留原始日志，不计为功能通过。正常宿主重跑没有改 ACL 或真实用户设置。
- `node scripts/build-plugin.mjs --check`：4.4.0，47 文件，无差异。
- `node scripts/build-dsh.mjs --check`：4.4.0，27 文件，无差异。
- Codex 评审者在独立 CODEX_HOME 的隔离市场验证原生 marketplace add 可重复、plugin add 可从 4.3.1 更新到 4.4.0。这不表示用户当前插件已更新或已加载。
- 核心复现脚本及结果：本机 `.ai-loop/diagnostics/recheck-core.mjs`、`recheck-core.json`。
- DSH 内存 UI 交互复现及结果：本机 `.ai-loop/diagnostics/recheck-dsh.mjs`、`recheck-dsh.log`。
- 完整测试日志：本机 `.ai-loop/diagnostics/recheck-all.log`、`recheck-all-host.log`。

## 改进与后续

优先修复以上五项并补针对性回归，再恢复安装和真实宿主验收。三端都应区分候选版本与已发布版本；不要把下载链接提前改为尚未发布的 4.4.0 URL。插件说明标题和旧安装示例需要与候选状态对应。

真实 Codex 新版会话加载、实际角色模型、设置页面，以及 DSH 桌面侧栏和实际派发仍需分别验收。自动测试通过不能证明没有 bug。本次独立评审为诊断发现，不是正式最终快照 APPROVED 门禁。
