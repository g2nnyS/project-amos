# project-amos

面向个人与封闭舰队的单机 Agent 行为约束系统。目标是让约束成为有证据、有审批、有过期、有评测、可由 harness 强制执行的工程资产，而不是只存在于 prompt 中的愿望。

当前处于**阶段 A：log-only 验证**。真实 deny、confirm、提案治理、SQLite 读模型和 Web 治理台尚未启用。

## 核心语义

- 模型是 proposer，harness 是 disposer。
- 可强制规则使用确定性命中条件（`predicate`）；自然语言 `narrative` 用于人类阅读和 advisory 提示。
- 无法确定性表达的规则标为 `advisory_only`，不使用自由文本或伪谓词硬凑。
- 多命中时 `deny > confirm > log > allow`；同层冲突 deny 获胜；非法输入和内部异常 fail-closed。
- 设计上的三层结构是“全局规则库 → 项目激活集 → 当前任务注入集”。激活决定适用性，注入决定提醒，硬规则是否执行不取决于是否被注入。

## 当前已有

- 15 条带具体 `source` 和 `probe` 的首批规则，以及封闭命中条件词表。
- TypeScript 纯函数引擎、JSON Schema 和语言中立 JSON fixtures。
- 深度冻结的内存规则快照；非法 reload 保留最后正常快照。
- 只追加 JSONL 原始审计日志及错误分类。
- OpenCode V2 编译后 log-only 插件，使用显式规则、Schema 和日志路径。
- 人审工作表生成器：0 层与非 0 层 deny 全量、错误全量、confirm 覆盖优先抽样。

## 环境

- Node.js 26
- npm
- OpenCode V2（仅运行适配器时需要）

## 安装与验证

```bash
npm ci
npm run build
npm test
npm run typecheck
```

`npm test` 会先执行 `npm run build`，再运行编译后的 JavaScript 测试。

## OpenCode log-only

先在本仓库根目录构建：

```bash
npm run build
```

项目根 `opencode.jsonc` 会从 `dist/adapters/opencode-v2/` 加载插件，配置为 `log-only`。随后从这个目录启动 OpenCode V2 即可。插件只记录假设裁决，不阻断实际工具调用。

实时日志写入 `spike/logs/opencode.jsonl`，该目录不会进入 git。派生样本位于 `spike/examples/`。

## 生成人审工作表

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

历史归档可以通过重复 `--log` 一并传入。输出必须是尚不存在的新文件，避免覆盖人已经填写的审核结论。

## 目录

```text
constraints/       规则、JSON Schema、封闭词表
engine/            纯函数引擎与测试
fixtures/          语言中立裁决 fixtures
adapters/          OpenCode V2 归一化与 hook
storage/           快照、JSONL、审核队列
spike/             接缝说明、真实日志样本、人审材料
docs/              决策、门禁与覆盖说明
```

## 阶段门禁

- 阶段 A：log-only、真实日志和误拒审核。
- 阶段 B：选择性 0 层强制，再启用 confirm。
- 阶段 C：提案、人工审批、git 治理与 TTL。
- 阶段 D：SQLite 派生读模型与本地 Web 治理台。

当前门禁状态以 [docs/go-no-go.md](docs/go-no-go.md) 为准，agent 不自行放行。

设计文档：[Agent 行为约束系统 — 设计文档](https://app.notion.com/p/eb784af41d4f834f8cb881cb913f7601)。

## 当前边界

仅交付 OpenCode V2 适配器；不修改或依赖 Termcp，不做第二 harness、多用户、SaaS、云控制面、LLM 裁决或自研谓词 DSL。
