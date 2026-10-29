# G0 go/no-go（2026-10-30）

判定权只在人。2026-10-30 的 G0 门禁仍待人工复核；基于 `master@3d07886` 的独立安全审查结论为 **NO-GO**。当前状态：**NO-GO（运行期强制执行）**。

上述 NO-GO 只针对安全策略层的运行期强制执行。独立的工程工作流门（Shell 封闭子集阻断、按会话固定的 advisory 注入、Jev 要求一致性、逐字命令授权）已实现并可显式启用；它仍不是完整动作覆盖，也不是安全边界，不能作为重新申请阶段 B 的依据。

NO-GO 不否定 log-only 观察原型的价值，但明确禁止把当前实现描述成已经成立的硬安全边界。下列能力必须补齐并经过对抗测试后，才能重新申请阶段 B：

- 完整动作接管，未知工具和 shell 不得绕过裁决；
- 与 Agent 可写域分离的受信任监督进程；
- 真实文件系统身份与 TOCTOU/symlink 防护；
- 与动作和规则快照绑定的认证审批；
- 可重建且防篡改的审计留存；
- 任意 clone 路径和清洁 CI 下可复现的测试。

| 判据 | 通过线 | 未通过处置 |
|---|---|---|
| 命中条件表达力 | ≥2/3 规则为 deterministic | 降级为"带治理的 AGENTS.md 生成器"或封档 |
| 引擎正确性 | 单测全绿，含 fail-closed 与 TTL 用例 | 修到过为止，不带伤进 go |
| 接缝真实性 | log-only 在真实任务流跑过（非 demo），有日志样本 | 延长观察，不放行 |
| 观察质量 | 误拒记录可解释，0 层规则不存在明显误伤 | 保持 log-only，修规则后复评 |

## 人审核对与抽样口径

- 0 层所有命中记录：全量审核。
- 非 0 层规则 deny：全量审核。
- confirm：总数不超过 20 条时全量；超过 20 条时至少审核 20 条，使用确定性覆盖优先选择不同工具和规则。这不是随机或统计抽样，不能用于推断总体误拒率。
- 解析失败、未知 payload、engine_error、not_evaluated、v2 的 `no_match_default_deny`：全量审核，因为这些是覆盖缺口，不只是误拒。
- snapshot_error、malformed JSON、未知规则 ID、旧日志缺少 matched_rules 元数据以及旧日志中无命中 ID 的 deny 同样进入覆盖缺口审核；旧记录不会被改写成现代错误类型。

审核工作表由 `npm run audit:review` 从原始 JSONL 派生，默认拒绝覆盖既有工作表。审核结论由人填写，agent 不得据此自动放行。

## 核对证据

- 规则表：`constraints/rules.yaml`；Schema：`constraints/schema.json`；封闭词表：`constraints/vocabulary.md`。
- 威胁模型与未实现边界：`docs/security-model.md`。
- 引擎、语言中立 fixtures 与单测：`engine/`、`fixtures/`。
- Jev 语义传感器边界：`docs/jev-integration.md`、`decision/`。
- 快照与 JSONL：`storage/snapshot.ts`、`storage/jsonl.ts`；快照按 digest 归档在日志目录下。
- 可复现验证与分支规范：`.github/workflows/ci.yml`、`CONTRIBUTING.md`。
- 真实接缝：`adapters/opencode-v2/` 与项目根 `opencode.jsonc`。
- 真实日志样本：`spike/examples/real-opencode.jsonl`。
- 人审工作表：`spike/review/stage-a-review.md`（158 条记录的生成时点快照；后续追加日志需另生成新文件）。
- 逐条预分析：`spike/review/stage-a-preanalysis.md`（只作裁决证据，不代替人填写审核结论）。

误拒只能由人结合实际任务意图核对日志中的假设 `verdict`；G0 不设置文档之外的自动放行阈值，也不把单测通过当作接缝真实性证据。
