# 本地治理控制台

## 范围与边界

本轮实现单机、单人使用的真实治理服务与中文 Web 控制台：内置 Global Project、工作区项目、规则继承、不可变提案、人类审批、原子发布、历史版本、回滚提案、YAML 导入导出与审计。
服务端使用 Node 26 内置 HTTP 与 SQLite，不引入 HTTP 框架或 ORM；`web/` 中的 Vue 治理工作台在构建时编译为静态资源，由同一服务提供。登录后默认进入 Global Project，可直接维护由所有工作区项目继承的全局规则；已保存的项目偏好仍优先恢复。项目边界、规则矩阵、检查器、提案、版本和审计均来自真实治理 API，没有营收、计费或模拟业务数据；界面与数据限制见 [前端交接](../web/FRONTEND-HANDOFF.md)。
数据库与凭据默认存放于工作区外。它是本地治理产品，不是已完成的受信控制面：同 UID Agent 仍可读取凭据或改写存储。
安全适配器继续 Stage A `log-only`；发布不修改仓库规则 YAML，也不是单次工具调用授权。写入的激活与 managed 产物须由助手重新加载，实际状态以运行回执为准。

## 启动与日常使用

```bash
npm ci # 同时安装 web workspace 的构建依赖
npm run console
# 已构建时可跳过重编译：
npm run console:serve -- --port 4310 --data-dir /absolute/path/outside-workspace
```

无界面运行：`npm run service` 只编译后端（`build:service`），以 `serve --api-only` 启动治理 API，无需构建 `web/` 或启动 Tauri；`dist/console/` 缺失时也能启动，`/` 返回 404。已构建时用 `npm run console:serve -- --api-only`。监听地址、Host/Origin 校验、状态目录和人类/Agent 令牌规则与控制台模式相同。
服务仅接受 `http://127.0.0.1:<port>`，不要改用 localhost、局域网地址或反向代理。默认端口 4310；端口占用时用 `--port` 指定其他端口。前端使用 hash 路由，刷新治理页面不会依赖服务器开放任意 SPA 路径。
若浏览器在另一台机器，可由人类在浏览器所在机器建立 `ssh -N -L 4310:127.0.0.1:4310 user@server` 隧道，再打开 `http://127.0.0.1:4310`；两端端口须一致以保留 Host/Origin 校验，不要为远程预览改成公网监听。
默认状态目录为 `${XDG_STATE_HOME:-$HOME/.local/state}/amos-governance`，含 `governance.sqlite`、`human.token`、`agent.token`；设置密码后另有 `human-password.json`。同一状态目录同一时间只允许一个 `serve` 实例，重复启动以 `service_already_running` 拒绝。运行中的 `service.lock` 和 `service.json` 分别用于协作式单实例互斥和 loopback 实例发现，不记录令牌，也不构成同 UID 安全边界；正常关闭会清理这两个文件。
首次打开先设置并确认 12 至 1024 字符的登录密码。Tauri 桌面自己启动服务时，通过私有 IPC 启动器提供 10 分钟的一次性设置授权，无需手动输入 token；浏览器或 Tauri 复用已有服务时，首次设密需粘贴 `human.token` 中的人类令牌。后续使用密码登录。应用不保存密码明文或启动授权，服务仅持久化随机盐和 scrypt 验证摘要（N=131072、r=8、p=1），不会覆盖已有密码。Agent 使用独立 Bearer token，与桌面人类密码会话分离。
桌面登录只提供密码方式。登录不代替逐项治理审批。不要把凭据贴到聊天、URL 或日志。
令牌文件须属当前用户且权限 0600，目录须为 0700；现有权限错误、符号链接或损坏状态会拒绝启动，不自动删除或重置。
也可只初始化而不启动：`npm run console:init`。`Ctrl-C` 正常关闭；重启保留项目/提案/版本/审计，但浏览器会话失效，须重新登录。
Tauri 启动时复用同状态目录中健康且带控制台的服务，关闭窗口不会停止该已有实例；桌面自己启动的服务仍随窗口关闭。纯 API 服务没有控制台资源，桌面会提示先停止该服务或改用 API/其他客户端，不会打开返回 404 的页面。

1. 登录后在内置 Global Project 中维护共享规则。全局版本独立于工作区项目版本，全局项目没有工作区配置、运行回执、临时收紧、探测或 rollout。
2. 需要项目差异时，创建项目并填写规范化绝对 workspace；该路径用于策略绑定，不授权网页读取该目录。项目候选保存自身补充规则，发布时与当前全局层组合。
3. 导入仓库规则或从已发布版本开始，编辑确定性安全/工程规则、纯建议性工程规范/设计偏好（`expressivity: advisory_only`、`predicate: null`、`policy_class: engineering`）及激活/排除集合与动态注入配置（`injection.baselineRuleIds`、`injection.routes`），先校验再提交提案。
4. 审阅当前/候选差异，批准并发布或拒绝；不可修改已提交正文，修订须新提案。
5. 在版本页导出已批准的有效规则 YAML 或完整版本 JSON；回滚生成新提案，不回退版本号。
6. 治理审计记录状态变化，不复制规则正文或自由文本审批备注。规则和提案详情包含敏感策略信息，仅供本机有权限用户查看。

可选观察日志只在启动时指定，网页不能指定服务器文件路径：

```bash
npm run console:serve -- --audit-log /absolute/path/to/opencode.jsonl
```

`--audit-log` 可重复；没有配置时，观察数据明确显示不可用。读取有大小/行数限制，界面会标记截断；不会修改原始日志。

### 备份与恢复

正常停止所有连接该数据目录的服务，再备份**整个状态目录**（包括仍存在的 SQLite `-wal`/`-shm` 文件），保存于受控位置；不要只复制运行中的主数据库文件。
恢复到工作区外的私有目录，保持原有属主和 0700/0600 权限，再以 `--data-dir` 启动。令牌也在备份中，必须按凭据处理。
不要通过删除数据库、移动 currentVersion 指针或覆盖 YAML 进行回滚。未知数据库版本、Schema/compiler 不兼容或损坏须人工诊断/恢复，服务不会静默重建空库。
此版本没有在线备份、账户/MFA、团队管理、外部审计锚定、签名信任链或自动 Harness 激活。人工审批能力仍受同 UID 可读写域限制。

## 不可变条件

- 内置 Global Project 使用稳定 ID `global`、`kind = 'global'`、`workspace = null`，始终位于项目列表首位；普通项目继续使用 `kind = 'project'` 和规范化绝对 workspace。
- 新项目 `currentVersion = null`，显示“尚未发布”，不能制造空的已批准策略。
- 全局与项目采用“全局继承 + 项目补充”。项目可新增规则、激活项和注入路由；重定义已发布全局规则会被拒绝，项目排除集合也不会移除全局已激活规则。仓库固定 catalog 的 `mandatory_exclusion` 与 `global_rule_conflict` 防护继续生效。
- 全局项目自身没有工作区产物。全局发布事务会先组合校验所有已发布项目，再提交全局版本，随后向这些项目扇出重写激活与 managed 产物；项目版本号和历史记录保持不变。任一项目存在临时收紧状态时，全局发布以 `global_tightening_active` 停止。
- 审查服务（Jev）是全局配置，不按项目设置：单一私有文件保存在服务数据目录（0700/0600），由 `/api/jev` 全局读写与测试；所有宿主投影中的 Jev 路径由服务注入。项目配置不存储 Jev 路径，旧库行中的历史路径在读取时剥离；启用 Jev reviewer 或工作流闸门消费方而全局服务未配置时，配置编辑与投影以 `jev_not_configured` 停止。历史项目级 Jev 文件保留在数据目录中但不再读取。
- 项目版本保留原始项目候选和发布时的有效快照。后续全局发布由运行时状态、模拟和产物重写使用最新全局层，项目历史版本保持不可变；产物写入失败通过 `never`/`stale` 状态呈现。
- 规则校验复用 `constraints/schema.json` 与 `engine/assertValidTable`，保留全部字段和七个操作符。
- 候选包含完整规则及 `activation: { includedRuleIds: string[] | null, excludedRuleIds: string[] }`。null 表示全部；显式 included 不得与 excluded 重叠；拒绝重复、未知 ID 和空的有效规则集。
- 只有 `${SESSION_WORKSPACE}` 的既有 glob 替换可用。项目 workspace 必须是已规范化绝对路径，创建后不可变。
- 提案正文不可修改；修改须提交新提案。审批绑定提案 digest、baseVersion、schema/compiler 版本；过期、已终结或 stale base 不得发布。
- “批准并发布”是单个 SQLite 事务：校验、版本、快照、审计、提案状态、项目指针一起提交；无异步间隙。重复同一决定只返回原结果，不创建新版本。
- 拒绝、撤回、过期也需条件状态变更与同事务审计。GET 不触发治理状态写入。
- 回滚复用历史候选生成新提案，经批准产生递增新版本，不移动指针回旧版本。
- 提案过期与规则 TTL 分开；TTL 仍由注入时钟的引擎判断，不自动发布版本。
- 初次提案 `baseVersion = 0`，已发布版本从 1 递增；项目未发布时仍是 `currentVersion = null`。HTTP 接受初始 null 为 0，未填提案期限时默认 7 天。
- 新快照使用独立版本化格式，不改变 `storage/snapshot.ts` 的历史 digest 合同。enforcement 包含全部选中的 deterministic 规则（包括 ci/server 元数据），advisory 包含 advisory_only；发布同时编译 P1 `amos-unified-rule-catalog` v2 快照（含已激活硬规则配对 narrative 与 `advisory_only` 工程规范/设计偏好投影）并写入 `<workspace>/.pi/activation.json`；不得声称 metadata 是运行授权。
- snapshot digest 绑定 project、workspace、版本、schema/compiler、激活集、编译内容；分开 enforcement/advisory digest。导出为派生产物，不参与 DB/文件跨域事务。
- YAML 导出保留原候选的 `${SESSION_WORKSPACE}` 供旧适配器解析；新快照保存已展开内容。两种 digest 不可互换。模拟使用独立引擎默认值（未命中为 allow），不同于既有 log-only 记录器的显式 default-deny，均不代表工具执行许可。

## 数据与服务合同

`control-plane/contracts.ts` 是领域服务与 HTTP 的共享类型合同；浏览器 JSON 形状与其保持一致。

- `Actor = { id: string, role: 'human' | 'agent' }`，由服务端认证构造，不能从请求正文采信。
- `Project = { id, name, workspace: string | null, currentVersion: number | null, createdAt, kind: 'global' | 'project' }`；仅内置全局项目的 workspace 为 null。
- `Candidate = { rules: RuleRecord[], activation }`，RuleRecord 完整保留现有 YAML 字段。
- `Proposal = { id, projectId, title, rationale, baseVersion, candidate, digest, author: Actor, createdAt, expiresAt, status, decision, publishedVersion: number | null, restoreFromVersion: number | null }`。
- `status = pending | approved | rejected | withdrawn | expired`；`decision = { decision: 'approve' | 'reject', note, actor: Actor, decidedAt } | null`。
- `PublishedVersion = { projectId, version, previousVersion, proposalId, candidate, snapshot, createdAt, approvedBy: Actor }`。
- `GovernanceEvent = { id: number, projectId: string | null, proposalId: string | null, version: number | null, kind, actor: Actor, createdAt, metadata }`；只记 ID/digest/计数，不复制规则正文、命令、凭据或自由文本备注。
- `ValidationResult = { valid: boolean, issues: { path: string, code: string }[] }`，失败不回显原始输入值。
- `DomainError` 暴露稳定 `code` 与 `status`，不要透传数据库、解析器或文件异常信息。

`createControlPlane({ databasePath, rawSchema, now? })` 返回同步对象：

```text
close()
listProjects(): Project[]
getProject(projectId): Project
createProject({name, workspace}, actor): Project
validateCandidate(projectId, candidate: unknown): ValidationResult
createProposal(projectId, {title, rationale, baseVersion, expiresAt, candidate}, actor): Proposal
listProposals(projectId): Proposal[]
getProposal(proposalId): Proposal
decideProposal(proposalId, {decision, note, expectedDigest}, actor): Proposal
withdrawProposal(proposalId, actor): Proposal
listVersions(projectId): PublishedVersion[]
getVersion(projectId, version): PublishedVersion
getCurrentPolicy(projectId): PublishedVersion | null
createRollbackProposal(projectId, version, {title, rationale, baseVersion, expiresAt}, actor): Proposal
listAudit({projectId?, limit?, before?}): {items: GovernanceEvent[], nextCursor: number | null}
simulate(projectId, {action, version?}): PolicyDecision
```

human 可创建项目、提案、审批和撤回；agent 只能读取、校验、模拟、提交提案、撤回自己的提案，不能审批或创建项目。
单人模式允许人类审批自己起草的变更，不宣称“四眼审批”；Agent 不得自我审批。所有状态写入需要领域层权限检查，不仅 HTTP。

## HTTP 合同

所有 API JSON 默认直接返回领域对象/数组；错误为 `{error: {code}}`。没有假成功或自动注入示例数据。

| 方法 | 路径 | 请求/响应 |
| --- | --- | --- |
| GET | `/api/session` | `{authenticated, role?, csrfToken, expiresAt?, auth:{setupRequired,methods,systemLabel?}}`；建立短期匿名 CSRF 会话 |
| POST | `/api/setup` | `{password,setupGrant?或token?或proof?}`；受信首次设置；已有密码返回 409 |
| POST | `/api/login` | `{method:"password",password}`、`{method:"system",proof}` 或 `{token}` → 新 human 会话；轮换会话 ID 和 CSRF |
| POST | `/api/logout` | 撤销服务端会话 |
| GET | `/api/status` | `{mode:'log-only', enforcement:false, trustBoundary:false}` 与可选计数 |
| GET/POST | `/api/projects` | 列表（内置 Global Project 始终首位）/ `{name,workspace}` 创建尚未配置的工作区项目 |
| GET | `/api/projects/:id` | Project |
| GET | `/api/projects/:id/policy` | PublishedVersion 或 null |
| GET | `/api/projects/:id/versions` | PublishedVersion[] |
| GET | `/api/projects/:id/versions/:n` | PublishedVersion |
| GET | `/api/projects/:id/versions/:n/export?format=yaml\|json` | 下载有效规则 YAML / 完整版本 JSON |
| POST | `/api/projects/:id/versions/:n/restore` | `{title,rationale,baseVersion,expiresAt}` → 回滚提案 |
| GET/POST | `/api/projects/:id/proposals` | Proposal[] / 创建提案正文（见服务合同） |
| GET | `/api/proposals/:id` | Proposal |
| POST | `/api/proposals/:id/decision` | `{decision,note,expectedDigest}` → Proposal |
| POST | `/api/proposals/:id/withdraw` | `{}` → Proposal |
| POST | `/api/projects/:id/validate` | `{candidate}` → ValidationResult |
| POST | `/api/projects/:id/simulate` | `{action,version?}` → 引擎观察裁决；不保存动作原文 |
| GET | `/api/audit?projectId=&limit=&before=` | 治理事件分页 |
| GET | `/api/audit/observations` | 启动时配置的脱敏观察日志与覆盖缺口；未配置返回 available:false |
| GET | `/api/schema` | 固定规则 JSON Schema |
| GET | `/api/seed` | 仓库固定规则导入候选；读取不创建、不批准项目 |
| GET | `/api/jev` | JevSettingsView；全局审查服务配置，密钥只回显“已保存”状态 |
| POST | `/api/jev` | SaveJevSettingsInput → JevSettingsView；仅 human 浏览器变更，密钥写入私有文件且不回显 |
| POST | `/api/jev/test` | `{}` → `{ok,model}`；仅 human 浏览器变更，用已保存密钥发起一次真实连接测试 |

校验/提案也接受 `{yaml: '...', activation?}` 代替 candidate，YAML 只在服务器有界解析，必须通过同一规则校验。浏览器端是否提供对应入口以界面为准。
浏览器先 GET session 获取 CSRF，所有 POST（含登录）须精确 Origin、application/json 与 `X-CSRF-Token`；human cookie 为 HttpOnly/SameSite=Strict/host-only，有服务端有效期、退出撤销。明文 localhost 不宣称 Secure cookie。
agent 仅使用独立 Bearer token；拒绝 cookie+bearer 混用，human token 不接受 Bearer 方式。令牌不进入 URL、日志、localStorage 或错误响应。
只监听 127.0.0.1，严格校验唯一 Host（含实际端口），忽略转发头，不开 CORS；限制请求体、超时、登录尝试和 YAML 别名。静态路由只有固定资产，不接受任意文件路径或网络抓取。
CSP 禁止内联脚本、外部资源与 frame；不使用 innerHTML 渲染不可信策略内容。所有页面明确区分治理审批与工具执行权限。

## 测试与验证边界

从仓库根目录运行：

```bash
npm run typecheck
npm test
# 仅运行治理服务与控制台的编译后测试：
npm run build && node --test dist/control-plane/*.test.js
```

- 领域测试覆盖规则/TTL/激活校验、持久化重启、回滚新版本、两 SQLite 连接的 stale/重复审批、角色权限、失败事务回滚及 digest 绑定；全局用例覆盖默认内置行、旧库重开（含历史项目级 Jev 路径剥离）、继承与冲突、多项目扇出、零全局产物、未来项目继承和临时收紧屏障。
- HTTP 测试使用真实 loopback 请求覆盖 Host/Origin/CSRF、混用认证、登录/退出/过期、Agent 禁止审批、请求体边界、固定文件路由和日志脱敏，并验证全局项目的工作区专属接口拒绝行为；Jev 用例覆盖全局读写、密钥保留、连接测试与 Agent 拒写。
- 浏览器验收覆盖默认 Global Project→全局编辑→校验→提案→审批发布→版本历史，全局 Jev 设置→保存→重载→连接测试→切换 Global Project 后配置一致，以及创建项目→种子导入→编辑补充规则→校验→提案→审批发布→下载→回滚；项目产物断言同时包含全局与补充规则，另覆盖重登、跨项目草稿隔离、桌面与 390px 窄屏；服务重启持久化由领域测试覆盖。
- 非 root 环境会跳过需构造其他 UID 文件的属主测试；两连接测试不等于跨进程锁竞争压力测试，也未建立断电/文件系统故障或受信执行隔离保证。
- 安全敏感改动仍须人类审阅；本地治理检查通过不代表运行期强制执行已满足 G0 条件。
