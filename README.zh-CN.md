<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent 策略匹配与审计原型</strong>
</p>

<p align="center">
  <code>阶段 A</code> · log-only · OpenCode V2 + Pi<br>
  <strong>当前状态：运行期强制执行 NO-GO</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

## 这是什么

Amos 在尝试把 Agent 约束从提示词移入确定性策略引擎，并留下可审计的裁决记录。
它目前**不是硬安全边界**。

现有适配器只观察部分文件工具动作，并把假设裁决写入 JSONL；它们不会阻断、确认、
沙箱隔离或代理执行工具。所谓“物理锁定”“全局默认拒绝”“不可篡改审计”都需要
受信任监督进程、完整动作覆盖和 OS 级执行边界，这些尚未实现。

## 已实现

- 纯 TypeScript 策略引擎、严格规则 Schema 与按 digest 定位的规则快照。
- 纯 Supervisor 核心，提供已注册 session 上下文、假设裁决与进程内停止栅栏；
  尚未接入工具执行。
- 明确区分规则命中、未命中、引擎错误和未评估。
- OpenCode V2 与 Pi 的 `log-only` 文件通道适配器。
- 已知但不支持的工具和不可解释的 shell 动作会生成覆盖记录，不再静默消失。
- 审计记录包含规则快照摘要、命中规则元数据、裁决类型、格式版本和覆盖状态。
- 日志目录下按 digest 保存内容寻址快照，包含当时的规则原文、Schema、Schema digest
  与有效 session workspace。
- URL 查询值、userinfo、fragment 和路径在落盘前脱敏；shell 文本与文件内容不记录。
- 人审工作表使用裁决时固化的规则元数据，并对不可信字段做不可注入的编码。
- 与 provider 解耦的 Jev 语义评估接入。Jev 只提供事实，确定性策略仍是权威，
  模型输出只能收紧、不能放宽裁决。

## 尚未实现

- 对 shell、patch、网络、未知工具、被禁用扩展及 harness 其他入口的完整接管。
- 与 Agent 可写域分离的受信任监督进程。
- Agent 无法修改的策略与审计存储。
- `scope`、`owner`、`level`、`policy_class` 的运行期语义；它们目前只是经过校验的
  审计元数据，不是权限或规则选择机制。
- 对 symlink、hard link、bind mount 和 TOCTOU 安全的文件执行。
- 与动作及策略快照绑定、可认证且一次性的审批。
- 防篡改的远程审计留存。
- 任一适配器中的真实 `deny`/`confirm` 强制执行。

威胁模型和强制架构见 [安全模型与当前保证](docs/security-model.md)。在这些能力实现并通过
对抗测试之前，产品只能被称为策略匹配与观察原型。

## 当前工作方式

```text
工具事件
   │
   ▼
适配器归一化 ── 不支持/不可解释 ──► 覆盖记录（未评估）
   │
   ▼
严格规则快照
   │
   ▼
确定性求值
   │
   ├─ 命中规则       → 假设裁决 + 规则元数据
   ├─ 未命中         → 显式 no_match（记录器使用假设 deny）
   ├─ 校验错误       → deny + engine_error
   └─ 快照加载失败   → deny + snapshot_error
   │
   ▼
脱敏 JSONL 审计 ──► 人审工作表
```

唯一副作用是写审计记录及其内容寻址快照；工具调用本身不会被修改。

## 快速开始

需要 Node.js 26 与 npm：

```bash
npm ci
npm run typecheck
npm test
```

OpenCode 与 Pi 仍仅以 log-only 方式接入。参见 [Pi 接入说明](docs/pi-adapter.md)
与根目录 `opencode.jsonc`。

生成人审工作表：

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

## 交付规范

- 新工作使用 `feat/`、`fix/`、`docs/`、`chore/`、`refactor/`、`test/` 或 `ci/` 分支。
- 受保护分支、禁止 force push、secret 扫描和发布权限必须由 Git 服务端执行。
  本地 hook 和分支名都不是授权依据。
- 安全敏感变更必须由人审查。Agent 不得自我批准、合并、force push、打 tag 或发布。
- 详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [安全模型](docs/security-model.md)
- [Supervisor 核心](docs/supervisor-core.md)
- [Jev 接入](docs/jev-integration.md)
- [产品与工程决策](docs/decisions.md)
- [G0 门禁标准](docs/go-no-go.md)
- [测试覆盖说明](docs/fixture-coverage.md)
- [OpenCode V2 接入笔记](spike/README.md)
- [Pi 适配器说明](docs/pi-adapter.md)

---

<p align="center">
  <sub>策略引擎的价值，不只在于会说什么 verdict，更在于它的信任边界、覆盖范围和审计链同样明确。</sub>
</p>
