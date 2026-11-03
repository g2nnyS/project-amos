# 实现状态

基线：`feat/constraint-runtime`，HEAD `a8b075d`。本页仅记录当前分支的实现与验证。

## P1 离线项目规则目录

- catalog v2 从现有 YAML 规则和 guidance seeds 建立版本化目录、迁移映射及项目激活集。
- 同一离线 activation snapshot 编译 runtime/CI/server enforcement 投影和 advisory 注入投影；包括基线/引用闭集校验、level-first 选择、TTL、last-good 与遗漏报告。
- 独立审查发现的五项选择/会话/投影边界问题均已补回归覆盖。
- 验证：`npm run typecheck`、`npm test`（526 项通过）和 `git diff --check` 通过。工作树改动未提交。
- 限制：现有适配器仍使用旧策略快照和静态 guidance seed；P1 不接入工具裁决，不认证来源，也不改变 `opencode.jsonc`。

## 外部 Jev 连通性检查

已发送一次合成输入的 OpenRouter/System One 请求，返回结构化答复，说明此配置可连通并解析响应。该样例置信度为 0.4，标记为需要复核；它不是完整校准，也不构成安全证据。当前客户端结果不含 usage/费用数据，因此不能据此确认实际扣费。

## 当前状态

安全适配器仍是 Stage A `log-only`，裁决是假设结果，不阻止工具执行。可选工程工作流门是独立护栏，不提供完整动作覆盖。不要将离线测试、一次模型请求或配置文件描述为运行期安全强制能力。
