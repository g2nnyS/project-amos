# Advisory-only 翻译缺口

以下 5 条均因结构化 action 缺少必要状态而保留为 advisory。

- id: credential-0-3
  source.quote: "token 从不进日志、也从不放进 URL。"
  reason: "结构化 action 不含文件或请求正文，无法确定日志写入内容是否包含 token 或认证 hash，因此无法表达为 deterministic 规则。"
- id: network-0-1
  source.quote: "Binding a non-loopback address (`0.0.0.0`, a LAN IP, …) without auth **refuses to start**."
  reason: "结构化 action 不含认证启动 flag，无法判定非 loopback 绑定是否配置了认证或使用了 --disable-auth，因此无法表达为 deterministic 规则。"
- id: side_effect-0-1
  source.quote: "Expiry is fail-closed: the request becomes `expired`, never `approved`."
  reason: "结构化 action 不含审批状态或关联 session 状态，无法判定审批是否已到期、被拒绝或因 session 消亡而失效，因此无法表达为 deterministic 规则。"
- id: side_effect-0-4
  source.quote: "不要把 Agent 独自放在生产主机上。必须如此时，打开审阅模式。"
  reason: "结构化 action 不含生产环境标识和是否有人值守的信息，无法判定是否属于无人值守操作生产主机，因此无法表达为 deterministic 规则。"
- id: resource-1-1
  source.quote: "The upload limit is 16 MiB."
  reason: "结构化 action 不含上传字节数，无法判定批量导入是否超过 16 MiB，因此无法表达为 deterministic 规则。"
