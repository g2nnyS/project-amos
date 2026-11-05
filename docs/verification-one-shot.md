# 验证记录（当前交付分支）

本记录只列实际运行结果。完整范围、证据路径与限制见
[MVP 交付](mvp-delivery.md)。

环境：Linux，Node `v26.8.2`，npm `11.19.1`；分支 `feat/amos-mvp`，工作树
`.slim/worktrees/amos-mvp`。所有测试从仓库根运行，使用临时目录/loopback
HTTP/真实本地 SQLite；不向外部 provider 发请求。

## 1. 全套命令

```bash
npm run typecheck
npm test
git diff --check
git diff --cached --check
```

实际结果：

- `npm run typecheck` → exit 0（根 TS + `web` vue-tsc）。
- `npm test` → exit 0；Node 与 Web 均无失败；1 项“外来 UID 数据库文件”
  测试需要 root，保持 skip 而非伪通过。
- `git diff --check` → exit 0。
- `git diff --cached --check` → exit 0（提交前运行）。

`npm test` 先删除并重建 `dist/`，然后运行编译后的 Node 测试与 `web`
测试；不新增独立 TS test runner。

## 2. 浏览器真实闭环（AC-12）

```bash
npm run build
node web/e2e/smoke.mjs
```

结果：全部检查 PASS，无 console error、runtime exception、CSP violation
或同源 4xx/5xx。证据目录
`/tmp/opencode/amos-governance-e2e-*/`（`evidence.txt` + 截图）。

关键检查：

- 人类令牌登录、项目创建、仓库种子、新增项目规则、服务端校验；
- 不可变提案、批准并发布；
- `.pi/activation.json` 为 catalog v2 且 workspace/project 匹配；
- `/api/projects/:id/runtime` 初始 `never`；写入真实格式报告后控制台显示
  `loaded`；回滚 v2 后旧报告显示 `stale`，更新后 `loaded`；
- 版本 YAML 下载（`format: amos-project-policy`）→ 同文件导入 → 服务端
  校验通过；
- 回滚创建版本 2；规则矩阵/检查器/移动端/筛选/导出/登录失效均通过。

浏览器 runtime 报告由 e2e 按真实 `.pi/runtime.json` 文件协议写入，用于
验证控制台读取/展示；报告生产者由下一节真实 Harness 证据覆盖。

## 3. 真实 Pi Harness（faux 模型）

```bash
node --test dist/managed/pi-harness.test.js
node --test dist/managed/harness-empty.test.js
```

- `pi-harness.test.js`：7 pass。真实 Pi `AgentSession`、真实扩展加载、真实
  `write` 工具与临时文件副作用；deny 无文件、log 写入、confirm 无 review
  停止、reviewer approved 恰好一次、reviewer mismatch 停止、system prompt
  注入、审计路径在工作区内 fail closed。模型响应由 faux provider 脚本化，
  不冒充真实模型校准。
- `harness-empty.test.js`：1 pass。合法空 runtime 投影按 no-match allow
  并写审计，不调用空表引擎。

## 4. 真实模型 + 真实 reviewer + 真实副作用

```bash
npm run build
npm run probe:live
```

使用本机已授权的本地 llama.cpp OpenAI-compatible 端点（默认
`http://127.0.0.1:8080/v1`，`gemma-4-e4b`）；不访问外部 provider、不打印
密钥。结果（`/tmp/opencode/amos-live-probe-*/evidence.json`）：

- 真实编译后的 `control-plane` CLI HTTP 服务（人类令牌登录→项目→提案→
  批准→发布）写 catalog v2 artifact；
- 独立 reviewer 对 8 个合成场景调用真实模型：6 unsafe / 2 safe，
  `falseAllows: 0`；
- 真实 Pi 会话读取 `src/input.txt`，confirm 写 `src/confirm.txt` 仅执行
  一次，内容匹配；reviewer 收到 requirement 原文与 digest；
- 真实 Pi 会话写 `src/deny.txt` 被 deny，文件不存在；
- 第三个会话按任务选择 `live-python` guidance，未出现 `live-ts`；
- system prompt guidance 含同一 activationDigest；`.pi/runtime.json`
  `loaded`；同一控制台 HTTP `GET /api/projects/:id/runtime` 返回
  `loaded` 且 digest 匹配；managed journal confirm 仅 1 条 allow，deny
  记录存在。

## 5. 针对性模块结果（用于定位失败）

| 范围 | 命令 | 结果 |
|---|---|---|
| 控制面/发布/YAML/runtime | `node --test dist/control-plane/publication.test.js` | 6 pass |
| Harness gate | `node --test dist/managed/harness-empty.test.js` | 1 pass |
| 真实 Pi Harness | `node --test dist/managed/pi-harness.test.js` | 7 pass |
| Activation/Injector | `node --test dist/activation/*.test.js dist/injector/*.test.js` | 全过 |
| Review/Authority | `node --test dist/review/*.test.js` | 全过 |
| Engine/Fixtures 兼容 | `node --test dist/engine/*.test.js` | 全过 |

## 6. 未运行/不在本轮

- 外部 provider（OpenAI/Anthropic/xAI/Kimi Code）真实调用：本机凭据不可用
  或订阅无权限；live probe 使用本地模型，未产生外部费用/出境。
- OS 隔离、bwrap/cgroup、独立 UID、挂载域：本轮明确不做。
- 完整自动 rollout、临时收紧持久化、远端 CI 接纳：本轮明确不做。
- 真实宿主“生效回执”（跨机器签名/远程锚定）：未实现；runtime report 是
  same-UID 本地文件观察。
