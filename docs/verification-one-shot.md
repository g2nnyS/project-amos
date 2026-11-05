# One-shot 验证记录

环境：Linux，Node `v26.8.2`，npm `11.19.1`；工作树
`.slim/worktrees/amos-one-shot`（分支 `feat/amos-one-shot-delivery`）。
基线 HEAD `7236c77`；本记录只报告实际运行结果，不固定“通过数”。

## P0 基线（原始工作树，未修改）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0；node:test 报告 526 tests / 526 pass / 0 fail / 0 skip |
| `git diff --check` | 待整合后运行 |

说明：原始工作树有用户未提交的 README 修改与三份未跟踪文档；未覆盖、未
提交。开发在独立工作树进行，PRD/需求台账/one-shot 指令已显式复制。

## 实现 lanes（本地离线）

| Lane | 范围 | 命令 | 结果 |
|---|---|---|---|
| activation | `activation/runtime.ts`、`activation/tighten.ts` | `node --test dist/activation/*.test.js` | 见下文实际记录 |
| host | `host/` | `node --test dist/host/*.test.js` | 见下文 |
| review | `review/` | `node --test dist/review/*.test.js` | 见下文 |
| check | `check/` | `node --test dist/check/*.test.js` | 见下文 |
| rollout | `rollout/` | `node --test dist/rollout/*.test.js` | 见下文 |
| governance | `governance/` | `node --test dist/governance/*.test.js` | 见下文 |

每个 lane 只跑 focused 测试；整合后由整合者跑一次
`npm run typecheck && npm test && git diff --check`。

## 真实外部条件 / blocked

- 真实独立安全 reviewer provider 校准：无凭据、无出境/费用授权、无真实
  校准集 → **blocked**，未发请求。
- 真实 OS 执行身份/挂载域隔离（bwrap/cgroup）：未运行 → **blocked**；
  本地文件宿主只证明声明范围内的文件路径/审计语义。
- 真实流量 probe、宿主接收回执、生产 rollout：未运行 → **blocked**；
  只交付版本绑定证据门与记录契约。
- Vue 治理台浏览器流程（AC-12）：未移植 B 的 web → **blocked/partial**。
- 远端 CI/受管提交接纳点：本仓库无服务端保护接线 → **blocked/partial**。

## 未覆盖范围

- Pi/OpenCode 默认受管入口；仍为 Stage A log-only。
- 多用户/云/跨进程共享预算/新 harness/正则 DSL/第八谓词。
- 外部审计锚定、真实秘密存储、来源签名认证（O5 未决）。
- 生产阈值/TTL/配额预授权（O4 未授予）。
- 任何安全 deny/confirm 启用；NO-GO 不变。

最终整合结果与命令输出摘要将在完成后追加；skip/blocked 单列，不计入通过。
