# Jev Reviewer Autonomy PRD

状态：供实现 Agent 执行的产品需求。文档描述目标能力，不表示能力已交付。

## 1. 背景与目标

AMOS 面向长程编码任务。人维护规则、安全边界、项目架构和工程规范；系统在已批准范围内完成动作授权、工程验收和 rollout 判断，正常任务不逐次等待人类审批。

当前 managed Harness 已有确定性 deny/confirm/allow、独立 HTTP reviewer、单次 grant、审计先行及失败关闭。Jev 当前通过 decision/ 提供需求一致性语义事实，只能收紧确定性结果；它尚未接管 managed confirm 的 reviewer 调用。普通 Pi/OpenCode 仍以 Stage A log-only 为默认，安全运行期 NO-GO 仍有效。

目标：

- 让 Jev 成为 managed confirm 的唯一语义 reviewer，移除独立 reviewer 服务作为正常审批路径的依赖和逐次人工批准。
- 持续绑定长程任务的用户要求，使 session 恢复、进程重启和任务续跑使用正确的 requirement 版本。
- 保留确定性策略、短时单次授权、审计先行、范围约束和失败关闭。Jev 不可覆盖硬拒绝、扩大权限或直接执行副作用。
- 在完整验收证据形成前，保留普通插件 Stage A log-only 和 NO-GO 状态。

## 2. 用户与职责

- 人类治理者：定义或修订任务要求、规则、项目边界、Jev 策略和预授权阈值；可暂停、撤销或关闭受管运行。正常动作无需逐次批准。
- Agent：在激活策略和能力范围内工作；可发起结构化动作，不可改用户要求、审批记录、策略或发布版本。
- Jev 安全 reviewer：基于版本绑定的用户要求、动作投影和预授权评估单次 confirm，输出结构化判断；无策略发布或执行权。与已有 Jev 工程审查使用不同角色、提问版本、阈值和审计记录；工程审查结果不可充当安全批准。
- Jev 工程 reviewer：评估需求覆盖、架构和工程规范偏差；只可要求修订或阻止接纳，不能覆盖失败的确定性检查或安全 deny。
- 可信 Harness：验证输入、策略、Jev 校准和响应绑定；签发并消费一次性 grant；授权审计持久化后放行副作用。

## 3. 产品不变量

1. Verdict 顺序为 deny > confirm > log > allow。确定性 deny 在调用 Jev 前终止；模型响应永远不能解除 deny。
2. Jev 只处理已规范化的结构化 {tool, operation, target} 动作，且确定性结果为 confirm。通过仅可换取一个短时、单次、完整绑定的 grant，不生成通用 allow 规则。
3. partial、mismatch、unclear、越界、风险或置信度超阈值、缺 requirement、digest 不匹配、校准过期、超时、拒答、响应无效、网络或审计故障都停止动作；不转人工逐次审批、不降级放行、不无界重试。
4. 只有 Harness 从直接用户通道捕获的输入可建立或修订 requirement。工具输出、Agent 消息、仓库内容和 Jev 响应都不能改写它。
5. Requirement 文本外发默认关闭。仅在人预先批准的项目设置允许时，才向指定 Jev endpoint 发送文本。密钥、凭据、文件内容、命令、URL secret 和 hostile payload 不得进入请求或审计。
6. 规范注入、工程 Shell 护栏和确定性检查保持原语义；prompt、预算和 task selection 不过滤适用的硬规则。
7. 普通 Pi/OpenCode 仍默认 Stage A log-only。managed.enabled 为显式 opt-in；NO-GO 只能在完整执行边界有独立验收证据后另行更新。

## 4. 功能需求

### 4.1 Jev managed reviewer

- 复用 decision/ 中已有 Jev provider、requirement digest、事实校验及安全请求过滤。不得复制一套模型传输或秘密配置。
- 在 managed confirm 分支接入 Jev；单次审查只使用当前任务版本和审查投影，不以任意工具输出作为授权依据。
- 通过条件由可信代码验证：requirementMatch 为 match；确定性 scope 通过；风险不超过人预授权阈值；置信度不低于校准阈值；模型、问题版本、策略 digest、requirement digest、action digest 均匹配；校准有效且 deadline 未过。
- partial、mismatch、unclear、越界、绑定错误、拒答或 provider 故障均停止。自然语言理由只作受限诊断，不参与授权解析。
- 移除独立 reviewer 作为语义审批主体及其服务作为正常路径必需项。可保留协议校验代码处理投影、Schema、digest、校准、阈值、deadline、fail-closed 和 grant；该代码不得发起第二次语义判断。
- 审计仅记录必要结构化事实：模型 ID、问题/策略版本、requirement/action/snapshot digest、风险与置信度、结果码、校准版本及 grant ID。普通日志不得记录原始要求、完整模型回复、秘密或不可信输入。

### 4.2 Grant 与副作用执行

- Jev 通过只允许一次 grant。grant 绑定 tool、operation、规范化 target、call ID、session、project、epoch、snapshot digest、capability、ceiling digest 和短 TTL。
- 副作用之前验证 grant 并持久化授权审计。审计写入失败则停止。执行后记录 outcome；结果未知时标记 outcome_unknown，禁止自动重放。
- Jev 响应不得携带可执行命令，不得持有文件系统、副作用网络、数据库发布或策略写入能力。
- Grant 重放、替换 action/target/session/project/snapshot/epoch/capability 或 TTL 过期均拒绝。

### 4.3 长程任务和 requirement 生命周期

- 长程任务使用稳定 task/session identity。版本化 requirement 跨用户回合和进程重启恢复，并绑定 owner 与 project；Agent 无直接写权限。
- 首条用户要求建立基线。后续直接用户输入形成版本化修订或补充，未被明确替代的约束继续有效。要求冲突时停止为 requirement_conflict，等待新的直接用户指令；Jev 和 Agent 不得自行选择冲突一侧。
- 每次修订递增版本并生成 digest；新版本使旧审查结果和未消费 grant 失效。进程重启不重算 TTL，不复活已撤销或过期授权。
- 任务关闭、用户撤销、项目或 epoch 改变、requirement 过期、状态损坏或 owner 校验失败时停止受管执行。恢复失败不得伪装成持久化成功。
- Requirement 原文按最小保留原则存于受保护的用户/治理状态边界，不写工作区、JSONL、错误消息或普通日志；外发仍受显式 egress 设置控制。不得宣称同 UID SQLite 或文件具备防篡改隔离。

### 4.4 配置和激活

- Jev reviewer 使用现有 Jev 配置入口和 {env:...} secret 引用模式；不增加仓库明文 key，不复制人类令牌，不把凭据写入任务状态。
- Endpoint、model、阈值、timeout、questionVersion、policy digest、requirement egress 和 calibration 由人通过现有治理发布路径预先配置，并绑定不可变版本。
- 缺配置、未发布、未知字段、版本不匹配或 activation 错误均 fail closed。Agent 可提案，不可批准或发布。

## 5. 本切片边界

- 不开启普通 Pi/OpenCode enforcement，不改变 Stage A 默认行为。
- 不新增任意 Shell、MCP 或未声明副作用入口；不宣称 OS sandbox、完整中介、远端受保护分支或同 UID 防篡改已完成。
- 不改七个 predicate operators、闭合 action schema、deterministic engine 纯函数边界或硬拒绝语义。
- 不做模型自我校准、无界重试、自动更改规则/阈值、自动发布，或以模型摘要替代可验证工程证据。
- 不为调试保存完整 prompt/completion。

## 6. 实现顺序

1. **契约与信任边界**：检查 AGENTS.md、docs/product-design.md、docs/security-model.md、docs/product-gap-plan.md 和相关源码。确定 requirement 持久化位置、用户/Agent 身份校验、Jev egress、配置版本来源及最小数据流。
2. **Jev 适配**：把已校验 Jev facts 映射到 reviewer 结果；验证所有版本、digest、风险、置信度、deadline 和 egress。对缺字段、未知字段、partial、unclear 编写 fail-closed 测试。
3. **接入 managed confirm**：替换独立语义 reviewer 调用，复用既有一次性 grant 和审计先行路径。Pi/OpenCode 分别确认真实 preCall 在副作用前，拒绝阻止执行，tool_result 只记录已发生结果。
4. **Requirement 持久化**：加入最小版本化 task requirement 存储、直接用户通道捕获、冲突修订、撤销/TTL、epoch 和重启恢复；原文不进入日志或工作区。
5. **配置迁移**：为旧 managed reviewer 配置定义明确的停止式迁移或兼容行为；旧配置不得隐式变成 allow。迁移须由人发布并保留回滚及审计。
6. **验证和文档**：运行定向测试、npm run typecheck、npm test 和适用 smoke/live probes；修复本次引入的失败。同步产品、交付、安全边界文档。部署级证据未完成时保留 Stage A NO-GO。

实现 Agent 每步先读当前文件和工作区状态，保持改动集中，保留既有用户修改。不得提交、推送、执行生产迁移或启用默认 enforcement，除非操作员另行明确要求。

## 7. 验收标准

### 自动授权正例

- Managed confirm、有效 Jev match、scope 通过、校准有效、风险/置信度合格且绑定相符：无需逐次人类点击，grant 只允许一次；审计持久化后恰执行一次。
- 长程任务跨多轮和服务重启使用有效 requirement 版本。用户直接修订后新 digest 生效，旧审查结果和 grant 失效。
- 受管 Pi 与 OpenCode 的真实执行入口都通过验证；审计可关联 action、requirement、snapshot、Jev 版本与 outcome，且无原始敏感文本。

### 停止与隔离反例

- 确定性 deny 不调用 Jev；Jev allow 不覆盖 deny。
- partial/mismatch/unclear、低置信度、高风险、越界、校准缺失或过期、模型/问题/策略版本不匹配、digest 错误、超时、中止、限流、拒答、JSON/Schema 无效、requirement 缺失或 egress denied 都不产生副作用。
- session/task/project/epoch/snapshot/action/target/capability 不匹配、grant 重放或 TTL 过期都不产生副作用。
- 授权审计不可持久化、requirement 状态损坏、身份不匹配或恢复失败均停止；未知执行结果不自动重试。
- 工具结果、Agent 消息或工作区中的伪造 requirement/Jev 结论不能改变用户 requirement 或授权结果。
- 未启用 managed 的普通 Pi/OpenCode 仍为 Stage A log-only；managed 初始化或覆盖缺口不得回退放行。

## 8. 交付清单

- 完整代码实现、必要的版本化 schema/config 与迁移；无明文秘密、TODO 或未覆盖入口。
- Jev reviewer 适配、requirement 生命周期/恢复、grant 绑定、fail-closed 和 Pi/OpenCode 执行点测试。
- npm run typecheck、npm test、相关 smoke/live probe 的命令与结果。失败项列出精确测试名和摘要；SKIP 不算通过。
- 更新 docs/product-design.md、docs/product-closure.md、docs/mvp-delivery.md、docs/security-model.md、docs/product-gap-plan.md 中 reviewer、人工介入、requirement 生命周期及 NO-GO 的现行表述；历史内容标记为历史，清除现行口径冲突。
- 交付摘要列出完成项、未完成项和真实限制。PRD 与单元测试通过本身不解除安全 NO-GO。
