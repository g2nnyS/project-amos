# ADR：Harness 层工具拦截 MVP（Pi）

- 状态：**已实现并本地/真实 harness 验证；pending-human-review；默认不启用**。
- 范围：在真实 Pi Harness 的 `tool_call` 前按项目激活快照裁决，deny 阻断，
  confirm 交独立 reviewer，批准后一次性放行；`tool_result` 记录结果；动态
  注入来自同一 activation snapshot。
- 明确非目标：**不建设 OS 隔离**。独立 UID、挂载域、bwrap/cgroup、内核
  沙箱、全副作用中介、防篡改审计都不是本轮要求，也不列为人工阻塞。

## 1. 为什么是 Harness 层

用户将 MVP 限定为 Harness 层工具拦截。Harness 已在真实工具执行前提供
`tool_call` 钩子；在这里使用既有规则引擎/项目快照即可得到真实的
deny/confirm/allow，而无需假装 OS 沙箱。默认行为仍是 Stage A log-only；
只有 `.pi/amos.json` 显式配置 `managed.enabled` 时才启用本 gate。

## 2. 配置（Pi）

```jsonc
{
  "mode": "log-only",
  "rulesPath": "./constraints/rules.yaml",
  "schemaPath": "./constraints/schema.json",
  "logPath": "./spike/logs/pi.jsonl",
  "activation": {
    "snapshotPath": ".pi/activation.json",
    "projectId": "my-project"
  },
  "managed": {
    "enabled": true,
    "auditPath": "/var/lib/amos/managed-audit.jsonl",
    "requirementEgress": "denied",
    "review": {
      "endpoint": "http://127.0.0.1:PORT/review",
      "model": "local-reviewer",
      "apiKeyEnv": "AMOS_REVIEW_KEY",
      "policy": { /* ReviewerPolicy */ },
      "calibration": { /* CalibrationEvidence | null */ },
      "ceilingDigest": "sha256:…",
      "grantTtlMs": 20000
    }
  }
}
```

- `managed` 缺省/`enabled:false`：保持原 log-only + workflow gate 行为。
- `managed` 存在但结构非法：所有归一化工具调用阻断
  `amos_managed_config_error`（fail closed）。
- `review` 缺省：confirm 一律阻断 `amos_managed_review_unavailable`。
- `auditPath` 必须在工作区外；否则配置错误、阻断。
- `requirementEgress` 缺省 `denied`；只有显式 `allowed` 且 review policy
  允许时才发送用户要求原文到 reviewer，digest 始终绑定。
- snapshot 必须是 catalog v2 的 workspace/epoch/双投影一致内容；这不是
  来源认证。

## 3. 顺序

1. Harness 归一化工具事件；`ActionNormalization` 非 `action` 或缺失
   call id → `amos_managed_coverage_gap` / `amos_managed_missing_call_id`。
2. `evaluatePolicy(action, execution.rules, now, {defaultVerdict:'allow'})`。
   `deny`/引擎错误 → 写 deny 授权 + stopped 结果，阻断。
3. `confirm`：构造最小有界投影（tool/operation/工作区相对 target/规则 ID/
   digest，无内容/命令/环境/绝对外部路径；requirement 原文仅在显式 egress
   allowed 时）→ 独立 reviewer。
4. reviewer approved → 签发并立即消费 HMAC one-shot grant（绑定
   callId/actionDigest/session/epoch/snapshot/capability/TTL/ceiling）→
   写 allow 授权并 fsync → 返回 allow。denied/低置信/超时/失败/无校准/
   grant 失败 → stopped，阻断。
5. Harness 执行工具（真实副作用）；`tool_result` 另写 result
   （executed/failed），不记录内容/命令。
6. 同一 callId 再次评估 → `replay_denied`；审计失败 → 不执行。

## 4. 动态注入

managed 模式启用 activation advisory，即使独立 workflow gate 未开启：
`before_agent_start` 把 activation advisory 块写入 system prompt 的
`amos-workflow-guidance` section；未激活规则不注入；配置存在但无效时使用
空 advisory，不回退 global seed。注入不参与执行裁决。

## 5. 真实证据（非 mock 的 Harness/副作用）

`npm run probe:live` 使用真实本地 llama.cpp `gemma-4-e4b`、真实 Pi
AgentSession、真实扩展、真实文件副作用和独立模型 reviewer：8 个合成校准
场景 0 false allow；confirm 只执行一次；deny 无文件；system prompt 注入与
runtime report 使用同一 activationDigest；reviewer 收到 requirement 原文
与 digest。证据在 `/tmp/opencode/amos-live-probe-*/evidence.json`。


`managed/pi-harness.test.ts`（7 pass）使用：

- 真实 Pi `AgentSession`、真实 `.pi/extensions` 扩展加载、真实 `write`
  工具、真实临时工作区与文件副作用；
- 真实 loopback HTTP reviewer 服务（本地确定性 reviewer 根据投影判断
  scope，不是固定返回）；
- 真实 deny/allow/confirm、reviewer mismatch、审计路径错误、system prompt
  注入断言。

模型响应由 faux provider 脚本化；这不冒充真实模型校准。真实 Model 调用
仍为后续/可选，不是本轮 OS 隔离替代。

## 6. 限制（必须保留）

- **不是 OS 沙箱**：不解析真实文件对象身份，不防 symlink/hardlink/bind
  mount/TOCTOU，不中介子进程/插件/MCP/未知入口；这些不在本轮范围。
- **不是全副作用覆盖**：只覆盖 Pi 归一化工具；未知 tool/覆盖缺口在
  managed 模式阻断，但不能证明所有宿主入口。
- **不是防篡改审计**：JSONL 与 Agent 同写域，无外部锚定；崩溃后 unknown
  不重放，但历史可被同 UID 改写。
- reviewer 是本地确定性 baseline；没有真实模型校准/费用/出境证据。不能
  描述为已认证生产 reviewer。
- 默认仍 log-only；`opencode.jsonc` 的 gate 不改；不解除 G0/NO-GO，不
  自动合并/发布。
- 独立 UID/挂载域/bwrap/cgroup 明确**本轮不做**，不是阻塞项；未来若要求
  更强边界，另立 ADR。

## 7. 与 `host/` 的关系

`host/` 的受限文件执行器保留为可选库/未来受管入口，不是本次 MVP 的默认
路径。它的路径/审计测试仍有效，但 OS 隔离同样不是本轮要求；不把它的
能力声明扩大为 Harness MVP 的完整覆盖。
