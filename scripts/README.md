# 本地工具接口

需要 Node.js 18+，仅使用标准库。命令在目标项目根目录执行；安装与测试时，将 `BUNDLE` 替换为 install.json.source 的原始源包路径；开发运行时替换为当前 harness 注册表中的 home 部署路径。`ROOT` 为项目绝对路径。这里的占位符不是环境变量或固定目录名。
脚本不调用模型、不执行报告中的验证命令、不安装依赖、不修改 settings.json。执行前仍须遵守项目权限与已批准范围；遇到配置 deny 停止。

## 安装

```text
node BUNDLE/scripts/install.mjs --project ROOT --harness codex
node BUNDLE/scripts/install.mjs --project ROOT --harness codex --apply
node BUNDLE/scripts/install.mjs --project ROOT --harness codex --check
```

`--harness` 支持 codex / claude-code / cursor / pi / dsh / generic / auto。默认预演，--apply 写入，--check 只读。AI 优先根据用户指定和会话身份提供明确参数；auto 只采用唯一环境提示，不看已有目录猜测。

Codex 以 .codex/config.toml 的 developer_instructions 指向 .codex/ai-loop/AGENTS.md；Claude 以 .claude/rules/ai-loop.md 指向 .claude/ai-loop；Cursor 以 .cursor/rules/ai-loop.mdc 的 alwaysApply 指向其部署；Pi 合并 .pi/APPEND_SYSTEM.md。DSH 使用显式 .dsh/ai-loop/ENTRY.md。generic 必须指定如 --entry .mytool/rules/ai-loop.md 的工具子目录入口，默认显式读取。

正常安装不改根 AGENTS.md / CLAUDE.md，只配置当前工具。schema 2 清单 harnesses 为注册表，各记录独立 home、entry、loader、version、files 摘要和 entries 管理块摘要；loading 仍为 unverified。源包和已部署文件不能相互包含；不从部署副本反向安装。

schema 1 使用 --migrate 预演与应用，迁移全部已知旧平台，备份原清单与根入口，移除未改动的旧管理块，保留块外规则与 runs。旧 generic 需单独映射。孤立块、修改过的正文、符号链接、目录冲突和路径越界均停止。个人指令覆盖风险、原生规则碰撞及加载验收按 SETUP 处理；不修改 settings.json。

## 项目记忆与启动

以下 BUNDLE 为当前平台部署 home；不要把知识复制到各平台。完整职责与恢复顺序见 [MEMORY.md](../MEMORY.md)。

```text
node BUNDLE/scripts/memory.mjs bootstrap --project ROOT
node BUNDLE/scripts/memory.mjs bootstrap --project ROOT --intent continue
node BUNDLE/scripts/memory.mjs bootstrap --project ROOT --intent continue --run RUN_ID
node BUNDLE/scripts/memory.mjs bootstrap --project ROOT --intent new
node BUNDLE/scripts/memory.mjs inspect --project ROOT
node BUNDLE/scripts/memory.mjs search --project ROOT --query "接口 兼容" --limit 8
```

bootstrap 默认 inspect，仅返回共享记忆状态、索引路径、active 运行短摘要和交接问题。continue 唯一候选时定位，多个候选返回 needs_choice；显式指定关闭运行返回 do-not-resume。选择并不执行开发或自动 resume；先核对当前项目，snapshot_status 始终 unchecked。--limit 为 1–30，默认 10；有 next_after 时用 --after 续读。new 不自动继续旧任务。

inspect 返回 revision、文档 hash 与来源问题，不输出全部知识。search 合并完全相同的条目并保留其他文档指针，返回有限条目，单次摘录约束为 8000 字符，可能截断；核对重要原文。字符数不等于 token 数。

## 增量保存知识

先读取相关原文和 inspect 的 revision/hash，再保存输入 JSON，例如 .ai-loop/memory-update.json：

```json
{
  "base_revision": 0,
  "documents": [{
    "name": "index",
    "expected_hash": "替换为 inspect 返回的当前文件 hash；文件不存在时为 null",
    "summary": "项目目标、重要约束与资料入口的短概览",
    "entries": [{
      "id": "compatibility",
      "title": "保留现有接口",
      "text": "用户确认本次开发须保持现有接口兼容。",
      "scope": "当前接口模块",
      "status": "confirmed",
      "sources": [{"type": "user", "text": "本次用户明确确认接口兼容要求"}]
    }]
  }]
}
```

```text
node BUNDLE/scripts/memory.mjs save --project ROOT --input .ai-loop/memory-update.json
```

name 为 index / architecture / decisions / lessons；不存在的详细文档按需创建。summary 首次必填，更新可省略；entries 为按稳定 id 合并的增量，不默认删除未提供条目。撤销条目标为 superseded。状态为 confirmed / observed / unverified / superseded；有效事实须有来源，猜测必须 unverified。

来源格式：file 带项目相对 path，保存时计算摘要；event 带 run 和正整数 seq；user 带实际记录的 text；url 带无凭据的 HTTP(S) url。不得引用知识库自身形成循环；外部链接仅记录，不由脚本联网验证。来源变化要求 AI 核对结论，不自动证明事实已失效或仍成立。

知识与交接文件采用 UTF-8；其他编码先保留原文并明确转换，不猜测编码后覆盖。catalog.json 是结构化存储，Markdown 为阅读视图。base_revision 和 expected_hash 防止覆盖并发修改；保存旧正文到 memory/history/。未索引旧资料需要先读、保留有效内容，并在对应文档 patch 加 import_existing: true；初始索引模板例外。已索引正文被手改也必须先读取并明确合并，通过 import_existing 保留有效补充；不直接重建丢弃信息。脚本不能证明 AI 真的处理了全部旧资料。

index 最多 6000 字符，其他文档最多 48000 字符；每文档最多 100 条，单条正文最多 4000 字符，目录 JSON ≤1 MiB。超限整理到项目资料并保存指针，不能以压缩为由丢失约束。相同有效更新返回 unchanged，不增长 revision。

## 保存与检查交接

从 bootstrap --run RUN_ID 的 selected.run.checkpoint 获取 expected_hash、event_cursor 与 event_head；用 loop events 分批读取实际未消费的事件。输入 .ai-loop/checkpoint-update.json：

```json
{
  "expected_session_hash": "替换为 checkpoint.expected_hash；文件缺失时为 null",
  "base_cursor": 0,
  "event_cursor": 1,
  "intent": "继续用户已确认的本次开发目标",
  "constraints": ["仍有效的范围和限制"],
  "decisions": ["已确认方案，以及选择它的原因"],
  "open_questions": [],
  "next_steps": ["核对实际差异，再继续尚未完成的任务"],
  "references": [".ai-loop/runs/RUN_ID/spec.json"]
}
```

```text
node BUNDLE/scripts/memory.mjs checkpoint --project ROOT --run RUN_ID --input .ai-loop/checkpoint-update.json
```

base_cursor 对应已读取的旧交接游标；event_cursor 仅填本次实际消费到的游标，不能回退或超过事件头。数组必填，next_steps 至少一项，引用须为已有项目内普通文件。交接最多 12000 字符。旧 session 备份到本运行 handoffs/；checkpoint.json 保存结构和 hash，不修改 state、报告或计数。

有未消费事件返回 events-pending；缺失 checkpoint 的旧运行仍可发现，但需读取旧 session 与必要事件后补交接。正文被改、引用丢失或游标落后均标 needs-check。completed/stopped 的交接可归档整理，不允许借此重开运行。脚本检查结构，语义完整性和真实事件阅读由执行者负责。

## 创建运行

先保存批准方案到项目 `.ai-loop/request.json`，不放源包或参与代码快照的源码目录。

```json
{
  "goal": "完成用户要求的修改",
  "max_fixes": 3,
  "ignore_paths": [],
  "tasks": [{
    "id": "task1",
    "title": "实现目标行为",
    "acceptance": ["正常与失败路径符合已确认要求"],
    "review": "self",
    "depends_on": [],
    "checks": [{"id": "regression", "command": "项目中实际可执行的验证命令", "expected_exit": 0}]
  }]
}
```

```text
node BUNDLE/scripts/loop.mjs create --project ROOT --input .ai-loop/request.json
node BUNDLE/scripts/loop.mjs status --project ROOT --run RUN_ID
node BUNDLE/scripts/loop.mjs begin --project ROOT --run RUN_ID --task task1 --phase development
node BUNDLE/scripts/loop.mjs begin --project ROOT --run RUN_ID --task task1 --phase verification
node BUNDLE/scripts/loop.mjs snapshot --project ROOT --run RUN_ID
```

工具返回 run_id；也可通过 create 的 `--run ID` 指定未使用的编号。任务、运行与检查编号均为 1–64 个字母、数字、点、下划线或连字符，以字母或数字开头。
review：none 不要求任务评审，self 允许诚实自检，independent 要求真实独立评审。共享检查可复用同一 id，但命令与预期退出码必须相同。
快照覆盖普通文件内容、路径和执行位；排除 `.git`、`.ai-loop`、原始源包与已注册平台部署正文；根规则及部署外原生配置仍绑定快照，核心升级后评估旧证据适用性。把明确的生成目录写入 ignore_paths；排除项属于方案，不能在验证后改写。快照遇到符号链接或权限错误会停止，先明确范围，不自动跟随或忽略。
创建前批准方案；脚本不能代替人类审批。plan.md 可补充设计说明，spec.json 固定本运行的验收配置，state.json 只能通过工具更新。

## 保存证据与修复

由 harness 执行真实验证，并捕获退出码与日志；日志放本运行的 reports/ 内。不要用管道最后一段的退出码代替验证程序退出码。
验证前后 snapshot 应一致；从输出原样复制 revision。报告 JSON 保存到 `.ai-loop/request-report.json`，示例如下：

```json
{
  "role": "tester",
  "task_id": "task1",
  "status": "PASS",
  "execution": "self",
  "revision": {"algorithm": "sha256", "digest": "替换为完整快照摘要", "files": 1},
  "checks": [{
    "id": "regression",
    "command": "与方案中的实际命令一致",
    "environment": "实际环境与工具版本",
    "exit_code": 0,
    "log": "reports/regression.log"
  }],
  "issues": []
}
```

```text
node BUNDLE/scripts/loop.mjs record --project ROOT --run RUN_ID --input .ai-loop/request-report.json
node BUNDLE/scripts/loop.mjs begin --project ROOT --run RUN_ID --task task1 --phase review
```

reviewer 报告包含 role、task_id、status（APPROVED / REJECTED / BLOCKED）、execution、revision、findings、issues。BLOCKER 的 severity 使用大写 `BLOCKER`。同一代理的 APPROVED 只代表自检；independent 的真实身份需由 harness 和主代理核对，工具不能证明隔离事实。

```text
node BUNDLE/scripts/loop.mjs fix --project ROOT --run RUN_ID --task task1
node BUNDLE/scripts/loop.mjs resume --project ROOT --run RUN_ID --task task1 --reason "阻塞条件已如何解决"
node BUNDLE/scripts/loop.mjs stop --project ROOT --run RUN_ID --reason "命中权限拒绝或用户要求停止"
```

fix 仅用于 FAIL/REJECTED，每任务总修复次数 0–3，由方案确定；重开会话不重置。修复后重新 begin verification，PASS 后重新评审。resume 仅恢复普通阻塞，保留修复计数。权限拒绝报告使用 BLOCKED 和 `permission_denied: true`，运行进入 stopped，不能 resume。

BLOCKED 可携带上一已知 revision；快照不可获取时使用 `null`。工具不为阻塞结果重新计算快照，并标记 `revision_confirmed: false`，该结果不能作为通过证据。恢复后必须重新获取快照并验证。
`stop` 可在运行任意活跃阶段持久化停止原因，不读取代码快照；停止后的运行不能 resume。状态目录本身不可写时也停止操作并报告，不能换方式突破权限。

## 事件与交付

事件输入为 `{"type":"decision","summary":"已确认的决策与原因"}`；type 为 requirement / decision / rejected / question / handoff。日常阶段无需手工重复写事件。

```text
node BUNDLE/scripts/loop.mjs event --project ROOT --run RUN_ID --input .ai-loop/event.json
node BUNDLE/scripts/loop.mjs events --project ROOT --run RUN_ID --after 0 --limit 50
node BUNDLE/scripts/loop.mjs complete --project ROOT --run RUN_ID --input .ai-loop/delivery.json
```

events 仅返回游标之后的有限事件，用返回的 next_cursor 续读；记录员通过 memory checkpoint 保存实际消费游标和 session 正文，跨会话续用；不直接编辑元信息，不复制执行状态和修复计数。
delivery.json 包含 `verification`（最终快照的 tester PASS 报告）及必要时的 `review`（同快照 reviewer APPROVED 报告），最终报告省略 task_id。verification 须覆盖 spec 所有检查；可复用同快照且已覆盖全部必需检查的证据，仅补缺失项。存在 independent 任务时最终 review 也须独立。
代码快照变化会拒绝旧报告；代码未变且完整证据仍有效时无需重复执行同一检查。complete 仍检查所有任务已通过，随后禁止修改已完成运行。

## 检查与故障

```text
node BUNDLE/tests/all.mjs
```

测试仅放在原始源包，不部署。所有用例在同一 Node 进程中运行，不启动模型或其它 harness。覆盖重复安装、规则保留、路径安全、轮数与依赖、过期/缺失证据、自检与独立评审、权限拒绝和恢复。
操作冲突出现锁文件时先确认进程是否仍活跃，不自动删除锁；事件和状态不一致时停止并保留资料人工恢复。脚本只验证数据与状态契约，不能代替平台文件系统隔离或证明 AI 没有伪造报告。
