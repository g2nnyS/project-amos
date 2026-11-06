# Product closure: configuration, tightening, rollout and check gate

- 状态：**本地实现已接线，默认不扩大执行范围；安全敏感行为仍需人工审阅。
  阶段 A 的 log-only 默认与 G0/NO-GO 结论不变。**
- 范围：G06/G07 语言检查门、G08 持久临时收紧、G10 SQLite 配置单主与宿主
  投影、G11 证据绑定 rollout；OpenCode 增加显式 managed 对等路径。
- 这不是 OS 沙箱、远程 CI 保护或跨身份信任边界。

## 1. G10：SQLite 配置单主与宿主投影

`control-plane/` 现在按项目保存完整非秘密配置：

- `workflowGate`：工程 Shell/完成审查开关与绝对 `jevConfigPath`；
- `managed`：`enabled`、`requirementEgress`、`grantTtlMs`、review provider
  的非秘密字段、`apiKeyEnv` 引用、`ceilingDigest`，可选 review policy 与
  calibration；
- `tightening`：预授权模板与配额；
- `rollout`：预注册阈值、逐规则阈值和当前 `RolloutState`。

凭据只保存环境变量名，字面 key、未知字段和带 userinfo/query 的 review URL
在写入时拒绝。项目配置由 human 通过 `POST /api/projects/:id/config` 更新；
Agent 仅可读取和触发已预授权动作。

发布（以及临时收紧、过期或配置更新）会用同一份配置生成并原子写入：

```text
<workspace>/.pi/activation.json       P1 激活快照
<workspace>/.pi/amos.managed.json     非秘密宿主投影
```

两个文件分别原子替换；managed 投影先 rename，因此中途崩溃会留下可见的
digest/epoch 不匹配，而不是静默接受旧快照。适配器同时校验投影和激活
digest/epoch/policyVersion，不匹配即 fail closed。`.pi/runtime.json` 仍由
真实 Host 在加载后写入；控制台通过 `control-plane/runtime-status.ts` 显示
`loaded` / `stale` / `never` / `invalid`，不把数据库发布或投影写入当作
“宿主已生效”。

Pi 与 OpenCode 都优先读取 `.pi/amos.managed.json`；缺少投影时保留原有
文件/选项配置行为。默认 `managed.enabled` 为 false。

## 2. G08：持久临时收紧

`activation/tighten.ts` 的纯附加型发布器已接入 `control-plane/`：

- `temporary_tightenings` 保存模板 id、规则 ref、`applied_at`、
  `expires_at`、`epoch` 与完整快照；
- `tightening_state` 保存最新有效快照、epoch 和最后可信时钟观察；
- `POST /api/projects/:id/tighten` 允许 human 或 agent 触发，但只接受当前
  human 发布配置中的模板，且必须是非 0 层、确定性 `deny`/`confirm`，在
  TTL/配额内；
- 每次应用或到期生成 `epoch + 1` 快照，重新写 activation/managed 投影；
- 重启从 SQLite 恢复；已过期条目不会被续期；时钟倒退或 TTL 状态不明时
  返回 `clock_regression`，不重新计算更长的 TTL；
- 发布新版本会退役旧临时层，避免把旧快照上的附加规则带入新基版。

放宽、删除、改叙事、改 on_hit、跳过 rollout 或修改 0 层基线仍不属于临时
收紧，必须走人工版本治理。

## 3. G11：证据绑定 rollout

- `probe_runs` 保存经 `createProbeRun` 规范化的证据；规则版本和 activation
  digest 必须匹配当前有效快照，否则 `evidence_unbound`。
- `rule_rollouts` 保存逐规则状态；`evaluateRulePromotion` 复用
  `evaluatePromotion`，只允许一步
  `draft -> log_only -> selective_deny -> confirm_enabled`。
- 阈值必须由 human 预注册（或与已注册阈值完全一致）；Agent 只能触发评估。
- `promote` 才推进状态；`hold`/`reject` 保持状态并写
  `rollout_promotion_held` 事件，包含固定 reason codes。
- 没有绑定证据、证据过期、覆盖率不足、未授权副作用或阈值不满足都不晋升。

## 4. G06/G07：语言检查门

- `check/cli.ts` 使用固定 TypeScript runner、当前 tree digest、
  `CheckBinding`/`FindingBatch` 和 `acceptFindingBatch`；
- 编译器失败、引擎不可用、tree 变化、覆盖不足或接纳校验失败均以非 0
  退出；不打印源码、命令原文或原始编译器输出；
- `npm run check:gate` 先在本地和 CI 重建 `dist/`，再运行该门；
- `.github/workflows/ci.yml` 在 `npm test` 之后运行 `npm run check:gate`。

这是本地/CI 检查点，不是远端分支保护或受管提交接纳平台。绕过本地 hook
的对抗性证明和仓库外保护仍由人工核验。

## 5. OpenCode managed 对等路径

`adapters/opencode-v2/` 支持显式 `managed` 或生成的
`.pi/amos.managed.json`：

- `execute.before` 先归一化，再调用 `createHarnessGate`；确定性 deny 在
  副作用前阻断；
- confirm 走独立 reviewer 与一次性授权；review 不可用、拒绝、超时、重放
  均不执行；
- `execute.after` 写 executed/failed 结果，不记录内容；
- 首次加载写 `.pi/runtime.json`，harness 标记为 `opencode`；
- 未显式启用 managed 时仍保持原 Stage A log-only + 可选 workflow gate。

OpenCode 没有 Pi 的同名配置层，因此支持 `options.managed`；生成投影优先
于手写选项。managed 模式仍只覆盖已接管的工具入口，不是 OS 沙箱。

## 6. 明确限制

- 同 UID 进程仍可写数据库、投影、审计和 journal；owner-only/append-only
  不是防篡改保证。
- `.pi/amos.managed.json` 不是签名，投影校验只证明内部一致性和与当前
  快照匹配。
- 临时收紧的“只附加”证明来自同一 catalog 编译和快照链校验，不是通用
  语义包含证明。
- rollout 晋升不等于安全认证；证据真实性仍依赖受信执行器和人工预设阈值。
- 远端 CI 接纳、真实受保护分支、独立 OS 身份和跨机器回执不在本轮范围。
