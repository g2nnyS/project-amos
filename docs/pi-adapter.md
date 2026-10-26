# Pi Coding Agent 适配器

当前状态：**Pi 1.4.0 log-only 代码、单测与真实 CLI 验证均已完成。** 真实会话样本见 `spike/examples/real-pi.jsonl`。

OpenCode V2 保留为参考适配器。Pi 因用户确认日常主用而解锁为第二适配器；两者只共享结构化归一化结果、快照评估和 JSONL 记录，不共享模型 provider，也不建立通用 harness 框架。

## 配置

Pi 扩展通过当次事件的 `ctx.cwd` 读取 `.pi/atmos.json`，不依赖进程 cwd：

```json
{
  "mode": "log-only",
  "rulesPath": "./constraints/rules.yaml",
  "schemaPath": "./constraints/schema.json",
  "logPath": "./spike/logs/pi.jsonl"
}
```

相对路径基于 `ctx.cwd` 解析。配置错误只输出一次通用错误，不包含 payload，也不会让 Pi 的工具调用被阻断。

## 构建与运行

先完成 provider 认证，并确认 `pi --list-models` 能列出模型，然后运行：

```bash
npm run build

pi --provider <provider> --model <model> \
  --print --no-session --no-context-files --no-mcp --approve \
  -e dist/adapters/pi/index.js \
  --tools read,write,edit,grep,ls \
  -p "在这里填写真实任务"
```

`--no-extensions` 不禁止显式 `-e`，用于隔离其他扩展对事件参数的后续修改。正式启用其他扩展前，需要单独评估 hook 顺序和同名工具覆盖。`--approve` 信任项目内的 `.pi/atmos.json`，否则项目级配置不会加载，适配器会退化成空操作。

## 事件与归一化

| Pi 事件/工具 | 统一 operation |
| --- | --- |
| `read` | `file_read` |
| `write` / `edit` | `file_write` |
| `grep` / `find` | `file_search` |
| `ls` | `file_list` |
| `bash` / `powershell` / `user_bash` | `shell_input` |
| 自定义或未知工具 | `unknown_payload` |

文件路径支持相对路径、绝对路径、`~` 和 `~/`，并在进入引擎前折叠。shell 命令、文件内容及其他自由文本不会进入 Action Envelope 或 JSONL；空白或缺失的命令记 `parse_error`，不当成一次正常的 `shell_input`。异常归一化/记录路径会留下 `deny + engine_error`；`tool_call` 和 `user_bash` 始终返回 `undefined`，不修改 input。

原始日志写入 `spike/logs/pi.jsonl`，该目录被 git 忽略。真实 CLI 已运行，派生样本保存在 `spike/examples/real-pi.jsonl`，不回写原始日志。

## 当前验证

- 全套测试：142/142 通过。
- TypeScript：`tsc --noEmit` 通过。
- 依赖审计：`npm audit` 为 0 漏洞。
- Pi 官方包固定为 `@earendil-works/pi-coding-agent@1.4.0` 开发依赖，用于固定扩展 API 类型和真实 CLI 兼容验证。
- `undici` 通过 `overrides` 固定到 8.12.3，以覆盖 Pi 当前依赖树中的已知漏洞版本；未使用强制降级。

### 真实 CLI 验证（2026-10-27）

用真实 `pi` 1.4.0、真实 provider、真实文档任务跑通，扩展按 `.pi/atmos.json` 定位配置并写入 `spike/logs/pi.jsonl`：

| Pi 动作 | 归一化 operation | 假设 verdict | 命中规则 |
| --- | --- | --- | --- |
| 读 `constraints/vocabulary.md` | `file_read` | `log` | `side_effect-1-3` |
| 写 `docs/pi-real-check.md` | `file_write` | `confirm` | `side_effect-1-2` |
| `bash echo` | `shell_input` | `confirm` | `side_effect-1-2` |
| 读 `/etc/hostname` | `file_read` | `deny` | `filesystem-0-2`、`side_effect-1-3` |
| 读 `/home/ganyu/.ssh/id_ed25519` | `file_read` | `deny` | `credential-0-1`、`filesystem-0-2`、`side_effect-1-3` |

读私钥路径同时命中 `credential-0-1`，说明新增的 `file_search` 与 `**/.ssh/` 覆盖生效。`shell_input` 的 target 为 `unknown`，命令文本没有进入日志。

`/etc/hostname` 的 `deny` 来自 `filesystem-0-2` 的 `/home/ganyu/projects/**` 白名单。这条规则的 session 适用范围仍待 G0 由人裁决，不由适配器决定。

## 尚未解锁的能力与已知旁路

- 真实 deny、confirm、项目激活、narrative 注入和治理均未启用。
- Pi 没有原生 permission 体系。后续 confirm 只能依赖 TUI/RPC；print/JSON 等非交互模式必须 fail-closed，不能假装存在确认。
- bash 只有原始命令字符串，不能用正则猜测目标或声称已覆盖 shell 写副作用。
- `pi.exec()`、`user_bash` 的其他执行方式、扩展内部副作用、`commandPrefix`/`spawnHook`、同名工具覆盖、后续扩展修改 input，以及 `--no-extensions`/SDK 未加载本扩展，都需要在强制前单独处理。
- 本适配器不依赖或包装 `pi-ai` provider。若未来 advisory 路由需要模型能力，必须另行隔离，且不得进入裁决路径。

官方资料：

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
- [Pi custom provider](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
