# ADR：CheckBinding / FindingBatch 与 TypeScript 检查点（P7）

- 状态：**库实现已接入本地/CI 命令行门，pending-human-review；仍无远端受管提交接纳平台**。
- 范围：一个真实 TypeScript 检查、精确 tree 绑定、FindingBatch 接纳校验。
- 本轮范围：`.github/workflows/ci.yml` 运行 `npm run check:gate`；不声称远端分支保护或受管提交门已经完成。
- 关联：CHECK-01–05、ENG-03、AC-18；PRD §5.6；O6。

## 1. 为什么不改旧规则格式

`registered-check` 不是第八谓词，也不塞进旧 action（`tool/operation/target`）
或旧规则 Schema。CheckBinding/FindingBatch 是独立、版本化的外层合同；旧
loader 继续拒绝未支持格式；旧 advisory 条目不会因本 ADR 暗变硬规则。
七算子、三字段 action、verdict 优先级与严格 Schema 不变。

## 2. 对象

| 对象 | 绑定 | 规则 |
|---|---|---|
| CheckBinding | project、精确 treeDigest、ruleRef、check id/version、analyzer id/version、checkpoint、固定命令 digest、issuedAt | 不可变、带 digest、拒绝未知字段 |
| FindingBatch | bindingDigest、treeDigest、status、覆盖率、findings（ruleId/path/line/messageDigest） | complete 才可接纳；缺失覆盖 ≠ 零发现 |
| Acceptance | binding + batch + currentTreeDigest + expected check/analyzer/rule | 任一项不匹配即拒绝 |

Tree digest 是确定性的有界遍历：排序相对路径 + 文件字节，跳过
`.git`/`node_modules`/`dist`/`.slim`/`coverage`，不跟随符号链接，限制文件数
与总字节。它不是 git tree id，也不是来源认证；用于证明“这次结果对应的
是这棵树”。

## 3. 接纳条件

必须同时满足：

1. batch `status === 'complete'`；
2. 覆盖率计数相等且 > 0（analyzersExpected/Run、filesExpected/Checked）；
3. binding/batch/`currentTreeDigest` 三者 treeDigest 一致；
4. check、analyzer、rule 的 id/version 与期望完全一致；
5. 每条 finding 映射到绑定的 ruleRef，path 是安全相对路径、line >= 1，
   无重复身份；
6. 所有 digest 校验通过（伪造/篡改拒绝）。

失败、漏跑、旧 tree、伪造 digest、缺覆盖、空覆盖、路径逃逸都拒绝，即使
findings 为空。跳本地 hook 不能改变这些库级结论；但本轮没有服务端 CI/
受管提交接纳点，因此**不声称**远端强制或“跳 hook 也无法接纳”的部署
证据，只证明库合同。

## 4. 真实 TypeScript 检查

`check/typescript-runner.ts`：

- 固定 argv：`node <typescript/bin/tsc> --noEmit --pretty false -p <tsconfig>`；
  `spawn` 且 `shell:false`；最小环境；不安装依赖、不联网。
- 运行前后各计算一次 tree digest；变化则失败（检查不能写树）。
- 超时 SIGKILL；输出流式计数并在上限处终止；**不返回原始 stdout/stderr**，
  只返回合并输出的 digest、退出码/耗时。
- 缺 tsc/引擎不可用返回固定 `engine_unavailable`，不泄露路径。
- 测试使用临时 TS 工程（干净/类型错误），不写入仓库。

## 5. 兼容与版本

- `amos-check-binding`、`amos-finding-batch` 为 v1；任何字段变更需新版本
  与兼容测试，不能改 format 串绕过校验。
- 旧 archive/JSONL 不受影响；新对象不复用旧 `snapshot_digest` 语义。
- 其他语言（Python/Rust）后续；本轮不做。
- 远端 CI 拒绝接纳不等于追回运行时副作用。

## 6. 未完成

- 真实 pre-commit/受管提交门、受保护 CI、服务端保护与 tree 锁定。
- 跳 hook 的对抗性集成证据；跨进程/并发 tree 变化。
- 多 analyzer 注册、语言服务、增量缓存。
- 人审格式与部署范围。

本地测试通过仍标 `pending-human-review`；不启用强制接纳。
