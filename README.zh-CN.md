<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Agent 行为授权与监督系统
</p>

<p align="center">
  别再把安全边界写成提示词里的“美好愿望”。<br>
  Amos 在 Agent 动作真正执行前，用确定性规则做硬拦截。
</p>

<p align="center">
  <code>阶段 A</code> · log-only · OpenCode V2 + Pi
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

## 为什么做这件事？

今天，我们对 Agent 的约束大多还写在 `AGENTS.md` 或系统提示词里。用自然语言定规矩很方便，但指望靠几句话拦住高危操作，本质上是在赌运气：

1. **全凭自觉**：模型听不听话是概率问题，不是工程保证；
2. **注意力稀释**：规矩越多，越容易被当成耳旁风（Lost-in-the-Middle）；
3. **上下文裁剪**：对话长了总得删内容，哪条安全规则被悄悄裁掉了谁也不知道。

**Amos 的思路很简单：模型只管提议（Propose），系统负责裁决（Dispose）。**

在动作产生副作用之前，先过一遍确定性的策略引擎。硬边界交给引擎死守，软性的编码偏好才放进上下文里。

---

## 它是怎么工作的？

```text
模型提议动作 (Action)
       │
       ▼
拦截器：归一化为标准结构 (tool, operation, target)
       │
       ▼
策略引擎：匹配确定性条件 (predicate) → 合并裁决
       │
       ├─ deny    → 直接拦截，记入审计日志
       ├─ confirm → 弹出结构化摘要，等人类点头
       ├─ log     → 先放行，记录“如果动真格会怎样”
       └─ allow   → 正常放行
```

### 4 个核心设计原则

- **结构化拦截，免疫提示词注入**：拦截器只检查工具名、操作和目标路径，不看自由文本。只要引擎说 `deny`（优先级：`deny > confirm > log > allow`，异常默认拒绝），模型怎么解释都没用。
- **硬约束与软约束分离**：写得出确定性命中条件（`predicate`）的由引擎强制执行；写不出的标为 `advisory_only`，生成到 `AGENTS.md` 里给模型当参考。
- **规则从真实证据长出来**：每条规则都必须绑定威胁场景或事故来源（`source`）以及测试探针（`probe`），不靠拍脑袋写规则。
- **Agent 只能交提案，不能直接改表**：收紧规则可自动生效（强制带过期时间 TTL）；放宽或删除规则必须由人审批；核心底线（0 层规则）物理锁定，碰都别碰。

---

## 当前进展（阶段 A：Log-only）

安全系统最忌讳一上来就乱拦一气，把用户逼得直接关掉开关。因此 Amos 分四步走：

- [x] **阶段 A（当前）**：旁路观察（`log-only`），在真实任务流里跑日志、抓误报。
- [ ] **阶段 B**：开启 0 层核心底线拦截（`deny`）与高危动作人工确认（`confirm`）。
- [ ] **阶段 C**：上线规则提案审批流、Git 审计溯源与 TTL 自动过期。
- [ ] **阶段 D**：构建 SQLite 派生读模型与本地 Web 治理台。

**目前已经就绪的部分**：
- **核心引擎**：TypeScript 纯函数引擎，冻结了 7 个基础匹配操作符，沉淀了首批 15 条规则，142 个测试全绿。
- **适配器**：提供 **OpenCode V2** 与 **Pi** 两个 `log-only` 适配器（覆盖文件读写/搜索等核心通道，不读取文件内容，不阻断正常调用）。
- **人审工作表**：支持从原始 JSONL 审计日志中分层抽样，一键生成待审队列。

*(G0 阶段门禁定于 2026-10-30 由人工核验，详见 [docs/go-no-go.md](docs/go-no-go.md)。)*

---

## 快速上手

需要 Node.js 26 与 npm：

```bash
npm ci
npm run build
npm test
```

### 1. 在 OpenCode V2 中体验（旁路模式）

项目根目录的 `opencode.jsonc` 已配置好插件。执行 `npm run build` 后，直接在当前目录启动 OpenCode V2 即可。插件只默默记录“假设拦截会怎样”，日志输出在 `spike/logs/opencode.jsonl`。

*(Pi 适配器位于 `adapters/pi/`，详见 [Pi 接入说明](docs/pi-adapter.md)。)*

### 2. 生成人工审核表

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

---

## 目录与深入阅读

```text
constraints/   规则表 (rules.yaml)、JSON Schema 与操作符词表
engine/        纯函数策略引擎与单元测试
fixtures/      跨语言裁决测试用例集
adapters/      OpenCode V2 与 Pi 的 log-only 适配器
storage/       内存快照、JSONL 日志与审核表生成工具
spike/         接入调研、真实会话日志样本与人审记录
docs/          架构决策与门禁文档
```

如果你想了解背后的架构取舍（如受 Karpathy `llm-wiki`、会话检索层 `obelisk` 以及防火墙 `iptables` 启发的设计细节），欢迎翻阅文档：

- [产品与工程决策记录](docs/decisions.md)
- [G0 门禁核验标准](docs/go-no-go.md)
- [测试覆盖说明](docs/fixture-coverage.md) · [Advisory 规则翻译缺口](docs/translation-notes.md)
- [OpenCode V2 接入笔记](spike/README.md) · [Pi 适配器说明](docs/pi-adapter.md)
- [完整架构设计文档（Notion）](https://app.notion.com/p/eb784af41d4f834f8cb881cb913f7601)

---

<p align="center">
  <sub>约束不该是写在提示词里的愿望，而应是动作落地前那道确定性的安全闸门。</sub>
</p>
