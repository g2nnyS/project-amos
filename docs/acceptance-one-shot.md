# One-shot 验收矩阵（AC-01–AC-22）

状态口径：`passed` 只表示本表注明的本地/离线/真实 Harness 证据；
`partial` 表示部分正反例有证据但范围未闭合；`blocked` 表示缺真实外部条件，
不能算通过。**MVP 限定为 Harness 层工具拦截；OS 隔离本轮不做，不是阻塞
项。** 全表不改变 G0/NO-GO。


> **2026-11-05 当前修订**：用户将 MVP 限定为 Harness 层拦截，明确不做 OS
> 隔离，并要求复用现有 Vue 控制台、真实浏览器与真实模型 probe。以下旧表
> 保留为历史记录；当前判定以本节和 [MVP 交付](mvp-delivery.md) 为准。

| AC | 当前状态（2026-11-05） | 证据 |
|---|---|---|
| AC-01/02/03/04 | passed（本地/离线） | engine/fixtures/schema/activation 全套；两项目隔离、必选基线、TTL/last-good、合法空投影 |
| AC-05/06 | passed（Harness 层；OS 隔离非目标） | 真实 Pi `tool_call` deny/confirm/allow；未知/Shell/自定义工具阻断；同 UID/无 OS 沙箱限制明确记录 |
| AC-07/08 | passed（本地 + 真实本地模型 reviewer） | 一次性授权/重放/过期/错目标/错快照测试；live probe 真实模型 8 场景 0 false allow；requirement 原文/摘要绑定 |
| AC-09/10/11 | passed（本地 SQLite + loopback HTTP；真实浏览器） | `control-plane` 单主、CAS/提案/发布/回滚；浏览器登录→发布→回滚；CSP/角色/请求上限 |
| AC-12 | **passed（真实浏览器）** | `node web/e2e/smoke.mjs` 18 项 PASS：登录→项目→规则→校验→发布→YAML 导出/导入→runtime loaded/stale→回滚 v2 |
| AC-13 | passed（同快照注入） | system prompt + tool_result area guidance；任务路由 `live-ts`/`live-python`；注入失败不改裁决 |
| AC-14 | passed（回归） | workflow shell/change review/Jev 既有测试全过 |
| AC-15 | out-of-scope（本轮） | 临时收紧持久化不在本轮；历史实现保留 |
| AC-16 | out-of-scope（本轮） | 完整自动 rollout/真实 probe 阈值不在本轮 |
| AC-17 | **passed（本地真实模型）** | 本地 llama.cpp `gemma-4-e4b` 真实调用 + 8 场景校准；外部 provider 未运行 |
| AC-18 | out-of-scope（本轮） | 远端 CI 接纳/跳 hook 不在本轮 |
| AC-19 | partial（Harness 层） | 放行前 authorization/fsync，结果另记；不含内容/命令；同 UID 非防篡改 |
| AC-20 | partial | 显式 managed opt-in；runtime report 为 same-UID 本地观察；来源认证未实现 |
| AC-21 | passed（保留） | 未改写历史 JSONL/审核结论/archive v1 |
| AC-22 | partial | 正常执行不逐次人工批准；误放行/误拒/完成率指标未实现 |

当前全套：Node 与 Web 测试无失败（1 项环境测试 skip）；浏览器检查全部
PASS；live probe 通过。历史表如下。

全套命令与环境见 `docs/verification-one-shot.md`。历史（2026-11-04）实际：
`npm run typecheck` exit 0；`npm test` 698 pass / 0 fail / 0 skip；
`git diff --check` exit 0。

| AC | 状态 | 证据 / 未覆盖 |
|---|---|---|
| AC-01 规则/引擎/兼容 | **passed（本地）** | 现有 engine/fixtures/schema/audit 测试全过；`log-only` recorder 的 `defaultVerdict: deny` 与 no-match 语义未改；旧 archive v1/JSONL v2 未改写。 |
| AC-02 项目激活/基线 | **passed（离线）** | `dist/activation/*.test.js`：两项目不同激活、排除必选失败、失败/检测缺失不减激活、首次无 snapshot 不启动；`activation/runtime` 拒绝错项目/错 workspace/混投影。 |
| AC-03 双投影/配对 | **passed（离线）** | 同 snapshot 编译 runtime/ci/server + advisory；同 digest/epoch/version；空投影显式 `empty`；伪造/混投影拒绝；prompt/预算不筛硬规则（现有 selector 测试）。 |
| AC-04 last-good/TTL/钉版 | **passed（离线）** | 现有 `activation/store` 测试 + `activation/runtime` TTL/epoch；last-good 不跨项目、失败不续 TTL、时钟倒退停止；适配器 session 钉住激活 snapshot。 |
| AC-05 Harness 边界/无 reviewer | **passed（Harness 层，真实 Pi）** | `dist/managed/pi-harness.test.js`：真实 Pi AgentSession + 真实 write 工具 + 真实文件副作用；deny 无文件、allow/log 写入、confirm 无 review 停止、reviewer mismatch 停止、approved 只写一次；`host/` 仍有本地 FS 测试。**独立 UID/挂载域/bwrap/cgroup 本轮明确不做，不是阻塞，也不宣称 OS 沙箱。** |
| AC-06 覆盖/保护面 | **partial（Harness 层）** | 归一化工具闭集；未知/覆盖缺口在 managed 模式阻断；策略 deny/confirm 由规则引擎决定；审计/策略/配置路径仍同写域。**OS symlink/bind mount/TOCTOU/子进程中介本轮不做，不宣称全副作用覆盖。** |
| AC-07 一次授权/重放 | **passed（离线）** | `review/authority` 42 项 + `managed` 10 项：只消费一次；错 target/session/epoch/snapshot/capability/ceiling/过期/重放均不执行；拒绝/低置信/超时/无通道停止；二次执行无副作用。 |
| AC-08 reviewer/egress | **passed（本地确定性 reviewer）** | 最小投影经真实 loopback HTTP 发送；本地确定性 reviewer 只看 tool/operation/相对 target/规则 ID/digest；无内容/命令/绝对外部路径/requirement 文本；sensor 仍 tighten-only；reviewer 不能覆盖 deny；无校准/超时/失败停止。**真实模型校准本轮不作为 MVP 必需项，未运行。** |
| AC-09 全配置导入/秘密 | **passed（本地）** | `governance/import` 全量预览（真实 9 条 YAML + guidance seeds），重复 ID/未知字段/非法谓词/秘密字面量拒绝；秘密只存 `{env:NAME}`；旧文件切换后无回退路径（无双向同步实现）。 |
| AC-10 提案/CAS/发布 | **passed（本地）** | `governance/store/http`：Agent 不能审/发；陈旧/过期/终结提案失败；并发 CAS/注入编译器失败不半发布；回滚新版本；receipt 不显示已生效。 |
| AC-11 DB/备份/HTTP 安全 | **passed（本地）** | 损坏/未知 schema/错误权限/符号链接拒绝且不重置；WAL 备份恢复；loopback Host/Origin/CSRF/CSP/角色/请求体上限/跨项目隔离测试。**真实浏览器/CSP 浏览器证据 blocked。** |
| AC-12 浏览器治理流程 | **blocked** | 未移植 B 的 Vue 治理台；无登录→项目→规则→发布→回滚真实浏览器流程。API 测试不能替代。 |
| AC-13 注入同源/失败 | **partial** | 未激活不注入、prompt 点名不加规则、TTL/路由失败不跨项目、预算遗漏有测试；Pi/OpenCode 可选 activation advisory，未配置仍 seed；注入失败不改裁决。**默认适配器未切；持久接受回执未接。** |
| AC-14 工程护栏 | **passed（回归）** | 现有 workflow shell/change-review/diff/Jev/Pi/OpenCode 测试全过；未知 Shell、固定 argv、超时/输出上限、diff 过滤、逐字 grant 不覆盖 deny 保持。 |
| AC-15 临时收紧 | **partial（进程内）** | `activation/tighten`：仅批准模板、0 层/放宽/新叙事/改旧规则/超 TTL/配额/时钟倒退拒绝；到期 epoch+1、不续期。**重启恢复/持久配额/真实宿主原子切换 blocked。** |
| AC-16 rollout 证据门 | **partial** | `rollout` 28 项：错误版本/宿主/环境/检查、synthetic/skip/inconclusive、缺覆盖、未授权副作用、过期、伪造 digest 不晋升；`confirm_enabled` 需 reviewer 校准。**真实 probe/流量/阈值预授权 blocked。** |
| AC-17 live model provider | **out-of-scope / blocked（MVP）** | MVP 使用独立本地确定性 reviewer；没有真实模型 key/费用/出境授权，未向外部 provider 发请求。若未来要求实时模型校准，仍按 blocked 补验。 |
| AC-18 TS 检查/接纳 | **partial** | `check` 23 项：真实 tsc 正反例、精确 tree、失败/漏跑/旧 tree/伪造 digest/不安全路径拒绝；无远端 CI/受管提交门，跳 hook 集成未证明。 |
| AC-19 审计/隐私 | **partial（Harness 层）** | Pi managed gate 在放行前写 authorization 并 fsync；tool_result 另记 result；deny/confirm 停止；测试断言不含内容/命令/绝对外部路径；审计失败不执行。**同 UID 审计可改写、无外部锚定、非防篡改；不宣称覆盖所有副作用。** |
| AC-20 能力矩阵/桥接 | **partial** | Pi managed 是显式 `.pi/amos.json` opt-in；默认仍 log-only；根 `workflowGate.enabled=false` 未改；B 格式未强转；治理发布→catalog v2 编译→receipt 契约有本地测试。**真实宿主接收/生效、来源认证仍 partial/blocked。** |
| AC-21 历史不改写 | **passed（保留）** | 未改 `spike/` 原始 JSONL、审核结论或 archive v1；新增文档/模块不伪造历史人审；派生输出仍要求新路径。 |
| AC-22 自动裁决/指标 | **partial** | 正常执行不逐次人工批准（managed grant）；拒绝重试有界、故障停止有测试；未实现真实误放行/误拒/完成率指标采集。 |

## MVP Harness 层真实调用证据

`node --test dist/managed/pi-harness.test.js`：7 pass / 0 fail。使用真实
Pi `AgentSession`、真实扩展加载、真实 `write` 工具与临时文件系统；模型
响应由 faux provider 脚本化，但工具执行/阻断/副作用是真实的。

覆盖：deny 无文件；log allow 写入；confirm 无 reviewer 停止；loopback
HTTP + 本地确定性 reviewer approved 后恰好一次写入；reviewer mismatch
停止；activation advisory 进入真实 system prompt；审计路径在工作区内时
fail closed。审查投影断言不含内容、绝对工作区路径或 requirement 原文。

## 汇总

- passed（本地/离线，限表内范围）：AC-01、02、03、04、05、07、08、09、
  10、11、14、21。
- partial：AC-06、13、15、16、18、19、20、22。
- blocked/out-of-scope：AC-12（GUI）、AC-17（live model；MVP 用本地
  deterministic reviewer）。

`passed` 不等于生产可用或阶段门通过；OS 隔离本轮不做，不宣称 OS 沙箱、
全副作用覆盖或防篡改审计；安全敏感实现仍是 `pending-human-review`，
G0/NO-GO 结论未改。
