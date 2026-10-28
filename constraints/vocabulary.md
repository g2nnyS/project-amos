# 封闭命中条件词表（G0 冻结）

冻结时间：2026-10-24。15 条规则翻译完成后冻结；后续规则只能复用下表，无法表达时标 `advisory_only`，不得新增一次性命中条件操作符。机器字段名保留 `predicate`；中文口径统一为「命中条件」。

规则表采用严格 schema：顶层数组至少 1 条规则；`rule`、`source`、`predicate` 及每种 `args` 均禁止未知字段。每条规则必须声明 `policy_class`（`security` 或 `engineering`）与 `enforcement`（`runtime`、`ci`、`server` 或 `advisory`）。`advisory_only` 必须搭配 `enforcement: advisory` 且 `predicate: null`；`deterministic` 只能使用 `runtime`、`ci` 或 `server`。当前 15 条规则的 `policy_class` 均为 `security`。

当前引擎中只有 `predicate`、`on_hit` 和 `ttl` 直接参与裁决；`dimension`、`scope`、`owner`、`policy_class` 与 `enforcement` 是经过校验并写入审计的治理元数据。按 `scope` 选规则、按 `owner` 实施写权限、按 `policy_class` 选择策略包尚未实现，不能当作已成立的能力。

## 表示边界

- `predicate` 是内置命中条件操作符调用的数组，数组内逐项做 AND；`advisory_only` 条目的值固定为 `null`。
- 每项只有 `op` 与 `args`。
- 除 `target_glob` / `target_outside_glob` 的 `args.patterns` 中唯一受限替换 `${SESSION_WORKSPACE}` 外，没有变量、脚本、嵌套布尔表达式、正则、自由文本条件或自定义扩展。`${SESSION_WORKSPACE}` 不是通用变量系统：它只接受适配器显式传入的单个 session workspace，且只替换上述位置中的完整 token。
- action 只含 `tool`、`operation`、`target` 三个语义字段；额外字段使整次评估 fail-closed，不再被忽略。文件内容为秘密的约束不能假装可由路径推断。
- 文件 target 必须已是规范化绝对路径：以 `/` 开头，不含 `//`、`.`、`..`、末尾 `/` 或 NUL。引擎不折叠这些形式，也不做 realpath、不访问文件系统、不识别 symlink；非规范化路径整次 fail-closed，避免用未折叠路径绕过 glob。
- URL target 是可解析的绝对 URL，且 host 谓词要求非空 hostname。forward 用 `dynamic://`、`local://` 或 `remote://` 表示类型；loopback 统一成 `localhost`，绑定 `*` 统一成 `0.0.0.0`。空 host 或空 scheme 不当作未命中。
- 重复规则 ID、空白 narrative、空白谓词参数、未知 `op`、参数类型错误、任何对象上的未知字段、URL 解析失败或内部异常都使整次评估 fail-closed 为 `deny`；空规则表同样 fail-closed。
- `ttl` 只接受 `null`、真实日历日期 `YYYY-MM-DD`，或与 `new Date(parsed).toISOString()` 完全一致的 UTC 时间；`now >= ttl` 时条目过期。

## `${SESSION_WORKSPACE}` 受限替换

- 规则表是便携核心：不得写死某位作者的 home 路径。唯一的路径替换 token 是 `${SESSION_WORKSPACE}`，只允许出现在 `target_glob` 与 `target_outside_glob` 的 `args.patterns` 字符串中。
- 替换只发生在解析后的规则表副本上；`narrative`、`source`、`probe`、键名、`tool` / `operation` 字符串、其他 op 的 `args` 以及任意其他字段保持原文，不做替换。
- 使用该 token 时必须由适配器显式传入 session workspace。缺失时整次加载 fail-closed 为 `snapshot_error`，不会把字面 token 当作路径参与评估。
- session workspace 必须是规范化绝对 POSIX 路径：以 `/` 开头，不含 NUL、`//`、`.` 或 `..` 段；除根 `/` 外不得有末尾 `/`。不合法同样 fail-closed。
- 快照 digest 同时绑定原始规则字节和生效的 session workspace：`SHA-256(rawRules + '\0SESSION_WORKSPACE=' + (sessionWorkspace ?? '') + '\0')`。因此不同 session workspace 不会共享同一个 digest，审计记录不会把两份不同的有效规则表误认为相同。

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
