# 当前运行期状态

当前默认状态：**Stage A `log-only`**。安全策略适配器的默认行为仍是记录
假设裁决，不阻止实际工具执行；`workflowGate.enabled` 根配置保持 `false`。

## Harness 层 MVP（显式 opt-in）

Pi 适配器支持 `.pi/amos.json` 的 `managed.enabled=true`：在真实
`tool_call` 前用规则引擎和项目激活快照裁决，deny 阻断、confirm 经独立
reviewer 与一次性 grant 放行、`tool_result` 记录结果。它只在声明范围内
生效，**不是 OS 沙箱**，不覆盖未归一化入口/全副作用，不提供防篡改审计。

本轮明确**不建设 OS 隔离**（独立 UID、挂载域、bwrap/cgroup、内核沙箱），
因此这些不是 MVP 的阻塞项；但也不得宣称已具备。

## 阶段门

单测、离线项目目录、Harness MVP 或一次模型请求都不能改变生产/OS 级阶段门
结论。G0 的历史审核材料仍保存在 `spike/review/`；判定结论不得由 Agent
自动更改。当前不申请、不宣称生产安全运行期通过。
