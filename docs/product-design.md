# 产品范围与当前实现

状态：本文只记录当前产品范围和仓库中可验证的实现。当前安全策略仍为 Stage A `log-only`，不会阻止工具执行。

## 当前组成

1. **安全策略观察器**：Pi 与 OpenCode 适配器归一化部分文件工具事件，使用严格策略快照计算假设裁决并写入脱敏 JSONL。结果不控制实际执行。
2. **可选工程工作流门**：单独配置后，可评估封闭子集 Shell 命令、运行固定本地检查并提供 advisory Jev 反馈。它不是安全策略强制执行，也不覆盖所有执行入口。
3. **动态规范注入**：从版本化 guidance seed 产生 advisory 内容，按结构化信号选择并写入模型上下文。注入内容不产生策略裁决或批准权。
4. **P1 离线项目规则目录**：catalog v2 可把 YAML 规则和 guidance seeds 编译为项目级 enforcement/advisory 双投影。它尚未接入现有 adapters，也不认证发布来源。
5. **受管文件宿主与一次性审查（离线）**：`host/` 提供闭集文件执行、能力/路径检查、审计前置与崩溃不重放；`review/`、`managed/` 提供最小投影、独立 reviewer、校准门、一次性 HMAC 授权和端到端离线接线。未接入 Pi/OpenCode 默认入口，未启用安全 confirm，无真实 OS 隔离或 provider 校准。
6. **治理与工程接纳（部分/离线）**：`governance/` 提供 SQLite 单主、导入预览、CAS 提案/发布、回执记录和 loopback API；`check/` 提供精确 tree 的 CheckBinding/FindingBatch 合同与一个真实 TypeScript 检查；`rollout/` 提供版本绑定证据门；`activation/tighten.ts` 提供附加型临时收紧。Vue 治理台、真实宿主回执、生产 rollout 和远端 CI 接纳点未交付。

## 当前配置与约束

- 运行策略仍来自 `constraints/rules.yaml`；注入种子仍来自 `guidance/packs.ts`。现有文件加载路径未迁移。
- 引擎只使用既有七种谓词操作符，保持 `deny > confirm > log > allow` 和 fail-closed 语义。
- Jev 是可选语义传感器，只能收紧确定性结果；它不是批准器或执行器。requirement 文本出境必须由对应 frame 显式允许。
- `opencode.jsonc` 的 `workflowGate.enabled` 仍为 `false`；不因本文或 P1 离线编译而改变。

## 当前安全状态

安全适配器只记录假设裁决，Stage A 不执行安全阻断；当前实现不具备运行期安全强制能力。

验证与当前差距见[实现状态](product-gap-plan.md)及[安全模型与当前保证](security-model.md)。
