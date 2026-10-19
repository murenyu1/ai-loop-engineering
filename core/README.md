# AI Loop 通用工作流 4.2

这份包提供 AI 开发的计划、实现、验证、评审与交接协议，以及可选的本地状态和分页记忆工具。它不包含 Codex 插件、模型面板或特定客户端的自动入口。

## 使用

1. 解压到一个固定目录，不必复制到每个项目。让 AI 读取该目录的 `WORKFLOW.md`、目标项目已有规则，以及当前阶段的 `agents/loop-*.md`。
2. 有 Node.js 18+ 时，用绝对路径运行 `node 工作流目录/scripts/memory.mjs bootstrap --project 项目绝对路径`。没有运行记录时返回空状态；这不表示失败。
3. 新任务先确认方案和验收，再按流程建立运行；继续任务先读摘要、交接、未关闭单元和必要的改动文件。命令接口见 `scripts/README.md`。
4. 项目状态保存在项目自己的 `.ai-loop/`，工作流目录保持只读。重要决定和工作单元及时落盘，中断后新会话才有据可恢复。

`WORKFLOW.md` 是执行流程，`MEMORY.md` 是读写与分页协议，`agents/` 是角色约定。独立评审需要客户端真正提供独立执行上下文；本包不会伪造子代理、有效模型或验证通过。

## 选择插件

需要 Codex 一次安装、可视化模型配置和工作区自动入口，请下载 [Codex 插件包](https://github.com/murenyu1/ai-loop-engineering/blob/main/downloads/ai-loop-codex-4.2.0.zip)，按包内 README 操作。其他客户端可以直接使用本通用包，其原生入口由对应适配器负责。

源代码、完整下载与设计说明见 [项目首页](https://github.com/murenyu1/ai-loop-engineering)。
