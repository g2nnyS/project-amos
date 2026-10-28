# Amos V1 实施指导：harness 全局约束系统

状态：**目标方案，未实施。** 本文不改变 `docs/decisions.md` 第 12 项的运行期强制执行 NO-GO 结论；只有本文第 15 节的停止条件全部解除后，才能重新评估。

适用范围：单机、单信任根、一个受管 workspace。团队、云端、多租户不在此文范围。

## 0. 怎么用这份文档

- 按第 16 节的顺序执行，不要跳阶段。
- 每个工作包都有「改动」「验收」「回滚」。验收不通过就不进入下一包。
- 任何实现与本文冲突时，先改本文和 `docs/decisions.md`，再改代码。不要在代码里悄悄偏离。
- 需要人类确认的决定集中在第 5 节，先拍板再动工。

## 1. 完成定义

V1 完成不是「功能都写了」，而是下面每句都能被测试或演示证明：

1. 人类通过 `amos run` 启动 harness；未经 `amos run` 启动的会话被标记为 unmanaged，不声称受保护。
2. Agent 不能通过任何受管工具修改或删除 `$AMOS_HOME`、策略快照、审计、gate 运行时。
3. 任何有副作用的动作，要么经过 gate，要么该工具不存在；未知工具默认 deny。
4. 没有任意 Shell。命令只能以 `program + argv` 形式提交给受控 runner，且受允许清单约束。
5. 动态注入只来自当前项目的 `AdvisorySnapshot`；prompt 不能引入未激活规则。
6. 工程规范在动作首次触及新区域时注入，不只在首轮 prompt 时猜一次。
7. 每个裁决记录同时带 `enforcement_digest` 与 `advisory_digest`。
8. 人类通过 `amos policy` CLI（后续 Web UI）管理规则与审批，不手改 YAML。
9. 上述任一项失败时，gate 拒绝有副作用动作，而不是降级为放行。

## 2. 事实基线

写这份指导时，仓库的真实状态：

| 组件 | 现状 | 位置 |
|---|---|---|
| 安全策略层 | Stage A `log-only`，不阻断 | `adapters/shared/log-only.ts` |
| 工程工作流门 | 可阻断危险 Shell，但项目级配置可被 Agent 关闭 | `adapters/pi/index.ts`、`adapters/opencode-v2/index.ts`、`opencode.jsonc` |
| 已确认绕过 | 修改 `opencode.jsonc` 的 `workflowGate.enabled=false` 后 Code Mode 恢复 | 2026-10-29 实际发生 |
| 注入 | 静态 8 个 pack，仅按首轮 prompt 关键词选 | `guidance/packs.ts`、`guidance/select.ts` |
| 引擎 | 纯函数，`deny > confirm > log > allow` | `engine/` |
| 审计 | JSONL，与 Agent 同可写域 | `storage/` |
| 配置 | 项目级 `.pi/amos.json` / `opencode.jsonc`，缺失视为关闭 | 两处适配器 |

两个必须记住的结论：

- 当前 `workflowGate` 是**工程护栏**，不是安全边界。
- 当前 `guidance/` 是动态注入的**静态前身**，不是实现。

## 3. 信任模型

### 3.1 信任锚

V1 的信任锚不是「配置文件放在全局目录」，而是这条启动链：

```text
人类
  │ 执行 amos run -- <harness>
  ▼
amos wrapper
  │ 校验 $AMOS_HOME/manifest.json 与快照 HMAC
  │ 用受保护配置启动 harness
  │ 只加载 $AMOS_HOME/runtime 下的 gate
  ▼
harness + gate
  │ 所有工具经 gate 归一化与裁决
  ▼
受管执行器
```

关键点：

- **Agent 没有进程创建工具**，所以它无法绕过 wrapper 自己启动另一个 harness。
- Gate 运行时是 `$AMOS_HOME/runtime/` 下的安装副本，**不是仓库 `dist/`**。Agent 改仓库 `dist/` 不影响正在运行的 gate。
- `amos run` 校验失败时拒绝启动，而不是「无 gate 启动」。
- 人类直接运行 `opencode` / `pi` 属于 unmanaged 会话，明确不在 V1 保护范围；gate 应在审计中记录 `launch_mode`，让这种会话可见，但不假装拦得住。

这解决了「Agent 改项目配置关闭门禁」的根因：**项目配置不再决定 gate 是否存在。**

### 3.2 为什么 V1 不需要独立 OS 用户

在「Agent 只能调用受管工具、不能执行任意代码」的前提下：

- 它触碰 `$AMOS_HOME` 的唯一路径是文件工具，gate 在路径归一化后拒绝。
- 它不能 fork 进程、不能写 `.git/hooks`、不能替换运行中的 gate。
- 因此同 OS 用户不构成额外风险。

一旦允许任意 Shell 或代码执行，这个结论立即失效，必须引入 sandbox/容器/独立 OS 用户。**这是二选一，不是渐进增强。**

### 3.3 V1 不覆盖

- 宿主 root、被攻陷的 gate 进程、内核逃逸。
- 人类手工启动的未受管 harness。
- 人类审批者本身作恶。
- 网络出口（V1 默认不提供网络工具）。

### 3.4 需要同步修正的决策

`docs/decisions.md` 第 16 项目前把「独立 OS 身份」写成硬性要求，与 3.2 冲突。实施第一步必须新增一条决策，明确：

> 在受管工具闭环、无任意代码执行、gate 运行时位于 Agent 不可达路径的前提下，V1 以 harness-global 中介作为执行边界，不以独立 OS 用户或容器为前置条件；一旦开放任意 Shell/代码执行，第 16 项的隔离要求立即恢复。

不能只在本文写，必须落到 `docs/decisions.md`，否则后续评审会以第 16 项否决实现。

## 4. 目标架构与模块所有权

```text
policy/    控制面：schema、迁移、规则版本、激活、编译、签名
control/   CLI 与最小 UI，只经 proposal/approval API 写
gate/      动作归一化、裁决、confirm、审计、会话
executor/  文件 broker、类型化命令 runner
injector/  快照路由、选择、渲染、session 状态
engine/    纯函数裁决内核（不改语义）
adapters/  只做 harness 事件到 ActionEnvelope 的映射
```

依赖方向：

```text
adapters → gate → engine
                 → executor
                 → injector（只读 action，单向）
policy → 生成快照（离线）
control → policy（写），不进入热路径
```

硬性约束：

- `engine/` 不 import 其他新模块，保持纯函数与注入时钟。
- `gate/` 不 import `control/`。
- `injector/` 不 import `gate/` 的裁决函数，只接收 `ActionEnvelope` 数据。
- `adapters/` 不做策略判断，不读数据库，不选规则。

## 5. 先拍板的决定

实施前需要人类确认，确认后写入 `docs/decisions.md`：

| # | 决定 | 建议 |
|---|---|---|
| D1 | V1 是否彻底移除任意 Shell | 是。只保留 `run_command` 允许清单 |
| D2 | 控制面权威源 | SQLite（`node:sqlite`），位于 `$AMOS_HOME/policy/`，YAML 仅为 seed/导出 |
| D3 | Gate 运行时位置 | `$AMOS_HOME/runtime/`，不从仓库 `dist/` 加载 |
| D4 | 快照认证方式 | HMAC-SHA256，密钥在 `$AMOS_HOME/keys/`，mode 0600 |
| D5 | advisory 删除是否需审批 | 需要。收紧可自动，删除/排除需人工 |
| D6 | V1 harness 范围 | Pi 先完成闭环；OpenCode 在 W0 spike 通过后接入 |
| D7 | `AGENTS.md` 是否改为派生视图 | 是，保留手写区 |
| D8 | 未受管启动的处理 | 记录并标注 unmanaged，不声称保护 |

## 6. W0：启动方式 spike（必须先做）

这一步决定后面所有设计是否成立，**不要跳过**。

要验证的问题：

1. Pi 能否用 `--no-extensions -e <绝对路径>` 只加载 `$AMOS_HOME/runtime/pi.js`，并忽略项目 `.pi/extensions`。
2. OpenCode 能否通过受保护配置（环境变量或启动参数）指定插件绝对路径，并忽略项目 `opencode.jsonc` 中的 plugin 段。
3. 两个 harness 是否都能在「gate 加载失败」时被 wrapper 拒绝启动。
4. harness 是否支持从绝对路径加载 ESM 插件（而不是必须 `./dist/...`）。

产物：`docs/spike/gate-bootstrap.md`，记录每条命令、实际输出、结论。

失败处理：

- Pi 通过、OpenCode 不通过 → V1 只承诺 Pi，OpenCode 明确标注 unmanaged。
- 两者都不通过 → 停止 W2 之后的工作，先解决启动信任锚；不要在项目插件上继续加功能。

## 7. W1：控制面

### 7.1 目标

把 `constraints/rules.yaml` 从运行时事实源降级为导入种子，建立可版本化、可审批、可编译的规则库。

### 7.2 改动

```text
policy/schema/001_init.sql
policy/db.ts            打开、迁移、事务；只用 node:sqlite
policy/import.ts        YAML → rules/rule_versions（保留原 id）
policy/compile.ts       生成 EnforcementSnapshot + AdvisorySnapshot
policy/sign.ts          规范化 JSON + HMAC
policy/validate.ts      第 7.4 节的一致性校验
policy/types.ts
control/cli.ts          amos policy ...
```

核心表（示意，完整 DDL 在 `001_init.sql`）：

```sql
rules(id, dimension, level, kind, status, created_at);
rule_versions(
  rule_version_id, rule_id, kind,
  predicate_json, narrative, on_hit, scope, owner,
  source_json, probe, ttl, paired_rule_id,
  areas_json, path_hints_json, task_tags_json,
  specificity, priority, narrative_version,
  created_by, approved_by, created_at, digest
);
rule_tags(rule_id, tag);
projects(project_id, name, workspace_root, languages_json, features_json);
project_activations(
  project_id, rule_id, state, reason,
  approved_by, valid_from, expires_at
);
injection_routes(
  route_id, project_id, match_json,
  add_rule_ids_json, suppress_rule_ids_json,
  specificity, enabled, revision
);
policy_snapshots(
  snapshot_id, policy_version, engine_version, project_id,
  enforcement_json, enforcement_digest,
  advisory_json, advisory_digest,
  signature, created_at
);
proposals(proposal_id, author, diff_json, change_kind, status, ttl, created_at);
approvals(
  approval_id, proposal_id, approver, action_digest,
  policy_digest, nonce, expires_at
);
audit_events(
  seq, prev_digest, digest, actor, delegator, project_id, session_id,
  action_digest, enforcement_digest, advisory_digest,
  verdict, matched_rule_ids_json, approval_id, result, created_at
);
ttl_jobs(job_id, rule_id, expires_at, status);
```

### 7.3 导入

- 现有 15 条规则全部导入，`kind='enforcement'`，保留原 id。
- 现有 8 个 guidance pack 导入为 `kind='advisory'`，保留原 rule id：`ts-*`、`engine-*`、`adapters-*`、`supervisor-*`、`decision-*`、`deps-*`。
- `guidance/packs.ts` 改为 seed 常量导出，运行时不再 import。
- 项目 `project-amos` 的激活集初始包含全部现有规则，`baseline_rule_ids` 由人工选择，不默认包含 `ts-*`。

### 7.4 编译与校验

编译产物必须满足：

1. `kind='advisory'` 不得有 `on_hit`。
2. `paired_rule_id` 必须存在、同项目激活、且为 enforcement。
3. 每条 advisory 必须有 `source`、`owner`、`ttl`。
4. `path_hints` 必须是合法 glob，且不得匹配 `$AMOS_HOME`、`.git/`。
5. 项目存在但激活集为空 → 编译失败。
6. 同一 rule id 的 `narrative_version` 单调递增。
7. 输出确定性：同一输入两次编译得到同一 digest。

### 7.5 CLI

```text
amos policy import <file>
amos policy list [--kind advisory|enforcement]
amos policy show <rule-id>
amos policy activate <project> <rule-id> --state active|excluded|shadow
amos policy compile --project <id> --out <path>
amos policy diff <version-a> <version-b>
amos policy propose ...
amos policy approve ...
amos audit tail
```

### 7.6 验收

- 导入后，同一规则集在新 gate 与旧 `engine/` 上对全部 fixtures 裁决一致。
- 运行时不读 `constraints/rules.yaml`；删除该文件不影响 gate。
- 编译两次，digest 相同；修改一条 narrative，只有 `advisory_digest` 变化。
- `npm run policy:check` 能发现 advisory/enforcement 不一致。

### 7.7 回滚

控制面是新增模块，旧路径不受影响。删除 `$AMOS_HOME/policy/amos.db` 与快照即可回到导入前状态。

## 8. W2：Gate 与自保护

### 8.1 目标

让「关闭 gate」不再是一个 Agent 可用的动作。

### 8.2 运行时安装

```text
$AMOS_HOME/                     默认 ~/.local/share/amos，可用 AMOS_HOME 覆盖
  config.json                   全局配置（非项目）
  manifest.json                 文件 sha256 清单
  keys/policy.key               HMAC 密钥，0600
  runtime/gate.js               gate 入口
  runtime/engine/               编译后的引擎副本
  runtime/adapters/             pi.js / opencode.js
  policy/amos.db
  policy/snapshots/<version>.json
  audit/<date>.jsonl
  run/amos.sock
```

安装命令（人类执行）：

```text
npm run build
amos gate install --from ./dist --home "$AMOS_HOME"
amos policy compile --project project-amos
```

`gate install` 写入 manifest；gate 启动时逐文件校验 sha256，任一不符即拒绝启动。

### 8.3 启动校验

`amos run` 必须：

1. 校验 `manifest.json` 自身签名。
2. 校验快照 HMAC 与 `policy_version`。
3. 校验 engine 版本与快照 `engine_version` 一致。
4. 任一项失败 → 退出码非 0，不启动 harness。
5. 输出一行人类可读状态：`amos: policy=2026-10-29.1 enforcement=sha256:... advisory=sha256:...`。

### 8.4 受保护路径矩阵

| 路径 | 读 | 写 | 说明 |
|---|---|---|---|
| `$AMOS_HOME/**` | deny | deny | 含策略、审计、密钥、运行时 |
| `<workspace>/.git/hooks/**` | deny | deny | 防持久化 |
| `<workspace>/.git/config` | deny | deny | 防改 remote/credential helper |
| `<workspace>/opencode.jsonc` | allow | deny | 本地偏好，不作为安全开关 |
| `<workspace>/.pi/**` | allow | deny | 本地偏好 |
| `<workspace>/dist/**` | allow | allow | 运行时不用它，无安全收益，避免开发摩擦 |
| 其他 workspace 内路径 | allow | allow | 由规则与 confirm 决定 |

`dist/` 的选择是刻意的：gate 从 `$AMOS_HOME` 加载后，仓库 `dist/` 不再是信任源；把它设为只读只会妨碍正常开发，不增加安全性。

### 8.5 每个动作

```ts
export interface ActionEnvelope {
  readonly sessionId: string;
  readonly tool: string;
  readonly operation: "read" | "write" | "edit" | "run" | "network" | "mcp";
  readonly target: string | null;   // 词法折叠后的绝对路径
  readonly area: string | null;     // 由快照 path_hints 最长前缀导出
  readonly argv?: readonly string[];
  readonly digest: string;          // 规范化后内容的 sha256
}
```

流程：

1. adapter 把 harness 事件转成候选 action。
2. gate **用真实输入重建** action，不信任 adapter 给的 target/digest。
3. 无法结构化 → `deny`。
4. 未注册工具 → `deny`。
5. 命中受保护路径 → `deny`。
6. 引擎裁决。
7. `allow`/`log` → executor；`confirm` → 审批；`deny` → 返回结构化拒绝。
8. 执行前后各写一条审计。

### 8.6 对抗测试（必须真实失败过）

| 测试 | 期望 |
|---|---|
| write `$AMOS_HOME/policy/amos.db` | deny |
| write `opencode.jsonc` 关闭 gate | deny |
| write `.pi/amos.json` | deny |
| write `.git/hooks/pre-commit` | deny |
| 删除快照文件 | 下次启动拒绝 |
| 篡改 manifest | 启动拒绝 |
| 修改仓库 `dist/` | 运行中 gate 不受影响 |
| 未知 MCP 工具 | deny |
| `execute` / Code Mode | 工具不存在或 deny |
| symlink 指向 `$AMOS_HOME` | deny |
| `..` 路径穿越 | deny |

### 8.7 验收

- 用真实 harness 演示：Agent 尝试写 `$AMOS_HOME` 与 `opencode.jsonc`，被拒且审计有记录。
- 删除 `$AMOS_HOME/runtime/gate.js` 后，`amos run` 拒绝启动。
- 未经 `amos run` 启动的会话在审计中标记 `unmanaged=true`。

### 8.8 回滚

保留旧的项目级 `workflowGate` 作为开发期护栏，但它不再被描述为安全边界。回滚只需移除 wrapper 启动方式，不影响仓库代码。

## 9. W3：受管执行

### 9.1 文件 broker

```ts
readFile(session, path)
writeFile(session, path, content)
editFile(session, path, oldText, newText)
```

要求：

- 先词法归一化，再 `realpath` 校验；最终打开用 `O_NOFOLLOW`。
- 打开后 `fstat` 校验仍位于允许根内，防 TOCTOU。
- 写入不改变原有文件模式；新文件 0600。
- 内容大小上限（如 2 MiB）与路径长度上限。
- 所有失败返回结构化错误码，不回显内容。

### 9.2 类型化命令 runner

```ts
runCommand(session, { program, argv, cwd, timeoutMs })
```

V1 允许清单：

```text
npm test
npm run typecheck
npm run build
npm run policy:check
npm run guidance:check
git status
git diff
git diff --check
git log
```

规则：

- 不接受 shell 字符串；`argv` 直接 `spawn`，`shell: false`。
- `cwd` 必须是 workspace 根或其子目录。
- 环境变量 allowlist；不继承凭据。
- 超时、输出上限、并发上限。
- `npm install`、`git push`、`git remote`、任何网络命令默认 deny。
- 不在清单内 → 提案或 deny，不做「猜测式放行」。

### 9.3 confirm 协议

```ts
interface Approval {
  approvalId: string;
  actionDigest: string;    // 规范化 action
  policyDigest: string;    // enforcement digest
  sessionId: string;
  nonce: string;
  expiresAt: string;
  approver: string;
}
```

- 一次性；重放、换 target、换内容、换 session 全部失败。
- 非交互环境没有审批通道 → 直接 deny。
- 展示给人类的只有结构化字段，不展示模型解释。

### 9.4 审计

每条记录：

```json
{
  "seq": 1,
  "prev_digest": "sha256:...",
  "digest": "sha256:...",
  "actor": "agent",
  "delegator": "human",
  "session_id": "ses_...",
  "tool": "write",
  "operation": "write",
  "target_digest": "sha256:...",
  "enforcement_digest": "sha256:...",
  "advisory_digest": "sha256:...",
  "verdict": "deny",
  "matched_rule_ids": ["protected-gate-0"],
  "approval_id": null,
  "result": "blocked",
  "created_at": "2026-10-29T..."
}
```

哈希链只提供篡改可见性，不提供防篡改。团队阶段再引入外部留存。

### 9.5 验收

- 一个 workspace 内 read/write/edit 全走 broker。
- 所有允许命令经 runner；不存在其他执行路径。
- 重放审批失败。
- 审计哈希链可校验，断链能被 `amos audit verify` 发现。

## 10. W4：动态注入

实现顺序固定为：选择（10.2）→ 注入（10.3）→ 渲染（10.4）→ `AGENTS.md` 投影（10.6）。区域注入依赖 W3 的归一化 action，不能提前做。

### 10.1 数据与快照

advisory 规则字段：

```text
id, narrative, narrative_version,
areas[], path_hints[], task_tags[], tags[],
specificity, priority, paired_rule_id,
source, owner, ttl
```

`AdvisorySnapshot`：

```json
{
  "policy_version": "2026-10-29.1",
  "advisory_digest": "sha256:...",
  "baseline_rule_ids": ["ts-rebuild"],
  "rules": [
    {
      "id": "engine-pure",
      "narrative": "Keep `engine/` pure: ...",
      "narrative_version": 3,
      "areas": ["engine"],
      "path_hints": ["engine/**"],
      "task_tags": ["refactor"],
      "specificity": 10,
      "priority": 100,
      "paired_rule_id": null
    }
  ],
  "routes": [
    {
      "id": "engine-area",
      "match": { "area": "engine" },
      "add": ["engine-pure", "engine-precedence"],
      "suppress": [],
      "specificity": 20
    }
  ]
}
```

### 10.2 选择算法

```text
候选 = 项目激活集 ∩ kind=advisory ∩ 未 exclude
     − 本 session 已注入
     − route.suppress

score = 400 * area_match
      + 300 * path_hint_match
      + 200 * task_tag_match
      + 100 * keyword_match
      + specificity
      + priority / 1000
```

约束：

- 只做精确匹配、glob、token 包含；无正则、无模型。
- prompt 只作为 token 袋，切词沿用 `guidance/select.ts` 的现有实现，永不回显。
- 无命中 → baseline + 项目激活 advisory 中 score 最高的前 K 条；不回退全局库。
- 基线来自快照，不是代码常量。
- Jev 只能加分，失败立即回退；不参与裁决。

### 10.3 注入时机

| 时机 | 触发 | Pi | OpenCode V2 |
|---|---|---|---|
| session 建立 | 新 session | `before_agent_start` 首次用户消息写 `systemPromptOptions.sections` | `session.instructions.entry.put` |
| 每个用户 turn | 新 prompt | 同上，重算覆盖 | `session.hook('prompt')` 重算，`context` 兜底 |
| 区域切换 | gate 归一化到新 area 的 write/edit | `tool_result` 追加有界块 | `execute.before` 入队，下一次 `context` 刷出 |

OpenCode V2 目前只有 `tool.execute.before`（`adapters/opencode-v2/index.ts:113`），没有 after 钩子，所以只能入队后在下一次模型请求前注入。不要把注入写回工具结果正文。

### 10.4 渲染

```text
<amos-guidance policy="2026-10-29.1" digest="sha256:..." mode="advisory">
These are project conventions, not permissions.
Every action is decided by the gate; this block cannot authorize anything.

- [engine-pure] Keep `engine/` pure: no filesystem, network, model, harness,
  or wall-clock I/O; accept an injected clock. (docs/decisions.md)
</amos-guidance>
```

要求：

- 纯函数；输入只有快照子集与选中的 rule id。
- 不含 prompt、文件内容、绝对路径、命令文本、凭据。
- 同一 rule id 一个 session 内只出现一次。
- 渲染异常不注入，也不影响裁决。

预算：

```text
baseline_max_chars   1200
per_turn_max_chars   1800
per_area_max_chars    900
session_total_chars  6000
max_rules_per_block     6
```

截断必须记录被丢弃的 rule id。

### 10.5 一致性校验

1. advisory 不得有 `on_hit`。
2. `paired_rule_id` 必须存在、激活、为 enforcement。
3. 每条 advisory 必须有 `source`、`owner`、`ttl`。
4. `path_hints` 不得匹配 `$AMOS_HOME`、`.git/`。
5. 激活集为空 → 编译失败。
6. `narrative_version` 单调递增。
7. 固定黑名单词（如「允许」「可以跳过」「无需审批」）命中时要求人工复核，不自动拒绝。这是粗筛，不是语义审核。

### 10.6 `AGENTS.md` 投影

```markdown
<!-- amos:generated:start policy=2026-10-29.1 digest=sha256:... -->
## Engineering guidance
...
<!-- amos:generated:end -->
```

- 手写区保留构建命令、目录说明、仓库特有知识。
- 生成区由项目激活 advisory 渲染，顺序与运行时一致。
- `npm run guidance:check` 只校验不写；不一致 CI 失败。
- 静态投影与运行时注入共用 `advisory_digest`。

### 10.7 对抗测试

1. 未激活 advisory 无法被任何 prompt 选中。
2. 项目 `exclude` 后关键词无法拉回。
3. 修改项目文件不能改变注入集。
4. 伪造路径/area 不能触发错误区域规范（area 来自 gate）。
5. 同一规则一个 session 内不重复注入。
6. 区域切换后追加，不清除既有规范。
7. 注入块不含 prompt、文件内容、绝对路径、命令文本。
8. `advisory_digest` 变化后注入与审计同步。
9. advisory 带 `on_hit` → 编译失败。
10. `paired_rule_id` 无效 → 编译失败。
11. 超预算截断被记录。
12. 注入器抛异常不影响裁决。
13. `AGENTS.md` 与快照不一致 → CI 失败。
14. 换 session 后注入集合重建，不复用。

### 10.8 验收

- 真实会话中，首次编辑 `engine/*.ts` 后出现 `engine-*` 规范，且只出现一次。
- 同一 prompt 在两个项目激活不同规则时，注入内容不同。
- 删除一条 advisory 需要审批；Agent 无法自行 exclude。

## 11. W5：治理与 UI

最小 UI 不晚于 W5 开始，但不要提前做全量。

V1 范围：

- `amos policy` CLI：规则浏览、激活、提案、审批、diff。
- 只读 Web 页（`node:http` 手写 HTML，无框架）：规则表、激活矩阵、审计 tail、TTL 队列。
- 所有写操作走 `proposal → approval → publish`，UI 不直连数据库写表。
- Agent 只能调用 `propose`，不能调用 `approve`。

验收：

- 人类能在不手改 YAML 的情况下新增一条 advisory 并发布。
- 提案 diff 包含影响项目与规则版本。
- 审批绑定 `action_digest` 与 `policy_digest`，过期失效。

## 12. 测试策略

分层，不要把所有测试都写成集成测试：

| 层 | 内容 | 运行 |
|---|---|---|
| fixture | 语言中立规则用例，放 `fixtures/*.json`，名称全局唯一 | `node --test dist/engine/*.test.js` |
| unit | 编译、选择、渲染、校验、路径归一化 | 同上 |
| integration | gate + broker + 假 harness | `dist/gate/*.test.js` |
| adversarial | 第 8.6、10.7 节 | 同上，必须真实断言 `deny` |
| canary | 真实 Pi/OpenCode 会话 | 人工或单独脚本，不进 `npm test` |

规则：

- 测试跑编译后的 `dist/`，不新增 TS 测试运行器。
- 测试从仓库根运行，fixtures 通过 `process.cwd()` 解析。
- 任何安全相关修复必须先有失败测试，再有修复。

新增脚本：

```json
{
  "gate:verify": "node dist/gate/verify-cli.js",
  "policy:check": "node dist/policy/check-cli.js",
  "guidance:check": "node dist/injector/check-cli.js",
  "audit:verify": "node dist/control/audit-verify-cli.js"
}
```

`npm test` 至少包含 `gate:verify` 与 `policy:check`。

## 13. 迁移映射

| 现有 | 去向 | 处理 |
|---|---|---|
| `engine/` | 保留 | 不改语义，只改快照输入类型 |
| `constraints/rules.yaml` | `policy/` seed | 导入后不再运行时读取 |
| `constraints/schema.json` | `policy/` 校验 | 扩展 `kind` 与 advisory 字段 |
| `guidance/packs.ts` | `policy/` seed | 运行时不再 import |
| `guidance/select.ts` | `injector/select.ts` | 去掉硬编码 base，改接收 baseline |
| `guidance/render.ts` | `injector/render.ts` | 增加 provenance 与预算 |
| `supervisor/core.ts` | `gate/session.ts` | 复用会话与停止内核 |
| `workflow/shell.ts` | `executor/command.ts` | 作为分类器，不再是最终边界 |
| `decision/` | `injector/` 的可选加分 | Jev 只做 advisory |
| `storage/` | `gate/audit.ts` | 保留 JSONL 兼容，新增哈希链 |
| `adapters/*` | 保留 | 只做事件映射，删除策略判断 |
| `.pi/`、`opencode.jsonc` | 本地偏好 | 不再决定 gate 是否启用 |
| `workflowGate` | 开发期护栏 | 明确标注非安全边界 |

## 14. 提交与评审

按逻辑拆分，不混提交：

```text
feat(policy): 控制面 schema、导入与快照编译
feat(gate): 全局 gate、manifest 校验与自保护
feat(executor): 文件 broker 与类型化命令 runner
feat(injector): 快照路由、渲染与 session 注入
feat(control): 规则 CLI 与只读审计页
test(gate): 自修改与绕过对抗测试
docs(decisions): 记录 V1 信任模型与运行时安装
```

评审要求：

- 安全相关改动必须人类评审，遵循 `CONTRIBUTING.md`。
- 每个 PR 附「威胁模型影响」一段：新增了什么能力、暴露了什么路径、失败时是否 fail closed。
- 不允许在同一个 PR 里既改策略又改执行路径。

## 15. 风险与停止条件

| 风险 | 后果 | 处理 |
|---|---|---|
| W0 spike 失败 | 无启动信任锚 | 停止 W2 之后，先解决启动方式 |
| 运行时仍从 `dist/` 加载 | Agent 改 `dist/` 即绕过 | 强制 `$AMOS_HOME/runtime/`，manifest 校验 |
| 保留任意 Shell | 全部设计失效 | 移除，或引入 sandbox；二选一 |
| 未知工具放行 | 静默缺口 | 默认 deny，提案后再接入 |
| 注入器自行解析路径 | 两套路径解释 | 只消费 `ActionEnvelope` |
| advisory 与 enforcement 漂移 | 规范说一套、裁决做一套 | 同源编译 + 一致性校验 |
| confirm 可重放 | 审批被复用 | nonce + digest + TTL + session 绑定 |
| 审计与 Agent 同域 | 可被删改 | 移到 `$AMOS_HOME`，哈希链仅作可见性 |

停止条件（任一成立就停下来，不要继续写功能）：

1. `amos run` 无法阻止未校验的 gate 启动。
2. 存在任何 Agent 可用的、未经 gate 的执行路径。
3. 受保护路径 deny 无法在真实 harness 中验证。
4. 快照仍可被 Agent 替换且 gate 不拒绝。
5. 为了「先跑起来」而临时放行未知工具或任意 Shell。

## 16. 执行清单

按顺序勾选；每项完成必须附验收证据（测试名或命令输出）。

- [ ] D1–D8 写入 `docs/decisions.md`
- [ ] W0：Pi 启动方式 spike 通过
- [ ] W0：OpenCode 启动方式 spike 通过，或明确降级为 unmanaged
- [ ] W1：`policy/schema/001_init.sql` 与迁移
- [ ] W1：导入 15 条 enforcement + 现有 advisory
- [ ] W1：快照编译、HMAC、双 digest
- [ ] W1：`amos policy import/compile/list/diff`
- [ ] W1：`npm run policy:check` 接入 `npm test`
- [ ] W2：`$AMOS_HOME` 安装与 manifest 校验
- [ ] W2：`amos run` wrapper
- [ ] W2：受保护路径矩阵与 deny
- [ ] W2：第 8.6 节对抗测试
- [ ] W3：文件 broker（含 symlink/TOCTOU）
- [ ] W3：`runCommand` 允许清单
- [ ] W3：confirm 协议与重放测试
- [ ] W3：哈希链审计与 `audit verify`
- [ ] W4：advisory 入库与编译
- [ ] W4a：baseline + 每轮注入
- [ ] W4b：区域切换注入（Pi 先）
- [ ] W4c：`AGENTS.md` 投影与 `guidance:check`
- [ ] W4：第 10.7 节对抗测试
- [ ] W5：提案/审批 CLI
- [ ] W5：只读 Web 页
- [ ] W5：TTL 清理器
- [ ] 真实 canary：写 `$AMOS_HOME` 被拒；编辑 `opencode.jsonc` 被拒；危险命令被拒
- [ ] 更新 `docs/security-model.md`、`docs/workflow-gate.md`、`README` 的能力声明

## 17. 最小第一刀

如果只能做一件事，做这个垂直切片：

> `amos policy import` 现有规则 → 编译带双 digest 的签名快照 → `amos run` 加载 `$AMOS_HOME/runtime` → Agent 写 `$AMOS_HOME` 与 `opencode.jsonc` 被拒 → 一个 workspace 的文件读写经 broker。

它同时验证了权威源、快照、启动信任锚、自保护和执行闭环。**这五件事任何一件没通，都不要开始做 UI、全工具覆盖或 Jev 语义路由。**
