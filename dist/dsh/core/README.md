# AI Loop 通用工作流 4.3.0

这份包提供 AI 开发的计划、实现、验证、评审与交接协议，以及可选的本地状态和分页记忆工具。它不包含 Codex 插件或特定客户端的自动入口。

通用工作流与 Codex 插件在 [GitHub Releases](https://github.com/murenyu1/ai-loop-engineering/releases/tag/v4.3.0) 分别下载。

## 使用

1. 将通用工作流包解压到固定目录，不必复制到每个项目。让 AI 读取该目录的 `WORKFLOW.md`、目标项目已有规则，以及当前阶段需要的 `agents/loop-*.md`。
2. 有 Node.js 18+ 时，运行 `node 工作流目录/scripts/memory.mjs bootstrap --project 项目绝对路径`。没有运行记录时返回空状态，不表示失败。
3. 新任务先确认方案和验收，再按流程建立运行；继续任务先读摘要、交接、未关闭工作单元和必要改动文件。命令接口见 `scripts/README.md`。
4. 项目状态保存在项目自己的 `.ai-loop/`，工作流目录保持只读。重要决定和工作单元及时落盘，中断后新会话才有据可恢复。

`WORKFLOW.md` 是执行流程，`MEMORY.md` 是读写与分页协议，`agents/` 是角色约定。独立评审需要客户端真正提供独立执行上下文；本包不会伪造子代理、有效模型或验证通过。

## Codex 插件

Codex 用户可选用独立的 Codex 插件包。4.3.0 本机候选 ZIP 位于仓库 `downloads/ai-loop-codex-4.3.0.zip`，目前尚未发布到 GitHub；远端仍为 4.2.0。插件包包含所需核心与 Codex 原生设置接入，用户无需另装通用包。原生设置可见性取决于客户端支持和功能开关，页面仍需在实际 Codex 客户端验收。

其他客户端可使用通用包，其原生入口由对应适配器负责。源码、目录说明和下载选择见仓库[项目首页](../README.md)。
