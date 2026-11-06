# 需求范围修订（2026-11-05）

本文记录本轮用户裁决相对 one-shot 输入文档的范围变化，避免把已排除项
继续当作人工阻塞。历史输入文档未删除；原始工作树中的三份未提交输入文档
保持未提交状态：

| 输入文档 | SHA-256（原始工作树） |
|---|---|
| `docs/deepseek-one-shot.md` | `54f21619adeaefc0a6901174dfc57fcbd55a92fc9e37064fcba7ee8a5b831a47` |
| `docs/prd.md` | `589dd74d3066807b00993bd3ab8e14a5c6fc26555a0e3a881b4c7a976c95ab52` |
| `docs/requirements-inventory.md` | `0a081682f229e0820fedc7aa953a997865c4f223d68cbc0bf22e8880f6f8ce60` |

## 1. 修订后的主验收

1. 复用现有 Vue 控制台：登录 → 项目 → 编辑/导入规则 → 校验 → 发布 →
   版本 → 回滚；真实浏览器。
2. 发布产生 P1 catalog v2 快照；受管 Pi 会话加载并报告版本。
3. 同一快照动态注入工程规范；任务/路径变化改变注入选择，不缩减执行规则。
4. 真实 Harness `tool_call` 前确定性裁决；deny 阻止；confirm 暂停并交独立
   reviewer，通过后仅执行一次；拒绝/超时/错快照/换目标/过期/重放不执行。
5. 正常真实任务可完成（读取 + 创建/修改文件），由独立检查核对文件结果。
6. 控制台展示真实 runtime 加载报告与审计；数据库发布不等于宿主生效。

## 2. 明确不做（本轮）

- 独立 OS 身份、挂载域、bwrap/cgroup、内核沙箱、全副作用中介。
- 同 UID 进程间防篡改、远程签名/密钥轮换、外部审计锚定。
- 完整自动 rollout、临时收紧持久化、远端 CI 接纳平台。
- OpenCode 受管拦截（保持兼容/log-only）。
- 运行中热切换快照、多租户、跨机器密钥管理平台。

这些不再列为本轮人工阻塞；相关历史实现/ADR 保留，但不得宣称已具备。

## 3. 复用与取舍

- 复用 `feat/local-governance-console` 的 `control-plane/` + `web/`；
  不重建登录/项目/规则/发布/版本/审计页面。
- 不整包合并实验分支：`governance/` 重复 SQLite/编译器未并入交付分支，
  `control-plane/` 是单一治理存储。
- 发布编译器统一为 P1 `catalog/` + `activation/compiler`；控制台不再维护
  第二套长期规则逻辑。
- `host/` 受限执行器保留为可选库；Pi managed 路径直接以 Harness 执行原
  工具一次，避免“适配器执行一次 + 原管线再执行一次”。
- `check/`、`rollout/`、`activation/tighten.ts` 保留为离线库；未接入本轮
  运行路径。

## 4. 来源与秘密

- 控制面为本机 loopback API，使用人类/Agent 令牌；不提供发布者签名。
- 快照 verify 是结构/身份一致性检查，不是来源认证；digest 不是认证。
- 凭据只保存引用；live probe 从本机 llama.cpp key 文件读取，不打印、不
  写入数据库/前端/审计。
- 外部 provider 真实调用因本机凭据不可用/无权限未运行；本轮用本地模型
  完成真实 Harness + 真实 reviewer 证据。

## 5. 验收状态

见 [MVP 交付](mvp-delivery.md) 与 [AC 矩阵](acceptance-one-shot.md) 的
2026-11-05 表。历史输入文档中的 AC-12/AC-17 等状态已被本轮证据取代。
