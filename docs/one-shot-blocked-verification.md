# One-shot blocked 项的精确补验步骤

本文件只列**未完成**的真实环境验证与复验步骤。它们不是已通过证据；在
完成前，相关能力保持未启用/未认证。

## 1. 独立安全 reviewer：真实 provider 校准

现状：`review/` 只有协议、最小投影、校准门与 loopback stub 测试。未向任何
真实 provider 发请求；无凭据、无出境/费用授权、无真实校准集（O3）。

补验前需要人工提供：

1. provider/模型与 endpoint；只允许 `{env:NAME}` 引用凭据，不写入配置库、
   文档、测试或提交。
2. 明确的数据出境授权：允许发送的字段（只应是 `review/projection.ts` 的
   白名单）、禁止的字段（内容、命令、环境、凭据、绝对外部路径）。
3. 费用授权与调用上限。
4. 校准集：由人预先注册的正例/反例与不安全样例，固定 digest；不得由模型
   自报“未执行”作为证据。

补验步骤（在隔离工作区、脱敏工件）：

```bash
# 1) 只跑协议测试，确认没有网络调用
npm run build && node --test dist/review/*.test.js

# 2) 用本地 loopback stub 复核发送体只含允许投影
#    （已由测试覆盖；保留测试输出摘要，不保留请求正文）

# 3) 真实 provider（需显式 opt-in、费用/出境授权后）
#    - 用临时环境变量注入 key（不落盘）
#    - 只发送固定校准集的脱敏输入
#    - 记录 provider/模型/版本、问题集 digest、调用数、失败/超时、
#      false-allow/false-deny 统计与费用（若 provider 提供可信 usage）
#    - 保存脱敏摘要与不可逆 digest，不保存原文/响应正文
```

通过条件：`review/calibration.ts` 的绑定全部匹配、样本量达到预注册阈值、
false-allow 率不超过阈值、无超时/失败；否则保持 `blocked`，不得启用
confirm。一次连通不是校准。

## 2. 真实 OS 执行身份/挂载域隔离（P2A/P4）

现状：`host/` 在本地文件系统上验证了路径、符号链接、硬链接、保护路径、
审计前置与崩溃恢复；没有独立 UID、挂载域、cgroup、bwrap、受信监督进程或
真实 Pi/OpenCode 受管入口。

补验需要：

1. 一台可用的隔离环境（独立 UID 或 namespace/bwrap/cgroup）；记录内核、
   Node、宿主版本与挂载配置。
2. 受信 supervisor 与 Agent 写域分离；audit/policy/snapshot 不在 Agent
   可写域。
3. 对抗矩阵：工作区外读写、symlink/hardlink/bind mount、子进程/MCP/插件、
   `.git/hooks`/`.git/config`、审计/策略/凭据路径、TOCTOU、崩溃/重启。

步骤：

```bash
# 在隔离环境内，以受管身份启动宿主/适配器
# 1) 正常文件读/写对照：确认真实副作用与审计
# 2) 越界/受保护/未知入口：确认真实副作用为 0（不是日志为 deny）
# 3) 崩溃注入：authorization 后 kill -9，重启确认 unknown 且不重放
# 4) 将环境、版本、输入/期望摘要、实际副作用对照、脱敏工件单独记录
```

未取得这些证据前，`host/` 只标 `pending-human-review`，不声称
managed/security boundary。

## 3. 真实 probe 与生产 rollout（P4）

现状：`rollout/` 只做纯证据门；没有真实 ProbeRun、真实流量、宿主接收回执
或生产晋升。`ROLL-05` 的 live probe 需要显式 opt-in。

补验需要人工授予：

- 允许的真实工作区/固定受控端点；不携真实秘密；
- 预注册阈值（样本量、覆盖率、false-allow/deny、宿主/环境范围）；
- 观察窗口与回滚/停止条件。

步骤：按 `rollout/contracts.ts` 记录 trusted-os driver 的真实正反例与
副作用对照；用 `evaluatePromotion` 复核；任何 synthetic/skip/inconclusive/
缺覆盖/错版本/过期证据保持 hold。完成前不启用生产 confirm，不解除 NO-GO。

## 4. 治理台浏览器流程（AC-12）

现状：`governance/` 只交付 SQLite/API 与本地 HTTP 测试；B 的 Vue `web/`
未移植，AC-12 未交付。

补验步骤若后续移植：构建真实本地服务 → 登录 → 项目 → 规则 → 导入预览 →
提案 → 审批/发布 → 导出/回滚 → 重登；验证跨项目隔离、Agent 角色拒绝、
过期会话、CSRF/Origin/Host/CSP、错误/空态、移动端关键流程；不使用 mock
数据。完成前 UI 标 `blocked/partial`，不能把 API 测试当浏览器证据。

## 5. 宿主接收与生效回执（P3/AC-20）

现状：只有 `Receipt` 记录契约与本地测试；没有真实宿主进程接收/生效回执。

补验：受信宿主验证来源/能力/epoch 后写入 receipt；治理状态分别显示
published/received/effective；错 digest/错 project/未知 publication 拒绝；
宿主拒收时 UI 不得显示已生效。没有来源认证（O5）前，接收也不能自动升级为
“已认证”。

## 6. 来源认证（O5）

现状：只有 ADR 与一致性 verify；未实现签名/HMAC/独立密钥域/外部锚定。

在人工选定机制并完成引导/轮换/撤销/时钟设计前，不实现、不启用、不声称
来源认证；所有相关状态 `pending-human-review`。
