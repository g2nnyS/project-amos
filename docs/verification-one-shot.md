# One-shot 验证记录

环境：Linux，Node `v26.8.2`，npm `11.19.1`；工作树
`.slim/worktrees/amos-one-shot`（分支 `feat/amos-one-shot-delivery`，
目标文档与交付文档未提交，原工作树未被覆盖）。基线 HEAD `7236c77`。

本记录只报告实际运行结果；不固定“通过测试数”作为长期承诺。skip/blocked
单列，不计入通过。

## P0 基线（原始工作树，未修改）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0；node:test 报告 526 tests / 526 pass / 0 fail / 0 skip |
| `git diff --check` | 通过 |

原始工作树有用户未提交的 README 修改与三份未跟踪文档；未覆盖、未提交。
开发在独立工作树进行，PRD/需求台账/one-shot 指令已显式复制。

## 各 lane focused 结果（合并前在其工作树运行）

| Lane | 命令 | 结果 |
|---|---|---|
| CHECK | `npm run typecheck`；`npm run build`；`node --test dist/check/*.test.js` | 23 pass / 0 fail / 0 skip；真实 tsc 正反例 |
| ROLLOUT | 同上，`dist/rollout/*.test.js` | 28 pass / 0 fail / 0 skip |
| ACTIVATION | 同上，`dist/activation/*.test.js` | 46 pass / 0 fail / 0 skip（含既有测试） |
| REVIEW | 同上，`dist/review/*.test.js` | 47 pass / 0 fail / 0 skip；含本地确定性 reviewer；无真实模型 provider |
| HOST | 同上，`dist/host/*.test.js` | 17 pass / 0 fail / 0 skip；真实临时文件系统 |
| GOVERNANCE | 同上，`dist/governance/*.test.js` | 39 pass / 0 fail / 0 skip；真实临时 SQLite + loopback HTTP |
| MANAGED（整合者） | `node --test dist/managed/*.test.js` | 17 pass / 0 fail / 0 skip（10 协议流 + 7 真实 Pi harness） |
| ADAPTER WIRING（整合者） | `node --test dist/adapters/pi/*.test.js dist/adapters/opencode-v2/*.test.js dist/adapters/shared/*.test.js` | 115 pass / 0 fail / 0 skip；含可选 activation advisory 3 项 |
| REAL PI HARNESS（整合者） | `node --test dist/managed/pi-harness.test.js` | 7 pass / 0 fail / 0 skip；真实 Pi AgentSession/扩展/write 工具/文件副作用 + loopback reviewer + system prompt 注入 |

## 整合后全套（交付分支）

工作树根运行：

```bash
npm run typecheck
npm test
git diff --check
```

实际结果：

- `npm run typecheck` → exit 0。
- `npm test` → `tests 698`, `pass 698`, `fail 0`, `cancelled 0`,
  `skipped 0`, `todo 0`；`npm test` 先删除并重建 `dist/`。
- `git diff --check` → 无输出，exit 0。

覆盖包括既有 engine/storage/adapters/decision/supervisor/guidance/injector/
activation/catalog/workflow 回归，以及新增 check/rollout/review/host/
governance/managed 测试。新增测试均使用本地临时目录、loopback HTTP 或
真实临时 SQLite；没有向外部 provider 发请求。

## 真实外部条件 / blocked

| 项 | 状态 | 原因 / 补验入口 |
|---|---|---|
| 真实模型 reviewer 校准 | **非 MVP 必需 / blocked** | MVP 使用本地确定性 reviewer；无真实模型凭据/出境/费用授权；未发请求 |
| 真实 OS 执行身份/挂载域隔离（bwrap/cgroup） | **本轮不做（非目标）** | 用户将 MVP 限定为 Harness 层；不是阻塞项。不得宣称 OS 沙箱 |
| 真实流量 probe、生产 rollout | **blocked** | 无真实 ProbeRun/阈值预授权；`rollout/` 只做证据门 |
| 真实宿主接收/生效回执 | **blocked** | 只有 `Receipt` 契约与本地 API；无宿主进程接线 |
| Vue 治理台浏览器流程（AC-12） | **blocked/partial** | B 的 `web/` 未移植；只有 SQLite/API 测试 |
| 远端 CI/受管提交接纳点（AC-18 后半） | **blocked/partial** | 无服务端保护接线；`check/` 是库级合同 |
| 来源认证/O5、秘密后端、引导 | **blocked** | ADR 已写；未实现签名/HMAC/独立密钥域 |
| 真实 Jev/OpenRouter 费用与 usage | **blocked** | 未调用；不能确认扣费 |

精确补验步骤见 `docs/one-shot-blocked-verification.md`。

## 未覆盖范围

- Pi/OpenCode 默认受管入口；仍是 Stage A log-only；未改
  `opencode.jsonc` 的 `workflowGate.enabled=false`。
- 多用户/云/跨进程共享预算/新 harness/正则 DSL/第八谓词。
- 外部审计锚定、真实秘密存储、来源签名认证。
- **OS 隔离（独立 UID/挂载域/bwrap/cgroup/内核沙箱）本轮不做**；不宣称
  OS 沙箱、全副作用覆盖或防篡改审计。
- 默认适配器未启用 managed；Pi managed 是显式 opt-in，可在声明范围内
  deny/confirm；G0/NO-GO 未改变。
- 真实浏览器（AC-12）、移动端、跨浏览器、完整 WCAG。

## 复现注意

- `npm ci` 已在工作树执行；`node_modules` 为共享安装目录的符号链接仅用于
  lane 并行开发，不影响源码/构建。
- 测试必须从工作树根运行（`fixtures/`、`constraints/` 通过
  `process.cwd()` 解析）。
- 构建会删除并重建 `dist/`；没有手改 `dist`，没有新增 TS 测试 runner。
