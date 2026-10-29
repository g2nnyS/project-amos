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
  <strong>当前状态：工程硬门已实现（可选启用）；安全运行期强制执行 NO-GO</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

## 这是什么？

把安全规矩写在 `AGENTS.md` 或系统提示词里，本质上是在赌模型的自觉。**Amos 的思路很简单：模型只管提议动作，确定性的策略引擎负责按规则算账，并留下一条干净的审计链。**

> **安全边界声明**：安全策略层目前处于 **阶段 A（`log-only` 旁路观察）**，还**不是硬安全边界**。
> 安全适配器只观察部分文件工具调用，把假设裁决写进 JSONL。另有独立的、显式启用的**工程工作流硬门**，可阻断危险 Shell 命令、注入按会话固定的 advisory 规范、按捕获的人类要求评估动作，并暂缓有问题的变更；它是工作流护栏，不等于全通道中介或 OS 安全边界。“物理锁定”“全局默认拒绝”或“防篡改审计”仍需受信任监督进程、完整动作覆盖与 OS 级执行隔离（详见 [安全模型](docs/security-model.md) 与 [工作流硬门](docs/workflow-gate.md)）。

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
- **要求一致性与逐字授权**：把当前人类要求捕获为 harness 持有的 `RequirementFrame`，由 Jev 判断动作是否服务于该要求。`mismatch` 拒绝，`partial`/`unclear` 要求确认，`match` 绝不放宽基线。人类逐字输入的命令可把非 `deny` 的 Shell 裁决提升为 `allow`；确定性 `deny` 永远保留。审计只记录 frame 与命令 digest，不记录要求原文。
- **隐私脱敏与防注入人审表**：落盘前自动脱敏 URL 敏感参数，绝不记录文件内容或 Shell 命令原文；生成的人工审核表会对不可信字段做安全编码，防止 Markdown/HTML 注入。
- **Jev 语义顾问接入**：支持 TypeSafe 直连与 OpenRouter System One，可通过受保护的本地配置文件提供凭据。确定性规则才是权威，模型评估**只能收紧裁决，绝不能放宽裁决**。

### 尚未实现（进入强制执行前必须补齐的拼图）

- 对 Shell、Patch、网络请求、未知工具及扩展入口的**全通道无死角接管**。
- 与 Agent 可写目录隔离的**受信任监督进程（Trusted Supervisor）**及防篡改存储。
- 抗符号链接（Symlink）、硬链接、Bind Mount 及 TOCTOU 竞争的文件系统安全执行。
- 绑定具体动作与策略快照的**一次性认证审批**，以及 `scope` / `owner` / `level` 等元数据的运行期权限语义。
- 安全策略层在任一适配器中的真实 `deny` / `confirm` 拦截。独立的工程工作流硬门不满足这一要求。

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
- [安全模型与当前保证](docs/security-model.md) · [G0 门禁核验标准](docs/go-no-go.md)
- [Supervisor 核心说明](docs/supervisor-core.md) · [工程工作流硬门](docs/workflow-gate.md) · [Jev 语义接入说明](docs/jev-integration.md)
- [产品与工程决策记录](docs/decisions.md) · [测试覆盖说明](docs/fixture-coverage.md)
- [OpenCode V2 接入笔记](spike/README.md) · [Pi 适配器说明](docs/pi-adapter.md)

---

<p align="center">
  <sub>一个策略引擎真正的价值，不只在于它会给出什么裁决，更在于它的信任边界、覆盖死角和审计链同样坦诚透明。</sub>
</p>
