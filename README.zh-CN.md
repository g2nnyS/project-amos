<h1 align="center">Project Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  智能体授权与监管系统
</p>

<p align="center">
  把 Agent 的硬性边界与工程规范从臃肿提示词迁入同源编译的确定性策略引擎与动态上下文注入器，留下可溯源、可复核的裁决轨迹。
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

## 这是什么？

把安全规矩和工程规范一股脑堆进 `AGENTS.md` 或系统提示词里，既是在赌模型的自觉，也会用大量无关上下文稀释真正关键的约束。**Amos 将同一个项目激活目录拆分为同源双投影：确定性策略引擎对结构化动作执行硬性裁决（`deny`/`confirm`/`allow`），而按会话固定的动态上下文注入器（`<amos-guidance>`）则根据代码区域、目标路径、任务标签与输入词元，按需投递当前任务相关的工程规范、架构不变量与设计偏好。**

> **安全边界**：安全适配器默认 log-only。Pi `.pi/amos.json` 的 `managed.enabled` 是显式 opt-in 的 Harness 层 gate，可阻断归一化工具调用并审查 confirm；它**不是 OS 沙箱**，不覆盖所有入口/副作用，审计也不防篡改。独立工程工作流门仍是可选护栏。详见[安全模型](docs/security-model.md)、[Harness gate ADR](docs/adr-harness-gate.md)和[工作流硬门](docs/workflow-gate.md)。

---

## 目前到什么阶段了？

`Harness 层 MVP` · Vue 治理控制台 · Pi 受管硬门（显式启用） · Stage A 默认适配器

**端到端闭环已交付：真实 Vue 控制台发布 P1 catalog-v2 快照，Pi `managed.enabled` 执行工具前 `deny`/`confirm`/`allow` 裁决、Jev 语义 reviewer + 一次性 HMAC 授权与动态 advisory 注入；默认适配器保持 log-only，OS 隔离不在本 MVP 范围。**

---

## 当前产品范围

Amos 当前提供限定范围的 Harness 层 MVP：真实 Vue 控制台发布 P1 项目快照，真实 Pi 会话用同一快照执行拦截与 advisory 注入，工具执行前完成 `deny`/`confirm`/`allow` 裁决；`confirm` 由 Jev 语义 reviewer 审查并通过一次性授权后执行一次。默认适配器仍为 log-only，managed 需显式启用，且不是 OS 沙箱。详见[MVP 交付](docs/mvp-delivery.md)、[产品范围](docs/product-design.md)和[实现状态](docs/product-gap-plan.md)。

---

## 它是怎么工作的？

```text
[1] 受管治理与 Harness 硬门路径（Pi 显式启用：.pi/amos.json managed.enabled = true）
Vue 治理控制台 / SQLite ── 发布 P1 catalog-v2 ──► .pi/activation.json
   │
   ▼
Pi 会话加载快照（写 .pi/runtime.json 回执）+ 将 <amos-guidance> 动态注入系统提示词
   │
   ▼
工具调用事件 (read/write/edit/ls/find/grep)
   ├─ deny     → 执行前直接阻断 + 写入审计记录
   ├─ confirm  → Jev 语义 reviewer 审查 ──► 一次性 HMAC grant ──► 放行执行一次
   └─ allow    → 放行执行 + tool_result 审计记录 & 路径/任务级 advisory 附加

[2] 默认 log-only 适配器路径（OpenCode V2 & 默认 Pi）
工具调用事件 ──► 适配器归一化（不支持的工具 / 不可解析的 Shell → 写入覆盖缺口记录）
   │
   ▼
按内容 Digest 寻址策略快照 ──► 确定性策略求值（命中 / no_match / 引擎或快照错误）
   │
   ▼
脱敏写入 JSONL 审计日志 & 快照归档 ──► 生成防注入的人工审核表
```

在默认 `log-only` 模式下，唯一副作用是写审计日志与快照归档。当显式启用 Pi `managed.enabled` 时，归一化文件与检索工具调用会在执行前按已发布的 P1 快照做真实阻断与一次性授权审查。独立工程工作流硬门也可用于阻断危险 Shell 命令或暂缓工作。

---

## 动态上下文注入：工程规范与设计偏好

Amos 把项目的工程规范、架构不变量与设计偏好视为一等公民的版本化规则（`policy_class: engineering` / `expressivity: advisory_only` 或硬规则配对的 `narrative`），与安全硬规则从同一个 P1 项目激活快照（`activation/` + `injector/`）同源编译：

- **内置工程规范包与自定义设计偏好**：`guidance/packs.ts` 内置 7 个领域规范包（`typescript-base`、`engine-invariants`、`adapters`、`supervisor-core`、`decision-jev`、`dependencies-and-manifests`、`workflow-security`），覆盖严格 ESM/Node 26 规范、纯函数引擎边界、依赖极简主义（禁止引入未批准的 HTTP/ORM 框架）与适配器归一化职责。团队可在控制台或 YAML 中新增项目级 `advisory_only` 设计偏好、为确定性规则维护 `narrative` 说明，并配置项目默认基线（`injection.baselineRuleIds`）与任务/路径路由（`injection.routes`）。
- **两阶段确定性选择与打分（`injector/select.ts`）**：先按 `languages` / `frameworks` 过滤适用规则，再按 `level` 升序及多维结构化信号（`areas`、`pathHints` glob、`taskTags` 与有界 prompt 关键词序列）确定性打分排序，并叠加路由的显式 `add` / `suppress`。若无信号命中或路由异常，自动回退至当前项目已激活的 narrative 集合（优先 `baselineRuleIds`），绝不越界回退到未激活的全局规则库。
- **会话固定投递与字符预算（`injector/session.ts`、`injector/render.ts`）**：在严格字符与条数预算下（prompt `1,800` / fallback `1,200` / area `900` / 会话总计 `6,000` 字符，单块最多 `6` 条）渲染 XML 转义的 `<amos-guidance policy="..." digest="..." mode="advisory">` 块。用户轮次注入与当前任务匹配的工程规范；归一化写/改文件动作（`write`/`edit`/`file_write`）按目标路径推导代码区域并在工具结果或下一轮上下文追加区域规范。仅在宿主确认发出（`commit`）后才计入会话去重，超出预算被裁剪的规则通过 `omittedRefs` 与 `incomplete: true` 显式上报。
- **裁决零干扰不变量**：提示词词元、任务标签与字符预算仅影响 advisory 文本的排序与截断，绝不裁剪硬性拦截规则、不授予执行权限，注入失败也绝不改变任何门禁裁决或审计结果。

---

## 目前做到了哪一步？

### 已实现（Harness 层 MVP 与 Stage A 基础能力）

- **纯函数策略引擎与快照归档**：基于严格 Schema 校验的 TypeScript 引擎，清晰区分“命中、未命中、引擎错误、未评估”。每次策略变更按内容摘要（Digest）归档完整快照（含规则原文、Schema 与有效工作区）。
- **Supervisor 会话与停止栅栏核心**：提供进程内的已注册会话上下文、假设裁决与停止栅栏（Stop Fencing）核心逻辑；真实 Pi 工具执行前拦截由 Harness 层阻断 MVP（`managed/`）承接。
- **双端安全 `log-only` 默认适配器**：支持 **OpenCode V2** 与 **默认 Pi** 的文件通道。遇到不支持的工具或黑盒 Shell 动作时，显式生成覆盖缺口记录，绝不静默跳过。
- **可选的工程工作流硬门**：版本化规范包、封闭子集的危险命令判定、harness 支持时的执行前阻断，以及变更后的本地/Jev 审查反馈。OpenCode V2 没有真正的 settle 阻断点，因此其完成审查明确保持 advisory。
- **按会话固定的 advisory 注入**：把版本化规范种子编译成不可变 advisory 快照，按区域、路径、任务标签和 prompt 词元做确定性选择，渲染带 policy 与 digest 出处的有界 `<amos-guidance>` 块。prompt 只能给已激活规则排序，不能引入新规则；注入失败不会改变任何门禁裁决。
- **P1 项目规则目录与发布**：把仓库 YAML 规则和 guidance seed 导入版本化目录，按项目编译执行与 advisory 投影，并由控制台发布 catalog-v2 产物；Pi managed 路径直接消费同一产物完成执行前拦截与动态注入。
- **Harness 层阻断 MVP（Pi，显式 opt-in）**：真实 Pi `tool_call` 钩子用 activation execution 投影裁决；`deny` 在执行前阻断，`confirm` 先停住并交有界投影的 Jev 语义 reviewer 审查与一次性 HMAC 授权，`tool_result` 记录结果；activation advisory 注入真实 system prompt 并在工具结果附加路径/任务级指导。已由 `managed/pi-harness.test.ts`（真实 Pi 会话 + 真实扩展 + 真实 write 工具 + loopback Jev 协议应答 + 真实文件副作用）与 `managed/harness-requirement.test.ts` 验证；2026-11-05 的 live probe 用的是已退役的本地 reviewer 服务。不是 OS 沙箱，默认仍 log-only。
- **离线受管宿主与一次性审查**：闭集文件宿主做真实路径/符号链接/硬链接检查、能力根、审计前置和崩溃 unknown 不重放；Jev reviewer（`review/jev-reviewer.ts`）只接收最小有界投影，经过校准门与 HMAC 一次性 grant；`managed/` 把 confirm 先停、审查、消费 grant、单次执行串成端到端闭环。Pi 与 OpenCode 的 managed 路径都接入该 review/grant 链路，普通适配器仍 log-only；OS 隔离不在本轮范围。
- **Vue 治理控制台与 SQLite API**：提供登录、项目创建/切换、规则编辑与 YAML 导入导出、校验、不可变提案、人工审批/发布、版本列表、回滚新版本、审计与运行期状态观察。SQLite 单主存储，发布事务原子编译 catalog-v2 并写出 `.pi/activation.json`；真实 Chromium 端到端测试已覆盖登录→发布→YAML 导出/导入→runtime 状态→回滚全链路。宿主回执为同 UID 本地 `.pi/runtime.json` 报告，非跨机器远程证明。
- **CheckBinding、rollout 与临时收紧**：精确 tree 的 TypeScript 检查合同、版本绑定的 probe 证据晋升门、已批准模板的附加型 TTL/配额/epoch 收紧。均为本地库；无远端 CI 强制、真实 probe 或持久 TTL 恢复。
- **要求一致性与逐字授权**：把当前人类要求捕获为 harness 持有的 `RequirementFrame`，由 Jev 判断动作是否服务于该要求。`mismatch` 拒绝，`partial`/`unclear` 要求确认，`match` 绝不放宽基线。人类逐字输入的命令可把非 `deny` 的 Shell 裁决提升为 `allow`；确定性 `deny` 永远保留。审计只记录 frame 与命令 digest，不记录要求原文。
- **隐私脱敏与防注入人审表**：落盘前自动脱敏 URL 敏感参数，绝不记录文件内容或 Shell 命令原文；生成的人工审核表会对不可信字段做安全编码，防止 Markdown/HTML 注入。
- **Jev 语义顾问接入**：支持 TypeSafe 直连与 OpenRouter System One，可通过受保护的本地配置文件提供凭据。确定性规则才是权威，模型评估**只能收紧裁决，绝不能放宽裁决**。

### 当前限制

- Pi/OpenCode 默认适配器仍是 Stage A log-only；Pi `managed.enabled` 是显式 opt-in 的 Harness 门，OpenCode 的显式 managed 路径读取同一投影，普通适配器仍 log-only。
- `managed` 只覆盖归一化 `read/write/edit/ls/find/grep`；Shell、PowerShell、自定义工具、MCP、子进程、绕过路径以及获准 Shell 内部副作用不在保证内。
- **OS 隔离（独立 UID、挂载域、bwrap/cgroup、内核沙箱、全副作用中介、防篡改审计）本轮不做，不是阻塞项**，不得宣称已具备。
- 来源认证未实现；快照 verify 是结构/身份一致性检查，不是签名；控制台令牌与 runtime 报告都是同 UID 本地观察。
- reviewer 是 Jev，通过本地 Jev 配置文件提供；校准集不是安全认证。本轮未运行 hosted Jev 或本地 llama live probe，需要人工提供凭据与本机端点。*（历史，2026-11-05：reviewer 是独立服务后的本地模型，已于 2026-11-07 被 Jev 取代。）*
- 完整 rollout、临时收紧持久化、远端 CI 接纳门、跨机器生效回执未实现。
- SQLite owner-only 文件、同进程 HMAC、JSONL 和 digest 都不是防篡改或来源认证边界。
- `strict/`、`autonomy/` 是 dev 线保留的本地实验库，不是本 MVP 受管路径。

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
- [产品范围](docs/product-design.md) · [项目激活与双投影](docs/project-activation.md) · [实现状态](docs/product-gap-plan.md)
- [安全模型与当前状态](docs/security-model.md) · [运行期状态](docs/go-no-go.md)
- [Supervisor 核心说明](docs/supervisor-core.md) · [工程工作流硬门与动态注入](docs/workflow-gate.md) · [Jev 语义接入说明](docs/jev-integration.md)
- [产品与工程决策记录](docs/decisions.md) · [测试覆盖说明](docs/fixture-coverage.md)
- [交付状态](docs/delivery-status.md) · [AC-01–22 验收矩阵](docs/acceptance-one-shot.md) · [One-shot 验证记录](docs/verification-one-shot.md) · [配置迁移与受管启动](docs/configuration-one-shot.md)
- 安全与架构 ADR：[统一规则目录](docs/adr-unified-rule-catalog.md) · [来源认证](docs/adr-source-authentication.md) · [受管宿主](docs/adr-managed-file-host.md) · [review 协议](docs/adr-review-protocol.md) · [治理库](docs/adr-governance-store.md) · [CheckBinding](docs/adr-check-binding.md) · [临时收紧](docs/adr-temporary-tightening.md)
- [OpenCode V2 接入笔记](spike/README.md) · [Pi 适配器说明](docs/pi-adapter.md)

---

<p align="center">
  <sub>一个策略引擎真正的价值，不只在于它会给出什么裁决，更在于它的信任边界、覆盖死角和审计链同样坦诚透明。</sub>
</p>
