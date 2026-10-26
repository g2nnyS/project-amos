# OpenCode V2 log-only 接缝

项目根 `opencode.jsonc` 加载 `dist/adapters/opencode-v2/` 中由 TypeScript 编译得到的插件。开始 OpenCode 前必须运行 `npm run build`；`hook-config.jsonc` 是同一配置的可复制样例。没有 `.opencode/` 源码 hook，也不依赖类型擦除。

## 工作方式

- 配置显式传入 `rulesPath`、`schemaPath`、`logPath` 和 `mode=log-only`；相对路径以 OpenCode 项目位置解析，不依赖 cwd。
- loader 校验 YAML、JSON Schema 和规则语义，成功后加载深度冻结的内存快照；首次快照失败记录 `snapshot_error`，非法 reload 保留最后正常快照。
- `read` → `file_read`；`write` / `edit` → `file_write`；`glob` / `grep` → `file_search`；`list` → `file_list`。
- 文件目标解析为绝对路径，并展开 `~` / `~/`。不读取或记录文件内容，不由引擎理解 OpenCode payload。
- 已知非文件工具显式跳过；patch、未知工具或畸形文件 payload 记录 `unknown_payload` / `parse_error`，不静默忽略。
- hook 不修改 input、不返回裁决、不向工具管线抛错。实际工具调用始终按 harness 原有流程继续。
- 实时日志写入 `spike/logs/opencode.jsonl`（git 忽略），只追加。每行至少有 `ts / action / matched_rule_ids / verdict / latency_ms`，错误时增加 `error`。
- `examples/real-opencode.jsonl` 是从真实任务日志派生的样本，不回写原始日志。

当前样本来自 2026-10-24 的 OpenCode V2 standalone 会话，执行的是 fixtures 覆盖说明整理：三次读取后实际创建 `docs/fixture-coverage.md`，再读回确认。样本取原始 JSONL 第 104–108 行；写操作的假设 verdict 为 `confirm`，文件仍实际创建，验证编译后的插件保持 log-only。

生成人审工作表（输出必须是不存在的新文件，避免覆盖已填写的结论）：

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode-field-mismatch.jsonl \
  --log spike/logs/opencode.jsonl \
  --output spike/review/stage-a-review-next.md
```

当前工作表为 `review/stage-a-review.md`。它只派生人审队列，不自动判断误拒或放行；原始 JSONL 持续追加时，后续审核应使用新文件名。

运行检查：

```bash
npm ci
npm run build
npm test
npm run typecheck
```

当前仍处阶段 A，不包含真实 deny、confirm、SQLite、Web 治理台或任何 LLM 裁决。Pi 是单独的 log-only 适配器，见 `docs/pi-adapter.md`。OpenCode 的 shell、patch 等写旁路必须在阶段 B 前另行裁决。
