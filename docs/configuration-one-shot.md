# 配置、发布与受管启动（当前 MVP）

状态：本地 Harness 层 MVP。控制台、SQLite、P1 快照发布和 Pi managed 拦截
已接通；**不是 OS 沙箱**，默认 managed 关闭，安全敏感实现仍
`pending-human-review`。范围与证据见 [MVP 交付](mvp-delivery.md)。

## 1. 单一事实源

- 控制台/治理存储：`control-plane/`，SQLite `node:sqlite`，WAL、
  `synchronous=FULL`、`foreign_keys=ON`；数据库文件 owner-only `0600`、
  非符号链接；未知/损坏/权限不符拒绝打开，不自动重置。
- 规则/项目/激活/注入配置的持久权威是已发布版本（SQLite 中的不可变
  snapshot）。
- YAML/JSON 只用于编辑、导入、导出；导入必须经过同一
  `validateCandidate` → `createProposal` → 人类审批 → `decideProposal`
  流水线，不能直接成为运行期权威。
- 运行期配置从已发布版本派生：发布时编译 P1 `amos-unified-rule-catalog`
  v2 快照并原子写入 `<workspace>/.pi/activation.json`。
- 旧的观察模式仍可读取 `constraints/rules.yaml` / 旧 seed；它不是新受管
  入口的静默 fallback。受管入口只读 activation snapshot。

## 2. 版本化 YAML 文档

导出格式（`GET /api/projects/:id/versions/:v/export?format=yaml`）：

```yaml
format: amos-project-policy
version: 1
project:
  id: <uuid>
  workspace: /abs/workspace
published:
  version: 3
  snapshotDigest: sha256:...
  activationDigest: sha256:...
activation:
  includedRuleIds: null      # null = 选中全局 + 项目规则；显式数组 = 只选这些
  excludedRuleIds: []
injection:
  baselineRuleIds:           # 无信号命中或回退时优先选中的激活规则 ID
    - ts-strict-esm
    - ts-rebuild
  routes:                    # 可选：按 area/pathHint/taskTag/keyword 触发 add/suppress
    - match:
        area: engine
        pathHint: engine/**
      add: [engine-pure, engine-precedence]
      suppress: []
      specificity: 10
rules:                       # 项目候选中的规则定义（含硬规则与纯工程规范/设计偏好）
  - id: ...
    dimension: ...
    level: 1
    expressivity: deterministic|advisory_only
    predicate: [...]|null
    narrative: ...           # 动态注入 <amos-guidance> 的工程规范/偏好或硬规则说明
    on_hit: deny|confirm|log
    scope: project|session
    ttl: null|ISO
    owner: human|agent
    source: {...}
    probe: ...
    policy_class: security|engineering
    enforcement: runtime|ci|server|advisory
```

导入：`POST /api/projects/:id/import`，body `{ "yaml": "<text>" }`，返回
`{valid, issues, candidate}`。GUI 的“导入 YAML/JSON”使用同一端点；导入成功
后仍需“校验候选→提交提案→人工批准并发布”。

Agent 辅助编写：可使用 [`amos-skill`](https://github.com/g2nnyS/amos-skill) 让编码 Agent 为内置 `global` 基线或工作区项目生成/编辑完整 `format: amos-project-policy` YAML 草案。完整文档必须先走 `POST /api/projects/:id/import`（保留 `injection` 并返回 `candidate`），再将返回的 `candidate` 传给 `/validate`、`/simulate`（支持未发布草稿模拟）与获授权时的 `/proposals`；审批与发布始终由人类在控制台完成。

规则约束：

- 仓库全局 catalog（`constraints/rules.yaml` + `guidance/packs.ts`）在服务
  启动时构建一次；必选基线固定，显式进入每个激活集，不能排除。
- 项目可新增规则 ID；不能修改/重定义全局规则 ID
  （`global_rule_conflict`），不能排除必选基线（`mandatory_exclusion`）。
- 同 ID 重复、未知字段、非法谓词、空激活、项目无法覆盖全局 hard deny 均
  在发布前拒绝。
- `${SESSION_WORKSPACE}` 只允许出现在 `target_glob` /
  `target_outside_glob` 模式中，编译时展开为项目 workspace。
- `level` 只影响 advisory 排序/审计优先级，不改变
  `deny > confirm > log > allow`。
- 纯工程规范/设计偏好规则设置 `expressivity: advisory_only`、`predicate: null`、
  `enforcement: advisory`、`policy_class: engineering`；编译时从 `dimension`
  派生默认 `areas`/`keywords`（内置 7 个 guidance pack 则带显式 `taskTags`、
  `languages`、`pathHints` 映射），也可通过 `injection.routes` 按 `area`、
  `pathHint`、`taskTag`、`keyword` 精确路由或抑制已激活规则。

## 3. 控制台启动

```bash
npm ci
npm run build
npm run console:init      # 初始化 SQLite、human.token、agent.token（0600）
npm run console:serve     # 127.0.0.1:4310；可用 --data-dir/--workspace/--port
```

- 首次打开控制台先设置并确认登录密码（12–1024 字符）：浏览器粘贴一次 `~/.local/state/amos-governance/human.token`，Tauri 自启动服务通过私有 IPC 获取一次性设置授权；之后使用密码登录。令牌不会打印到终端。
- 项目 workspace 必须是已存在的绝对路径；发布或保存配置时原子写入
  `<workspace>/.pi/activation.json` 与 `<workspace>/.pi/amos.managed.json`。写入失败不会回滚数据库版本，控制台
  runtime 状态会显示 `never`/`stale`，不会伪装成已生效。
- `GET /api/projects/:id/runtime` 分别读取 `<workspace>/.pi/runtime.pi.json` 与
  `.pi/runtime.opencode.json`；专属回执缺失时按 Harness 回退到旧版 `.pi/runtime.json`。
  状态：`loaded`/`loaded-unverified`/`stale`/`never`/`invalid`/`unpublished`；
  `loaded-unverified` 表示身份匹配、配置摘要尚待核验。

## 4. Harness 插件接入与 Managed 配置

### 4.1 控制台一键安装与 `.pi/amos.managed.json` 投影（推荐）

在控制台 `#/harnesses` 页面可一键为 Pi（写入 `~/.pi/agent/extensions/amos.js`）或 OpenCode（写入 `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`）安装插件。项目发布或更新配置后，控制台自动在工作区写出 `<workspace>/.pi/amos.managed.json`（`amos-managed-host-projection` v2），Pi 与 OpenCode 均优先读取该投影：

- 投影包含解析后的 `harness: { enabled, mode: "log-only" | "managed", advisoryInjection }`、`configDigest`、`activation`、`managed`（固定 `reviewer: "jev"` 与全局配置的 `jevConfigPath`）及 `workflowGate`。
- 旧版 HTTP reviewer 配置形状（`endpoint`/`model`/`apiKeyEnv`）已退役，遇到时会以 `reviewer_migration_required` 停止，不会隐式放行。

### 4.2 手工配置 `.pi/amos.json`（无宿主投影时的项目级配置）

`.pi/extensions/amos.js`（若未通过控制台做用户级安装）：

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
  "activation": { "snapshotPath": ".pi/activation.json", "projectId": "<uuid>" },
  "managed": {
    "enabled": true,
    "auditPath": "/abs/audit/managed.jsonl",
    "requirementEgress": "denied",
    "grantTtlMs": 20000,
    "review": {
      "reviewer": "jev",
      "jevConfigPath": "/abs/state/amos-governance/jev.local.json",
      "policy": { /* ReviewerPolicy */ },
      "calibration": { /* CalibrationEvidence */ },
      "ceilingDigest": "sha256:<64 hex>",
      "grantTtlMs": 20000
    }
  }
}
```

- `managed` 缺省/`enabled:false`：保持 log-only + 可选 workflow gate。
- `managed` 存在但非法：所有归一化工具调用阻断
  `amos_managed_config_error`（fail closed）。
- `review` 缺省：confirm 一律阻断 `amos_managed_review_unavailable`；
  不提供“审查失败后人工点一下继续”的日常回退。
- `requirementEgress` 缺省 `denied`；显式 `allowed` 且 review policy
  `requirementEgress: "allowed"` 时才把用户要求原文放进最小投影。
- `auditPath` 必须在工作区外；否则配置错误、阻断。
- 受管工具：`read`/`write`/`edit`/`ls`/`find`/`grep`；bash/powershell/
  自定义工具在 managed 模式阻断（覆盖缺口），不静默放行。
- 会话启动/首次工具调用加载快照并写回执：v2 投影使用 `.pi/runtime.pi.json`，
  旧投影使用 `.pi/runtime.json`；执行与注入使用同一个 `ActivationRuntime`。
  新发布只由后续会话加载，不热切换。

## 5. 真实探针

```bash
npm run build
AMOS_LOCAL_LLAMA_URL=http://127.0.0.1:8080/v1 \
AMOS_LOCAL_LLAMA_KEY_FILE=/path/to/llama-server-api-key \
AMOS_LOCAL_LLAMA_MODEL=gemma-4-e4b \
npm run probe:live
```

探针使用真实本地模型、真实 Pi AgentSession、真实文件副作用和独立模型
reviewer；8 个合成校准场景 0 false allow。没有本地模型时以固定错误退出，
不伪造响应。外部 provider 凭据/费用/出境授权不是本轮前提。

## 6. 不在本轮

OS 隔离（独立 UID/挂载域/bwrap/cgroup）、防篡改审计/远程锚定、完整
rollout、远端 CI 接纳、运行中热切换。
这些是明确范围外，不是隐藏阻塞。
