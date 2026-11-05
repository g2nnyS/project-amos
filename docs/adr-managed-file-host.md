# ADR：受管受限文件宿主（P2A）

- 状态：**实现草案，pending-human-review；未在 Pi/OpenCode 默认启用**。
- 范围裁决（2026-11-05）：MVP 采用 Harness 层拦截（见
  [Harness gate ADR](adr-harness-gate.md)）；本文件的受限文件执行器是
  可选库/未来受管入口，不是默认 MVP 路径。**独立 UID、挂载域、
  bwrap/cgroup、内核沙箱本轮不做，不是人工阻塞**。
- 范围：`host/` 的一个封闭文件执行面、能力闭集、真实路径检查、审计前置与
  崩溃恢复语义。不改变 Stage A log-only 适配器，不解除 NO-GO。
- 关联：HOST-01–04/08/09、AUD-02/03、AC-05/06/19；CAND-09 风险面；PRD §5.2。

## 1. 保护声明

本宿主**只**覆盖下列已声明工具（闭集）：

`read | write | edit | list | search | mkdir | remove`

没有 `shell`、`network`、MCP、插件、子进程或任意命令执行入口。未知工具
没有执行器；额外/未知请求字段拒绝。工作区默认可写、无网；策略/审计/
宿主配置/凭据路径在保护集内。

**不是**完整动作覆盖：Pi/OpenCode 的默认工具调用仍走 log-only 适配器；
本宿主只能作为显式受管入口使用。未接入的入口不因本模块存在而受管。

## 2. 保护矩阵

| 面 | 处理 | 证据/限制 |
|---|---|---|
| 工作区外文件 | 真实 `realpath` + 资源根包含检查；拒绝 | 本地 FS 测试 |
| 工作区内符号链接 | 逐段 `lstat` 拒绝；最终 `O_NOFOLLOW` | 本地 FS 测试 |
| 硬链接 | 写/编辑要求 `nlink === 1`；否则拒绝 | 保守，可能误拒 |
| `.git/hooks/**`、`.git/config` | 硬编码保护，不可被调用方关闭 | 测试 |
| `.pi/**`、`opencode.jsonc`、`constraints/**`、`decision/jev.local.json` | 默认保护 | 测试 |
| 审计文件 | 构造时要求真实父目录在工作区外；`O_NOFOLLOW` + `0600` + fsync | 同 UID 仍可改写 |
| bind mount / TOCTOU | **UNSUPPORTED**：词汇/设备身份不能证明挂载域；无独立进程 | 明确不支持 |
| 目录遍历/搜索结果 | 跳过 `.git`/`node_modules`/`dist`/符号链接；只返回相对路径 | 测试 |
| 子进程/插件/MCP | 无入口 | 闭集 |

CAND-09 的 `.git/hooks`、`.git/config` 持久化面已纳入默认保护，但这是
**本实现的保护矩阵**，不是声称 H 旧 15 条规则原本已覆盖。具体开发例外
仍由人治理；不得为演示而放宽。

## 3. 裁决与授权

1. 宿主自己构造 action（三字段）与 identity；不信任 Agent 传入的
   `approved`/project/version。
2. 用现有 `evaluatePolicy(action, execution.rules, now,
   { defaultVerdict: 'allow' })` 评估**已知闭集动作**。`deny`/引擎错误
   在任何副作用前停止；`confirm` 只有在可信 `consumeConfirm` 回调对本次
   请求返回 true 时才继续，否则停止；`allow`/`log`/无命中继续。
3. `consumeConfirm` 是 P2B one-shot 的接线点；P2A 缺省为不存在，因此所有
   confirm 停止。回调抛错也是停止。
4. 无命中 allow **只属于本受管宿主**；不改变 log-only recorder 的
   `defaultVerdict: 'deny'`、no-match 审计或 hypothetical deny 语义。
5. 0 层/任何确定性 deny 不进入 review/回调；不可被覆盖。

## 4. 审计先于副作用

每条请求：

1. 追加 `authorization` 行并 `fsync`；失败 → 无副作用，返回
   `audit_unavailable`。
2. 执行单个文件效果。
3. 追加 `result` 行（状态/字节/digest），不记录内容、命令、查询、环境或
   原始路径。

崩溃恢复：启动时扫描 journal，有 `authorization` 无 `result` 的操作追加
`unknown` 并毒化其 operationId；之后同名请求返回 `replay_denied`，不重放。
若效果执行中抛错，追加 `outcome_unknown`，不自动重试。授权记录与结果
分开，授权不等于执行成功。

已知顺序限制：`write(overwriteDigest)`/`edit` 的只读 preflight 会在授权行
之前读取现有文件内容以核对 digest/oldText；它只返回布尔并在内存中处理，
不把内容返回给 Agent 或写日志，但严格来说这是授权前的数据访问。生产启用
前应把内容相关检查移到授权之后，或把该读取显式纳入受审计披露。`read`
的内容读取本身发生在授权行之后。

## 5. 能力与配额

能力绑定 tools、resourceRoots、maxReadBytes、maxWriteBytes、
maxOperations、expiresAt。过期、越根、工具不允许、超字节、超操作数均
停止。能力是宿主内部分配，不是模型自报；本轮没有持久化委托/预算账本。

## 6. 残余风险（明确）

- 同 UID 的 Agent 仍可改写审计/策略/快照；jsonl 的 `0600` 不是防篡改。
- 没有独立 OS 身份、挂载域、cgroup、bwrap 或受信监督进程；这些是
  **本轮明确非目标**，不是 MVP 阻塞项。不得把本宿主描述为 OS 沙箱。
- bind mount、TOCTOU 设备身份、网络文件系统不在声明范围；写操作只做
  保守 `nlink`/`O_NOFOLLOW` 检查。`read` 没有 `nlink === 1` 限制：工作区内
  既有的硬链接到外部文件可能被读取；本宿主不提供外部 `file_link` 工具，
  但没有对预置硬链接做完整对象身份证明。
- 审计不可用时不执行；但审计被攻破后的历史重写无法检测（无外部锚定）。
- 没有真实 Pi/OpenCode 受管入口接线；没有 reviewer 时 confirm 全部停止。

## 7. 人审前状态

本地测试通过仍标 `pending-human-review`；不得合并、部署或扩大启用范围。
生产启用前还需要：独立写域/审计端、真实 OS 隔离证据、能力矩阵与宿主
版本、对抗性 probe、以及本 ADR 的保护矩阵人审。
