# 产品与工程决策

来源：2026-10-24 整合版产品与工程指令，以及《Agent 行为约束系统 — 设计文档》。本文件记录当前实现边界，不代表阶段门禁已经通过。

目标设计的现行口径见第 26–32 项、[产品设计](product-design.md) 与[差距闭环](product-gap-plan.md)。这些是设计修订，不表示运行代码、配置迁移或安全门禁已完成。历史决策按下述取代关系保留。

## 已拍板

1. 当前阶段的治理闭环是单机、单信任根；多端协作与团队功能是后续方向，不提前实现，也不提前设计接口。当前仍处阶段 A（log-only），不得提前启用真实 deny、confirm 或治理。
2. OpenCode V2 保留为参考适配器。2026-10-26 用户确认日常主用 Pi，第二适配器因此按既定反转条件解锁；只新增 Pi log-only，不替换 OpenCode，也不扩展第三 harness。
3. （已由第 14 项取代）YAML 是规则事实源，JSONL 是原始审计事实源；SQLite 仅在阶段 D 作为可删除、可重建的派生读模型。裁决热路径只读不可变内存快照。每次加载的规则原文、Schema、schema digest 与有效 session workspace 按规则 digest 归档在日志目录的 `snapshots/` 下，供事后重建；归档仍与 Agent 同属一个可写域，不能当作防篡改保证。
4. 使用 TypeScript strict、ESM、Node 26、npm 单 package。正式 hook 与测试运行 `tsc` 编译后的 JavaScript。
5. 核心运行时依赖为 Ajv、YAML、picomatch；不引入 Web 框架、ORM、LLM SDK、表达式执行器或第二语言引擎。Pi 官方包仅作为 adapter 开发依赖以固定 1.4.0 API；其传递依赖 undici 覆盖到 8.12.3 以消除已披露漏洞，核心引擎不引入 Pi provider。
6. 引擎保持纯函数和注入时钟；Schema/词表校验在 loader，OpenCode 参数归一化只在 adapter，JSONL I/O 只在 logger。
7. 新快照校验失败时保留最后正常快照；首次没有正常快照时按 fail-closed 记录。SQLite 永不进入引擎热路径。
8. agent 只有提案权，没有直接写表权；UI 无直达写表通道。阶段 C/D 未到，不提前实现其接口。当前策略文件仍与 Agent 处于同一可写域，因此这条是目标约束，不是已成立的物理保证。
9. （2026-10-26）多端协作与团队功能（包括托管或云辅助形态）是后续方向，当前阶段不实现，也不提前设计接口；不再以“多用户、SaaS、云控制面”作为负约束排除。
10. （2026-10-28）策略分类采用两层：`policy_class` 区分 `security`/`engineering`，`dimension` 标识具体风险域或工程领域，`enforcement` 记录预期机制（runtime/ci/server/advisory）。分支名和提交格式属于 engineering/delivery，由 CI 检查；受保护分支、force push 与发布权限必须由 Git 服务端执行，分支名不是授权依据。
11. （2026-10-28，2026-10-29 修订）Jev 等决策模型只作为概率化语义传感器，输出类型化事实，不拥有策略或执行权。确定性引擎是权威，模型只能收紧 verdict；需要评估时模型失败、拒答、超时或低置信度必须 fail closed。Jev 的动作评估必须包含 requirement conformance：判断动作是否服务于人类要求，而不是模型的自我意图。人类要求的唯一合法来源是 harness 从用户输入通道捕获的 `RequirementFrame`，不是模型自述、工具结果、文件内容、MCP 返回或子代理 prompt；`source: delegated` 的 frame 不能用于放宽任何 verdict。requirement 文本的出境必须由 frame 的 `egress` 显式允许；审计只记录 frame digest 与来源，不记录原文。
12. （2026-10-28）在受信任监督进程、完整动作覆盖、真实文件系统执行边界和认证审批落地前，项目状态为运行期强制执行 NO-GO；log-only 结果只能作为观察数据，不能作为安全保证或自动放行依据。
13. （2026-10-29）新增独立的、显式启用的工程工作流门，与安全 `log-only` 策略层分离。它可注入版本化工程规范、阻断或要求确认危险 Shell、运行固定本地检查，并在变更后执行可选 Jev 审查；不得据此宣称安全边界或完整动作覆盖。Shell 判定只接受封闭子集，未知、PowerShell、自定义 shell/prefix 或分析错误必须 fail closed。Jev 配置支持 TypeSafe 与 OpenRouter System One 的 `baseUrl`、模型 allowlist 和凭据引用；共享配置只能引用环境变量，直接凭据只允许受保护的本地 `decision/jev.local.json`（属主当前用户、POSIX mode 0600）。OpenCode V2 缺少真正的 settle/merge 阻断点，其完成审查只能作为 advisory feedback；Pi 每个会话最多一次修复续跑。运行期安全强制执行的 NO-GO 状态不变。
14. （2026-10-29）目标架构的权威策略与治理源改为位于 Agent 可写域之外的受信控制面数据库，取代第 3 项中 YAML、JSONL 和 SQLite 的原有存储定位。Git 只保存控制面对已批准版本生成的归档与审计导出；YAML 只作为导入、导出、测试 fixture 和 CI 审查格式，不再是日常治理入口；JSONL 只保留为现有观察管道或导出格式，不再是目标架构的原始审计事实源。控制面的逻辑模型分为规则定义与版本、项目激活与排除、提案/审批/审计/TTL 治理、编译策略快照四层；`dimension` 是字段或字典，不按维度拆物理表。Agent 与人类 UI 均只能经提案和审批流程修改治理状态，不能直写权威表。
15. （2026-10-29）执行引擎继续保持纯函数，热路径只消费经过验证的不可变编译快照，不查询控制面数据库。快照 digest 提供内容标识和完整性校验，不单独提供来源认证；来源认证必须由受信控制面签名或等效的受信清单机制提供，密钥、快照及其激活指针均不得由 Agent 修改。快照身份必须绑定编译内容、Schema/编译器版本和项目激活集；回滚与撤销通过受信控制面发布新的已批准版本完成，不能靠 Agent 替换文件或指针。新快照验证失败时保留最后正常快照、首次失败时 fail-closed 的现有语义不变，但运行期强制执行仍须满足完整动作覆盖和受信执行边界。
16. （2026-10-29）单机控制面可采用 SQLite，但必须由独立服务持有，存放在项目工作区之外，并通过独立 OS 身份和受认证 IPC 与 Agent 隔离；同一 OS 用户下的目录权限、`0600`/`0700` 或签名文件都不构成对恶意 Agent 的信任边界。团队阶段可替换为 PostgreSQL，不改变权威源位置。全局 Harness 网关/Supervisor、执行 mediator、策略与审计存储、网关二进制和配置都必须位于 Agent 可写域之外；`.pi/`、`opencode.jsonc` 和项目级 `workflowGate` 只能承担本地偏好或工程护栏，不能决定是否启用安全门禁。Agent 只能提交结构化 action，未经 mediator 的 Harness、Shell、网络、MCP、凭据及替代入口必须在声明的保护域内被禁用或覆盖。
17. （2026-10-29）上述决策目前仅是目标架构，不表示控制面、数据库、全局网关、签名快照或 OS 执行边界已经实现。当前仓库仍是 Stage A `log-only` 观察原型，项目级 `workflowGate` 仍是可选工程护栏；第 12 项运行期安全强制执行 NO-GO 不变。后续实现先做权威源和快照迁移，再接入受信执行面与完整动作覆盖，不能仅把现有 YAML 包装成数据库或把项目插件移到全局目录就宣称完成。
18. （2026-10-29）目标 `PolicySnapshot` 在同一 `policy_version` 下分别携带 enforcement 与 advisory 内容及 digest。Gate 只读 enforcement，Injector 只读 advisory，二者依赖方向保持单向：Gate 不依赖 Injector，注入失败、回退或异常不得改变任何工具裁决。任务注入集只能由项目激活快照中的 advisory 规则经确定性路由、去重和预算选择产生；prompt 只能影响已激活集合内的选择，不能引入或排除规则。advisory 的新增/收紧可自动发布，删除、排除或 suppress 属于减少防护，必须经人工审批。快照按 session 固定，渲染块携带 policy、advisory digest 与 `mode="advisory"`，审计据此区分模型看到的规范版本和 enforcement 裁决版本。
19. （2026-10-29）当前无控制面阶段的 pack-to-snapshot seed 只用于打通闭集选择、session 去重、纯渲染和 Harness 注入管道，不是受信策略源或不可绕过边界。基线与轮次注入可先落地；区域队列也可以先复用现有 adapter 的 write/edit 归一化结果做工程验证，但在 Phase 3 受管执行闭环前不得宣称完成受信的区域注入。Pi 的区域规范只能作为 `tool_result` 的独立追加块，OpenCode V2 只能排队到下一次 context；两者都不得改写工具结果正文。运行时应只有一个选择实现，`guidance/packs.ts` 逐步降级为导入种子，`AGENTS.md` 投影与 digest 一致性检查留待后续子阶段。
20. （2026-10-29，2026-10-30 实现）动作裁决分为三层：结构层（工具是否受管、路径是否在范围内、是否命中 0 层拒绝）、确定性策略层（引擎基线）和语义层（Jev 的 requirement conformance 与风险事实）。Jev 只能收紧基线：`requirementMatch: mismatch` 可把 `allow` 降为 `deny`，`partial` / `unclear` 降为 `confirm`；`match` 不得把 `deny` / `confirm` 升为 `allow`。事实必须绑定 `RequirementFrame` digest，digest 不匹配按评估失败处理。受管动作的基线必须允许人类明确要求生效；Pi 直接用户通道的逐字命令经 `UserLiteralGrant` 在结构层把非 `deny` 提升为 `allow`，但所有确定性 `deny` 永远保留。人类要求只能由 harness 用户输入通道捕获；`actionAssessment` 必须显式启用，requirement 文本出境另需 `requirementEgress: allowed`。OpenCode 中由语义层新增而确定性基线未要求的 `confirm` 必须 fail closed，不能依赖可能不会询问的后续权限事件。评估结果写入独立脱敏审计记录；运行期整体仍是 Stage A log-only，且该门控不是安全边界。
21. （2026-11-01）安全部分的目标形态改为对齐 ChatGPT / Codex 的 Approve for me，不把它实现成比该产品更强的声明。三件套是：宿主沙箱（`workspace-write`：会话工作区可写、默认无网络、策略/审计/宿主配置/凭据路径受保护）、`on-request`（沙箱内未命中则执行，越界或 `on_hit: confirm` 先停住）、独立审查者（只处理已经停住的 confirm 类越界，可批准或拒绝这一次请求）。审查者替换的是“谁来看这次越界”，不是授权：不能扩大可写根、不能打开网络、不能削弱受保护路径、不能把任何 `deny` 抬成 `allow`。0 层 `deny` 不可被审查者批准。审查者失败、拒答、超时或低置信度不得批准。这不是确定性安全保证。第 11、20 项对已实现的 `decision/` Jev 仍然有效：该路径只能收紧，不得改造成这个审查者。工程工作流门与按会话固定的 advisory 注入保留，不并入安全审查者，注入失败不改变沙箱或审查裁决。详见 `docs/security-shape.md`。
22. （2026-11-01）人通过现有多维规则表编辑规则，不新增谓词操作符、正则路由或表达式语言。`dimension` 只是标签；`policy_class`、`enforcement`、`level`、`on_hit`、`expressivity`、`scope`、`ttl`、`owner` 在编译时决定规则进入沙箱快照、工程护栏还是动态注入。七个命中条件操作符保持冻结。`owner: agent` 的规则永远不能进入强制快照。收紧可以发布到下一次会话；删除、排除、放宽工作区、把 `deny` 改成 `confirm` 或 `log` 也只能由人发布到下一次会话。运行中的会话保持启动时钉住的快照。Agent 与审查者都不能发布。仓库内的 `constraints/rules.yaml` 是人的编辑格式和草稿，不是已经隔离的权威源；把它包进数据库也不构成沙箱。`scope` / `owner` / `policy_class` 的运行期选择仍未实现，不能当成已有能力。本项取代第 14 项里“人必须经提案审批才能改规则”和“YAML 不再是日常编辑格式”：单人编辑入口就是这张多维表。Agent 不能直写权威表仍然有效。本项也取代第 17 项的实现顺序：下一刀是宿主信封，不是先做控制面数据库。第 17 项“不能把 YAML 包进数据库或把插件移到全局目录就宣称完成”仍然有效。
23. （2026-11-01）第 21、22 项是目标形态，不解除第 12 项的运行期强制执行 NO-GO，也不授权在现有插件里打开安全 `deny` / `confirm`。下一刀只做宿主信封：越界请求在被停住之前没有执行器，且项目文件不能制造这个执行器。审查者不得先于这个信封实现。普通 `pi` / OpenCode 的插件 flag 不是这个形态。
24. （2026-11-01）产品就是三块，不互相替代。第一块是第 21 项的 Approve for me。第二块是多维拦截规则：内置标准集是 `constraints/rules.yaml`，人可以在同一格式上追加或收紧，不能删除或削弱 0 层标准拒绝，也不能用自定义规则关掉沙箱；Shell 封闭子集属于内置标准，不是用户表达式。第三块是动态注入：把版本化工程规范按区域、路径和任务选进模型上下文；prompt 不能引入规范，注入失败不改变拦截或审查裁决。第二、三块已有草稿。第一块未实现。不要把控制面、治理台或插件模式写成这三块之外的第四个产品。
25. （2026-11-02）Codex 接入不重做沙箱。Codex 的 `workspace-write`、`on-request` 和 `auto_review` 就是 Approve for me 宿主。Amos 把内置标准集和人编辑的多维规则编译到用户层 `~/.codex/` 或组织 `requirements.toml`，不把权威只放在仓库 `.codex/`。工程规范经用户层 `SessionStart` 注入。`PermissionRequest` 只处理 Codex 已经停住的请求：确定性 `deny` 必须拒绝，confirm 类才可由审查者批准这一次；钩子不决定则交给 Codex 自己的审查。`PreToolUse` 只拒绝 0 层，不用于批准。钩子失败可能不阻断，因此钩子不是沙箱。Pi 与 OpenCode 的 NO-GO 不因 Codex 接入而解除。
26. （2026-11-02，用户确认 GUI 后配置全部入 SQLite）产品仍是 Approve for me、内置标准加用户多维规则、动态工程规范注入三块。GUI 阶段全部 **Amos 所有的配置** 以受保护服务持有的 SQLite 为唯一事实源，包括规则、项目激活、规范/路由/预算、护栏、宿主/审查者非秘密配置、rollout/probe/TTL 和运维配置。GUI 通过已认证类型化 API 编辑/提案/批准，不能直接写 DB 或执行任意 SQL；Agent 仅有提案权。Git/YAML/JSON 仅导入、导出、fixture 或审计归档，不作为发布前提，不与数据库双主。凭据材料在独立秘密存储、库内只存引用；定位服务及信任根的最小启动引导和宿主必须的原生配置可以在库外，后者是受保护的生成投影。此项取代第 22 项中 YAML 作为长期日常编辑入口、第 14 项中存储流程与本项不符的部分，以及旧设计“控制台只浏览/提案，修改必须走 Git”的安排；隔离要求不降级。现有文件加载行为和本地凭据配置在迁移完成前不改。
27. （2026-11-02）两通道必须源于同一个不可变项目激活快照。全局规则库、项目激活集、任务注入集严格分开。必选标准基线显式列入激活集，项目不能排除标准 0 层拒绝；其他规则按 ID/版本激活。未激活规则既不评估也不新注入。引擎评估当前项目全部适用的可执行规则，按真实检查点和 rollout 分实拦/shadow，不受 prompt、路由或注入预算筛选。硬规则 narrative 可派生到 advisory 投影，纯 advisory 不产生裁决；`enforcement` 不因附带叙事变成双语义枚举。检测仅建议，失败不自动停用；替换失败保留同项目最后有效快照、首次失败不开受管执行。此项细化第 15、18、19、22 项；guidance pack 只是迁移种子，不是长期第二规则库。
28. （2026-11-02）批准基版按会话固定；普通编辑和放宽只对以后会话生效。唯一运行中变化是受信发布器按人的显式预授权，追加已批准模板的有限 TTL 临时限制，保留旧规则、通过配额与 rollout 校验，不触碰 0 层、不自动发布新叙事。Agent/安全审查者不持有发布能力；`owner` 是来源，不是认证。新增/到期产生双投影原子切换的不可变 epoch，异步批准在执行前重新核验 epoch/TTL；重复提交、重启、失败回退不续期。到期是预先批准的生命周期结束，不等待后台 Git revert。放宽、删除、降级、续期/永久化与不能证明单调性的改动转人批；glob 变窄不能一概叫收紧。此项取代第 18、22 项中“任何收紧只能人发布到下一会话”和“整个运行期永不变”的笼统限制，不取代 Agent 无直接写权、工程 Jev 只能收紧及安全 NO-GO。
29. （2026-11-02）语言语义规则由受保护的 AST/编译器/linter runner 产生绑定 tree/blob、检查版本、规则版本及检查点的结构化 finding；引擎不跑解析器、不信任模型/自由文本诊断。当前三字段 action 和七算子无法表达 finding，不往旧 Schema 偷塞新字段。后续独立版本化 check-binding/纯求值扩展需专门 ADR；未实现前保留 advisory 或独立工程检查。可绕过的 pre-commit 只能反馈，真正接纳点必须由受管宿主或受保护 CI 兜底；CI 只能拒绝接纳，不能追回先前副作用。
30. （2026-11-02）规则激活不等于强制。rollout 单独记录 `draft`、`log_only`、`selective_deny`、`confirm_enabled`、`retired`，绑定规则/激活配置/执行入口/环境及真实 probe 证据。先验证宿主能停止，再由人评审第一个 0 层实拦范围；confirm 协议在此之后，独立安全 reviewer 只能处理已停止且没有任何实拦 deny 的请求。新规则不能因 TTL 或自动收紧跳过 probe；文字 `probe`、单测或模型总结不是晋升授权。授权先写受保护持久审计，执行结果另记，失败不执行；同域 hash/SQLite 不等于外部防篡改。当前 JSONL 观察器吞审计失败的行为只属于 Stage A，不可复用为目标强制语义。
31. （2026-11-02）按 P1 项目激活双投影（离线）→ P2 一类真实宿主执行/审计边界 → P3 GUI/SQLite 单主配置与接收回执 → P4 真实 probe/人审选择性 deny → P5 单次 confirm 与独立 reviewer → P6 临时收紧 → P7 一个语言检查点交付；护栏和注入全程保留。不合并预建模块来代替每片可运行证据。第 25 项具体 hook 名称/API 是候选接入点而非已核验适配器保证，须锁定宿主版本并用真实 probe 验证；不能无损映射的规则报 unsupported。SQLite 对宿主是受保护配置生成源，不声称宿主直接读取它。旧 archive v1 digest 与 JSONL v2 保持兼容，新格式显式升版并关联旧 digest。GUI、数据库和文档完成均不解除第 12 项 NO-GO。

32. （2026-11-02，最新目标）减少逐次人类介入：所有门禁的日常放行由系统依据人维护的多维规则表、确定性检查和适用时的独立 Jev 审查自行决定；人负责规则、安全边界、架构和工程标准，而非逐个审批动作、变更或 rollout 晋升。此项取代第 30、31 项要求逐次人审晋升和先人工单次审批的目标，以及其他文档与之冲突的日常人审要求；历史实现与证据保留。人设置的规则与预授权仍是治理权，不是每次放行的人审。任何实拦 `deny`、失败检查或宿主硬边界不得被模型翻转；证据不足、审查失败/超时或不支持的入口保持停止，不自动转人工放行。安全 confirm 仅由独立 Jev 角色审查已停止、可升级的一次请求；现有 `decision/` tighten-only 路径不变，先证明真实宿主与审计边界才能实现。工程完成/合并同样以自动证据和 Jev 为目标，但当前 OpenCode 无真实 settle/merge 阻断点，不能称已自动强制。模型可能误判，自动化目标不是安全证明。

33. （2026-10-30，本地治理实现记录；合并时保留第 21–32 项目标编号）用户确认先交付单机单人的本地治理产品，再建设独立 OS 身份与受信执行层。`control-plane/` 使用独立 Node HTTP 服务及 SQLite，原 `console/` 提供中文规则编辑、提案、审批发布、版本与回滚界面，不引入 HTTP 框架或 ORM。所有规则治理变更必须通过不可变提案；“批准并发布”原子生成新版本和审计，回滚也是新提案、新版本。human 与 agent 使用分离的访问能力，agent API 不可审批；单人模式允许人类审批自己起草的提案，不宣称四眼审批。状态默认在工作区外，但同 UID 可读写仍不构成隔离；本地发布不修改 Harness 配置、不放行单次动作，第 12、17 项的强制执行 NO-GO 不变。此处记录已实现的本地治理范围，不取代第 26–32 项目标、实现顺序或自动门禁设计，也不表示全部配置已迁入 SQLite。详见 `docs/local-governance.md`。

34. （2026-11-01，本地前端实现记录）用户确认 Neuralyn 仅作为视觉风格参考，不作为独立的营收、计费或分析产品保留。实际界面仍是 Amos 本地治理控制台：Vue 前端源码位于 `web/`，使用 npm workspace 管理，预编译后由既有 Node 服务同源提供，替换旧 `console/` 页面；不新增 HTTP 框架或 ORM。页面只使用现有治理 API 的真实数据与状态，不以本地模拟数据填补未实现功能。静态资源采用构建生成的封闭清单，严格 CSP、Host/Origin/CSRF、人类与 Agent 权限分离及第 33 项的本地治理语义不变；前端迁移不表示受信执行层、自动 Harness 激活或运行期强制执行已经实现。控制台是三块产品的治理界面，不是第四个独立产品。

35. （2026-10-31，受限 Harness 实现记录；合并时消除原重复编号 21）用户确认优先实现 Harness 内严格管控，而非仅由模型判断恶意。保护域包含本 Harness 发起的全部动作，不能把它启动的 Shell、MCP 或子 Harness 作为外部旁路。首个可验证实现限定为受控 Pi SDK 宿主及内存工作区：仅显式开放结构化文件工具，关闭原生 Shell、网络工具、MCP、扩展和项目资源发现，变更只暂存、由宿主显式导出；因此不声称原生文件系统或 OS 隔离。普通 Pi/OpenCode 插件不支持严格模式，不能静默降级。策略按 session 固定，审计失败停止执行，confirm 没有真实批准通道就不执行，Jev 仍只能收紧；这不解除第 12 项对完整原生执行域的 NO-GO，也不取代第 21–32 项的后续目标。详见 `docs/strict-harness.md`。

## 当前实现约束

- `opencode.jsonc` 显式传入规则、Schema、日志路径和 `log-only` 模式；Pi 通过 `ctx.cwd` 定位 `.pi/amos.json`，两个适配器都不依赖进程 cwd。
- 无法结构化的 patch/未知 payload 在 log-only 中记录 `unknown_payload`；已知但不属于当前文件通道的工具生成 `not_evaluated` 覆盖记录，不再静默跳过。OpenCode 的非文件工具和 Pi 的 `shell_input` 均为不可确认的覆盖缺口，命令文本不进入日志，空白命令记 `parse_error`。
- 文件 target 在进入引擎前必须是已折叠的绝对路径。引擎拒绝 `//`、`.`、`..` 和末尾 `/`，不在热路径做 realpath。`${SESSION_WORKSPACE}` 是唯一允许的规则替换，只作用于 `target_glob`/`target_outside_glob` 的 patterns；缺失或非法 workspace 使快照加载 fail closed，digest 同时绑定规则原文和有效 workspace。
- 原始 JSONL 通过追加接口写入，但“只追加”不等于防篡改：具备文件写权限的主体仍可截断或重写。派生样例可以重建，但不能回写原始日志。
- OpenCode 与 Pi 只共享归一化结果、快照评估和 JSONL 记录；各 harness 的 deny、confirm、权限 UI 与事件生命周期保持独立，不建立模型 provider 抽象。
- Pi 的 `tool_call` 可用于执行前 block，但安全策略当前仍仅启用 log-only；独立的工程工作流门可选择启用。Pi 没有原生 permission 体系，工作流门的 confirm 依赖 UI，非交互模式 fail-closed；bash 原始命令、`pi.exec`、扩展组合、`--no-extensions` 等旁路仍未完整接管。
- 工程工作流门由 `.pi/amos.json` 或 OpenCode 插件 options 中的 `workflowGate` 独立启用；缺失表示关闭，显式配置错误对有门控动作 fail closed。Jev 凭据、配置路径和公开限制见 `docs/workflow-gate.md`。

## 负约束

不修改或依赖 Termcp；除已明确解锁的 Pi 外不继续扩展 harness；不做正则路由、自研 DSL、规则市场或对外协议冻结。不得为了架构观感改变 deny > confirm > log > allow、同层 deny 和 fail-closed 语义。已实现的 Jev 路径仍然不是裁决者。目标形态里的安全审查者只处理沙箱已经停住的 confirm 类越界，不能代替引擎，也不能先于沙箱实现。
