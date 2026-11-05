# 当前产品与工程决策

本文只记录当前采用的实现语义和边界。

## 安全状态

- 安全策略适配器保持 Stage A `log-only`；计算出的 verdict 仅供观察，不阻止工具执行。安全运行期强制执行状态为 **NO-GO**。
- 可选工程工作流门与安全策略分离，只覆盖已实现的封闭子集；OpenCode 的完成反馈是 advisory。`opencode.jsonc` 中 `workflowGate.enabled` 当前为 `false`。
- 安全敏感变更需要人工审查。不能把离线测试、审计文件权限或模型输出当作安全放行依据。

## 当前实现语义

- 引擎保持纯函数并使用注入时钟；裁决优先级为 `deny > confirm > log > allow`，异常按既定 fail-closed 语义处理。
- 现有七种谓词操作符保持不变。只有 `predicate`、`on_hit` 与 `ttl` 参与规则裁决；其他字段是经校验的元数据。
- `constraints/rules.yaml` + `guidance/packs.ts` 是全局 catalog 的仓库输入；项目发布版本是受管入口的运行期权威。旧观察模式仍可读旧文件，但不是 managed 的静默 fallback。
- P1 catalog v2 由控制面在发布时编译；Pi managed 入口消费同一 activation snapshot，执行与注入同源。默认适配器仍 log-only，未启用 managed 时不改变运行行为。
- Jev 是可选语义传感器，输出类型化事实，只能收紧确定性结果，不能授权执行。requirement 文本仅在 harness 捕获的 frame 显式允许时出境；caller-supplied `context` 不会自动脱敏。
- 文件目标只进行词法规范化；JSONL 追加和摘要归档不提供防篡改保证。不得记录文件内容、Shell 命令文本、URL secret 值或原始 hostile payload。

## one-shot 新增模块（默认关闭）

- `activation/runtime.ts`：对现有 `amos-unified-rule-catalog` v2 snapshot 做
  结构验证、身份绑定和 runtime/execution 视图；不是来源认证。
- `host/`：可选闭集文件执行器、能力/路径检查、审计前置；不是 MVP 默认
  路径，OS 隔离不是本轮要求。
- `review/`、`managed/`：最小有界投影、独立 reviewer（本地确定性/HTTP/真实本地模型）、
  一次性 HMAC 授权；Pi `managed` 是显式 opt-in 的真实 Harness 层拦截。
  默认仍 log-only；live probe 已对真实本地模型做 8 场景校准。
- `check/`、`rollout/`、`activation/tighten.ts`：精确 tree 检查合同、
  证据绑定晋升门、附加型临时收紧；均只在本地测试中使用。
- 治理 SQLite/API 由 `control-plane/` 提供；Vue 控制台已复用并完成真实浏览器闭环。

这些模块不改变 `deny > confirm > log > allow`、七算子、严格 Schema 或
log-only recorder 的 `defaultVerdict: deny`。Harness MVP 可在声明范围内
真实阻断，但不是 OS 沙箱、不覆盖全副作用、不提供防篡改审计；不得描述为
已认证生产边界。

## Harness 层 MVP（2026-11-05 用户裁决）

- MVP 限定为 Harness 层工具拦截；Pi `.pi/amos.json managed.enabled` 是
  显式 opt-in，默认仍 Stage A log-only。
- 规则引擎/项目快照裁决，deny 阻断，confirm 交独立 reviewer + HMAC 一次性
  grant，`tool_result` 记录；advisory 注入同源。
- **OS 隔离（独立 UID、挂载域、bwrap/cgroup、内核沙箱）本轮不做**，不是
  人工阻塞；不得宣称 OS 沙箱、全副作用覆盖或防篡改审计。
- G0/NO-GO 结论不由本 MVP 改变。

## 历史决策（dev 合并保留）

33. （2026-10-30，本地治理实现记录；合并时保留第 21–32 项目标编号）用户确认先交付单机单人的本地治理产品，再建设独立 OS 身份与受信执行层。`control-plane/` 使用独立 Node HTTP 服务及 SQLite，原 `console/` 提供中文规则编辑、提案、审批发布、版本与回滚界面，不引入 HTTP 框架或 ORM。所有规则治理变更必须通过不可变提案；“批准并发布”原子生成新版本和审计，回滚也是新提案、新版本。human 与 agent 使用分离的访问能力，agent API 不可审批；单人模式允许人类审批自己起草的提案，不宣称四眼审批。状态默认在工作区外，但同 UID 可读写仍不构成隔离；本地发布不修改 Harness 配置、不放行单次动作，第 12、17 项的强制执行 NO-GO 不变。此处记录已实现的本地治理范围，不取代第 26–32 项目标、实现顺序或自动门禁设计，也不表示全部配置已迁入 SQLite。详见 `docs/local-governance.md`。

34. （2026-11-01，本地前端实现记录）用户确认 Neuralyn 仅作为视觉风格参考，不作为独立的营收、计费或分析产品保留。实际界面仍是 Amos 本地治理控制台：Vue 前端源码位于 `web/`，使用 npm workspace 管理，预编译后由既有 Node 服务同源提供，替换旧 `console/` 页面；不新增 HTTP 框架或 ORM。页面只使用现有治理 API 的真实数据与状态，不以本地模拟数据填补未实现功能。静态资源采用构建生成的封闭清单，严格 CSP、Host/Origin/CSRF、人类与 Agent 权限分离及第 33 项的本地治理语义不变；前端迁移不表示受信执行层、自动 Harness 激活或运行期强制执行已经实现。控制台是三块产品的治理界面，不是第四个独立产品。

35. （2026-10-31，受限 Harness 实现记录；合并时消除原重复编号 21）用户确认优先实现 Harness 内严格管控，而非仅由模型判断恶意。保护域包含本 Harness 发起的全部动作，不能把它启动的 Shell、MCP 或子 Harness 作为外部旁路。首个可验证实现限定为受控 Pi SDK 宿主及内存工作区：仅显式开放结构化文件工具，关闭原生 Shell、网络工具、MCP、扩展和项目资源发现，变更只暂存、由宿主显式导出；因此不声称原生文件系统或 OS 隔离。普通 Pi/OpenCode 插件不支持严格模式，不能静默降级。策略按 session 固定，审计失败停止执行，confirm 没有真实批准通道就不执行，Jev 仍只能收紧；这不解除第 12 项对完整原生执行域的 NO-GO，也不取代第 21–32 项的后续目标。详见 `docs/strict-harness.md`。

## 配置

控制台通过 SQLite 管理发布版本；Pi managed 运行期读取发布产物 `.pi/activation.json`。旧文件配置仅用于观察模式/兼容，不是 managed 的回退。
安全适配器和工程工作流门的实现状态见[运行期状态](go-no-go.md)、[安全模型](security-model.md)及[工作流门](workflow-gate.md)。
