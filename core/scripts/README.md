# 状态与记忆工具

Node.js 18+，仅标准库。脚本目录以本工作流解压目录为准，`ROOT` 是目标项目真实绝对路径。脚本只管理记录，不会替你执行测试命令、调用模型、提交或发布。项目规则和已批准范围优先。

## 发现与续接

```text
node scripts/memory.mjs bootstrap --project ROOT
node scripts/memory.mjs bootstrap --project ROOT --intent continue
node scripts/loop.mjs status --project ROOT --run RUN
node scripts/loop.mjs events --project ROOT --run RUN --after 0 --limit 20
```

bootstrap 返回短状态与候选，不自动执行任务。读取项目 `.ai-loop/memory/index.md`，然后按需读取运行的 session/checkpoint 与关键改动。只有多个候选且用户未指定时才澄清。

## 建立运行

先得到方案确认，把规范写入 JSON 文件：

```json
{"goal":"明确的项目目标","tasks":[{"id":"task1","title":"实现功能","acceptance":["可验证的验收条件"],"review":"independent","checks":[{"id":"test","command":"项目的真实测试命令","expected_exit":0}]}],"max_fixes":3,"ignore_paths":[]}
```

```text
node scripts/loop.mjs create --project ROOT --run RUN --input 方案.json
node scripts/loop.mjs begin --project ROOT --run RUN --task task1 --phase development
node scripts/loop.mjs snapshot --project ROOT --run RUN
```

工作单元前后用 progress --input JSON 保存 `{unit,task,stage,summary,files}`；stage 为 planned / done / blocked，先 planned 后关闭，同一 unit 不重复使用。done 不代表测试通过。

测试和评审报告必须带对应 revision、角色、结果及真实证据；通过 record 保存，最后 complete 绑定最终快照。不得直接改 state.json、清零修复次数或伪造独立评审；详细契约见 WORKFLOW.md 与 agents/loop-tester.md、agents/loop-reviewer.md。

## 分页记忆与交接

先 inspect 获取当前 revision / hash，save 使用这些字段并发校验。知识正文和长交接由工具完整分片，搜索返回精确 read 参数与游标，不需一次读取全部正文。

```text
node scripts/memory.mjs --help
node scripts/loop.mjs --help
```

MEMORY.md 定义 save / checkpoint 的输入结构、来源、并发处理和分页读取。交接记录变更文件、关键符号、原因与优先读取位置。只有落盘的资料能够跨会话恢复；旧检查须核对当前代码才有效。
