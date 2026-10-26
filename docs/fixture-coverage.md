# Fixture 覆盖现状

## 语言中立 fixtures

语言中立的 JSON fixtures 位于仓库根目录的 `fixtures/`。`engine/fixtures.test.ts` 按文件名排序加载其中所有 `.json` 文件；每个文件是非空 fixture 数组，每条 fixture 以 `name`、`table`、`action`、`now` 和 `expect` 描述输入及预期结果，其中 `expect` 包含 `verdict`、`matched_rule_ids`，并可包含 `error`。

## 当前覆盖的裁决语义

- 命中条件未命中时返回 `allow`，且没有匹配规则 ID；命中时返回规则对应的裁决，例如 `deny` 或 `confirm`。
- 多规则命中时选择最严格的裁决；现有用例覆盖 `deny` 胜过 `confirm` 和 `log`，以及同级 `deny`/`confirm` 冲突归为 `deny`。
- 所有命中规则的 ID 按 `table` 中的顺序保留，包括同级多个 `deny`；未命中规则不列入结果。
- `action`、规则、命中条件调用及其 `args` 等位置的未知额外字段不会改变匹配结果。
- 含 `.`、`..`、`//` 或末尾 `/` 的文件 target，以及没有 hostname 的 URL target，在对应谓词被求值时 fail-closed，而不是当成未命中。
- 重复规则 ID、空白谓词参数和空白 narrative 使整张表 fail-closed。

## 7 个命中条件操作符

`fixtures/predicates.json` 为以下 7 个冻结命中条件操作符分别提供正例和反例：

| 命中条件操作符 | 当前覆盖的匹配语义 |
| --- | --- |
| `op_in` | 操作名精确、区分大小写地属于给定集合。 |
| `target_glob` | 绝对目标路径匹配任一 glob 模式。 |
| `target_outside_glob` | 目标路径位于所有给定 glob 模式之外。 |
| `url_query_key_in` | URL 查询键按完整键名匹配，键名比较不区分大小写。 |
| `target_scheme_in` | 目标 scheme 经规范化后属于给定集合。 |
| `target_host_in` | 目标主机经规范化后精确属于给定集合，包括 IPv6 方括号规范化。 |
| `target_host_not_in` | 目标主机位于排除集合之外；属于排除集合时不命中。 |

getter/Proxy 抛出的内部异常仍由 TypeScript 测试补充覆盖，不属于上述语言中立 fixtures 的覆盖范围。
