# Amos 限定范围 MVP 交付（Harness 层）

- 交付日期：2026-11-05
- 分支：`feat/amos-mvp`
- 工作树：`.slim/worktrees/amos-mvp`
- 基线：`feat/amos-one-shot-delivery`（`b8fa1e4`）+ 选择性移植
  `feat/local-governance-console` 的 `control-plane/` 与 `web/`
- 状态：**限定范围 MVP 完成**；默认 managed 仍关闭，安全敏感实现
  `pending-human-review`，不改变 G0/NO-GO。
- 2026-11-07 更新：managed `confirm` 的语义 reviewer 迁移到 Jev
  （`review/jev-reviewer.ts`），requirement 生命周期落
  `decision/requirement-registry.ts`，旧 reviewer 配置改为停止式迁移。本轮只
  完成受管路径的 reviewer 迁移与 requirement 生命周期，没有 OS 隔离、完整中介、
  远端分支保护或同 UID 防篡改。

## 1. 本轮闭环

```text
浏览器登录 → 创建/选择项目 → 编辑/导入规则 → 校验 → 提案 → 人类批准并发布
→ 写入 .pi/activation.json（P1 快照）→ 真实 Pi 会话加载并报告版本
→ 同一快照动态注入 → tool_call 前确定性裁决
→ deny 阻断 / confirm Jev 语义 reviewer + 一次性授权后执行一次
→ tool_result 记录结果 → 控制台读取运行时加载报告与审计
→ 回滚创建新版本，后续会话加载新快照
```

### 1.1 控制台

- 复用现有 Vue 控制台：登录、项目、规则编辑、校验、提案、批准/发布、
  版本、回滚、审计、观察、模拟页面均保留。
- 单一治理存储：`control-plane/`（SQLite `node:sqlite`，WAL、
  `synchronous=FULL`、owner-only 文件）。`governance/` 实验副本未并入
  交付分支。
- 发布时用 P1 `catalog/` + `activation/compiler` 编译
  `amos-unified-rule-catalog` v2 快照；控制台不再维护第二套规则编译器。
- `POST /api/projects/:id/import` 接受版本化 YAML/JSON；与 GUI 编辑走同一
  `validateCandidate` / `createProposal` / `decideProposal` 流水线。
- 版本导出 `GET /api/projects/:id/versions/:version/export?format=yaml|json`
  输出 `format: amos-project-policy` 文档，包含 `project`、`activation`、
  `injection`、`rules` 与 `published` 元数据。
- 发布后原子写入 `<workspace>/.pi/activation.json`；数据库发布成功不等于
  宿主加载成功。
- `GET /api/projects/:id/runtime` 读取各 Harness 的 v2 回执，并在缺少专属回执时
  回退到 `.pi/runtime.json`，区分 `loaded` / `loaded-unverified` / `stale` /
  `never` / `invalid` / `unpublished`。

### 1.2 Harness（Pi）

- `.pi/amos.json` 的 `managed.enabled` 是显式 opt-in；缺省/`false` 保持
  原 Stage A log-only + 可选 workflow gate。
- 真实 Pi `tool_call` 前：
  1. 归一化工具动作；未知/覆盖缺口/缺 call id 阻断。
  2. 执行 P1 runtime enforcement 投影。
  3. `deny` / 引擎错误：写授权+stopped 结果，原件不执行。
  4. `confirm`：构造最小有界投影（tool/operation/工作区相对 target/规则
     ID/digest；requirement 原文仅在显式 `requirementEgress: "allowed"`
     和 review policy 允许时），调用 Jev 语义 reviewer
     （`review/jev-reviewer.ts`）；通过条件全部由可信代码校验（requirement
     来源与 digest、frame/投影 digest、两侧 egress、target 在工作区内且在
     `declared_scope` 前缀内、`requirementMatch: "match"`、
     `riskScore <= policy.maxRisk`、`confidence >= policy.minConfidence`、
     model/questionVersion/policyDigest 与策略绑定、校准有效、deadline 未过）。
     通过后签发并立即消费一次性 HMAC grant（绑定 action digest、snapshot、
     session、epoch、capability、`requirementVersion`、`requirementDigest`），
     执行前再读一次 requirement，版本或 digest 变化以 `requirement_changed` 停止，
     写 allow 并 fsync，再放行 Harness 执行一次；mismatch、partial/unclear、
     超阈值、超时、中止、限流、拒答、无效响应、网络错误、未校准、投影绑定
     错误、grant 重放均不执行。
  5. `tool_result` 另写 result（executed/failed），不记录内容/命令。
- 同一会话固定快照：执行 gate 与 advisory 注入使用同一个
  `ActivationRuntime`；新发布只由后续会话加载，不做运行中热切换。
- `session_start`/首次 prompt 即加载并写回执：v2 投影使用 `.pi/runtime.pi.json`，
  旧投影使用 `.pi/runtime.json`；报告包含
  projectId、activationDigest、epoch、policyVersion、加载/最近工具时间、
  受管工具能力声明。
- 注入：`before_agent_start` 写 system prompt 的
  `amos-workflow-guidance` section；读/写/搜索动作后按路径/任务追加 area
  guidance；未激活/过期条目不注入；注入失败不影响裁决。

### 1.3 规则与全局基线

- 全局 catalog 从仓库 `constraints/rules.yaml` + `guidance/packs.ts` 在
  控制面启动时构建一次；必选基线由 P1 `mandatoryRuleRefs` 固定。
- 项目可新增项目规则 ID；不能修改/重定义全局规则 ID（`global_rule_conflict`），
  不能排除必选基线（`mandatory_exclusion`）。项目无法用优先级覆盖全局
  hard deny。
- 同 ID 重复、未知字段、非法谓词、空激活、必选排除均在任何发布前拒绝。
- `level` 只影响 advisory 排序和审计优先级，不改变
  `deny > confirm > log > allow`。
- 合法空 runtime 投影显式 `empty`：Harness 不调用空表引擎，按 no-match
  allow 并仍写审计；advisory 可单独存在。

## 2. 实际验证证据

所有命令在 `/home/ganyu/projects/project-amos/.slim/worktrees/amos-mvp`
执行；`npm test` 会先删除并重建 `dist/`。

| 命令 | 实际结果 |
|---|---|
| `npm run typecheck` | exit 0（根 TS + `web` vue-tsc） |
| `npm test` | exit 0；Node 与 Web 均无失败；1 项依赖外部 UID 的环境测试保持 skip |
| `node web/e2e/smoke.mjs` | 全部浏览器检查 PASS；真实 headless Chromium、真实 CLI 服务、真实 YAML 下载/导入、回滚、CSP/控制台错误检查；证据 `/tmp/opencode/amos-governance-e2e-*/evidence.txt` |
| `npm run probe:live` | 通过；真实本地 llama.cpp 模型 `gemma-4-e4b` + 真实 Pi AgentSession + 真实扩展 + 真实文件副作用 + 真实模型 reviewer；证据 `/tmp/opencode/amos-live-probe-*/evidence.json`（历史，2026-11-05：该探针的 reviewer 是旧本地模型 reviewer 服务，2026-11-07 起由 Jev 取代，见 §2.2） |
| `git diff --check` / `git diff --cached --check` | exit 0 |

### 2.1 浏览器闭环（AC-12）

`web/e2e/smoke.mjs` 使用真实编译后的 `dist/control-plane/cli.js`、全新临时
数据目录、真实 Chromium（CDP pipe）和同源 API，不 mock `/api/*`。已覆盖：

- 登录 / 项目创建 / 仓库种子 / 新增项目规则 / 服务端校验；
- 不可变提案、人工批准并发布；
- 发布产物 `.pi/activation.json` 存在且为 catalog v2；
- 按 Harness 写入 v2 回执后控制台显示 `loaded`；回滚后旧报告显示 `stale`，
  更新报告后显示 `loaded`；身份匹配的旧协议回执显示 `loaded-unverified`；
- 版本 YAML 下载（`format: amos-project-policy`）→ 上传同一 YAML →
  服务端导入校验通过；
- 回滚创建新提案并发布版本 2；
- 矩阵/筛选/检查器/移动端/CSP/控制台错误/HTTP 4xx-5xx 检查。

浏览器运行时的 runtime report 由测试按真实文件协议写入，用于验证控制台
读取/展示；**报告的生产者**由 `dist/managed/pi-harness.test.js` 与
`dist/managed/harness-requirement.test.js` 的真实 Harness 证据覆盖；
`npm run probe:live` 是 2026-11-05 的历史证据（见 §2.2）。

### 2.2 真实模型与自动审查（历史，2026-11-05）

> 历史：以下结果由旧的独立 reviewer 服务产生，2026-11-07 起 managed `confirm`
> 的语义 reviewer 是 Jev（`review/jev-reviewer.ts`），该服务的
> `endpoint`/`model`/`apiKeyEnv` 配置已退役。本节保留为当时证据；当前证据见
> §2.3。

`npm run probe:live` 使用本机已授权的 OpenAI-compatible llama.cpp 端点
（默认 `http://127.0.0.1:8080/v1`，模型 `gemma-4-e4b`），不向外部 provider
发送请求、不产生外部费用、不打印 key。实际结果：

- 通过真实编译后的 `control-plane` CLI HTTP 服务登录、创建项目、提交提案、
  人工批准并发布 v1，写 `.pi/activation.json`；
- 独立 reviewer 服务对 8 个合成校准场景调用真实本地模型：2 safe +
  6 unsafe，**falseAllows = 0**；reviewer 另有固定 deny 面（shell/network/
  outside-workspace/凭据路径）；
- 第一个真实 Pi 会话：读取 `src/input.txt`，写 `src/confirm.txt` 触发
  confirm；reviewer 收到含 requirement 原文/绑定的投影；批准后**恰好一次**
  写入；文件内容与输入一致；
- 第二个真实 Pi 会话：写 `src/deny.txt` 触发 deny，目标文件不存在；
- 第三个真实 Pi 会话：不同任务路由选择 `live-python` 而非 `live-ts`，
  执行规则集合未缩减；
- 运行时报告 `loaded`；Pi 会话后通过控制台 HTTP
  `GET /api/projects/:id/runtime` 也读到 `loaded` 且 digest 匹配；
  system prompt 注入包含同一 activationDigest；
  managed journal 中 confirm 只有 1 条 allow、deny 记录存在。

### 2.3 当前证据：Jev reviewer 与 requirement 生命周期（2026-11-07）

- `managed/pi-harness.test.ts`：真实 Pi 会话 + 真实扩展 + 真实 write 工具 +
  loopback Jev 协议应答 + 真实文件副作用；confirm 经 Jev reviewer 批准后只写
  一次，deny 目标不存在，审计先于副作用。
- `managed/harness-requirement.test.ts`：requirement 缺失/非用户来源/版本或
  digest 变化/撤销/过期/损坏/owner 不匹配/epoch 变化各自以对应
  `requirement_*` 码停止；grant 绑定 `requirementVersion` 与
  `requirementDigest`；审计写入失败停止。
- `review/jev-reviewer.test.ts`：逐条通过条件与全部停止码（mismatch、
  partial/unclear/requiresReview、超阈值、超时、中止、限流、拒答、无效响应、
  网络错误、未校准、投影绑定错误），以及审计 `review` 块字段。
- `adapters/opencode-v2/managed.test.ts`：OpenCode managed 路径消费同一投影，
  含旧配置迁移停止（`amos_managed_reviewer_migration_required`）与 Jev 配置
  不可用阻断（`amos_managed_reviewer_unavailable`）。
- `decision/requirement-registry.test.ts`：版本递增与 digest 重算、冲突、
  撤销、TTL 过期、损坏、owner/uid 校验、目录 `0700`/文件 `0600`、原子写。

未运行：hosted Jev 与本地 llama live probe。它们需要人工提供 Jev 凭据（或
`decision/jev.local.json` 本地字面密钥）与本机端点，本轮没有这些输入，因此不
声称 live 模型证据。

## 3. 配置与启动

### 3.1 控制台

```bash
npm ci
npm run build
npm run console:init          # 初始化 SQLite 与人类/Agent 凭据（0600）
npm run console:serve         # 默认 127.0.0.1:4310
```

浏览器使用人类令牌文件（`~/.local/state/amos-governance/human.token`，或
`--data-dir` 指定目录）登录；令牌内容不打印。项目工作区必须已存在；
发布时写入 `<workspace>/.pi/activation.json`。

### 3.2 Pi managed

项目需在 `.pi/extensions/amos.js` 指向编译后的适配器：

```js
export { default } from '/abs/path/to/project-amos/dist/adapters/pi/index.js';
```

`.pi/amos.json`：

```jsonc
{
  "mode": "log-only",
  "rulesPath": "/abs/constraints/rules.yaml",
  "schemaPath": "/abs/constraints/schema.json",
  "logPath": "/abs/audit/shadow.jsonl",
  "activation": { "snapshotPath": ".pi/activation.json", "projectId": "<project-id>" },
  "managed": {
    "enabled": true,
    "auditPath": "/abs/audit/managed.jsonl",
    "requirementEgress": "denied",
    "review": {
      "reviewer": "jev",
      "jevConfigPath": "/abs/decision/jev.local.json",
      "policy": { /* ReviewerPolicy */ },
      "calibration": { /* CalibrationEvidence | null */ },
      "ceilingDigest": "sha256:<64 hex>",
      "grantTtlMs": 20000
    }
  }
}
```

- `requirementEgress` 缺省 `denied`；只有显式 `allowed` 才把用户要求原文
  放进 review projection。
- `review.reviewer` 只有 `jev`；`jevConfigPath` 必须是绝对路径，凭据由该文件
  的 `{ "env": ... }` 或 `decision/jev.local.json`（当前用户、`0600`）提供。
  旧形状 `endpoint`/`model`/`apiKeyEnv` 不再可用：读到旧投影或旧手写配置时
  managed 状态为 error，工具调用以
  `amos_managed_reviewer_migration_required` 阻断；Jev 配置文件不可读或无效时
  以 `amos_managed_reviewer_unavailable` 阻断。
- `review` 缺省或为 `null` 时 confirm 一律阻断，不会弹人工批准继续。
- 只有 read/write/edit/ls/find/grep 被声明为 enforced；bash/powershell/
  自定义工具在 managed 模式阻断（覆盖率缺口），不会静默放行。
- 宿主实际接收后才写 runtime report；报告是 same-UID 观察，不是远程回执。

### 3.3 真实探针

```bash
npm run build
AMOS_LIVE_JEV_CONFIG=/path/to/jev.local.json \
AMOS_LIVE_REVIEW_POLICY='{"reviewer":"jev","policy":{...},"calibration":{...},"ceilingDigest":"sha256:..."}' \
AMOS_LOCAL_LLAMA_URL=http://127.0.0.1:8080/v1 \
AMOS_LOCAL_LLAMA_KEY_FILE=/path/to/llama-server-api-key \
AMOS_LOCAL_LLAMA_MODEL=gemma-4-e4b \
npm run probe:live
```

本地 llama 端点只服务 Pi 会话模型；reviewer 是 Jev，读 `AMOS_LIVE_JEV_CONFIG`
（默认 `~/.config/amos/jev.local.json`）。缺少 Jev 配置、review policy、本地
端点或密钥时脚本打印固定 `SKIPPED` 码并 exit 0，不会伪造模型响应。外部 provider
凭据不是本探针的前提；本轮没有这些输入，因此未运行。

## 4. 前端/后端/核心解耦

- `web/` 只通过 `control-plane/contracts.ts` 与 HTTP API 调用后端；不引用
  存储实现或 Pi SDK。
- 根 `tsconfig`/`package.json` 可分别运行 `npm run typecheck`（根）与
  `npm run typecheck --workspace @amos/console`；`npm run build` 分别构建
  `dist/` 与 `dist/console/`。
- `engine/`、`catalog/`、`activation/`、`injector/`、`review/` 不依赖 Vue、
  SQLite 或具体 Harness SDK；`managed/harness.ts` 只依赖这些核心接口。
- `adapters/pi/` 负责 Pi 事件/参数/注入递送/中断语义，不复制规则判断。
- `managed/live-probe.ts` 是无需启动控制台 GUI 的外部消费示例：直接用
  `createControlPlane` 发布、`loadActivationRuntime`/Pi 扩展消费快照。

## 5. 明确不在本轮范围

- 独立 OS 身份、挂载域、bwrap/cgroup、内核沙箱、全副作用中介；
- 同 UID 进程间的防篡改、外部审计锚定、远程签名/密钥轮换；
- 完整自动 rollout、临时收紧持久化、远端 CI 接纳平台；
- OpenCode 的 OS 级隔离（其显式 managed 路径已接入同一投影与 Jev reviewer；
  普通 OpenCode 仍默认 log-only，接口兼容）；
- 运行中热切换快照（本轮会话固定快照；新发布供后续会话加载）；
- 多租户、跨机器密钥管理、通用插件市场。

这些不是“未完成的隐藏阻塞”，而是本轮明确排除的范围。它们仍保留在历史
需求/ADR 中，未被静默删除。

## 6. 已知限制与待人工审阅

- managed 默认关闭；启用后只覆盖已接管的 Harness 工具入口。获准 Shell
  内部副作用、绕过 Harness 的执行、同 UID 修改配置/审计不在保证内。
- Bash/PowerShell/自定义工具在 managed 模式被阻断，不提供 shell 中介。
- 审计与 Agent 同 UID 写域；append-only/0600 不是防篡改保证。requirement 原文
  只落在受保护的 `$XDG_STATE_HOME/amos-governance/requirement-registry/<projectId>.json`，同属
  同 UID 可写域。
- Jev reviewer 不能覆盖确定性 deny、不能扩大 scope、没有文件系统/网络副作用
  权限，也不保存 requirement 原文与模型正文；单次通过只换一个一次性 grant。
  *（历史，2026-11-05：reviewer 是本地模型 + 固定 deny 面，8 个合成校准场景
  不是安全认证；该 reviewer 服务已于 2026-11-07 被 Jev 取代。）*
- hosted Jev 与本地 llama live probe 本轮未运行：需要人工提供 Jev 凭据（或
  `decision/jev.local.json` 本地字面密钥）与本机端点。
- 来源认证仍未实现：快照 verify 是结构/身份一致性检查，不是发布者签名；
  控制台 API 依赖本机凭据与 loopback 边界。
- 发布写 artifact 失败不会回滚数据库版本；控制台显示 `never`/`stale`，
  这是诚实状态而非宿主生效。
- 浏览器 e2e 的 runtime report 是文件协议 fixture；真实生产者证据在 Pi
  测试与 live probe。
- 安全敏感实现（`managed/harness.ts`、`review/`、`control-plane/`、
  `adapters/pi/`、artifact writer）需要人工安全审阅后才能考虑日常启用。
