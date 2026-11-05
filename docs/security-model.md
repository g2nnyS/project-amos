# 安全模型与当前保证

状态：默认安全适配器是 Stage A `log-only` 观察器。它计算并记录假设裁决，
默认不阻止工具执行。Pi 适配器提供显式 `.pi/amos.json managed` opt-in，
在 Harness 层对归一化工具做真实阻断；它不是 OS 沙箱。本文件只描述已实现
行为和当前限制。

## 当前实现

- 引擎对无效动作、规则表、谓词和内部异常 fail closed；裁决优先级为 `deny > confirm > log > allow`。
- 适配器归一化支持的文件工具事件。未支持或不透明的工具会记录覆盖缺口，不被当作已评估。
- JSONL 记录包含规则快照摘要、匹配元数据、裁决类别与覆盖状态。URL 中的 userinfo、路径、查询值和 fragment 会脱敏；不记录文件内容、Shell 命令文本或原始 hostile payload。
- 快照归档通过摘要检查内容一致性；owner-only 权限和摘要不提供来源认证或防篡改保证。
- 文件 target 做词法规范化，不解析 symlink、bind mount、hard link 或 TOCTOU 对象身份。
- `${SESSION_WORKSPACE}` 只允许出现在 `target_glob` / `target_outside_glob` 的 patterns 中；快照摘要同时绑定原始规则和有效 workspace。

这些保证默认只覆盖观察和记录路径，不能让工具调用停下；显式 Pi
managed 模式另有 Harness 层阻断（见下文），仍不是 OS 边界。

## Jev 语义传感器

`decision/` 可以将 harness 捕获的 `RequirementFrame` 与动作交给 Jev，返回类型化事实。它不是策略权威、批准器或执行器；确定性引擎仍是基线，Jev 只能收紧结果。需要评估时，provider 失败、拒答、超时、低置信度或 frame 摘要不匹配按既定策略 fail closed。

requirement 文本属于用户内容，只有 frame 明确设置 `egress: "allowed"` 才能发送到 hosted provider。日志只记录 frame 摘要与来源，不写原文。调用方提供的 `context` 不会自动脱敏。具体配置和边界见 [Jev 接入说明](jev-integration.md)。

## Harness 层 MVP（Pi）

`managed/harness.ts` + Pi `tool_call` 钩子是本轮 MVP：规则引擎裁决、
deny 前阻断、confirm 最小投影 + 独立 reviewer + HMAC 一次性 grant、
`tool_result` 记录；advisory 注入来自同一 activation snapshot。真实
Pi harness 测试证明 deny/allow/confirm 与真实文件副作用。

限制：不是 OS 沙箱；不解析真实文件对象身份，不防 symlink/hardlink/
bind mount/TOCTOU；不中介子进程/插件/MCP；不宣称全副作用覆盖；审计与
Agent 同写域、无防篡改。OS 隔离（独立 UID/挂载域/bwrap/cgroup）本轮明确
不做，不是阻塞项。

## one-shot 离线模块的边界

以下模块默认未启用；Pi managed 是显式 opt-in 的 Harness 层阻断，其余仍
为离线/可选实现：

- `host/` 的受管文件宿主在声明闭集内做真实路径、符号链接、硬链接、保护
  路径和审计前置检查；它没有独立 OS 身份/挂载域/cgroup，bind mount 与
  TOCTOU 对象身份不支持，同 UID 的 Agent 仍可改写审计/策略。见
  [受管宿主 ADR](adr-managed-file-host.md)。
- `review/`/`managed/` 的投影只允许有界字段，reviewer 只能收紧；Pi
  managed 对 confirm 使用本地确定性 reviewer 或 loopback HTTP reviewer，
  无真实模型校准时不得称已校准；grant 是进程内单次 HMAC，重启拒绝而非
  持久授权。见 [review ADR](adr-review-protocol.md)。
- `control-plane/` 的 SQLite/API 提供单主、CAS、审计和版本契约；SQLite/0600/
  同 UID 不是隔离，发布不等于宿主接收或生效。见
  [治理 ADR](adr-governance-store.md)。
- `check/`、`rollout/`、`activation/tighten.ts` 是库级合同/证据门；没有
  远端 CI 强制、真实 probe 或持久 TTL 恢复。见
  [CheckBinding ADR](adr-check-binding.md) 与
  [临时收紧 ADR](adr-temporary-tightening.md)。
- 来源认证仍是未决项（O5）；digest、SQLite、HMAC 同域或文件权限都不能
  替身认证。见 [来源认证 ADR](adr-source-authentication.md)。

## 尚未具备的能力

默认适配器不执行安全阻断；Pi managed 只在 Harness 层阻断归一化工具，
不覆盖未知/未归一化入口或全副作用。策略、审计和配置仍处于同一可写域，
JSONL 可被有写权限的主体修改；词法路径检查不是实际文件系统身份检查。
独立的工程工作流门只覆盖其明确实现的子集，不能替代安全裁决或声称完整
覆盖。OS 隔离本轮不做。当前限制见[运行期状态](go-no-go.md)与
[工作流门](workflow-gate.md)。
