<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Agent 行为授权与监督系统
</p>

<p align="center">
  把 agent 的行为约束，从提示词里的愿望，变成有证据、有审批、有过期、可评测、由 harness 强制执行的工程资产。
</p>

<p align="center">
  <code>阶段 A</code> · log-only · OpenCode V2 + Pi
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

> 约束不该只活在提示词里。它应该在动作发生前被执行。

Project-Amos 的 AMOS 取自 **A**gent **M**andate & **O**versight **S**ystem：它管的是 mandate 与 oversight，不是 intelligence。它不试图让模型更聪明，而是让模型的动作更可约束。

## 设想

今天，大量 Agent 行为约束仍以 `AGENTS.md`、系统提示和项目说明中的自然语言表达。自然语言适合向模型传递意图，但它本身不能保证约束在动作执行前得到落实。这类约束有三个结构性缺陷：

1. **全靠模型自觉**——遵守是概率，不是保证；
2. **注意力稀释**——约束越多，每条越不容易被遵守（Lost-in-the-Middle）；
3. **压缩丢失**——上下文塞不下时必须裁剪，裁哪条却没有判据。

Amos 的设想是把约束从“提醒”变成“机制”：模型只负责提议动作，harness 在动作产生副作用之前做确定性裁决。硬边界由引擎执行，软偏好才进入上下文。

### 核心主张

- **模型是 proposer，harness 是 disposer。** 每个 action 在执行前都要经过确定性策略引擎；模型不能用自己的解释覆盖裁决。
- **可强制的规则必须有确定性命中条件（`predicate`）。** 自然语言 `narrative` 面向人和 prompt，是 advisory 视图；写不出命中条件的规则标为 `advisory_only`，不硬凑。
- **约束表是唯一核心数据结构。** 引擎是它的执行语义，git 是它的历史，治理流程是它的写权限。
- **激活与注入分离。** 全局规则库 → 项目激活集 → 当前任务注入集。激活决定规则是否适用于项目，注入决定模型此刻看到哪些提醒，是否硬执行不取决于是否被注入。
- **规则从证据编译。** 每条规则强制引用威胁模型、事故报告或 probe 结果；证据消失时，规则应进入待复审，而不是悄悄活在表里。
- **agent 可以提议改表，但不能直接写表。** 改表本身是一类受管 action；0 层（硬不变量）物理拒绝。
- **硬约束不靠注意力。** 不做微调、不做注意力手术，也不把安全交给“更醒目的 prompt”。

### 硬约束与软约束

| | 硬约束 | 软约束 |
| --- | --- | --- |
| 载体 | `predicate` + `on_hit` | `narrative` |
| 执行者 | 策略引擎 | prompt 上下文 |
| 生效时机 | 动作产生副作用之前 | 模型阅读上下文时 |
| 失败形态 | fail-closed：默认拒绝 | 模型可能忽略 |
| 治理 | 0 层不可触碰；改动走提案 | 可随项目与任务路由 |

### 与 AGENTS.md 的关系

不是取代，是投影。项目知识（怎么 build、怎么 test）仍归 `AGENTS.md` 本体；约束表里的 `narrative` 按维度渲染，自动生成或更新 `AGENTS.md` 的约束章节。把硬约束只写在 `AGENTS.md` 里，执行就只能靠模型自觉或外部检查，那是语义错位。

## 工作方式

下面是系统的目标工作方式。阶段 A 只落地了其中的观察部分：引擎照常裁决，但所有结果只写日志，不阻断真实工具调用。

### 一次 action 的路径

```text
模型提议 action
      │
      ▼
拦截器：归一化为 (tool, operation, target)
      │
      ▼
策略引擎：读取项目激活快照 → 匹配 predicate → 合并裁决
      │
      ├─ deny    → 阻断副作用，记录
      ├─ confirm → 展示结构化摘要，等待人
      ├─ log     → 放行，记录“如果强制会怎样”
      └─ allow   → 放行
      │
      ▼
harness / sandbox 执行 → 追加 JSONL 审计日志
```

拦截器只消费结构化信封，不读取自由文本。路由和裁决因此不直接暴露给 prompt injection：攻击者要操纵路由，得先改工具名，而工具名由 harness 解析器控制。

### 规则如何表达

每条规则至少有三块：

- `predicate`：给引擎的确定性命中条件；
- `on_hit`：`deny` / `confirm` / `log`；
- `narrative`：给人读、给模型念的说明。

机器字段名保留 `predicate`；中文口径统一为「命中条件」。

G0 冻结了 7 个命中条件操作符：`op_in`、`target_glob`、`target_outside_glob`、`url_query_key_in`、`target_scheme_in`、`target_host_in`、`target_host_not_in`。没有变量、脚本、嵌套布尔表达式、正则或自由文本条件；表达不了的状态就标 `advisory_only`，不用 target 猜内容。

### 三种集合，不要混用

| 集合 | 决定什么 | 谁消费 |
| --- | --- | --- |
| 全局规则库 | 有哪些候选规则 | 治理与激活 |
| 项目激活集 | 哪些规则在这个项目里有意义 | 引擎与 narrative 路由 |
| 当前任务注入集 | 此刻该提醒模型哪几条软约束 | prompt 上下文 |

引擎执行项目激活集里的全部硬规则，不管它有没有被注入；注入只减少噪音，不改变强制面。激活按规则级 tags / `exclude_rules` 生效，不能只按整个维度开关。新增激活视同收紧；停用或排除已激活规则视同放宽，需要人工确认。检测失败保留上一个有效激活快照，不自动停用。

### 裁决如何合并

- 命中多条时：`deny > confirm > log > allow`；
- 同层冲突：`deny` 获胜；
- 非法输入、未知命中条件操作符、解析失败和引擎内部异常：`deny`（fail-closed）。

### 治理：提案，不是写入

改表与普通 action 走同一套 harness：

- 新增 / 收紧 → 自动生效，TTL 强制，git 留痕；
- 放宽 / 删除 / 降级 → 结构化 diff 摘要 → 人工确认；
- 碰 0 层 → 物理拒绝 + 越权日志，试一次吊销 session 的改表权；
- TTL 到期 → 自动 revert，不提醒、不续期。

提案里的“理由”字段不参与自动审批——它可能是注入产物。confirm 和审批视图只展示结构化摘要（工具、参数、目标、命中规则），不展示模型撰写的说服性文案。

### 事实源、快照与日志

- **YAML 是规则事实源。** JSON Schema 与封闭词表在 loader 校验；规则本身可读、可 diff、可 review。
- **JSONL 是原始审计事实源。** 只追加，不重写；派生样本和审核工作表可以重建，但不能回写原始日志。
- **SQLite 只在阶段 D 作为可删除、可重建的派生读模型。** 它永远不进入裁决热路径；引擎加载的是深度冻结的内存快照。
- **快照失败保留最后正常版本。** 非法 reload 不会把系统带进半坏状态；首次加载失败按 fail-closed 记录。

### 冷启动

1. **log-only**：只记录“如果强制会怎么裁决”，跑真实任务流收集误拒；
2. **选择性强制**：只对 0 层开 deny；
3. **confirm 上线**：不可逆副作用进入人工确认；
4. **治理上线**：提案队列、TTL、git 治理。

跳步的结局通常是 deny 风暴，然后用户关掉系统。**会被关掉的安全系统，比没有更糟。**

## 目前已经做的

当前处于**阶段 A：log-only 验证**。真实 deny、confirm、提案治理、SQLite 读模型和本地 Web 治理台尚未启用。

| 部分 | 状态 | 证据 |
| --- | --- | --- |
| 规则表 | 15 条，5 个维度 | `constraints/rules.yaml` |
| 命中条件词表 | 7 个，已冻结 | `constraints/vocabulary.md` |
| 规则校验 | JSON Schema + loader 语义校验 | `constraints/schema.json` |
| 引擎 | TypeScript 纯函数，注入时钟，fail-closed | `engine/engine.ts` |
| 语言中立 fixtures | 覆盖命中条件、多命中、TTL、非法输入 | `fixtures/` |
| 快照 | 深度冻结；非法 reload 保留最后正常版本 | `storage/snapshot.ts` |
| 审计日志 | 只追加 JSONL + 错误分类 | `storage/jsonl.ts` |
| OpenCode V2 | 编译后 log-only 插件；真实会话样本 | `adapters/opencode-v2/`、`spike/` |
| Pi | log-only 扩展；真实 CLI 样本仍因 provider 未配置而缺失 | `adapters/pi/`、`docs/pi-adapter.md` |
| 人审工作表 | 分层抽样；拒绝覆盖既有结论 | `storage/audit-review.ts` |
| 测试 | 142 个用例全绿 | `npm test` |

首批 15 条规则中，10 条是 deterministic，5 条是 advisory_only；按 `on_hit` 声明值分为 11 条 deny、3 条 confirm、1 条 log（advisory_only 条目不进入硬裁决）。每条规则都有具体的 `source` 引用和诱人违反场景 `probe`；最初的约束先由威胁场景整理成候选，再逐条落成可执行的命中条件。

OpenCode 目前只挂文件类通道：`read` → `file_read`，`write` / `edit` → `file_write`，`glob` / `grep` → `file_search`，`list` → `file_list`。Pi 覆盖对应的文件工具，并把 `bash` / `user_bash` 记为 `shell_input`，不记录命令文本。目标路径解析为绝对路径，包括 `~`；引擎拒绝未折叠的 `.`、`..` 和 `//`，而不是把它们当成未命中。不读取、不记录文件内容；未知 payload 和解析失败显式记录。两个 hook 都不修改 input、不返回裁决、不阻断工具调用。`http_request` 等网络规则已在引擎和 fixtures 中，但尚未接入任一实时 hook。OpenCode 仍跳过 shell；两边的 patch 仍无法结构化。

人审工作表从原始 JSONL 派生，0 层命中全量、非 0 层 deny 全量、confirm 优先按工具和规则覆盖抽样、错误与覆盖缺口全量。当前工作表（生成时点）基于 158 条记录：0 层 1 条、非 0 层 deny 0 条、错误/缺口 35 条、confirm 65 条中抽 20 条。工作表只生成队列，不自动判断误拒或放行；输出拒绝覆盖已有人工结论的文件。

**尚未启用**：真实 deny / confirm、OpenCode 的 shell 与两边的 patch、项目激活快照与 narrative 路由、提案队列、TTL 清理、SQLite、本地 Web 治理台、探针执行与违反率/误拒率仪表盘。Pi 还没有真实 CLI 样本。

G0（go/no-go）门禁定于 **2026-10-30** 由人逐项核对，当前状态为**未裁决**；agent 不自行放行。门禁标准见 [docs/go-no-go.md](docs/go-no-go.md)。

## 灵感来源

最初的约束，来自设计 Termcp 威胁模型时的灵感：先把“什么行为会造成不可接受的后果”写成威胁场景，再从中提炼可执行的命中条件。

### llm-wiki：把约束当“编译产物”

Karpathy 的 llm-wiki 哲学是这套设计最直接的哲学参照。它的核心原则几乎逐条映射：

| llm-wiki | Project-Amos |
| --- | --- |
| 原子化 | 一条规则就是一个最小单元 |
| 数据驱动 | 规则从威胁模型、事故、probe 编译，不写直觉 |
| 显式溯源 | `source` 是强制引用，不是装饰 |
| 无损演进 | 提案即 ADD/FIX，git 保留全轨迹，TTL 是带过期标记的 ADD |
| 晋升管道 | 想法 → 实验规则（TTL + log-only）→ probe 证据 → 强制层 |

两条修正：执行点不追 living wiki，引擎加载 pin 住的项目激活快照（lockfile 语义）；规则是否晋升由 probe 决定，不由编辑共识决定。用一句话定位：**llm-wiki 存 facts，Amos 存 norms。**

### obelisk：读侧与写侧

[tommy0103/obelisk](https://github.com/tommy0103/obelisk) 是 agent 历史检索层：把多家编程 agent 的 session JSONL 归一进单库，给 agent 提供 CLI、给人提供浏览界面。它管 agent 记得什么；Amos 管 agent 不许做什么。两者是同一套架构的读写两侧。

借走的模式：

- 单库归一 + dual audience：agent 用 CLI 查，人用界面审；
- 把 N 家 provider 投影进共享 schema：OpenCode 与 Pi 各自把事件归一进同一 action 信封；这不是通用 harness 框架；
- 记忆层的“agent 提议 → 人批准 → 注册 → 日后召回”，是提案管线的现成原型；
- 读表接口分层：typed helpers 为主，raw 查询做逃生舱。

不借的边界：

- **热路径查库**：读侧可以慢、可以失败；裁决侧库损坏在 fail-closed 下等于全舰队 DoS；
- **任意 JS 查询面**：只能开在审计 / 读表侧，裁决侧永不开；
- **Electron**：人管界面做本地 Web 服务，不做桌面应用；也不在第一天做，界面渲染状态，状态先于界面存在；
- **AGPL 污染**：只读 README / docs / ADR，代码净室重写，规范与一致性套件从第一天用宽松许可证。

### Jev：只坐 advisory 席

Jev（TypeSafe AI 的 System One 决策模型）只出现在四个 advisory 位置：语义路由、提案预分类、probe 评测（Jev-as-a-Judge）、意图到命中条件模板的路由。它不进引擎、不审批、不碰 0 层。`confidence` 不是 `permission`；可解释性不足的模型永远不上裁决席。

### 其他参照

- **iptables / 防火墙语义**：narrative 路由只查结构化信封，精确 + glob 匹配，specificity 优先；查不到时 fail-open 回退到当前项目激活的全部软约束。可以把它理解成 “iptables for narratives”。
- **Lost-in-the-Middle（Liu et al., 2023）**：约束越多、位置越中间，越容易被忽略。这条实证是“动态注入”和“激活 / 注入分离”的理由，而不是把强制责任推给 prompt 的理由。
- **AGENTS.md**：约定与执行机制分离。AGENTS.md 继续做项目知识的入口，约束章节成为规则表的 advisory 派生视图。

## 快速开始

环境：Node.js 26、npm；运行适配器时另需对应的 OpenCode V2 或 Pi。

```bash
npm ci
npm run build
npm test
npm run typecheck
```

`npm test` 会先构建，再运行编译后的 JavaScript 测试。

### 以 log-only 接入 OpenCode V2

```bash
npm run build
```

项目根 `opencode.jsonc` 从 `dist/adapters/opencode-v2/` 加载插件，显式传入规则、Schema、日志路径和 `log-only` 模式。随后从这个目录启动 OpenCode V2 即可。插件只记录假设裁决，不阻断真实工具调用；实时日志写入 `spike/logs/opencode.jsonl`（git 忽略）。

Pi 适配器位于 `adapters/pi/`，同样只启用 log-only。

### 生成人审工作表

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

输出必须是尚不存在的新文件，避免覆盖人已经填写的结论。历史归档可以通过重复 `--log` 一并传入。

## 目录

```text
constraints/       规则、JSON Schema、封闭词表
engine/            纯函数引擎与测试
fixtures/          语言中立裁决 fixtures
adapters/          OpenCode V2 与 Pi 的 log-only 适配器
storage/           快照、JSONL、审核队列
spike/             接缝说明、真实日志样本、人审材料
docs/              决策、门禁与覆盖说明
```

## 文档

- [产品与工程决策](docs/decisions.md)
- [G0 go/no-go](docs/go-no-go.md)
- [Fixture 覆盖](docs/fixture-coverage.md)
- [Advisory-only 翻译缺口](docs/translation-notes.md)
- [OpenCode V2 log-only 接缝](spike/README.md)
- [Pi log-only 适配器](docs/pi-adapter.md)
- [设计文档（Notion）](https://app.notion.com/p/eb784af41d4f834f8cb881cb913f7601)
- [English README](README.md)

## 边界

当前重点是单机、单信任根的治理闭环，面向个人与封闭舰队。多端协作和团队功能（包括托管或云辅助形态）是后续方向，不属于当前交付范围。

阶段门禁：

- **阶段 A**：log-only、真实日志和误拒审核。（当前）
- **阶段 B**：选择性 0 层强制，再启用 confirm。
- **阶段 C**：提案、人工审批、git 治理与 TTL。
- **阶段 D**：SQLite 派生读模型与本地 Web 治理台。

当前交付 OpenCode V2 与 Pi 两个 log-only 适配器。不做提示词工程软约束、第三 harness、LLM 裁决、自研命中条件 DSL、正则路由或规则市场。不得为了架构观感改变 `deny > confirm > log > allow`、同层 deny 和 fail-closed 语义。

---

<p align="center">
  <sub>约束不该是写在提示词里的愿望，而应是动作发生前的一道确定性检查。</sub>
</p>
