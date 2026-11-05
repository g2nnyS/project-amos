<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Agent 策略匹配与审计原型
</p>

<p align="center">
  把 Agent 的行为约束从提示词移入确定性策略引擎，留下可溯源、可复核的裁决轨迹。
</p>

<p align="center">
  <code>阶段 A</code> · 安全层 log-only · 工程硬门可选启用<br>
  <strong>Pi Harness 层阻断（显式 opt-in）、独立审查 + 一次性授权、激活注入与审计已实现；默认适配器仍为 log-only。OS 隔离不在本 MVP 范围。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

## 这是什么？

把安全规矩写在 `AGENTS.md` 或系统提示词里，本质上是在赌模型的自觉。**Amos 的思路很简单：模型只管提议动作，确定性的策略引擎负责按规则算账，并留下一条干净的审计链。**

> **安全边界**：安全适配器默认 log-only。Pi `.pi/amos.json` 的 `managed.enabled` 是显式 opt-in 的 Harness 层 gate，可阻断归一化工具调用并审查 confirm；它**不是 OS 沙箱**，不覆盖所有入口/副作用，审计也不防篡改。独立工程工作流门仍是可选护栏。详见[安全模型](docs/security-model.md)、[Harness gate ADR](docs/adr-harness-gate.md)和[工作流硬门](docs/workflow-gate.md)。

---

## 当前产品范围

Amos 当前提供限定范围的 Harness 层 MVP：真实 Vue 控制台发布 P1 项目快照，真实 Pi 会话用同一快照执行拦截与 advisory 注入，工具执行前完成 `deny`/`confirm`/`allow` 裁决；`confirm` 由独立 reviewer 审查并通过一次性授权后执行一次。默认适配器仍为 log-only，managed 需显式启用，且不是 OS 沙箱。详见[MVP 交付](docs/mvp-delivery.md)、[产品范围](docs/product-design.md)和[实现状态](docs/product-gap-plan.md)。

---

## 它是怎么工作的？

```text
工具调用事件 (Tool Event)
   │
   ▼
适配器归一化 ── 不支持的工具 / 不可解析的 Shell ──► 写入覆盖缺口记录（不静默丢弃）
   │
   ▼
加载严格策略快照（按内容 Digest 寻址）
   │
   ▼
确定性策略求值
   │
   ├─ 命中规则       → 生成假设裁决 + 固化当时的规则元数据
   ├─ 未命中         → 显式标记 no_match（记录器按假设 deny 留痕）
   ├─ 校验错误       → deny + engine_error
   └─ 快照加载失败   → deny + snapshot_error
   │
   ▼
脱敏写入 JSONL 审计日志 & 快照归档 ──► 生成防注入的人工审核表
```

在安全 `log-only` 模式下，唯一副作用是写审计日志与快照归档。单独启用的工程工作流硬门可以阻断危险 Shell 命令或暂缓工作，但不会把安全策略层变成硬边界。

---

## 目前做到了哪一步？

### 已实现（Stage A 基础能力）

- **纯函数策略引擎与快照归档**：基于严格 Schema 校验的 TypeScript 引擎，清晰区分“命中、未命中、引擎错误、未评估”。每次策略变更按内容摘要（Digest）归档完整快照（含规则原文、Schema 与有效工作区）。
- **Supervisor 会话与停止栅栏核心**：提供进程内的已注册会话上下文、假设裁决与停止栅栏（Stop Fencing）核心逻辑（目前仅在内存中运行，尚未接入真实工具拦截）。
- **双端安全 `log-only` 适配器**：支持 **OpenCode V2** 与 **Pi** 的文件通道。遇到不支持的工具或黑盒 Shell 动作时，显式生成覆盖缺口记录，绝不静默跳过。
- **可选的工程工作流硬门**：版本化规范包、封闭子集的危险命令判定、harness 支持时的执行前阻断，以及变更后的本地/Jev 审查反馈。OpenCode V2 没有真正的 settle 阻断点，因此其完成审查明确保持 advisory。
- **按会话固定的 advisory 注入**：把版本化规范种子编译成不可变 advisory 快照，按区域、路径、任务标签和 prompt 词元做确定性选择，渲染带 policy 与 digest 出处的有界 `<amos-guidance>` 块。prompt 只能给已激活规则排序，不能引入新规则；注入失败不会改变任何门禁裁决。
- **P1 离线项目规则目录**：把现有 YAML 规则和全部 guidance seed 导入版本化目录，再按项目生成执行与 advisory 投影。编译、TTL 过滤和选择已通过离线测试；现有适配器仍走当前文件快照和静态 seed 路径。
- **Harness 层阻断 MVP（Pi，显式 opt-in）**：真实 Pi `tool_call` 钩子用 activation execution 投影裁决；deny 在执行前阻断，confirm 先停住并交有界独立审查与一次性 HMAC 授权，`tool_result` 记录结果；activation advisory 注入真实 system prompt。真实 Pi harness 测试覆盖 deny/allow/confirm 与真实文件副作用。不是 OS 沙箱，默认仍 log-only。
- **离线受管宿主与一次性审查**：闭集文件宿主做真实路径/符号链接/硬链接检查、能力根、审计前置和崩溃 unknown 不重放；独立 reviewer 只接收最小有界投影，经过校准门与 HMAC 一次性 grant；`managed/` 把 confirm 先停、审查、消费 grant、单次执行串成离线端到端测试。Pi managed 已接入 review/grant 路径，OpenCode 仍 log-only；OS 隔离不在本轮范围，无真实模型校准。
- **SQLite 治理库与 API（部分）**：单主 schema、全量导入预览、baseVersion CAS 提案、human-only 审批/发布、catalog v2 编译 + 审计原子提交、独立宿主回执、回滚新版本、WAL 备份/恢复和 loopback 认证 API。Vue 治理台与真实宿主回执未交付。
- **CheckBinding、rollout 与临时收紧**：精确 tree 的 TypeScript 检查合同、版本绑定的 probe 证据晋升门、已批准模板的附加型 TTL/配额/epoch 收紧。均为本地库；无远端 CI 强制、真实 probe 或持久 TTL 恢复。
- **要求一致性与逐字授权**：把当前人类要求捕获为 harness 持有的 `RequirementFrame`，由 Jev 判断动作是否服务于该要求。`mismatch` 拒绝，`partial`/`unclear` 要求确认，`match` 绝不放宽基线。人类逐字输入的命令可把非 `deny` 的 Shell 裁决提升为 `allow`；确定性 `deny` 永远保留。审计只记录 frame 与命令 digest，不记录要求原文。
- **隐私脱敏与防注入人审表**：落盘前自动脱敏 URL 敏感参数，绝不记录文件内容或 Shell 命令原文；生成的人工审核表会对不可信字段做安全编码，防止 Markdown/HTML 注入。
- **Jev 语义顾问接入**：支持 TypeSafe 直连与 OpenRouter System One，可通过受保护的本地配置文件提供凭据。确定性规则才是权威，模型评估**只能收紧裁决，绝不能放宽裁决**。

### 当前限制

- P1 仍是离线编译器；现有适配器继续使用旧策略快照与 guidance seed。受管宿主/reviewer 流程是库，不是默认宿主入口。
- 安全适配器不阻止工具执行；可选工作流门仍只是工程护栏。安全运行期仍是 **NO-GO**。
- **OS 隔离（独立 UID、挂载域、bwrap/cgroup、内核沙箱、全副作用中介）本轮不做，不是阻塞项**，不得宣称已具备。
- 来源认证、真实模型 reviewer 校准、真实 probe/rollout、宿主接收/生效回执、Vue 治理台、远端 CI 接纳门均未交付。
- SQLite owner-only 文件、同进程 HMAC、JSONL 和 digest 都不是防篡改或来源认证边界。

---

## 快速上手

环境要求：Node.js 26 与 npm。

```bash
npm ci
npm run typecheck
npm test
```

### 1. 接入 OpenCode V2 / Pi

根目录的 `opencode.jsonc` 已配置好插件。执行 `npm run build` 后，在项目根目录启动 OpenCode V2 即可把安全裁决写入 `spike/logs/opencode.jsonl`。Pi 的接入方式参见 [Pi 适配器说明](docs/pi-adapter.md)。工程硬门、Jev 配置及各 harness 的真实限制见 [工作流硬门](docs/workflow-gate.md)。

### 2. 生成人工审核工作表

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

*(注：`--output` 必须指向尚不存在的新文件，防止覆盖已有的人工审核结论。)*

---

## 协作规范与延伸文档

- **分支与权限**：日常开发请使用 `feat/`、`fix/`、`docs/`、`chore/`、`refactor/`、`test/` 或 `ci/` 分支。分支保护、禁止强推与发布权限由 Git 服务端强制执行；安全敏感变更必须经过人工审查，**Agent 不得自我批准、合并或发布**（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

**核心文档索引**：
- [产品范围](docs/product-design.md) · [实现状态](docs/product-gap-plan.md)
- [安全模型与当前状态](docs/security-model.md) · [运行期状态](docs/go-no-go.md)
- [Supervisor 核心说明](docs/supervisor-core.md) · [工程工作流硬门](docs/workflow-gate.md) · [Jev 语义接入说明](docs/jev-integration.md)
- [产品与工程决策记录](docs/decisions.md) · [测试覆盖说明](docs/fixture-coverage.md)
- [交付状态](docs/delivery-status.md) · [AC-01–22 验收矩阵](docs/acceptance-one-shot.md) · [One-shot 验证记录](docs/verification-one-shot.md) · [配置迁移与受管启动](docs/configuration-one-shot.md)
- 安全 ADR：[来源认证](docs/adr-source-authentication.md) · [受管宿主](docs/adr-managed-file-host.md) · [review 协议](docs/adr-review-protocol.md) · [治理库](docs/adr-governance-store.md) · [CheckBinding](docs/adr-check-binding.md) · [临时收紧](docs/adr-temporary-tightening.md)
- [OpenCode V2 接入笔记](spike/README.md) · [Pi 适配器说明](docs/pi-adapter.md)

---

<p align="center">
  <sub>一个策略引擎真正的价值，不只在于它会给出什么裁决，更在于它的信任边界、覆盖死角和审计链同样坦诚透明。</sub>
</p>
