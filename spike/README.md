# OpenCode V2 适配器与接入说明

项目根 `opencode.jsonc` 是本仓库的 OpenCode 配置示例，加载 `dist/adapters/opencode-v2/` 中编译得到的插件。启动 OpenCode 前先运行 `npm run build`。

## 接入方式

1. **控制台一键全局接入（推荐）**：在治理控制台打开 **Harness 检测**（`#/harnesses`），对已探测到的 OpenCode 点击 **接入 Amos 插件**。控制台会在 `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc` 中追加指向本仓 `dist/adapters/opencode-v2` 的插件项（含绝对路径 `rulesPath`、`schemaPath`、`logPath`），保留已有配置与注释。
2. **项目级配置与模式控制**：插件选项不设置 `mode`。当工作区在控制台完成发布或配置保存后，适配器优先读取 `<workspace>/.pi/amos.managed.json` 与 `<workspace>/.pi/activation.json`，按控制台为该项目解析的模式（`log-only` 或 `managed`）与 `advisoryInjection` 开关运行，并写出 `<workspace>/.pi/runtime.opencode.json` 回执。未生成项目投影时，自动回退为读取 `rulesPath` / `schemaPath` 的 `log-only` 观察模式。

## 工作方式

- 配置传入 `rulesPath`、`schemaPath`、`logPath`（以及可选 `workflowGate`）；相对路径以 OpenCode 项目位置解析，不依赖进程 cwd。
- loader 校验 YAML、JSON Schema 和规则语义，成功后加载深度冻结的内存快照；首次快照失败记录 `snapshot_error`，非法 reload 保留最后正常快照。
- `read` → `file_read`；`write` / `edit` → `file_write`；`glob` / `grep` → `file_search`；`list` → `file_list`。
- 文件目标解析为绝对路径，并展开 `~` / `~/`。不读取或记录文件内容，不由引擎理解 OpenCode payload。
- 已知非文件工具显式跳过；patch、未知工具或畸形文件 payload 记录 `unknown_payload` / `parse_error`，不静默忽略。
- 默认 `log-only` 观察模式下，hook 不修改 input、不返回裁决、不向工具管线抛错；实时日志追加写入 `spike/logs/opencode.jsonl`（git 忽略）。当 `.pi/amos.managed.json` 将项目设为 `managed` 时，`execute.before` 在副作用前调用 `createHarnessGate` 执行 `deny` 阻断与 `confirm` Jev 语义审查 + 一次性授权。
- 从真实任务日志派生的样本可放入本地 `examples/`，不回写原始日志。

`logs/`、`examples/` 和 `review/` 都是本地观察产物目录，由 Git 忽略，不随仓库分发。取消历史样本与工作表的 Git 跟踪不删除本地证据、不修改审核结论；已有提交中的历史材料仍可查阅。正式回归测试和语言中立 fixtures 继续受版本控制。日常使用以治理控制台的审计与观察页面为准；本地 JSONL 的专项复盘属于维护者工作，不属于产品使用流程。

运行检查：

```bash
npm ci
npm run build
npm test
npm run typecheck
```

安全适配器仍处阶段 A，不包含真实安全 deny/confirm 或任何 LLM 裁决。独立的 SQLite 本地治理服务与 Web 界面见 `docs/local-governance.md`；它管理规则提案和版本，不是受信执行层或动作授权。Pi 是单独的 log-only 适配器，见 `docs/pi-adapter.md`。OpenCode 的 shell、patch 等写旁路仍须在强制执行前另行裁决。
