# G0 go/no-go（2026-10-30）

判定权只在人。2026-10-30 由人逐项核对，agent 不得自行放行；当前状态：**未裁决**。

| 判据 | 通过线 | 未通过处置 |
|---|---|---|
| 命中条件表达力 | ≥2/3 规则为 deterministic | 降级为"带治理的 AGENTS.md 生成器"或封档 |
| 引擎正确性 | 单测全绿，含 fail-closed 与 TTL 用例 | 修到过为止，不带伤进 go |
| 接缝真实性 | log-only 在真实任务流跑过（非 demo），有日志样本 | 延长观察，不放行 |
| 观察质量 | 误拒记录可解释，0 层规则不存在明显误伤 | 保持 log-only，修规则后复评 |

## 人审核对与抽样口径

- 0 层所有命中记录：全量审核。
- 非 0 层规则 deny：全量审核。
- confirm：总数不超过 20 条时全量；超过 20 条时至少审核 20 条，并优先覆盖不同工具和规则。
- 解析失败、未知 payload、engine_error：全量审核，因为这些可能是覆盖缺口，不只是误拒。
- snapshot_error、malformed JSON、未知规则 ID 以及旧日志中无命中 ID 的 deny 同样进入覆盖缺口审核；旧记录不会被改写成现代错误类型。

审核工作表由 `npm run audit:review` 从原始 JSONL 派生，默认拒绝覆盖既有工作表。审核结论由人填写，agent 不得据此自动放行。

## 核对证据

- 规则表：`constraints/rules.yaml`；Schema：`constraints/schema.json`；封闭词表：`constraints/vocabulary.md`。
- 引擎、语言中立 fixtures 与单测：`engine/`、`fixtures/`。
- 快照与 JSONL：`storage/snapshot.ts`、`storage/jsonl.ts`。
- 真实接缝：`adapters/opencode-v2/` 与项目根 `opencode.jsonc`。
- 真实日志样本：`spike/examples/real-opencode.jsonl`。
- 人审工作表：`spike/review/stage-a-review.md`（158 条记录的生成时点快照；后续追加日志需另生成新文件）。
- 逐条预分析：`spike/review/stage-a-preanalysis.md`（只作裁决证据，不代替人填写审核结论）。

误拒只能由人结合实际任务意图核对日志中的假设 `verdict`；G0 不设置文档之外的自动放行阈值，也不把单测通过当作接缝真实性证据。
