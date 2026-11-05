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

## one-shot 新增模块（默认关闭）

- `activation/runtime.ts`：对现有 `amos-unified-rule-catalog` v2 snapshot 做
  结构验证、身份绑定和 runtime/execution 视图；不是来源认证。
- `host/`：可选闭集文件执行器、能力/路径检查、审计前置；不是 MVP 默认
  路径，OS 隔离不是本轮要求。
- `review/`、`managed/`：最小有界投影、独立 reviewer（本地确定性/HTTP）、
  一次性 HMAC 授权；Pi `managed` 是显式 opt-in 的真实 Harness 层拦截。
  默认仍 log-only；没有真实模型校准。
- `check/`、`rollout/`、`activation/tighten.ts`：精确 tree 检查合同、
  证据绑定晋升门、附加型临时收紧；均只在本地测试中使用。
- 治理 SQLite/API 的实现状态见 [交付状态](delivery-status.md)；Vue 治理台
  未交付。

这些模块不改变 `deny > confirm > log > allow`、七算子、严格 Schema 或
log-only recorder 的 `defaultVerdict: deny`。Harness MVP 可在声明范围内
真实阻断，但不是 OS 沙箱、不覆盖全副作用、不提供防篡改审计；不得描述为
已认证生产边界。

## Harness 层 MVP（2026-11-05 用户裁决）

- MVP 限定为 Harness 层工具拦截；Pi `.pi/amos.json managed.enabled` 是
  显式 opt-in，默认仍 Stage A log-only。
- 规则引擎/项目快照裁决，deny 阻断，confirm 交独立 reviewer + HMAC 一次性
  grant，`tool_result` 记录；advisory 注入同源。
- **OS 隔离（独立 UID、挂载域、bwrap/cgroup、内核沙箱）本轮不做**，不是
  人工阻塞；不得宣称 OS 沙箱、全副作用覆盖或防篡改审计。
- G0/NO-GO 结论不由本 MVP 改变。

## 配置

运行期配置仍为文件式；SQLite 治理库/API 是离线实现，尚未接管运行期配置。
安全适配器和工程工作流门的实现状态见[运行期状态](go-no-go.md)、[安全模型](security-model.md)及[工作流门](workflow-gate.md)。
