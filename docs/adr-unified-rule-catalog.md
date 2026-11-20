# P1 项目规则目录实现记录

- 状态：已实现并接入控制面发布（`control-plane/activation.ts`）与 Harness 受管/激活指导路径（`adapters/shared/activation-guidance.ts`、Pi `managed.enabled`）。五项独立审查发现均已补回归覆盖；安全运行期仍为 **NO-GO**（非 OS 沙箱，普通适配器默认仍为 Stage A `log-only`）。
- 范围：记录 catalog v2 的离线导入、项目激活、enforcement/advisory 双投影（含工程规范与设计偏好动态注入）及当前限制。

## 实现状态

目录从现有 YAML 规则和 guidance seeds 建立版本化记录与迁移映射；按项目激活引用编译同一 activation snapshot 的 enforcement 与 advisory 投影。实现包括闭集验证、last-good store、level-first 选择、advisory TTL 过滤和遗漏报告；控制台发布时原子写出 `<workspace>/.pi/activation.json` 供 Harness 消费。

五项审查修复覆盖 TTL 缓存复用、投影完整性、初始 clock rollback、route applicability，以及无信号 fallback 的显式适用性。

## 当前限制

- 普通 Pi/OpenCode 适配器在未配置 `activation` 或 `managed.enabled` 时仍保持 Stage A `log-only` 与静态 guidance seed 默认行为。
- 投影的 `verify` 是结构与身份一致性重编译，不提供跨机器密码学签名或来源认证；同 UID 本地文件不构成防篡改边界。
