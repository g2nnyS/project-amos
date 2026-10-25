# Atmos 阶段 A 人工审核工作表

> **这是从原始 JSONL 派生的人审工作表，不是自动审核结论，也不是自动放行。**
> 所有“结论”和“说明”必须由人填写；生成器只读事实源，不会修改日志或规则。

## 汇总

| 项目 | 数量 |
| --- | --- |
| 日志记录总数 | 158 |
| 0 层规则命中（全量） | 1 |
| 非 0 层规则 deny（全量） | 0 |
| 错误/覆盖缺口（全量、去重） | 35 |
| confirm 总数 | 65 |
| confirm 选中 | 20 |

覆盖缺口分类：`legacy_fail_closed_no_ids` 35 条、`action_invalid` 29 条

## 0 层规则命中（全量）

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:31`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:31`
- ts: `2026-10-24T06:34:00.553Z`
- action: `grep` / `file_search` → `/home/ganyu/.cache/opencode`
- matched: `filesystem-0-2`（level 0，on_hit `deny`）、`side_effect-1-3`（level 1，on_hit `log`）
- verdict: `deny`
- error: —
- 原因: `zero_level_hit`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

## 非 0 层规则 deny（全量）

_（无）_

## 错误与覆盖缺口（全量）

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:1`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:1`
- ts: `2026-10-24T06:29:27.084Z`
- action: `write` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:2`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:2`
- ts: `2026-10-24T06:29:30.605Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:3`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:3`
- ts: `2026-10-24T06:30:33.670Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:4`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:4`
- ts: `2026-10-24T06:30:33.671Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:5`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:5`
- ts: `2026-10-24T06:30:33.671Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:6`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:6`
- ts: `2026-10-24T06:31:21.903Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:8`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:8`
- ts: `2026-10-24T06:31:39.946Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:9`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:9`
- ts: `2026-10-24T06:31:40.897Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:10`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:10`
- ts: `2026-10-24T06:31:40.897Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:11`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:11`
- ts: `2026-10-24T06:31:40.898Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:12`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:12`
- ts: `2026-10-24T06:31:40.906Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:13`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:13`
- ts: `2026-10-24T06:31:44.340Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:14`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:14`
- ts: `2026-10-24T06:31:51.970Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:15`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:15`
- ts: `2026-10-24T06:31:51.971Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:16`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:16`
- ts: `2026-10-24T06:31:51.971Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:17`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:17`
- ts: `2026-10-24T06:32:01.148Z`
- action: `write` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:18`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:18`
- ts: `2026-10-24T06:32:01.149Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:19`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:19`
- ts: `2026-10-24T06:32:05.218Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:20`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:20`
- ts: `2026-10-24T06:32:05.218Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:21`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:21`
- ts: `2026-10-24T06:32:37.103Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:23`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:23`
- ts: `2026-10-24T06:32:41.236Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:24`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:24`
- ts: `2026-10-24T06:33:07.138Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:25`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:25`
- ts: `2026-10-24T06:33:11.231Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:26`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:26`
- ts: `2026-10-24T06:33:13.547Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:27`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:27`
- ts: `2026-10-24T06:33:30.718Z`
- action: `write` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:28`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:28`
- ts: `2026-10-24T06:33:32.893Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:29`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:29`
- ts: `2026-10-24T06:33:46.205Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:30`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:30`
- ts: `2026-10-24T06:33:46.211Z`
- action: `read` / `file_read` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:32`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode-field-mismatch.jsonl:32`
- ts: `2026-10-24T06:35:18.200Z`
- action: `edit` / `file_write` → （空）
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`、`action_invalid`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:39`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:39`
- ts: `2026-10-24T10:47:44.469Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/engine/engine.ts`
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:40`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:40`
- ts: `2026-10-24T10:47:45.581Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/adapters/opencode-v2/normalize.ts`
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:41`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:41`
- ts: `2026-10-24T10:47:50.648Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/adapters/opencode-v2/hook.test.ts`
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:42`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:42`
- ts: `2026-10-24T10:47:50.782Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/engine/engine.ts`
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:43`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:43`
- ts: `2026-10-24T10:47:51.365Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/storage/snapshot.ts`
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:44`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:44`
- ts: `2026-10-24T10:47:54.048Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/engine/engine.ts`
- matched: （无命中规则）
- verdict: `deny`
- error: —
- 原因: `legacy_fail_closed_no_ids`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

> confirm 超过 20 条：按不同 action.tool 与 matched rule id 做确定性覆盖优先选择，等覆盖增益时取原始行更早者，最终按 source+line 排序。

## confirm（共 65 条，选中 20 条）

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:4`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:4`
- ts: `2026-10-24T06:35:50.369Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/docs/translation-notes.md`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:8`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:8`
- ts: `2026-10-24T06:36:26.188Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/spike/README.md`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:9`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:9`
- ts: `2026-10-24T06:36:26.189Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/constraints/vocabulary.md`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:21`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:21`
- ts: `2026-10-24T10:45:37.512Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/package.json`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:22`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:22`
- ts: `2026-10-24T10:45:37.513Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/tsconfig.json`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:23`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:23`
- ts: `2026-10-24T10:45:37.513Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/tsconfig.build.json`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:24`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:24`
- ts: `2026-10-24T10:45:37.542Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/.gitignore`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:28`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:28`
- ts: `2026-10-24T10:46:41.645Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/opencode.jsonc`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:29`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:29`
- ts: `2026-10-24T10:46:41.646Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/docs/decisions.md`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:31`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:31`
- ts: `2026-10-24T10:47:15.967Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/storage/snapshot.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:32`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:32`
- ts: `2026-10-24T10:47:19.473Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/storage/jsonl.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:33`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:33`
- ts: `2026-10-24T10:47:30.127Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/adapters/opencode-v2/index.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:34`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:34`
- ts: `2026-10-24T10:47:31.716Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/storage/snapshot.test.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:35`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:35`
- ts: `2026-10-24T10:47:37.071Z`
- action: `write` / `file_write` → `/home/ganyu/projects/project-atmos/storage/jsonl.test.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:36`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:36`
- ts: `2026-10-24T10:47:39.261Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/storage/jsonl.test.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:37`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:37`
- ts: `2026-10-24T10:47:41.767Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/storage/jsonl.test.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:38`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:38`
- ts: `2026-10-24T10:47:42.070Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/engine/engine.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:45`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:45`
- ts: `2026-10-24T10:47:57.854Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/engine/engine.test.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:46`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:46`
- ts: `2026-10-24T10:48:03.010Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/engine/engine.test.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：

### `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:47`

- source:line: `/home/ganyu/projects/project-atmos/spike/logs/opencode.jsonl:47`
- ts: `2026-10-24T10:48:05.327Z`
- action: `edit` / `file_write` → `/home/ganyu/projects/project-atmos/engine/engine.test.ts`
- matched: `side_effect-1-2`（level 1，on_hit `confirm`）
- verdict: `confirm`
- error: —
- 原因: `confirm`

- [ ] 已审核
- 结论（人填）：
- 说明（人填）：
