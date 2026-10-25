# 产品与工程决策

来源：2026-10-24 整合版产品与工程指令，以及《Agent 行为约束系统 — 设计文档》。本文件记录当前实现边界，不代表阶段门禁已经通过。

## 已拍板

1. 产品终态是单机、单信任根的完整治理闭环；当前仍处阶段 A（log-only），不得提前启用真实 deny、confirm 或治理。
2. 当前唯一适配器是 OpenCode V2。核心引擎不 import OpenCode，第二适配器不由当前实现预留空接口。
3. YAML 是规则事实源，JSONL 是原始审计事实源；SQLite 仅在阶段 D 作为可删除、可重建的派生读模型。裁决热路径只读不可变内存快照。
4. 使用 TypeScript strict、ESM、Node 26、npm 单 package。正式 hook 与测试运行 `tsc` 编译后的 JavaScript。
5. 核心运行时依赖为 Ajv、YAML、picomatch；不引入 Web 框架、ORM、LLM SDK、表达式执行器或第二语言引擎。
6. 引擎保持纯函数和注入时钟；Schema/词表校验在 loader，OpenCode 参数归一化只在 adapter，JSONL I/O 只在 logger。
7. 新快照校验失败时保留最后正常快照；首次没有正常快照时按 fail-closed 记录。SQLite 永不进入引擎热路径。
8. agent 只有提案权，没有直接写表权；UI 无直达写表通道。阶段 C/D 未到，不提前实现其接口。

## 当前实现约束

- `opencode.jsonc` 显式传入规则、Schema、日志路径和 `log-only` 模式。
- 无法结构化的 patch/未知 payload 在 log-only 中记录 `unknown_payload`；已知但不属于当前文件通道的工具显式跳过。
- 原始 JSONL 只追加。派生样例可以重建，但不能回写原始日志。
- shell、patch 和其他写旁路在阶段 B 前必须另行裁决；当前文件 hook 不代表全通道强制覆盖。

## 负约束

不修改或依赖 Termcp；不做第二 harness、多用户、SaaS、正则路由、自研 DSL、LLM 裁决、规则市场或对外协议冻结。不得为了架构观感改变 deny > confirm > log > allow、同层 deny 和 fail-closed 语义。
