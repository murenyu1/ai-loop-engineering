# AI Loop 多平台（Harness）适配层设计规范

本仓库采用 **Core 共享内核 + Harness 独立适配层** 的 Monorepo 架构。

## 一、 目录组织与分工
```text
ai-loop-engineering/
├── core/             # 纯业务内核：状态机、协议标准、记忆存储、任务流与代理角色定义（跨平台通用）
├── dsh/              # DeepSeek Harness 专用插件（基于 DSH 协议、UI 面板、原生 subagent 派发）
├── codex/            # OpenAI Codex / CLI 适配（原生角色注入、MCP 服务、控制台）
├── cursor/           # [规划中] Cursor 适配层（基于 Cursor Rules / IDE 扩展）
└── claudecode/       # [规划中] Claude Code 适配层（基于 CLAUDE.md 与子代理调度）
```

## 二、 适配层研发红线与准则
1. **单向依赖原则**：
   - 适配层（如 `dsh/`, `codex/`, `cursor/`）可依赖或引用 `core/` 中的标准协议与通用脚本。
   - `core/` 内核代码绝对禁止包含任何特定 Harness 的私有 API 或硬编码依赖。
2. **构建纯洁性（无符号链接）**：
   - 为确保在跨平台（Windows / Linux / macOS）以及安全沙箱中发布，发行包打包流程要求所有文件为普通实体文件，禁止使用跨目录符号链接（Symlink）。
   - 打包脚本（如 `scripts/build-dsh.mjs`）会在构建时将 `core/` 内容自动合入目标发行包。
3. **版本号协同**：
   - 所有平台适配层的版本号严格与 `core` 的 `VERSION` 保持同步。
