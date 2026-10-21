---
name: ai-loop-models
description: 管理 DSH AI Loop 的精确工作区启停、全局角色模型、项目覆盖和并发。
---

# DSH 原生插件设置

在 DSH 设置中的 AI Loop 插件页面管理配置；配置由 DSH 原生 volatile 字段保存。不要调用 Codex 设置服务，不通过宿主 fs、CLI 或修改 settings.json 代替原生设置。

- 总开关 `enabled` 默认关闭。只有总开关开启且 `projects` 中精确路径条目 `enabled: true` 才启用；选择工作区只读，新工作区默认停用，父路径不会自动启用子项目。
- 全局 `roles` 包含 planner/dev/tester/reviewer/scribe。每个角色的 `provider` 与 `model` 必须同时填写或同时留空；`reasoningEffort` 使用所选模型实际支持的 id，留空表示模型默认或同一路由父代理继承。
- `projects[].roles` 按角色覆盖全局；模型路由的 `provider` 与 `model` 必须成对设置或同时留空，不能只改其中一个。思考强度可单独覆盖；未覆盖的值继承全局。显式空字符串清除对应值并回到父代理/模型默认。恢复全局时移除该项目角色覆盖。
- `maxConcurrent` 为 1 到 16 的整数，默认 3；项目可覆盖。它只限制此插件的项目派发，不提高 DSH 自身子代理容量和深度限制。
- 保存后下一次上下文组装和派发读取新配置，已运行子代理不受追溯修改。通过 DSH 实际可用模型目录核实 provider/model/强度；派发时原生 resolveCallConfig 会预检，无效设置报错，不静默降级。

插件技能与设置不会授予额外权限。不要把配置保存成功当成真实模型执行或 UI 验收已经通过。
