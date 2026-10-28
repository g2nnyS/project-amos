# 产品与工程决策

来源：2026-10-24 整合版产品与工程指令，以及《Agent 行为约束系统 — 设计文档》。本文件记录当前实现边界，不代表阶段门禁已经通过。

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
11. （2026-10-28）Jev 等决策模型只作为概率化语义传感器，输出类型化事实，不拥有策略或执行权。确定性引擎是权威，模型只能收紧 verdict；需要评估时模型失败或低置信度必须 fail closed。
12. （2026-10-28）在受信任监督进程、完整动作覆盖、真实文件系统执行边界和认证审批落地前，项目状态为运行期强制执行 NO-GO；log-only 结果只能作为观察数据，不能作为安全保证或自动放行依据。
13. （2026-10-29）新增独立的、显式启用的工程工作流门，与安全 `log-only` 策略层分离。它可注入版本化工程规范、阻断或要求确认危险 Shell、运行固定本地检查，并在变更后执行可选 Jev 审查；不得据此宣称安全边界或完整动作覆盖。Shell 判定只接受封闭子集，未知、PowerShell、自定义 shell/prefix 或分析错误必须 fail closed。Jev 配置支持 TypeSafe 与 OpenRouter System One 的 `baseUrl`、模型 allowlist 和凭据引用；共享配置只能引用环境变量，直接凭据只允许受保护的本地 `decision/jev.local.json`（属主当前用户、POSIX mode 0600）。OpenCode V2 缺少真正的 settle/merge 阻断点，其完成审查只能作为 advisory feedback；Pi 每个会话最多一次修复续跑。运行期安全强制执行的 NO-GO 状态不变。
14. （2026-10-29）目标架构的权威策略与治理源改为位于 Agent 可写域之外的受信控制面数据库，取代第 3 项中 YAML、JSONL 和 SQLite 的原有存储定位。Git 只保存控制面对已批准版本生成的归档与审计导出；YAML 只作为导入、导出、测试 fixture 和 CI 审查格式，不再是日常治理入口；JSONL 只保留为现有观察管道或导出格式，不再是目标架构的原始审计事实源。控制面的逻辑模型分为规则定义与版本、项目激活与排除、提案/审批/审计/TTL 治理、编译策略快照四层；`dimension` 是字段或字典，不按维度拆物理表。Agent 与人类 UI 均只能经提案和审批流程修改治理状态，不能直写权威表。
15. （2026-10-29）执行引擎继续保持纯函数，热路径只消费经过验证的不可变编译快照，不查询控制面数据库。快照 digest 提供内容标识和完整性校验，不单独提供来源认证；来源认证必须由受信控制面签名或等效的受信清单机制提供，密钥、快照及其激活指针均不得由 Agent 修改。快照身份必须绑定编译内容、Schema/编译器版本和项目激活集；回滚与撤销通过受信控制面发布新的已批准版本完成，不能靠 Agent 替换文件或指针。新快照验证失败时保留最后正常快照、首次失败时 fail-closed 的现有语义不变，但运行期强制执行仍须满足完整动作覆盖和受信执行边界。
16. （2026-10-29）单机控制面可采用 SQLite，但必须由独立服务持有，存放在项目工作区之外，并通过独立 OS 身份和受认证 IPC 与 Agent 隔离；同一 OS 用户下的目录权限、`0600`/`0700` 或签名文件都不构成对恶意 Agent 的信任边界。团队阶段可替换为 PostgreSQL，不改变权威源位置。全局 Harness 网关/Supervisor、执行 mediator、策略与审计存储、网关二进制和配置都必须位于 Agent 可写域之外；`.pi/`、`opencode.jsonc` 和项目级 `workflowGate` 只能承担本地偏好或工程护栏，不能决定是否启用安全门禁。Agent 只能提交结构化 action，未经 mediator 的 Harness、Shell、网络、MCP、凭据及替代入口必须在声明的保护域内被禁用或覆盖。
17. （2026-10-29）上述决策目前仅是目标架构，不表示控制面、数据库、全局网关、签名快照或 OS 执行边界已经实现。当前仓库仍是 Stage A `log-only` 观察原型，项目级 `workflowGate` 仍是可选工程护栏；第 12 项运行期安全强制执行 NO-GO 不变。后续实现先做权威源和快照迁移，再接入受信执行面与完整动作覆盖，不能仅把现有 YAML 包装成数据库或把项目插件移到全局目录就宣称完成。

## 当前实现约束

- `opencode.jsonc` 显式传入规则、Schema、日志路径和 `log-only` 模式；Pi 通过 `ctx.cwd` 定位 `.pi/amos.json`，两个适配器都不依赖进程 cwd。
- 无法结构化的 patch/未知 payload 在 log-only 中记录 `unknown_payload`；已知但不属于当前文件通道的工具生成 `not_evaluated` 覆盖记录，不再静默跳过。OpenCode 的非文件工具和 Pi 的 `shell_input` 均为不可确认的覆盖缺口，命令文本不进入日志，空白命令记 `parse_error`。
- 文件 target 在进入引擎前必须是已折叠的绝对路径。引擎拒绝 `//`、`.`、`..` 和末尾 `/`，不在热路径做 realpath。`${SESSION_WORKSPACE}` 是唯一允许的规则替换，只作用于 `target_glob`/`target_outside_glob` 的 patterns；缺失或非法 workspace 使快照加载 fail closed，digest 同时绑定规则原文和有效 workspace。
- 原始 JSONL 通过追加接口写入，但“只追加”不等于防篡改：具备文件写权限的主体仍可截断或重写。派生样例可以重建，但不能回写原始日志。
- OpenCode 与 Pi 只共享归一化结果、快照评估和 JSONL 记录；各 harness 的 deny、confirm、权限 UI 与事件生命周期保持独立，不建立模型 provider 抽象。
- Pi 的 `tool_call` 可用于执行前 block，但安全策略当前仍仅启用 log-only；独立的工程工作流门可选择启用。Pi 没有原生 permission 体系，工作流门的 confirm 依赖 UI，非交互模式 fail-closed；bash 原始命令、`pi.exec`、扩展组合、`--no-extensions` 等旁路仍未完整接管。
- 工程工作流门由 `.pi/amos.json` 或 OpenCode 插件 options 中的 `workflowGate` 独立启用；缺失表示关闭，显式配置错误对有门控动作 fail closed。Jev 凭据、配置路径和公开限制见 `docs/workflow-gate.md`。

## 负约束

不修改或依赖 Termcp；除已明确解锁的 Pi 外不继续扩展 harness；不做正则路由、自研 DSL、LLM 裁决、规则市场或对外协议冻结。不得为了架构观感改变 deny > confirm > log > allow、同层 deny 和 fail-closed 语义。
