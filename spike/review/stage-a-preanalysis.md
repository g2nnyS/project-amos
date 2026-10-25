# 阶段 A 审核预分析（非放行结论）

本文件是对 `stage-a-review.md` 所列记录的逐条预核，供人填写审核结论时使用。它不把人审工作表标记为已审核，也不改变 go/no-go 状态。

## 0 层命中（1/1）

- `opencode-field-mismatch.jsonl:31`：`grep` 目标为 `/home/ganyu/.cache/opencode`，命中 `filesystem-0-2` 与 `side_effect-1-3`，最终假设 verdict 为 `deny`。
- 谓词层面，目标确实位于规则给出的 `/home/ganyu/projects/**` 之外，匹配没有错误。
- 需要人判断的是规则适用性：该 OpenCode session 是否应启用这条 session-scoped paths 白名单。未确认这一点前，不能把该记录认定为合理拒绝或误拒。

## 非 0 层规则 deny（0/0）

本时点没有此类记录。

## 错误与覆盖缺口（35/35）

### 旧版 path 字段适配错误（29 条）

记录为 `opencode-field-mismatch.jsonl` 的第 `1-6`、`8-21`、`23-30`、`32` 行，合计 29 条。

- 所有记录的 read/write/edit 目标均为空字符串，同时带 `legacy_fail_closed_no_ids` 与 `action_invalid`。
- 这些记录对应旧适配器把 OpenCode V2 的 `path` 错读为 `filePath` 的覆盖缺陷，不是任何规则命中的误拒。
- 当前归一化已统一使用 V2 `path`，并有 read/write/edit 正例、缺 path 反例及真实编译后 hook 日志。历史记录仍保留为覆盖缺口证据，不回写或删除。

### 迁移期无命中 ID 的 fail-closed（6 条）

记录为 `opencode.jsonl:39-44`，目标分别为 `engine/engine.ts`、`adapters/opencode-v2/normalize.ts`、`adapters/opencode-v2/hook.test.ts`、`engine/engine.ts`、`storage/snapshot.ts`、`engine/engine.ts`。

- 六条均为 `verdict=deny`、`matched_rule_ids=[]`，旧格式没有 `error` 字段。
- 因为没有命中规则，它们不能作为某条规则误拒的证据；应作为迁移期 fail-closed/诊断覆盖缺口审核。
- 旧日志没有保留足够的内部错误类型，不能事后编造精确根因。新格式已要求显式 `engine_error` / `snapshot_error` 分类。

## confirm 抽样（20/65）

审核了工作表选中的 `opencode.jsonl` 第 `4`、`8`、`9`、`21`、`22`、`23`、`24`、`28`、`29`、`31`、`32`、`33`、`34`、`35`、`36`、`37`、`38`、`45`、`46`、`47` 行。

- 工具覆盖为 `edit` 与 `write`；命中规则均为 `side_effect-1-2`，与当前日志中 confirm 的工具/规则全集一致。
- 每条 action 都是实际的文件创建或修改，目标路径均在项目内；没有发现工具名、操作类型或目标归一化错误。
- 未发现明显的误分类。是否接受这类日常写操作都进入 confirm，属于规则摩擦预算与启用时机决策，仍由人判断；log-only 中这些动作均实际执行，没有被阻断。

## 仍需人裁决

1. `filesystem-0-2` 的 session 适用范围，以及唯一 0 层记录是否属于误伤。
2. 是否接受把 29 条旧适配器错误和 6 条迁移期 fail-closed 均作为已识别的覆盖问题，而不是规则误拒；如何防止同类问题回归。
3. 日常写操作全部命中 `side_effect-1-2` 的 confirm 频率是否可接受。
4. 在上述结论形成前，阶段 A 保持未裁决，阶段 B 不解锁。
