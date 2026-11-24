<h1 align="center">Project Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  智能体授权与监管系统
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

## Amos 提供什么

Amos 是一个本地运行的 AI Agent 治理与监管系统。

- **人类负责治理**：本地控制台统一管理全局基线与工作区项目、安全规则、工程规范、提案、审批、原子发布、版本历史、回滚、审计与草稿模拟。
- **系统在执行前裁决**：显式启用的 managed harness 门禁按已发布的项目快照评估归一化工具调用——`deny` 在工具执行前阻断，`confirm` 先停给有界 Jev 审查与一次性授权，`allow` 放行执行。
- **Agent 同时获得指导**：同一快照编译出 advisory 投影，按任务相关内容注入 `<amos-guidance>` 工程规范；注入不改变硬规则裁决。
- **每个决定都有记录**：脱敏审计记录与按 Harness 区分的运行期回执让覆盖范围与缺口可见；不支持的工具与黑盒 Shell 会被显式记录，绝不静默丢弃。

当前阶段：**Harness 层 MVP** —— Vue 治理控制台 · 可选 Tauri 桌面应用 · Pi 与 OpenCode managed 门禁（显式 opt-in）· 默认适配器 log-only。

> **安全边界**：默认适配器为 log-only。`managed` 模式是显式 opt-in 的 Harness 层门禁；它没有 OS 沙箱能力，未覆盖全部入口与副作用，审计也不防篡改。详见[安全模型](docs/security-model.md)与[运行期状态](docs/go-no-go.md)。

---

## 安装与验证

环境要求 Node.js 26 与 npm；桌面开发另需 Rust 工具链。

```bash
npm ci
npm run typecheck
npm test
```

可选的真实浏览器验收：

```bash
npm run e2e:smoke   # 需本机 Chromium
```

---

## 启动治理控制台

```bash
npm run console        # 构建并启动完整控制台
npm run console:serve  # 启动已有构建
npm run service        # 只构建并启动治理 API
```

打开服务输出的 `http://127.0.0.1:4310`。请保留 `127.0.0.1` 主机名以维持 Host/Origin 校验。首次打开时先设置并确认登录密码；浏览器会话粘贴一次 `human.token`，Tauri 自启动服务则通过私有 IPC 获得设置授权。之后使用密码登录。

默认状态目录：

```text
${XDG_STATE_HOME:-$HOME/.local/state}/amos-governance
```

目录内含 `governance.sqlite`、`human.token`、`agent.token`（设置密码后另有 `human-password.json`）。令牌文件属当前用户且权限 `0600`；切勿把令牌发到聊天、URL 或日志。同一状态目录同一时间只允许一个 `serve` 实例，重复启动返回 `service_already_running`。

自定义端口、状态目录或远程 SSH 隧道见[本地治理控制台](docs/local-governance.md)。

---

## 使用控制台与编写规则

1. **选择治理范围。** 内置 Global Project（`global`）维护所有工作区项目默认继承的共享基线；当某个仓库需要补充规则时创建工作区项目，并填写规范化绝对 workspace 路径。
2. **界面构建或 YAML 导入规则。** 使用控制台的 WAF 式条件构建器编辑规则，或导入版本化 `format: amos-project-policy` YAML。安全与工程规则分组展示，按封闭的 7 算子 Schema 校验，并支持按项目激活或排除。
3. **提交前先模拟。** 在模拟页或编辑器草稿面板中使用快速预设；预设可填充常见工具调用，直接对已发布版本或未提交草稿计算裁决，不执行真实工具。
4. **走治理发布流程。** 提交提案、查看差异、批准并发布。发布以单个原子操作向工作区写出 `<workspace>/.pi/activation.json`（P1 执行与 advisory 双投影快照）和 `<workspace>/.pi/amos.managed.json`（宿主配置投影）。
5. **运营版本与查看审计。** 导出 YAML/JSON、查看历史版本，需要时创建回滚提案（发布递增新版本，不改写既有历史）；在控制台直接查看治理事件与启动时配置的只读观察日志（`--audit-log`）。

### 使用 `amos-skill` 让 Agent 协助编写与验证规则

无需手工从零拼写 YAML 规则表，可以让你的编码 Agent 加载 [`amos-skill`](https://github.com/g2nnyS/amos-skill)（例如放到 `~/.claude/skills/amos-skill/` 或客户端的 skills 目录，或直接让 Agent 阅读其 `SKILL.md`）：

- **产出内容**：面向内置 `global` 基线或指定工作区项目的完整、可导入 `format: amos-project-policy` YAML 草案（包含 `activation`、`injection` 及 14 字段 `rules`，同时涵盖确定性 `deny`/`confirm`/`log` 硬规则与 `advisory_only` 工程规范）。
- **草案接入流程**：
  1. 查询当前规则表 Schema（`GET /api/schema`）；若修改既有策略，先导出当前已发布版本（`GET /api/projects/:id/versions/:n/export?format=yaml`）作为基线。
  2. 调用 `POST /api/projects/:id/import`（提交 `{"yaml": "..."}`）导入并校验完整文档，保留 `injection` 配置并取得返回的 `{valid, issues, candidate}`。
  3. 将同一个 `candidate` 传给 `POST /api/projects/:id/validate` 和 `POST /api/projects/:id/simulate`（提交 `{"candidate": ..., "action": ...}`），至少验证一个应命中与一个不应命中的正反例动作。
  4. 获得用户明确授权时，Agent 可使用 `agent.token` Bearer 凭据调用 `POST /api/projects/:id/proposals` 提交提案；**审批与发布（`POST /api/proposals/:id/decision`）始终由人类在控制台完成。**

控制台详情与 API 合同：[本地治理控制台](docs/local-governance.md) · [前端说明](web/README.md) · [`amos-skill` 规则编写指南](https://github.com/g2nnyS/amos-skill)。

---

## 接入 Agent Harness

### 1. 在控制台一键接入插件

在控制台打开 **Harness 检测**（`#/harnesses`）。对已探测到的 **Pi** 或 **OpenCode**，点击行内 **接入 Amos 插件**：

- **Pi**（`~/.pi/agent/extensions/amos.js`）：写入用户级扩展入口，一行转发到本仓编译后的 `dist/adapters/pi/index.js`，随 Pi 自动加载（Oh My Pi 兼容并复用该适配器）。
- **OpenCode**（`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`）：在全局配置中追加指向 `dist/adapters/opencode-v2` 的插件项（写入 `rulesPath`、`schemaPath`、`logPath` 绝对路径），保留原有插件与注释。

写入前界面会预览目标路径与完整内容；若已有文件内容冲突则拒绝覆盖。详见 [Harness 探测使用指南](docs/harness-discovery-usage.md)。

### 2. 项目模式与宿主投影（`.pi/amos.managed.json`）

项目在控制台发布或更新配置后，工作区会生成 `<workspace>/.pi/activation.json` 与 `<workspace>/.pi/amos.managed.json`：

- **Pi** 与 **OpenCode** 启动时都优先读取 `.pi/amos.managed.json`。该文件携带控制台解析后的项目模式（`log-only` 或 `managed`）、`advisoryInjection` 开关、`configDigest` 以及 Jev 审查与工程工作流门配置。
- 当项目启用 `mode: "managed"` 时，归一化文件与检索工具调用在执行前按激活快照裁决（`deny` 执行前阻断，`confirm` 先停给 Jev 语义审查与一次性 HMAC grant，`allow` 放行执行），同时从同一快照注入 `<amos-guidance>`。
- 适配器加载快照与评估工具时会写出 `<workspace>/.pi/runtime.pi.json` 或 `<workspace>/.pi/runtime.opencode.json` 回执，控制台据此展示各 Harness 是 `loaded`、`stale` 还是 `never`。
- 未生成项目投影时，适配器保持默认 Stage A `log-only` 观察模式（记录脱敏假设裁决与覆盖缺口，不阻断工具执行）。

适配器与配置说明：[配置迁移与受管启动](docs/configuration-one-shot.md) · [Pi 适配器说明](docs/pi-adapter.md) · [OpenCode V2 接入笔记](spike/README.md) · [工作流硬门](docs/workflow-gate.md)。

---

## 可选桌面应用

控制台也可以作为 Tauri 桌面应用运行：

```bash
npm run tauri:dev    # 开发模式；需 Rust 工具链
npm run tauri:build  # 生产构建
```

浏览器控制台是主要支持路径。当前桌面产物仍属开发阶段：没有 Developer ID 签名与 Apple 公证配置时，macOS Gatekeeper 可能拦截下载的 DMG。签名与公证流程完成前，请勿分发桌面产物。

架构与打包细节见 [src-tauri/README.md](src-tauri/README.md)。

---

## 命令速查

| 命令 | 用途 |
| --- | --- |
| `npm run console` | 构建后端与控制台并启动 |
| `npm run console:serve` | 启动已有构建 |
| `npm run service` | 只构建后端并启动治理 API |
| `npm run build` | 编译后端（`dist/`）与控制台（`dist/console/`） |
| `npm run typecheck` | 后端与控制台类型检查 |
| `npm test` | 构建并运行后端与控制台测试 |
| `npm run e2e:smoke` | 可选真实浏览器验收 |
| `npm run tauri:dev` | 开发模式启动桌面应用 |
| `npm run tauri:build` | 构建桌面产物 |

---

## 把这套机制直接集成到你自己的 Harness

如果你正在开发或维护自己的 Agent Harness，希望直接接入 Amos 的治理投影、执行前门禁与动态规范注入，可以按内置 Pi（`adapters/pi/`）和 OpenCode V2（`adapters/opencode-v2/`）适配器所遵循的五步契约完成集成：

### 1. 读取控制台发布的工作区产物

在目标项目工作区根目录读取治理控制台生成的两份文件：

- **宿主配置投影（`<workspace>/.pi/amos.managed.json`）**：调用 `readHostProjection(workspace)`（`adapters/shared/host-projection.ts`）。它通过文件描述符（`O_NOFOLLOW`）校验 `amos-managed-host-projection` v2 结构，返回 `{ status: 'ready', projection }`，内含 `harness: { enabled, mode: 'log-only' | 'managed', advisoryInjection }`、`activation: { snapshotPath, projectId }`、`managed` 审查配置、`workflowGate` 与 `configDigest`。当 `status === 'error'` 时必须 **fail closed**，不能静默回退到未校验的手写配置。
- **项目激活快照（`<workspace>/.pi/activation.json`）**：调用 `loadActivationRuntime({ snapshotPath, projectId, workspace })`（`adapters/shared/activation-guidance.ts`）或 `createActivationRuntime(snapshot, { projectId, workspace })`（`activation/runtime.ts`）。它校验 `amos-unified-rule-catalog` v2 摘要及项目/工作区身份绑定，返回不可变的 `ActivationRuntime`，同时提供 `runtime.execution('runtime')` 执行投影与 `runtime.injectorSession(now)` 注入会话。

### 2. 将工具事件归一化为封闭 Action Envelope

在工具真正执行前，把 Harness 原生工具参数转换为封闭的三字段动作 `{ tool, operation, target }`（参考 `adapters/pi/normalize.ts` 与 `adapters/opencode-v2/normalize.ts`）：

- 将动作映射到统一词表：`file_read`、`file_write`、`file_search`、`file_list`（若宿主中介目录创建与删除，可含 `file_mkdir` / `file_delete`）。
- 文件 `target` 规范化为工作区上下文下的词法绝对路径；**绝不**将文件内容、Shell 命令原文、URL secret 值或原始提示词放进 Action Envelope 或审计日志。
- 对不支持的工具、不可解析的 Shell（`shell_input`）或畸形参数，在 `log-only` 模式下显式写出覆盖缺口记录（`not_evaluated`、`unknown_payload` 或 `parse_error`），在 `managed` 模式下直接阻断——绝不把“未评估”当成隐式 `allow`。

### 3. 接入执行前策略评估与 Managed Gate

- **`log-only` 模式**：取 `runtime.execution('runtime').rules` 调用纯函数 `evaluatePolicy(action, rules, { now })`（`engine/engine.ts`）或共享观察记录器（`adapters/shared/log-only.ts`），把脱敏裁决追加写入 JSONL 审计日志，不中断工具调用。
- **`managed` 模式**：使用 `createHarnessGate`（`managed/harness.ts`）创建门禁实例，传入已验证的 `ActivationRuntime`、位于工作区外的 `auditPath`、当前会话捕获的用户需求状态（`decision/requirement-registry.ts`）以及 Jev 语义审查器（`createJevSemanticReviewer`，位于 `review/jev-reviewer.ts`）：
  - **工具执行前钩子（pre-tool hook）**：调用 `const decision = await gate.preCall({ callId, action })`。
    - `deny`（以及任何引擎、快照或需求状态异常）在副作用发生前返回 `{ action: 'block' }`。
    - `confirm` 先停住执行，构造最小有界投影（`tool`、`operation`、工作区相对 `target`、命中规则 ID、需求摘要）交给 Jev 审查器，按 `ReviewerPolicy` 与当前需求版本号核验通过后签发并立即消费一次性 HMAC grant，才返回 `{ action: 'allow' }`。
    - `allow` 先将授权记录持久化到 journal（`host/journal.ts`），再返回 `{ action: 'allow' }`。
  - **工具执行后钩子（post-tool hook）**：调用 `gate.recordResult(callId, 'executed' | 'failed' | 'cancelled')`，在 journal 中将每次获准调用与实际执行结果配对。
  - **用户输入钩子（user-prompt hook）**：仅从受信的用户输入通道捕获人类要求并写入版本化 `RequirementRegistry`（`decision/requirement-registry.ts`），绝不从工具输出或模型文本采信；需求更新会递增版本号，使旧审查结果与未消费的 grant 自动失效。

### 4. 注入按会话固定的 `<amos-guidance>` 工程规范

当 `harness.advisoryInjection` 开启时，为每个 Harness 会话创建一个注入器实例 `const injector = runtime.injectorSession(now)`（`activation/injector.ts`、`injector/session.ts`）：

- **用户轮次**：按提示词词元、任务标签与路径提示筛选已激活规范，在字符预算内渲染 XML 转义的 `<amos-guidance policy="..." digest="..." mode="advisory">` 块并附加到系统提示词或当前轮上下文；仅在宿主确认发出后调用 `commit` 记录会话去重。
- **写/改文件调用**：根据目标路径推导代码区域，在工具结果或下一轮上下文中附加匹配的区域规范。
- **保持零干扰不变量**：advisory 的排序、路由与字符预算截断绝不能过滤 `runtime.execution('runtime')` 中的硬规则，也不能改变任何门禁裁决；注入异常只丢弃建议块，不影响门禁与审计。

### 5. 写出运行期回执并注册 Harness 探测

- **运行期回执（`<workspace>/.pi/runtime.<harness>.json`）**：在加载快照和评估工具调用时，原子写入 v2 回执（`format: "amos-harness-runtime"`、`version: 2`、`projectId`、`activationDigest`、`epoch`、`policyVersion`、`configDigest`、`harness`、`mode: "enforcing" | "log-only" | "disabled"`、`loadedAt`、`lastToolAt`，格式定义见 `control-plane/runtime-status.ts`）。控制台通过该回执展示策略与配置在你的 Harness 中是否已生效（`loaded` / `stale` / `never`）。
- **控制台探测与一键接入**：若希望在控制台 `#/harnesses` 页面展示你的 Harness 并支持一键安装插件，可在 `control-plane/harness-discovery.ts` 中注册命令探测与插件标记检查，并在 `control-plane/harness-plugin-install.ts` 中添加幂等的用户级配置写入器。

---

## 文档索引

- **使用 Amos 与编写规则**：[本地治理控制台](docs/local-governance.md) · [前端说明](web/README.md) · [Harness 探测](docs/harness-discovery-usage.md) · [`amos-skill` 规则编写指南](https://github.com/g2nnyS/amos-skill)
- **Agent 与 Harness 接入**：[配置迁移与受管启动](docs/configuration-one-shot.md) · [Pi 适配器说明](docs/pi-adapter.md) · [OpenCode V2 接入笔记](spike/README.md) · [工作流硬门](docs/workflow-gate.md) · [Jev 语义接入](docs/jev-integration.md)
- **状态与安全**：[安全模型](docs/security-model.md) · [运行期状态](docs/go-no-go.md) · [产品闭环与宿主投影](docs/product-closure.md) · [实现状态](docs/product-gap-plan.md)
- **架构与决策**：[产品范围](docs/product-design.md) · [项目激活](docs/project-activation.md) · [Harness gate ADR](docs/adr-harness-gate.md) · [决策记录](docs/decisions.md)
- **参与贡献**：[CONTRIBUTING.md](CONTRIBUTING.md)

---

## 许可

本项目采用 [Apache License 2.0](LICENSE)。
