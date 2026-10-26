# Pi Coding Agent 适配器

当前状态：**Pi 1.4.0 log-only 代码与单测已完成，真实 CLI 验证因本机尚无 provider 配置而暂停。**

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

pi --no-session --no-context-files --no-extensions --no-mcp \
  -e dist/adapters/pi/index.js \
  --tools read,write,edit,bash \
  -p "在这里填写真实任务"
```

`--no-extensions` 不禁止显式 `-e`，用于隔离其他扩展对事件参数的后续修改。正式启用其他扩展前，需要单独评估 hook 顺序和同名工具覆盖。

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

原始日志写入 `spike/logs/pi.jsonl`，该目录被 git 忽略。真实 CLI 尚未运行，因此当前没有 `real-pi.jsonl` 样本；fake hook 测试只证明代码路径，不替代真实性证据。

## 当前验证

- 全套测试：142/142 通过。
- TypeScript：`tsc --noEmit` 通过。
- 依赖审计：`npm audit` 为 0 漏洞。
- Pi 官方包固定为 `@earendil-works/pi-coding-agent@1.4.0` 开发依赖，用于固定扩展 API 类型和真实 CLI 兼容验证。
- `undici` 通过 `overrides` 固定到 8.12.3，以覆盖 Pi 当前依赖树中的已知漏洞版本；未使用强制降级。

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
