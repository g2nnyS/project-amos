# 封闭命中条件词表（G0 冻结）

冻结时间：2026-10-24。15 条规则翻译完成后冻结；后续规则只能复用下表，无法表达时标 `advisory_only`，不得新增一次性命中条件操作符。机器字段名保留 `predicate`；中文口径统一为「命中条件」。

## 表示边界

- `predicate` 是内置命中条件操作符调用的数组，数组内逐项做 AND；`advisory_only` 条目的值固定为 `null`。
- 每项只有 `op` 与 `args`；没有变量、脚本、嵌套布尔表达式、正则、自由文本条件或自定义扩展。
- action 只含 `tool`、`operation`、`target` 三个语义字段；额外字段不参与裁决。文件内容为秘密的约束不能假装可由路径推断。
- 文件 target 是调用方给出的归一化绝对路径；引擎不做 realpath、不访问文件系统，也不承诺识别 symlink。
- URL target 是归一化绝对 URL。forward 用 `dynamic://`、`local://` 或 `remote://` 表示类型；loopback 统一成 `localhost`，绑定 `*` 统一成 `0.0.0.0`。
- 任一未知 `op`、参数类型错误、URL 解析失败或内部异常都使整次评估 fail-closed 为 `deny`。
- `ttl` 只接受 `null`、真实日历日期 `YYYY-MM-DD`，或与 `new Date(parsed).toISOString()` 完全一致的 UTC 时间；`now >= ttl` 时条目过期。

## 冻结清单

| op | args | 命中含义 |
|---|---|---|
| `op_in` | `{operations: string[]}` | `action.operation` 精确等于数组任一项。 |
| `target_glob` | `{patterns: string[]}` | 文件 target 命中任一 glob；只使用 glob，不接受正则。 |
| `target_outside_glob` | `{patterns: string[]}` | 文件 target 不在所有 glob 范围内，用于 paths 白名单。 |
| `url_query_key_in` | `{keys: string[]}` | URL 至少一个查询参数的键与列表项做大小写不敏感精确匹配；不检查或记录参数值。 |
| `target_scheme_in` | `{schemes: string[]}` | URL scheme 与列表项精确匹配。 |
| `target_host_in` | `{hosts: string[]}` | URL hostname 与任一归一化 host 精确匹配。 |
| `target_host_not_in` | `{hosts: string[]}` | URL hostname 不等于列表中的任何归一化 host。 |

## 本次表达力缺口

以下内容不在 action 信封内，因此没有对应命中条件：文件/请求正文、审批状态、生产环境与是否有人值守、认证启动 flag、上传字节数。对应规则已标 `advisory_only`，没有用 target 猜测这些状态。

本词表刻意没有 `rate_exceeds`：当前纯函数没有调用历史或速率状态，也没有注入这类状态的 G0 接口。
