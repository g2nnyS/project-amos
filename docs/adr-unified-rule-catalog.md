# P1 项目规则目录实现记录

- 状态：离线实现尚未提交。五项独立审查发现均已补回归覆盖；`npm run typecheck` 与 `npm test`（526 项）通过。安全运行期仍为 **NO-GO**。
- 范围：记录 catalog v2 的离线导入、项目激活、enforcement/advisory 双投影及当前限制。

## 实现状态

目录从现有 YAML 规则和 guidance seeds 建立版本化记录与迁移映射；按项目激活引用编译同一 activation snapshot 的 enforcement 与 advisory 投影。离线实现包括闭集验证、last-good store、level-first 选择、advisory TTL 过滤和遗漏报告。

五项审查修复覆盖 TTL 缓存复用、投影完整性、初始 clock rollback、route applicability，以及无信号 fallback 的显式适用性。

## 当前限制

- Pi/OpenCode adapters 尚未接入此 activation snapshot，仍使用原有规则快照与静态 guidance seed。
- 投影只用于离线编译和选择验证，不控制工具执行，不改变 Stage A `log-only` 状态，也不认证规则来源。
- 运行配置仍为现有文件配置；P1 不改变适配器设置或启用安全阻断。
