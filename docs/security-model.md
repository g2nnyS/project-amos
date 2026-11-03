# 安全模型与当前保证

状态：当前安全适配器是 Stage A `log-only` 观察器。它计算并记录假设裁决，不阻止工具执行；本文件只描述已实现行为和当前限制。

## 当前实现

- 引擎对无效动作、规则表、谓词和内部异常 fail closed；裁决优先级为 `deny > confirm > log > allow`。
- 适配器归一化支持的文件工具事件。未支持或不透明的工具会记录覆盖缺口，不被当作已评估。
- JSONL 记录包含规则快照摘要、匹配元数据、裁决类别与覆盖状态。URL 中的 userinfo、路径、查询值和 fragment 会脱敏；不记录文件内容、Shell 命令文本或原始 hostile payload。
- 快照归档通过摘要检查内容一致性；owner-only 权限和摘要不提供来源认证或防篡改保证。
- 文件 target 做词法规范化，不解析 symlink、bind mount、hard link 或 TOCTOU 对象身份。
- `${SESSION_WORKSPACE}` 只允许出现在 `target_glob` / `target_outside_glob` 的 patterns 中；快照摘要同时绑定原始规则和有效 workspace。

这些保证只覆盖观察和记录路径，不能让工具调用停下。

## Jev 语义传感器

`decision/` 可以将 harness 捕获的 `RequirementFrame` 与动作交给 Jev，返回类型化事实。它不是策略权威、批准器或执行器；确定性引擎仍是基线，Jev 只能收紧结果。需要评估时，provider 失败、拒答、超时、低置信度或 frame 摘要不匹配按既定策略 fail closed。

requirement 文本属于用户内容，只有 frame 明确设置 `egress: "allowed"` 才能发送到 hosted provider。日志只记录 frame 摘要与来源，不写原文。调用方提供的 `context` 不会自动脱敏。具体配置和边界见 [Jev 接入说明](jev-integration.md)。

## 尚未具备的能力

当前适配器不执行安全阻断；工具覆盖不完整，策略、审计和配置仍处于同一可写域，JSONL 可被有写权限的主体修改。词法路径检查不是实际文件系统身份检查。独立的工程工作流门只覆盖其明确实现的子集，不能替代安全裁决或声称完整覆盖。当前限制见[运行期状态](go-no-go.md)与[工作流门](workflow-gate.md)。
