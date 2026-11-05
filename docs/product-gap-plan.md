# 实现状态

当前交付分支：`feat/amos-one-shot-delivery`，基线 `7236c77`（原
`feat/constraint-runtime`）。本页保留历史 P1 记录，并追加 one-shot 的
离线实现；安全运行期仍是 Stage A `log-only`，NO-GO 未改变。

## one-shot 新增（离线，未启用）

- `activation/runtime.ts`：验证 catalog v2 snapshot、绑定 project/workspace/
  epoch/execution digest，并提供 runtime/ci/server 视图与 advisory session。
- `host/`：闭集文件宿主、能力/资源根、真实路径/符号链接/硬链接检查、
  审计先于副作用、崩溃 unknown 不重放。
- `review/` + `managed/`：最小有界投影、校准门、独立 reviewer、一次性
  HMAC grant、端到端离线确认/执行。
- `governance/`：SQLite 单主、导入预览、CAS 提案/发布、审计、独立 receipt、
  回滚、WAL 备份/恢复、loopback 认证 API。Vue GUI 未交付。
- `check/`：精确 tree 的 CheckBinding/FindingBatch + 真实 TypeScript 检查。
- `rollout/`：版本/宿主/环境/检查绑定证据门；无真实 probe。
- `activation/tighten.ts`：已批准模板的附加型临时收紧、TTL/配额/epoch。
- 验证：`npm run typecheck`、`npm test`（实际 686 pass / 0 fail / 0 skip）、
  `git diff --check` 通过。详见
  `docs/delivery-status.md` 与 `docs/verification-one-shot.md`。
- 限制：Pi/OpenCode 默认仍读旧策略快照/guidance seed；没有真实 OS 隔离、
  provider 校准、宿主回执、生产 rollout、Vue 浏览器流程或来源认证。

## P1 离线项目规则目录

- catalog v2 从现有 YAML 规则和 guidance seeds 建立版本化目录、迁移映射及项目激活集。
- 同一离线 activation snapshot 编译 runtime/CI/server enforcement 投影和 advisory 注入投影；包括基线/引用闭集校验、level-first 选择、TTL、last-good 与遗漏报告。
- 独立审查发现的五项选择/会话/投影边界问题均已补回归覆盖。
- 验证：`npm run typecheck`、`npm test`（526 项通过）和 `git diff --check` 通过。工作树改动未提交。
- 限制：现有适配器仍使用旧策略快照和静态 guidance seed；P1 不接入工具裁决，不认证来源，也不改变 `opencode.jsonc`。

## 外部 Jev 连通性检查

已发送一次合成输入的 OpenRouter/System One 请求，返回结构化答复，说明此配置可连通并解析响应。该样例置信度为 0.4，标记为需要复核；它不是完整校准，也不构成安全证据。当前客户端结果不含 usage/费用数据，因此不能据此确认实际扣费。

## 当前状态

安全适配器仍是 Stage A `log-only`，裁决是假设结果，不阻止工具执行。可选工程工作流门是独立护栏，不提供完整动作覆盖。不要将离线测试、一次模型请求或配置文件描述为运行期安全强制能力。
