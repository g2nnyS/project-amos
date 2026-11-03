# 当前产品与工程决策

本文只记录当前采用的实现语义和边界。

## 安全状态

- 安全策略适配器保持 Stage A `log-only`；计算出的 verdict 仅供观察，不阻止工具执行。安全运行期强制执行状态为 **NO-GO**。
- 可选工程工作流门与安全策略分离，只覆盖已实现的封闭子集；OpenCode 的完成反馈是 advisory。`opencode.jsonc` 中 `workflowGate.enabled` 当前为 `false`。
- 安全敏感变更需要人工审查。不能把离线测试、审计文件权限或模型输出当作安全放行依据。

## 当前实现语义

- 引擎保持纯函数并使用注入时钟；裁决优先级为 `deny > confirm > log > allow`，异常按既定 fail-closed 语义处理。
- 现有七种谓词操作符保持不变。只有 `predicate`、`on_hit` 与 `ttl` 参与规则裁决；其他字段是经校验的元数据。
- `constraints/rules.yaml` 仍是运行期规则输入；Pi 与 OpenCode 适配器仍记录假设裁决。`guidance/packs.ts` 仍是现有动态注入种子。
- P1 catalog v2 只离线编译项目激活集及 enforcement/advisory 投影，尚未替换适配器的运行期输入或改变运行行为。
- Jev 是可选语义传感器，输出类型化事实，只能收紧确定性结果，不能授权执行。requirement 文本仅在 harness 捕获的 frame 显式允许时出境；caller-supplied `context` 不会自动脱敏。
- 文件目标只进行词法规范化；JSONL 追加和摘要归档不提供防篡改保证。不得记录文件内容、Shell 命令文本、URL secret 值或原始 hostile payload。

## 配置

配置仍为文件式；当前没有配置迁移。安全适配器和工程工作流门的实现状态见[运行期状态](go-no-go.md)、[安全模型](security-model.md)及[工作流门](workflow-gate.md)。
