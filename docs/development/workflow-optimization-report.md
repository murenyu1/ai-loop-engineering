# AI Loop 工作流优化任务报告

- 报告生成时间：2026-10-26
- 项目：`ai-loop-engineering`（源包仓库）
- 分支：`dsh/workflow-optimization`（基线提交 `ff808dd`，尚未提交本次改动）
- 报告用途：交给其他 AI 对本次任务做完整检测与验证。第 6 节给出可执行复验步骤，第 5 节如实列出未完成项与已知限制。

---

## 1. 用户提出的全部要求

### 1.1 原始任务（两条主线）

用户初始请求：

1. 对工作流的所有提示词进行优化；
2. 对工作流的流程设计、子 Agent 调用设计进行优化。

范围对象是 `ai-loop-engineering/` 这个 AI Loop 工作流插件项目自带的全部提示词、流程与子 Agent 调度实现。

### 1.2 开发分支要求

用户在任务提出后追加要求：使用 `/ai-loop`，并在 `dsh` 分支进行开发。

项目规范 `ai-loop-engineering/docs/development/README.md` 要求新开发分支命名为 `dsh/<主题>`，因此实际分支为 `dsh/workflow-optimization`（不是裸 `dsh`）。这一点需在复验时注意：仓库中不存在名为 `dsh` 的分支。

### 1.3 记录与交接要求（用户重点澄清）

用户在方案评审阶段明确提出真实使用场景，这直接改变了设计：

- 需要保存开发过程中的重要内容，使他可以**随时中断当前聊天、开一个新聊天，甚至换一个 Harness 继续做**；
- 明确说明**不会提前通知即将中断或压缩上下文**，因此“退出前再整理一次”的思路不可行；
- 要求澄清这套记录与 Git 是否冲突、如何改进，或者是否该取消。

由此确定的硬性要求：

- 记录必须是**事件驱动、即时追加**的，不能依赖中断前通知；
- 每个主代理执行轮次都要能恢复，不是只在“阶段结束”时记录；
- 必须跨聊天、跨 Harness、跨子项目可恢复。

### 1.4 项目记录隔离要求

用户指出根目录 `.ai-loop/runs` 下多个项目的运行混在一起难以区分。由此要求：二级项目的运行记录要按项目物理隔离，且查询、看板、恢复都必须按项目边界解析，同名 run 不能冲突。

### 1.5 过程性要求

- 涉及 3 个以上文件改动时，先输出中文实施方案，用户确认后再编码；
- 修改 `settings.json` 前必须说明并取得许可；
- 命中配置中 deny 的操作立即停止，不得换方式绕过；
- 全部回答使用简体中文，每次回答前称呼用户为“主人”；
- Git 提交说明使用中文。

### 1.6 执行方式要求

用户先确认了综合方案，随后因 DSH 原生 dev 子代理连续两次在完成前 `failed`，选择“授权主代理单代理实施（推荐）”，由主代理直接按已确认方案实施。同时保留：独立评审仍须真实执行，宿主不可用时保留待复核，不能伪称完成。

### 1.7 本次报告的附加要求

把整个任务的用户要求、最终执行方案、完成结果与交付写成一份 Markdown 报告，供其他 AI 参考并全面检测验证本次任务。

---

## 2. 最终执行的优化方案

以下是实际落地的那一版方案（此前讨论的中间版本不在此列）。

### 2.1 项目本地物理隔离存储

新增 `core/scripts/storage.mjs`（114 行），把“一个 run 的文件到底在哪个目录”从散落的硬编码收敛为统一抽象：

| 导出函数 | 职责 |
|---|---|
| `projectBase(project, projectPath)` | 由工作区根与子项目相对路径解析子项目物理根 |
| `newRunBase(project, { project_path, snapshot_paths })` | 决定新 run 落在子项目本地还是工作区根 |
| `discoverRecordBases(project)` | 扫描根目录与子目录中的 `.ai-loop/runs`，含 `.ai-loop/storage-index.json` 索引 |
| `registerProjectBase(project, projectPath)` | 登记项目存储基址 |
| `resolveRunBase(project, run, projectPath, options)` | 解析既有 run 的真实归属基址，支持精确筛选与多候选报错 |
| `runPathsAt(base, run)` | 按基址给出运行文件集合 |
| `runPaths(project, run, projectPath)` | 统一定位入口 |
| `runFile(project, run, relative)` / `relativeRunPath(...)` | 单文件定位与相对路径换算 |

存放规则：

- 指定子项目且非根目录的单项目 run → `<子项目>/.ai-loop/runs/<run>/`
- 根项目 run 或跨项目 run → 工作区根 `.ai-loop/runs/<run>/`
- 旧记录不自动迁移，旧活跃 run 保持原位置可继续使用。

### 2.2 提示词全面重构

重构对象与原则：关键约束前置、消除同一上下文内的重复、参数规则写在参数上、去掉历史补丁堆砌、保留安全底线（deny、权限、证据门禁）。

- **五个角色提示词** `core/agents/loop-planner.md`、`loop-dev.md`、`loop-tester.md`、`loop-reviewer.md`、`loop-scribe.md`：
  - 清除文件开头堆叠的历史版本补丁行，内容并入现行输入/返回契约；
  - 顶部前置宿主与安全约束（命中 deny 立即停止、3 个以上文件先出方案、`settings.json` 需许可、叶节点不得递归派发）；
  - 明确输入边界与简短 JSON 返回契约，正式补齐 `attempt` 与 `execution_id` 字段定义；
  - Tester 强化“必须真实执行命令”，日志落盘本 run 的 `reports/`；
  - Reviewer 明确独立评审与快照 `revision` 绑定；
  - Scribe 定位改为 run 级共享记录角色（`task: "run"`）。
- **共享规范** `core/WORKFLOW.md`、`core/MEMORY.md`：
  - 写入项目本地隔离存储与 `--project-path` 筛选规则；
  - 写入前运行轻量规划流程（不占正式 run/task、不写源码、不自动执行）；
  - 明确 Git 与 AI Loop/记录职能的分工；
  - 明确 DAG 依赖、并行写入与串行验证评审的收敛门禁；
  - 明确每轮 checkpoint 与关键事件即时追加是硬性职责。
- **跨平台模板** `core/templates/routing.md`：统一调度规范，保留 `standard`/`full` 分级下“只使用用户已开启的原生 `loop-*` 子代理”的表述。
- **DSH 侧** `dsh/skills/ai-loop/SKILL.md`、`dsh/skills/ai-loop-models/SKILL.md`、`dsh/ROUTING.md`：
  - 原先原生派发四步流程在同一上下文重复叙述三次，收敛为一处标准流程；
  - 前置安全准则与恢复入口；
  - `maxConcurrent` 说明校准为 1–32 整数、默认 6，与 `dsh/config.mjs:21` 的 `min(1).max(32).default(6)` 一致。
- **Codex 侧** `codex/skills/ai-loop/SKILL.md`、`codex/skills/ai-loop-models/SKILL.md`、`codex/ROUTING.md`：
  - 移除历史版本补丁堆砌；
  - 把角色模型策略从执行技能剥离到模型技能，避免两处重复；
  - 提炼原生启动四步闭环与前运行规划、DAG 收敛规范。

### 2.3 流程与子 Agent 调用设计

- **前运行轻量规划**：解决“planner 需要先有 run/task，但流程要求先规划再建 run”的循环。简单任务主代理直接写计划；复杂任务在创建正式运行前，由主代理或已开启的 planner 产出任务、依赖、互斥范围、验收标准草案，经用户确认后才 `create` 正式 run。
- **主代理统一调度，角色子代理是叶节点**：不递归派发；原生审批策略为不自动批准，受阻上报主代理。
- **planner/scribe 边界**：只能挂 `task: "run"`，不能挂到正式任务；`core/scripts/activity.mjs:16-17` 增加正式任务存在性判断，兼容旧版无 `run` 任务的记录。
- **默认流程图**：普通任务内部角色收敛为 `['dev', 'tester', 'reviewer']`，删除每任务内部的 planner 阶段；总体 planner 保留在 run 级（`core/scripts/workflow-graph.mjs:151`）。
- **执行身份含项目边界**：`dsh/index.mjs` 的 `ai_loop_status` 新增 `project_path` 参数，多项目工作区可直接筛选子项目本地运行。

### 2.4 记录、checkpoint 与跨 Harness 恢复

- 关键事件即时追加到 events，不依赖退出时整理；
- 每个主代理执行轮次写一次原子 checkpoint，保留事件游标、约束、决策、未决问题、下一步、改动文件与证据指针；
- 恢复时核对 Git 分支/HEAD/工作区状态、实际源码 revision 与原生执行状态，不使用旧交接当作当前已通过证据；
- Scribe 只做增量整理，不在恢复关键路径上；未启用 scribe 时由主代理写 checkpoint；
- 跨机器或重新克隆时另生成精简可提交交接摘要，是否提交由用户决定。

### 2.5 Git 与记录的分工

- Git 管源码、分支、提交历史；
- AI Loop 记录管用户意图、批准内容、决策原因、被否决路线、阻塞、未决问题、下一步与验证证据指针；
- 记录不复制源码 diff 或长日志，只存指针；记录 Git 分支与 HEAD 与 dirty 状态，但 dirty 不等于已提交，也不等于已通过。

---

## 3. 任务完成结果

### 3.1 变更总览

- 分支：`dsh/workflow-optimization`
- 基线：`ff808dd`，本次改动**尚未提交**
- 变更文件：24 个（23 个已跟踪文件被修改 + 1 个新增文件 `core/scripts/storage.mjs`）；另有本报告文件 `docs/development/workflow-optimization-report.md` 为新增文档，不计入上述 24 个
- 行数：已跟踪文件 `672 insertions(+) / 442 deletions(-)`；新增文件 114 行
- 工作区除上述源码改动外，仅有工作区根 `.ai-loop/` 运行记录变化（`.gitignore:4` 已忽略 `/.ai-loop/`）

### 3.2 逐文件改动清单

| 文件 | 增删 | 改动要点 |
|---|---|---|
| `core/scripts/storage.mjs` | 新增 114 行 | 项目本地存储抽象，9 个导出函数 |
| `core/scripts/loop.mjs` | +118/−… | `snapshot` 对每个 scope 追加子目录 `.git`/`.ai-loop` 排除（`:167`）；新增 `normalizePath` 大小写规范化比较（`:153`，Windows 盘符/目录大小写不等导致排除失效）；导出 `paths`（`:202`）；`create` 接入 `newRunBase`/`resolveRunBase`/`registerProjectBase`（`:355-360`）；`listRuns`/`status` 支持 `project_path` 筛选 |
| `core/scripts/activity.mjs` | +48/−… | 引入 `storage.mjs`；`dispatchCheck` 增加正式任务存在性判断（`:16-17`）与 `options`；`recordActivity`/`activityStatus` 按项目基址加锁与读写 |
| `core/scripts/execution.mjs` | +5/−… | `checkExecution`/`executionEvidence` 改用 `runPaths(...).directory` 定位 reports 与 activity，不再硬编码根目录 |
| `core/scripts/memory.mjs` | +66/−… | 引入 `storage.mjs`；`runState`/`checkpointInfo`/`renderSession`/`checkpoint`/`compactRun`/`bootstrap`/`readHandoff` 全部支持 `project_path`；`bootstrap` 改用 `listRuns(root, { project_path })`；`readHandoff` 按 `runPaths` 定位 `checkpoint.json`（`:438`） |
| `core/scripts/dashboard.mjs` | +19/−… | `chatHistory` 支持 `project_path` 过滤；游标改为 `created_at` + `project_path` + `run_id` 复合键（`compareRunKey` `:7`），防跨项目同名 run 碰撞 |
| `core/scripts/workflow-graph.mjs` | +5/−… | 普通任务内部角色由含 planner 收敛为 `['dev','tester','reviewer']`（`:151`） |
| `core/WORKFLOW.md` | +20/−… | 项目本地存储、前运行规划、Git/记录分工、DAG 收敛门禁 |
| `core/MEMORY.md` | +17/−… | 存储架构、多项目隔离、Git 与记录互补、持续交接 |
| `core/templates/routing.md` | +76/−… | 跨平台调度规范统一，保留 `standard`/`full` 原生 `loop-*` 子代理表述 |
| `core/agents/loop-planner.md` | +66/−… | 提示词重构，安全约束前置，返回契约补齐 |
| `core/agents/loop-dev.md` | +82/−… | 同上，明确互斥范围与最小改动 |
| `core/agents/loop-tester.md` | +90/−… | 同上，强化真实执行与 `attempt`/`execution_id` |
| `core/agents/loop-reviewer.md` | +89/−… | 同上，独立评审与快照绑定 |
| `core/agents/loop-scribe.md` | +92/−… | 同上，run 级共享记录与持续 checkpoint |
| `dsh/skills/ai-loop/SKILL.md` | +72/−… | 去三重重复，四步派发收敛为一处 |
| `dsh/skills/ai-loop-models/SKILL.md` | +28/−… | `maxConcurrent` 校准为 1–32、默认 6 |
| `dsh/ROUTING.md` | +44/−… | 清理补丁注释，提炼派发、叶节点、收敛规范 |
| `dsh/index.mjs` | +12/−… | `ai_loop_status` 增加 `project_path` 参数（`:298`、`:315`） |
| `codex/skills/ai-loop/SKILL.md` | +72/−… | 移除历史补丁，角色模型策略剥离 |
| `codex/skills/ai-loop-models/SKILL.md` | +36/−… | 承接角色模型策略，去重 |
| `codex/ROUTING.md` | +48/−… | 原生启动四步闭环、前运行规划、DAG 门禁 |
| `tests/loop.test.mjs` | +3/−… | fixture 适配多项目路径定位 |
| `tests/execution.test.mjs` | +6/−… | 子项目 reports 相对路径与大小写不敏感匹配 |

### 3.3 关键实现细节（供复验定位）

- `ai-loop-engineering/core/scripts/loop.mjs:153`：`const normalizePath = value => process.platform === 'win32' ? value.toLowerCase() : value;`
- `ai-loop-engineering/core/scripts/loop.mjs:167`：`for (const metadata of ['.git', '.ai-loop']) if (fs.existsSync(safePath(root, `${prefix}/${metadata}`))) excluded.push(`${prefix}/${metadata}`);`
- `ai-loop-engineering/core/scripts/activity.mjs:16-17`：
  - `const hasFormalRunTask = current.tasks.some(item => item.id === 'run');`
  - `if (taskId === 'run' && !hasFormalRunTask) assert(['planner', 'scribe'].includes(role), '运行级只允许 planner 或 scribe');`
- `ai-loop-engineering/core/scripts/dashboard.mjs:7`：`const compareRunKey = (left, right) => compareText(left.created_at, right.created_at) || compareText(left.project_path ?? '.', right.project_path ?? '.') || compareText(left.run_id, right.run_id);`
- `ai-loop-engineering/dsh/config.mjs:21`：`maxConcurrent: z.number().step(1).min(1).max(32).default(6).volatile(),` —— 与 `dsh/skills/ai-loop-models/SKILL.md:22` 的文字一致。

---

## 4. 验证情况

### 4.1 已通过

用 `node tests/<file>.test.mjs` 逐个文件直接运行（避免 `node --test` 多文件模式在沙箱内派生进程）：

| 测试文件 | 结果 |
|---|---|
| `tests/workflow-graph.test.mjs` | 11 / 11 通过 |
| `tests/loop.test.mjs` | 28 项：25 通过，3 跳过（Windows 无符号链接权限），0 失败 |
| `tests/execution.test.mjs` | 5 / 5 通过 |
| `tests/roles.test.mjs` | 10 / 10 通过 |
| `tests/dsh-plugin.test.mjs` | 24 / 24 通过 |
| `tests/dsh-client.test.mjs` | 31 / 31 通过 |
| `tests/routing.test.mjs` | 13 项：3 通过，10 失败（失败原因全部为环境限制，见 4.2） |
| `tests/memory.test.mjs` | 16 项：12 通过，3 失败（环境限制），1 跳过 |

### 4.2 因宿主沙箱限制无法通过（非代码回归）

以下失败全部源自当前 Windows 沙箱禁止测试进程再派生外部进程，与本次改动无关，且已遵守“不提权、不换方式绕过”：

- `Error: Windows 权限检查/修复失败：spawnSync powershell.exe EPERM`（`codex/scripts/windows.mjs:43` → `adapters/project/scripts/install.mjs:302`）
- `AssertionError: spawnSync C:\Program Files\nodejs\node.exe EPERM`
- `Error: spawn EPERM`（`node --test` 多文件模式派生 runner 时）

影响面：`tests/memory.test.mjs` 的 3 项、`tests/routing.test.mjs` 的 10 项，以及 `node tests/all.mjs` 全量套件无法在本环境跑完。**这些项不代表功能已通过，也不代表功能已回归**，需要在无沙箱限制的环境重跑确认。

### 4.3 AI Loop 运行记录状态

- 运行：`workflow-optimization-20261026`，`schema_version: 4`，`project_path: ai-loop-engineering`，`event_seq: 6`
- 任务：`core-runtime` → `dsh-runtime` → `prompts-adapters`（后两者依赖前序）
- `core-runtime` 已执行 `finish`，阶段为 `developed`；**未进入验证与评审**
- `dsh-runtime`、`prompts-adapters` 仍为 `pending`，`blocked_reason` 为“依赖任务尚未通过”
- 原生 dev 子代理两次在完成前失败，无 closing message：
  - `exec-91c3603c-aa53-49f7-80de-c3edaa5c05e5` / native `433a3efd-6a04-41f9-813e-7b1fbfb5235f`
  - `exec-d976e890-9b0d-4f11-b2e2-463cf5e79f90` / native `a0b70186-9876-45f6-b380-e905d4ee8596`
  - 证据文件：`.ai-loop/runs/workflow-optimization-20261026/reports/exec-91c3603c-observed.json`、`exec-d976e890-observed.json`

---

## 5. 未完成项与已知限制（复验必读）

诚实列出，避免下游 AI 误判为“全部完成”：

1. **`ai_loop_plan` 工具未实现。** 方案中“前运行规划”只落地在流程与提示词层。`dsh/index.mjs` 实际只注册了 4 个工具：`ai_loop_delegate`、`ai_loop_prepare`、`ai_loop_observe`、`ai_loop_status`，没有 `ai_loop_plan`。原 `core/WORKFLOW.md:49` 曾以“如 DSH 的 `ai_loop_plan`”措辞指向不存在的工具，已修正为不指向具体工具名的流程描述。因此 `spec.json` 中 `dsh-runtime` 任务“`ai_loop_plan` 使用独立 plan_id 和真实原生证据”这条验收**未达成**。
2. **独立评审未执行。** `core-runtime` 声明 `review: independent`，但缺少可用的独立执行者（原生 dev 两次失败后用户授权单代理），按项目规范保留待复核，未伪造通过。三个任务均未走完 tester/reviewer 门禁。
3. **完整测试套件未跑通。** `node tests/all.mjs` 在本沙箱因进程派生限制失败，需在无限制环境重跑。
4. **版本号残留未清理。** `core/README.md`、`core/ROUTING.md`、`core/scripts/README.md`、`dsh/README.md` 等版本/发布说明文档中仍有 `4.6.0` / `4.5.0` 字样。这些是版本说明与下载指引，不属于本次“提示词去重”改动范围，未改动。
5. **未提交、未安装、未发布、未迁移历史记录。** 全部改动停留在工作区，`settings.json` 未被修改，历史 run 记录未被迁移。
6. **`dsh/index.mjs` 执行池与幂等键未加入项目边界。** `ai_loop_status` 已支持 `project_path` 筛选，但 `pool = projectKey(root)` 与执行 key `` `${run}\0${task}\0${role}\0${attempt}` `` 仍以工作区根为维度，方案中“执行身份含项目边界”这项只完成了状态筛选部分。这是 `dsh-runtime` 未完成的直接后果。
7. **未在真实宿主做端到端验收。** 未安装到 DSH/Codex 插件目录，未在真实宿主验证原生派发、看板与恢复链路。单元测试不证明真实宿主行为。

---

## 6. 给复验 AI 的可执行步骤

```bash
# 1. 确认分支与工作区状态（应看到 23 个 M + 1 个 ?? core/scripts/storage.mjs）
cd ai-loop-engineering
git status --short --branch
git log --oneline -1          # 应为 ff808dd
git diff --stat               # 应为 23 files, 672 insertions, 442 deletions

# 2. 确认新增存储抽象
wc -l core/scripts/storage.mjs        # 应为 114
grep -n "^export function" core/scripts/storage.mjs   # 应为 9 个导出

# 3. 逐文件跑核心测试（不要用 node --test 多文件模式，沙箱会 EPERM）
node tests/workflow-graph.test.mjs    # 期望 11 pass / 0 fail
node tests/loop.test.mjs              # 期望 25 pass / 3 skip / 0 fail
node tests/execution.test.mjs         # 期望 5 pass
node tests/roles.test.mjs             # 期望 10 pass
node tests/dsh-plugin.test.mjs        # 期望 24 pass
node tests/dsh-client.test.mjs        # 期望 31 pass

# 4. 跑受环境限制的两组，确认失败原因仅为 EPERM
node tests/memory.test.mjs 2>&1 | grep -iE "EPERM|ℹ (tests|pass|fail|skipped)"
node tests/routing.test.mjs 2>&1 | grep -iE "EPERM|ℹ (tests|pass|fail|skipped)"

# 5. 核对关键实现点
grep -n "normalizePath" core/scripts/loop.mjs            # 应在 :153
grep -n "hasFormalRunTask" core/scripts/activity.mjs     # 应在 :16-17
grep -n "compareRunKey" core/scripts/dashboard.mjs       # 应在 :7
grep -n "project_path" dsh/index.mjs                     # 应在 :298, :315
grep -n "maxConcurrent" dsh/config.mjs dsh/skills/ai-loop-models/SKILL.md

# 6. 核对未完成项
grep -n "name: 'ai_loop" dsh/index.mjs                   # 应只有 4 个，无 ai_loop_plan
grep -rn "ai_loop_plan" --include="*.md" --include="*.mjs" . | grep -v node_modules  # 应为空

# 7. 核对 AI Loop 运行状态
node core/scripts/loop.mjs status --project .. --run workflow-optimization-20261026
```

建议复验重点：

1. `storage.mjs` 的 base 解析在多候选、同名 run、子项目嵌套三种情形下是否正确报错或正确归属；
2. `loop.mjs:153` 的大小写规范化是否真的覆盖 Windows 盘符与目录大小写不一致；
3. `memory.mjs` 全部出口是否都改走 `runPaths`，有无遗漏的根目录硬编码；
4. 提示词重构后是否有语义漂移——尤其角色契约里的 `attempt`、`execution_id`、`revision` 是否仍与 `loop.mjs` 的 `record`/`begin` 校验一致；
5. 双端技能去重后是否丢失了某个宿主的必要约束（DSH 与 Codex 的并发默认值不同：DSH 6 / Codex 3，不可混写）。

---

## 7. 交付物清单

| 交付物 | 位置 |
|---|---|
| 源码改动 | `ai-loop-engineering/` 工作区，分支 `dsh/workflow-optimization` |
| 新增存储抽象 | `ai-loop-engineering/core/scripts/storage.mjs` |
| 任务规格 | `.ai-loop/runs/workflow-optimization-20261026/spec.json` |
| 运行状态 | `.ai-loop/runs/workflow-optimization-20261026/state.json` |
| 事件日志 | `.ai-loop/runs/workflow-optimization-20261026/events.jsonl` |
| 交接快照 | `.ai-loop/runs/workflow-optimization-20261026/checkpoint.json` 与 `handoffs/` |
| 原生失败证据 | `.ai-loop/runs/workflow-optimization-20261026/reports/exec-*-observed.json` |
| 本报告 | `ai-loop-engineering/docs/development/workflow-optimization-report.md` |
