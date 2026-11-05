# ADR：独立安全 reviewer 与一次授权（P2B）

- 状态：**协议实现 + Harness MVP 实际接线，pending-human-review；未启用
  日常生产 confirm**。
- MVP 范围：Harness 层 confirm 使用独立 loopback HTTP reviewer；测试使用
  本地确定性 reviewer，live probe 使用真实本地模型 reviewer（8 个合成
  校准场景，0 false allow）。这不是生产安全认证，也不替代 OS 隔离。
- 范围：`review/` 的最小有界投影、独立 reviewer、校准门、one-shot grant。
- 关联：HOST-05–08、ENG-05–08、AC-07/08/17/22；PRD §5.2。

## 1. 分离原则

- 确定性引擎仍是权威；reviewer 只处理已停住且 `confirm` 的请求。
  `deny`/`allow`/`log` 一律 `ineligible`，reviewer 不能放宽。
- `decision/` 的 Jev sensor 继续只收紧，**不复用**为安全批准器。
- reviewer 不生成执行器、不改规则、不发布、不扩大常驻权限。
- 没有可用审查通道时 confirm 停止；非交互模式本身不是批准。

## 2. 请求投影（最小、有界）

发送给 reviewer 的只允许：

- format/version、attemptId、tool、operation；
- 工作区相对 target 或 `[outside-workspace]`（默认 `denied` 时 target 为
  null）；绝不发送绝对外部路径；
- requestDigest、snapshotDigest、epoch、project/session/capability 标识；
- 有界 matchedRuleIds（上限）与 requestedBytes；
- requirement digest；requirement 原文**仅当** frame 来自用户通道、
  `frame.egress === 'allowed'` 且策略 egress 也是 `allowed`；
- questionVersion、policyDigest、deadline。

绝不发送：文件正文、oldText/newText、搜索 query、Shell 命令/参数/重定向、
环境、凭据、完整会话/工作区、provider key、审计原文。投影序列化上限
8 KiB，超出拒绝而不是截断。`context` 不自动脱敏，因此不提供任意 context
通道。

## 3. 校准

reviewer 在发出请求前必须通过校准门：

- model、questionVersion、policyDigest、caseSetDigest 完全匹配；
- cases 与 unsafeCases 达到最低样本量；
- `falseAllows / unsafeCases <= maximumFalseAllowRate`；
- 未过期、`evaluatedAt <= now`。

缺校准/过期/不匹配 → `uncalibrated`，不访问 provider。校准证据本身只做
结构/绑定校验，不证明其真实来源；真实校准集、模型、阈值与出境/费用授权
（O3）未定，因此 live provider 状态为 **blocked**。

## 4. 结果合成

- `requirementMatch === 'match'`、`withinScope === true`、
  `risk <= maxRisk`、`confidence >= minConfidence` 才是 approved。
- `mismatch` → denied；`unclear`、超范围、高风险、低置信 →
  `low_confidence` 停止，不自动转人工放行。
- 超时、provider 失败、abort、畸形响应、model 不一致 → 停止。
- 无自动 provider fallback；换 provider/model 必须重新校准。

## 5. One-shot grant

grant 绑定：requestId、nonce、actionDigest、sessionId、projectId、epoch、
snapshotDigest、capabilityId、ceilingDigest、issuedAt、expiresAt、HMAC 签名。
校验必须全部匹配；过期/未来签发/签名错/绑定错/重复消费都拒绝。`consume`
是唯一的原子 check-and-mark；失败不标记。HMAC 使用进程内随机密钥，重启后
旧 grant 因签名不符被拒绝——这是保守停止，不是持久授权账本。非对称签名/
独立密钥域属于 O5 未决项。

状态至少区分 pending、approved、denied、failed、timed_out、expired、
cancelled、consumed；批准不等于执行成功。人可请求对 reviewer 拒绝的同一
精确动作重试一次，但必须重新绑定/校验/审查，不是覆盖 deny，也不形成常驻
授权；重试次数有界。

## 6. Provider 接口

`review/provider.ts` 只实现带超时、响应大小上限、`redirect:'error'`、
JSON 严格字段校验的 HTTP provider；API key 只从环境变量名读取，不在配置/
日志/错误中出现。测试只连 loopback stub 并断言发送体只含允许投影。真实
OpenRouter/System One/本地模型校准、费用与出境授权未做，标 blocked。

## 7. 未决与启用条件

- 真实 reviewer 模型、置信阈值、校准集规模/期限、出境与费用授权（O3）。
- 生产启用的 rollout 阈值/范围（O4）与证据（P4）。
- 受信宿主如何持久化消费账本与跨重启审计（AUD-02/O5）。
- 真实 Pi/OpenCode 的 confirm 停住/审查/重试接线。

在这些条件满足前，本模块只作为协议/离线测试，不启用安全 confirm，不
解除 NO-GO。
