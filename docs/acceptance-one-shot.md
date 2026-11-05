# One-shot 验收矩阵（AC-01–AC-22）

状态口径：`passed` 只表示本表注明的本地/离线证据；`partial` 表示部分正反例
有证据但范围未闭合；`blocked` 表示缺真实外部条件，不能算通过。全表不改变
安全运行期 NO-GO。

全套命令与环境见 `docs/verification-one-shot.md`。整合后实际：
`npm run typecheck` exit 0；`npm test` 686 pass / 0 fail / 0 skip；
`git diff --check` exit 0。

| AC | 状态 | 证据 / 未覆盖 |
|---|---|---|
| AC-01 规则/引擎/兼容 | **passed（本地）** | 现有 engine/fixtures/schema/audit 测试全过；`log-only` recorder 的 `defaultVerdict: deny` 与 no-match 语义未改；旧 archive v1/JSONL v2 未改写。 |
| AC-02 项目激活/基线 | **passed（离线）** | `dist/activation/*.test.js`：两项目不同激活、排除必选失败、失败/检测缺失不减激活、首次无 snapshot 不启动；`activation/runtime` 拒绝错项目/错 workspace/混投影。 |
| AC-03 双投影/配对 | **passed（离线）** | 同 snapshot 编译 runtime/ci/server + advisory；同 digest/epoch/version；空投影显式 `empty`；伪造/混投影拒绝；prompt/预算不筛硬规则（现有 selector 测试）。 |
| AC-04 last-good/TTL/钉版 | **passed（离线）** | 现有 `activation/store` 测试 + `activation/runtime` TTL/epoch；last-good 不跨项目、失败不续 TTL、时钟倒退停止；适配器 session 钉住激活 snapshot。 |
| AC-05 宿主边界/无 reviewer | **passed（本地 FS）** | `dist/host/*.test.js`：真实临时文件系统；允许读、越界/受保护/未知入口无副作用；无 reviewer 时 confirm 停止；修改配置不能造执行器/关边界（闭集 + 保护路径）。**OS 身份/挂载域隔离 blocked。** |
| AC-06 保护矩阵/持久化面 | **partial** | `.git/hooks`、`.git/config`、`.pi`、`constraints`、`decision/jev.local.json`、审计路径保护；symlink/hardlink 写/unknown 工具/子进程无入口均有测试。bind mount、TOCTOU 对象身份、`read` 的预置 hardlink 未完全覆盖；未做独立 OS 对抗。 |
| AC-07 一次授权/重放 | **passed（离线）** | `review/authority` 42 项 + `managed` 10 项：只消费一次；错 target/session/epoch/snapshot/capability/ceiling/过期/重放均不执行；拒绝/低置信/超时/无通道停止；二次执行无副作用。 |
| AC-08 reviewer/egress | **partial** | 最小投影测试断言无绝对外部路径/内容/命令/requirement 文本/秘密；sensor 仍 tighten-only；reviewer 不能覆盖 deny；无校准/超时/失败停止。**真实 provider 校准/费用/出境 blocked。** |
| AC-09 全配置导入/秘密 | **passed（本地）** | `governance/import` 全量预览（真实 15 条 YAML + guidance seeds），重复 ID/未知字段/非法谓词/秘密字面量拒绝；秘密只存 `{env:NAME}`；旧文件切换后无回退路径（无双向同步实现）。 |
| AC-10 提案/CAS/发布 | **passed（本地）** | `governance/store/http`：Agent 不能审/发；陈旧/过期/终结提案失败；并发 CAS/注入编译器失败不半发布；回滚新版本；receipt 不显示已生效。 |
| AC-11 DB/备份/HTTP 安全 | **passed（本地）** | 损坏/未知 schema/错误权限/符号链接拒绝且不重置；WAL 备份恢复；loopback Host/Origin/CSRF/CSP/角色/请求体上限/跨项目隔离测试。**真实浏览器/CSP 浏览器证据 blocked。** |
| AC-12 浏览器治理流程 | **blocked** | 未移植 B 的 Vue 治理台；无登录→项目→规则→发布→回滚真实浏览器流程。API 测试不能替代。 |
| AC-13 注入同源/失败 | **partial** | 未激活不注入、prompt 点名不加规则、TTL/路由失败不跨项目、预算遗漏有测试；Pi/OpenCode 可选 activation advisory，未配置仍 seed；注入失败不改裁决。**默认适配器未切；持久接受回执未接。** |
| AC-14 工程护栏 | **passed（回归）** | 现有 workflow shell/change-review/diff/Jev/Pi/OpenCode 测试全过；未知 Shell、固定 argv、超时/输出上限、diff 过滤、逐字 grant 不覆盖 deny 保持。 |
| AC-15 临时收紧 | **partial（进程内）** | `activation/tighten`：仅批准模板、0 层/放宽/新叙事/改旧规则/超 TTL/配额/时钟倒退拒绝；到期 epoch+1、不续期。**重启恢复/持久配额/真实宿主原子切换 blocked。** |
| AC-16 rollout 证据门 | **partial** | `rollout` 28 项：错误版本/宿主/环境/检查、synthetic/skip/inconclusive、缺覆盖、未授权副作用、过期、伪造 digest 不晋升；`confirm_enabled` 需 reviewer 校准。**真实 probe/流量/阈值预授权 blocked。** |
| AC-17 live provider/宿主 | **blocked** | 无真实 key/费用/出境授权；未向外部 provider 发请求；一次连通也不能算校准。补验见 `docs/one-shot-blocked-verification.md`。 |
| AC-18 TS 检查/接纳 | **partial** | `check` 23 项：真实 tsc 正反例、精确 tree、失败/漏跑/旧 tree/伪造 digest/不安全路径拒绝；无远端 CI/受管提交门，跳 hook 集成未证明。 |
| AC-19 审计/隐私 | **partial** | host 授权行先于副作用并 fsync；审计失败无副作用；崩溃 unknown 不重放；测试断言不含内容/命令/秘密/绝对外部路径。**同 UID 审计可改写、无外部锚定；preflight 内容读取顺序限制见 ADR。** |
| AC-20 能力矩阵/桥接 | **partial** | 根 `workflowGate.enabled=false` 未改；旧插件仍 log-only；B 格式未强转；治理发布→catalog v2 编译→receipt 契约有本地测试。**真实宿主接收/生效、来源认证 blocked。** |
| AC-21 历史不改写 | **passed（保留）** | 未改 `spike/` 原始 JSONL、审核结论或 archive v1；新增文档/模块不伪造历史人审；派生输出仍要求新路径。 |
| AC-22 自动裁决/指标 | **partial** | 正常执行不逐次人工批准（managed grant）；拒绝重试有界、故障停止有测试；未实现真实误放行/误拒/完成率指标采集。 |

## 汇总

- passed（本地/离线，限表内范围）：AC-01、02、03、04、05、07、09、10、11、14、21。
- partial：AC-06、08、13、15、16、18、19、20、22。
- blocked：AC-12、17。

`passed` 不等于生产可用或阶段门通过；所有安全敏感实现仍是
`pending-human-review`，NO-GO 未解除。
