# Amos 交付状态（one-shot）

基线：`feat/constraint-runtime`，`7236c77`（文档取证基线；HEAD 未前进）。
本任务开发分支：`feat/amos-one-shot-delivery`，工作树
`.slim/worktrees/amos-one-shot`。原始脏工作树（README 修改与三份未跟踪文档）
未被覆盖、未被提交。

状态明确分三列，不能互相替代：

- **实现**：`已保留`、`已实现`、`部分`、`候选`、`不做`。
- **证据**：`passed`（离线/本地测试）、`blocked`（缺真实外部条件）、
  `inconclusive`、`not_run`。skip/blocked 从不算通过。
- **审查/启用**：`pending-human-review`、`未启用`、`仅离线`、
  `历史保留`。安全敏感实现即使本地测试通过也不等于已认证或可部署。

> 当前运行期安全状态仍是 **NO-GO**（Stage A log-only）。本交付不改变
> `docs/go-no-go.md`，不启用安全 deny/confirm，不改根 `opencode.jsonc` 的
> `workflowGate.enabled=false`。AC 通过也不等于阶段门通过。

## 1. 需求 ID → 实现 → 缺口 → AC → 依赖

### 1.1 产品、权限与范围（PROD）

| ID | 当前实现 | 缺口 | AC | 切片/依赖 | 实现 | 证据 | 审查/启用 |
|---|---|---|---|---|---|---|---|
| PROD-01 | 三块产品边界文档与源码分层保留 | 受管宿主/审查/治理尚未成为默认运行能力 | AC-20/22 | P0–P7 | 已保留 | passed（文档/测试） | 未启用 |
| PROD-02 | `host/`、`review/`、`rollout/` 提供自动裁决原语 | 真实流量验证、默认入口接线未启用 | AC-22 | P2/P4 | 部分 | passed（离线）；真实流量 blocked | pending-human-review / 未启用 |
| PROD-03 | reviewer/host 失败、超时、低置信、缺证据均停止 | 真实 provider 校准与故障注入受限 | AC-08/22 | P2B | 已实现（协议） | passed（本地 stub）；live blocked | pending-human-review / 未启用 |
| PROD-04 | 单机、单信任根先行；无团队/云实现 | 无 | AC-20 | 全程 | 已保留 | passed | — |
| PROD-05 | Pi/OpenCode 适配器生命周期与能力边界保留 | 受管模式未接入两宿主 | AC-20 | P1/P2 | 部分 | passed（现有回归） | 未启用 |
| PROD-06 | Codex 仍为候选，无第三适配器 | 锁版本 hooks/API 未核验 | AC-20 | 后续 | 候选 | not_run | 不做本轮 |
| PROD-07 | 治理 API 分列 published/received/effective；宿主回执契约 | GUI 未交付；无真实宿主回执 | AC-12/20 | P3 | 部分 | passed（API 测试）；UI blocked | 未启用 |
| PROD-08 | Stage A log-only 与可选工程门保持分离；根 gate=false | 无 | AC-20 | P0 | 已保留 | passed（基线） | 未启用变更 |

### 1.2 规则、项目激活与编译（RULE）

| ID | 当前实现 | 缺口 | AC | 切片/依赖 | 实现 | 证据 | 审查/启用 |
|---|---|---|---|---|---|---|---|
| RULE-01 | `constraints/vocabulary.md` 多维字段与严格 Schema 保留 | 维度/0 层分类判据仍需治理成文 | AC-02 | P0/P1 | 已保留（部分文档缺口） | passed（引擎测试） | 历史保留 |
| RULE-02 | 七算子、三字段 action、严格 Schema 不变 | 无 | AC-01 | P0 | 已保留 | passed | — |
| RULE-03 | `deny > confirm > log > allow`、同层 deny、fail-closed | 无 | AC-01 | P0 | 已保留 | passed | — |
| RULE-04 | 纯引擎/注入时钟；`${SESSION_WORKSPACE}` 仅 glob；digest 绑定 workspace | 词法身份不是真实 FS 身份（由 host 单独处理） | AC-01 | P0/P2A | 已保留 | passed | — |
| RULE-05 | 0 层拒绝不可排除；`deny` 不进入 review | 运行期强制仍 NO-GO | AC-02/07 | P1/P2 | 已保留 + host 测试 | passed（离线） | 未启用 |
| RULE-06 | L/A/I 分离；catalog v2 以 ID+version 激活；managed 消费 execution，Pi/OpenCode 可选消费 advisory | 适配器默认仍读旧 YAML/seed；来源未认证 | AC-02/03 | P1 | 部分（消费者已接） | passed（runtime + 115 adapter 回归） | 仅离线 |
| RULE-07 | 检测只产建议；删除清单不减少激活 | 项目检测发布闭环未接 | AC-02 | P1/P3 | 部分 | passed（离线） | 仅离线 |
| RULE-08 | 同一 snapshot 编译 runtime/ci/server 与 advisory；managed/适配器消费 | 适配器默认未切 execution（安全层仍 log-only） | AC-03 | P1 | 已实现（绑定+消费） | passed | 仅离线 |
| RULE-09 | 硬规则 narrative 与执行同源；未激活不评估/不注入；invalid activation advisory 不回退 seed | 无 | AC-03 | P1 | 已实现 | passed | 仅离线 |
| RULE-10 | shadow/实拦分轴；空投影显式 `empty` | rollout 未接运行期 | AC-03/16 | P1/P4 | 已实现（离线） | passed | 未启用 |
| RULE-11 | 编译确定、深冻结、verify 重编译；伪造/混投影拒绝 | verify 不是来源认证（见 ADR O5） | AC-03 | P1 | 已实现 | passed | pending-human-review |
| RULE-12 | 同项目 last-good；失败不续 TTL；时钟倒退停止 | 持久 last-good 未接治理发布 | AC-04 | P1/P3 | 已保留 | passed（现有测试） | 仅离线 |
| RULE-13 | YAML + guidance 全量迁移映射 | 运行期未迁 SQLite | AC-03/09 | P1/P3 | 部分 | passed（offline/governance store） | 未启用 |
| RULE-14 | 普通编辑/放宽只影响后续会话；钉版 | 受管宿主默认未接 | AC-04 | P2/P6 | 部分 | passed（协议） | 未启用 |
| RULE-15 | 规则表与分类判据需成文 | 0 层进层判据仍缺独立治理文档 | AC-02 | P1/治理 | 部分 | inconclusive | 人治理 |

### 1.3 宿主、一次审批与受限执行（HOST）

| ID | 当前实现 | 缺口 | AC | 切片/依赖 | 实现 | 证据 | 审查/启用 |
|---|---|---|---|---|---|---|---|
| HOST-01 | `host/` 真实文件执行、workspace 边界、受保护路径、审计前置 | 无 OS 身份/挂载域隔离 | AC-05/19 | P2A | 已实现（受限切片） | passed（真实 FS）；隔离 blocked | pending-human-review / 未启用 |
| HOST-02 | 宿主闭集工具；无 Shell/MCP/子进程入口；未知工具无执行器 | Pi/OpenCode 受管入口未接 | AC-05/06 | P2A | 部分 | passed（host 测试）；adapter 未接 | 未启用 |
| HOST-03 | 宿主构造 action/identity；不信 Agent 的 approved/version | 无 | AC-05 | P2A | 已实现 | passed | pending-human-review |
| HOST-04 | 已知无命中可执行；deny 停止；confirm 先停；log-only recorder 语义不变 | 受管入口默认关闭 | AC-05 | P2A | 已实现 | passed（host 测试 + 原 recorder 回归） | 未启用 |
| HOST-05 | one-shot grant 绑定 action/session/epoch/nonce/TTL/ceiling；只消费一次；重启拒绝；`managed/` 端到端消费 | 无持久化账本（HMAC 换键即失效） | AC-07 | P2B | 已实现（协议+离线端到端） | passed（9 项 managed 测试） | pending-human-review |
| HOST-06 | 独立 reviewer、最小有界投影、不扩大权限；`managed/` 只在 confirm 后调用 | 无真实 provider/校准 | AC-08 | P2B | 已实现（协议+离线端到端） | passed（loopback stub）；live blocked | pending-human-review |
| HOST-07 | pending/approved/denied/failed/timed_out/expired/cancelled/consumed 状态；拒绝/低置信/无校准均停止 | 人重试精确动作的 UI/编排未接 | AC-07 | P2B | 部分 | passed（状态机 + managed 拒绝路径） | 未启用 |
| HOST-08 | 不允许任意沙箱外 Shell；host 无网络/子进程 | 网络/外部文件例外未实现 | AC-05/08 | P2 | 部分 | passed（闭集） | 未启用 |
| HOST-09 | 真实 FS 词汇路径/符号链接/硬链接检查；同 UID 仍不是隔离 | 无独立 OS 身份/挂载域/cgroup/bwrap 证据 | AC-05/06 | P2A | 部分 | passed（本地 FS）；隔离 blocked | pending-human-review |
| HOST-10 | B 的 strict 闭集原型未移植 | 本轮不声称 strict 能力 | AC-20 | 复用材料 | 候选 | not_run | 不做本轮 |
| HOST-11 | B 的能力委托/预算/撤销原型未移植 | 协议边界未验证 | AC-07 | P2 | 候选 | not_run | 不做本轮 |
| HOST-12 | 外层 ALLOW/DENY/AUTO_REVIEW/DEFER 未成为新 verdict | 无 | AC-07 | P2 | 已保留（不引入） | passed（设计） | — |

### 1.4 GUI、治理、SQLite 与迁移（GOV）

| ID | 当前实现 | 缺口 | AC | 切片/依赖 | 实现 | 证据 | 审查/启用 |
|---|---|---|---|---|---|---|---|
| GOV-01 | `governance/` SQLite 单主（node:sqlite）；Git/YAML 仅导入 | 运行期接管/旧文件失效未部署 | AC-09 | P3 | 部分（store/API 已实现） | passed（39 项本地测试） | 未启用 |
| GOV-02 | 规则/项目/激活/非秘密设置导入映射；全量预览 | 全配置字段的逐项生产切换证据 | AC-09 | P3 | 部分 | passed（store/import 测试） | 未启用 |
| GOV-03 | 秘密仅存 `{env:NAME}` 引用；测试扫描无字面秘密 | 无真实秘密后端 | AC-09 | P3 | 已实现（引用约束） | passed | pending-human-review |
| GOV-04 | 认证 loopback API；人/Agent 能力分离；无任意 SQL；项目注册 | Vue UI 未接 | AC-10/12 | P3 | 已实现（API） | passed（HTTP 测试） | 未启用 |
| GOV-05 | 不可变提案、baseVersion CAS、绑定 digest、原子审发 | 多人四眼不是本轮范围 | AC-10 | P3 | 已实现 | passed | pending-human-review |
| GOV-06 | 发布事务编译 H catalog v2 并写 audit；宿主接收另记 | 无真实宿主接收回执 | AC-10/20 | P3 | 已实现（发布）/契约（回执） | passed（本地）；receipt blocked | 未启用 |
| GOV-07 | 回滚生成新版本；GET 不写；单人自批不称四眼 | UI 回滚流程未接 | AC-10 | P3 | 已实现（store/API） | passed | 未启用 |
| GOV-08 | 全量导入预览、重复/未知/秘密/未知字段拒绝 | 旧 YAML 失效切换需部署证据 | AC-09 | P3 | 已实现（预览/提案） | passed | 未启用 |
| GOV-09 | 损坏/未知 Schema/错误权限不自动重置；WAL 备份恢复 | 真实备份目标/权限未部署 | AC-11 | P3 | 已实现 | passed（本地） | pending-human-review |
| GOV-10 | loopback、Host/Origin/CSRF、CSP、角色分离、稳定错误 | 无 HTTPS/远程访问（未授权） | AC-11 | P3 | 已实现 | passed（HTTP 测试） | 未启用 |
| GOV-11 | API 状态区分 published/received/effective；无 mock | 真实浏览器治理台未交付 | AC-12 | P3 | 部分（API 完成，无 UI） | passed（API）；UI blocked | 未完成 |
| GOV-12 | 未引入 B 的营收/计费 SaaS 模板 | 无 | AC-12 | P3 | 不做 | — | — |
| GOV-13 | 旧 archive v1/JSONL v2 未改写；治理版本独立 | 新格式与 legacy 的迁移说明需人审 | AC-21 | P3 | 已保留 | passed（回归） | pending-human-review |

### 1.5 动态注入、工程护栏与语义传感器（INJ/ENG）

| ID | 当前实现 | 缺口 | AC | 切片/依赖 | 实现 | 证据 | 审查/启用 |
|---|---|---|---|---|---|---|---|
| INJ-01 | 现有 guidance seed 注入保留；activation runtime 提供同源 advisory；Pi/OpenCode 显式 `activation` 配置时可切到 activation advisory | 默认仍 seed；配置的快照无来源认证 | AC-13 | P1 | 部分（可选接线） | passed（runtime + adapter 测试） | 仅离线 |
| INJ-02 | level-first、去重、预算、遗漏报告 | 无 | AC-13 | P1/P2 | 已保留 | passed | — |
| INJ-03 | 宿主接受才 commit；注入失败不改裁决 | 持久接受回执未接 | AC-13 | 全程 | 部分 | passed（现有测试） | 未启用 |
| INJ-04 | 注入携带 activation/epoch/advisory digest | 重启重建持久化未实现 | AC-13 | P2/P3 | 部分 | passed（离线） | 未启用 |
| INJ-05 | TTL 到期不新注入；支持时替换受管块 | 历史上下文擦除不可保证 | AC-15 | P6 | 已实现（TTL 过滤） | passed | 未启用 |
| ENG-01 | 封闭 Shell 子集、未知语法 confirm/deny | 无 | AC-14 | 全程 | 已保留 | passed | — |
| ENG-02 | 固定 typecheck/test、argv/shell:false、超时/输出上限、diff 过滤 | 无 | AC-14 | 全程 | 已保留 | passed | — |
| ENG-03 | Pi 每 session 一次修复；OpenCode advisory 完成反馈 | 未来接纳门未接 | AC-14 | P7 | 已保留 | passed | — |
| ENG-04 | `UserLiteralGrant` 仅用户逐字通道；deny 保留 | 无 | AC-14 | 回归 | 已保留 | passed | — |
| ENG-05 | Jev sensor 仅收紧 | 无 | AC-08 | 回归 | 已保留 | passed | — |
| ENG-06 | RequirementFrame harness 捕获；delegated 不放宽 | 无 | AC-08 | 回归 | 已保留 | passed | — |
| ENG-07 | requirement 出境显式 allowed；无自动 provider fallback | reviewer 真实 provider 校准未做 | AC-08/17 | P2B | 已保留 + review 协议 | passed（协议）；live blocked | 未启用 |
| ENG-08 | Pi 无 UI 时 confirm 停止；非交互不是批准 | 受管 review 通道未接入 Pi/OpenCode | AC-08 | P2B | 部分 | passed（协议） | 未启用 |

### 1.6 临时收紧、rollout、检查、审计（LIFE/ROLL/CHECK/AUD）

| ID | 当前实现 | 缺口 | AC | 切片/依赖 | 实现 | 证据 | 审查/启用 |
|---|---|---|---|---|---|---|---|
| LIFE-01 | `activation/tighten.ts` 仅受信发布器按模板追加非 0 层规则 | 无持久化配额/发布器身份认证 | AC-15 | P6 | 已实现（进程内） | passed | pending-human-review / 未启用 |
| LIFE-02 | 新叙事/改旧规则/放宽/删除/续期拒绝或留待治理 | 无 UI 治理流 | AC-15 | P6 | 已实现（拒绝路径） | passed | 未启用 |
| LIFE-03 | 新增/到期双投影 epoch；TTL 从可信发布起算；不因重试续期；时钟倒退停止 | 重启恢复未实现 | AC-15 | P6 | 部分 | passed（进程内） | 未启用 |
| ROLL-01 | `rollout/` 阶段轴独立于激活/注入 | 运行期发布未接 | AC-16 | P4 | 已实现（纯决策） | passed | 未启用 |
| ROLL-02 | 版本/宿主/检查/环境绑定阈值；证据不足 hold | 无真实流量证据 | AC-16 | P4 | 已实现 | passed（合成测试）；真实 blocked | 未启用 |
| ROLL-03 | ProbeRun 结构化记录、期望/实际副作用、覆盖、脱敏 digest | 无真实 driver/probe 执行 | AC-16 | P4 | 部分 | passed（schema）；real blocked | 未启用 |
| ROLL-04 | 正反例/拒绝/超时/重放/审计/错 snapshot 反例测试 | OS 级对抗证据不足 | AC-16/17 | P2–P7 | 部分 | passed（本地反例）；OS blocked | 未启用 |
| ROLL-05 | live probe 明确 opt-in；synthetic/skip 不计 | 无凭据/费用授权 | AC-17 | P2B/P4 | 已保留（约束） | blocked | 未启用 |
| ROLL-06 | 生产分阶段启用文档与资格判据 | 未观察真实流量，未启用 | AC-16/22 | P4/启用门 | 部分 | blocked | 未启用 |
| CHECK-01 | `check/typescript-runner.ts` 固定 argv/shell:false/真实 tsc | 只有 TS 一个检查点 | AC-18 | P7 | 已实现 | passed（真实 tsc） | pending-human-review |
| CHECK-02 | CheckBinding/FindingBatch 绑定 rule/check/analyzer/tree/checkpoint/覆盖 | 无受管提交/CI 接纳点 | AC-18 | P7 | 已实现（库） | passed | 未启用 |
| CHECK-03 | 独立格式/版本；不改七算子/旧 advisory | ADR 需人审 | AC-18 | P7 | 已实现 | passed（兼容测试） | pending-human-review |
| CHECK-04 | 跳 hook/旧 tree/漏分析器不能通过（库级校验） | 无真实 pre-commit/CI 门 | AC-18 | P7 | 部分 | passed（库）；集成 blocked | 未启用 |
| CHECK-05 | 先一个 TS 检查；未做 Python/Rust | 无 | AC-18 | P7 | 已实现（TS） | passed | 未启用 |
| AUD-01 | 不记录内容/命令/URL 秘密/要求原文/敌意 payload | 无 | AC-19 | 全程 | 已保留 + host journal | passed | — |
| AUD-02 | host 授权日志先于副作用并 fsync；结果另记；崩溃 unknown 不重放 | 审计端仍在同 UID 写域；无独立受信服务 | AC-19 | P2A | 部分 | passed（本地）；隔离 blocked | pending-human-review |
| AUD-03 | 记录项目/session/activation/epoch/动作绑定 | 跨配置/审计库非天然事务 | AC-19 | P2–P6 | 部分 | passed（模块级） | 未启用 |
| AUD-04 | 明确 JSONL/0600/SQLite/digest 不是防篡改；无外部锚定 | 外部锚定未实现 | AC-19 | 全程 | 已保留 | passed（声明） | — |
| AUD-05 | 原始 JSONL 不回写；审核表不覆盖 | 0 层全审等历史流程不变 | AC-21 | 保留 | 已保留 | passed（现有） | 历史保留 |
| AUD-06 | 阶段 A 四项待裁决未被重判 | 需人裁决 | — | 人治理 | 历史保留 | not_run | 人治理 |
| AUD-07 | 历史 G0 条件与 NO-GO 保留 | 本任务不解除 | — | 阶段门 | 已保留 | — | 人治理 |

## 2. 三个断点的处理

1. **catalog v2 ≠ unified activation v1 / legacy project-activation v1**：
   不合并另一套编译器。新增 `activation/runtime.ts` 对现有
   `amos-unified-rule-catalog` v2 做结构验证、身份绑定和 runtime/execution
   视图；没有第四套快照格式。legacy v1 仍不进入本分支运行期。
2. **governance-snapshot v1 与运行期**：治理层在发布事务内调用现有
   catalog v2 编译器，产出 v2 activation snapshot；没有把 B 的
   `amos-governance-snapshot` 强转/改名成 v2，也没有长期双权威。
3. **B 的 `workflowGate.enabled=true`**：未带入。根 `opencode.jsonc` 仍为
   `false`；`.pi/amos.json` 的本地设置未被本任务改动。未整条合入 B 的
   AGENTS/injector/package。

## 3. 明确未集成/未做（本轮）

- Pi/OpenCode 没有默认切到受管 host/reviewer；仍是 Stage A log-only。
- 无真实 OS 身份隔离、bwrap/cgroup、live provider 校准、真实 probe、
  宿主接收回执或生产 rollout。
- P3 没有移植 B 的 Vue 治理台；AC-12 的浏览器流程未交付。
- P7 没有真实 pre-commit/CI 受管接纳点；只有库级合同和真实 TS runner。
- B 的 strict/autonomy/managed 原型未整条移植；只借鉴其边界概念。
- 未启用任何安全 deny/confirm；未改 NO-GO；未 push/merge/tag/deploy。

## 3.0 其他分支原型的处置（来源提交 `29c748a`）

本轮**没有整条合入** B；以下只记录审阅结论与来源，B 的测试存在/skip 不
作为本分支证据。

| B 来源 | 本分支处置 | 原因 |
|---|---|---|
| `control-plane/*` | 未复制；借鉴 loopback auth/Host/Origin/CSRF/角色分离与 CAS 概念 | B 发布 `amos-governance-snapshot` v1，不能强转/改名成 H catalog v2；已用 H store/API 原生实现 |
| `managed/*` | 未合入；借鉴“先宿主后 review、最小投影、grant 单次消费”概念 | B 接受 legacy/unified activation v1；H 用 catalog v2 + 自己的 host/review 合同 |
| `autonomy/*` | 未合入 | 单文件原型不覆盖 H 的审计前置/能力闭集/崩溃恢复要求 |
| `strict/*` | 未合入 | 内存虚拟文件宿主不是 OS 边界；本轮不声称 strict |
| `web/*`（Vue 控制台） | 未移植 | AC-12 浏览器流程仍 blocked；只交付 API 与本地测试 |
| B 的 `opencode.jsonc`/AGENTS/package | 未采用 | 不带入 `workflowGate.enabled=true`，不全量覆盖 H 配置 |

## 3.1 受管文件端到端（离线）

`managed/flow.ts` 把现有模块接成一条可测试链路：

1. `activation/runtime.ts` 验证 catalog v2 snapshot 并绑定 project/workspace/
   epoch/execution digest。
2. `host/` 用自己的闭集与真实路径检查执行；无 grant 时 confirm 先停。
3. `managed/authorize` 只对 `confirm` 生成最小投影，调用独立 reviewer；
   `deny`/`allow`/`log` 不进入 review。
4. reviewer approved 后签发 HMAC one-shot grant，绑定精确 request digest、
   session、project、epoch、snapshot、capability、TTL、ceiling、nonce。
5. host 在 path/capability/precondition 检查后调用 `consume`；只消费一次，
   授权日志 fsync 后才执行；结果另记。
6. 第二次执行、换 target、错 epoch/snapshot/凭据、拒绝/低置信/无校准、
   审计路径在工作区内均无副作用。

证据：`node --test dist/managed/*.test.js` → 9 pass / 0 fail。它不证明真实
provider、真实 OS 隔离或生产启用；这些仍是 blocked。

## 3.2 P1 消费者接线（advisory）

- `managed/` 使用 activation runtime 的 runtime execution 投影做受管裁决。
- Pi/OpenCode 增加显式可选字段 `activation: { snapshotPath, projectId }`：
  配置存在时读取并验证 catalog v2 snapshot，使用
  `createProjectInjectorSession`；snapshot 的 project/workspace 必须匹配
  当前 session 目录。配置存在但无效时使用**空 advisory session**，不回退
  global seed；未配置时保持现有 seed 行为。
- 该接线只影响 advisory 注入，不改变工具裁决、审计或 log-only 状态。
- 配置的 snapshot 路径不是来源认证；来源认证仍按 O5 pending。默认配置
  未启用该字段，`opencode.jsonc`/`.pi/amos.json` 的 gate 开关未改。

## 3.3 治理库与 API（离线/部分）

`governance/` 已实现：SQLite schema v1（WAL、FULL、owner-only、非符号链接、
未知/损坏版本不重置）、全量导入预览与候选、不可变提案/baseVersion CAS、
human-only 审批与发布、发布事务内编译 catalog v2 + verify + audit + 指针
推进、独立 receipt、回滚新版本、WAL 备份/恢复、loopback 认证 API
（Host/Origin/CSRF/CSP/角色/请求体上限/项目注册/回滚）。

未完成：Vue 治理台/浏览器流程（AC-12）、真实宿主接收与生效回执、全配置
运行期切换部署证据、来源认证/O5。API 测试不能替代浏览器或部署证据。

证据：`node --test dist/governance/*.test.js` → 39 pass / 0 fail / 0 skip；
使用真实临时 SQLite 文件与 loopback HTTP。

## 4. 验证记录

见 `docs/verification-one-shot.md`（命令、环境、结果、blocked 项）。
已复核通道（整合前，各 lane 工作树）：

- CHECK：`npm run typecheck`、`npm run build`、`node --test
  dist/check/*.test.js` → 23 pass / 0 fail / 0 skip；已合入交付分支。
- ROLLOUT：`npm run typecheck`、`npm run build`、`node --test
  dist/rollout/*.test.js` → 28 pass / 0 fail / 0 skip；已合入。
- ACTIVATION：`npm run typecheck`、`npm run build`、`node --test
  dist/activation/*.test.js` → 46 pass / 0 fail / 0 skip；已合入。
- HOST：`npm run typecheck`、`npm run build`、`node --test
  dist/host/*.test.js` → 17 pass / 0 fail / 0 skip（真实临时文件系统）；已合入。
- REVIEW：`npm run typecheck`、`npm run build`、`node --test
  dist/review/*.test.js` → 42 pass / 0 fail / 0 skip（loopback stub，无真实
  provider）；已合入。
- MANAGED：`node --test dist/managed/*.test.js` → 9 pass / 0 fail（端到端
  离线）；已合入。
- GOVERNANCE：`npm run typecheck`、`npm run build`、`node --test
  dist/governance/*.test.js` → 39 pass / 0 fail / 0 skip（真实临时 SQLite +
  loopback HTTP；无真实宿主/UI）；已合入。
- 整合后全套：`npm run typecheck` 通过；`npm test` → 686 tests / 686 pass /
  0 fail / 0 skip；`git diff --check` 通过。

最终整合后本文件会更新为实际全套结果。
