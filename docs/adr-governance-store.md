# ADR：治理存储、迁移与发布/接收（P3）

- 状态：**存储/API 协议实现草案，pending-human-review；GUI 未交付，宿主
  接收未接**。
- 范围：`governance/` 的 SQLite 单主、导入预览、CAS 提案/发布、审计、
  备份恢复、认证 loopback API。
- 关联：GOV-01–13、RULE-13、AUD-02/03、AC-09/10/11/12/20；PRD §5.3。

## 1. 单主与迁移

- GUI 阶段全部 Amos 配置以受保护 SQLite 为唯一事实源；Git/YAML/JSON 仅
  作为导入、导出、fixture、归档。
- 导入必须**全量等价**：YAML 规则、全部 guidance seeds、`.pi/amos.json`、
  OpenCode Amos options、Jev 非秘密设置、工作流/宿主/reviewer 非秘密设置、
  rollout/probe/TTL/配额与审计保留设置，逐项映射；未知字段/重复 ID/
  秘密字面量拒绝，不静默补默认。
- 当前不做“旧 YAML 仍可回退”的双主：发布后旧文件不再生效。未完成切换的
  部署必须显式保持旧模式；不能一边声称 SQLite 主库一边读 YAML。
- 秘密只存引用（`{env:NAME}` / `secret://name`）；不存材料。备份不含秘密。
- Schema 版本化；未知/更高版本、损坏文件、错误权限、符号链接不自动
  删除/重置。恢复核验版本与完整性，不回退项目 YAML。

## 2. 提案、CAS 与发布事务

- 提案不可变，绑定 project、baseVersion、candidateDigest、候选规则/激活/
  设置与期限；baseVersion 必须等于当前发布版本（初始为 0）。
- 陈旧/过期/已终结/重复提案不能发布；相同决议的幂等重试返回既有结果，
  冲突决议报错。
- 只有 human 角色能审批/发布；Agent 只能提交提案和读脱敏视图。单人自批
  不称四眼审批。
- 发布在**一个 SQLite 事务**内：校验 → 用现有
  `amos-unified-rule-catalog` v2 编译器编译 activation snapshot → verify →
  写入不可变版本/publication/audit → 推进 currentVersion。失败不留下
  半个版本；审计与发布同事务（或审计先行）。
- 回滚 = 新提案/新版本，复制历史内容后编译发布；不移动旧指针，不恢复
  旧 YAML。

## 3. 发布 ≠ 宿主接收 ≠ 生效

- `Publication` 只表示治理库已提交版本；`Receipt` 由受信宿主另行记录，
  绑定 publicationId/project/activationDigest/host 版本/接收时间/是否生效。
- 错 digest、错 project、未知 publication 的 receipt 拒绝。
- 状态 API 必须分别显示 published/received/effective，并明确
  `unsupported`/`unmanaged`；没有回执不能显示“已生效”。
- 本轮没有真实宿主进程回执接线；只交付记录契约与本地测试，标 blocked。

## 4. 备份与恢复

- 使用 SQLite 一致性备份（含 WAL）；目标不存在，父目录受检，生成
  `sha256` 摘要。
- 恢复源必须普通文件、非符号链接；先 `integrity_check` 与 schema 版本
  检查，再写入新目标；目标已存在拒绝。损坏/未知 schema/错误权限不自动
  重置。
- 跨配置库/审计库不假装天然事务；本轮同一 DB 内原子，未来拆分必须显式
  设计两阶段/审计先行。

## 5. API 与角色

- 仅绑定 `127.0.0.1`；精确 Host/Origin；变更请求要求 CSRF；HttpOnly
  SameSite=Lax 会话 cookie；请求体上限；JSON；稳定错误码；CSP。
- 人/Agent 会话由服务端构造，不信任客户端 role/actor；Agent 调用
  decision/publish/receipt 一律拒绝。
- 无任意 SQL/ORM/JS 逃生舱；GET 不写治理状态。
- 静态资产/浏览器 UI：**本轮未交付**。B 的 Vue 治理台未移植；不声称
  AC-12，不以 API 存在冒充 GUI 完成。

## 6. 明确未完成

- 全配置（尤其 guidance/Jev/工作流/宿主）运行期迁移与旧文件失效的部署
  证据。
- 真实宿主接收回执、生效回执与回滚后的宿主确认。
- Vue 浏览器流程、跨项目 UI 隔离、移动端、真实认证/过期/CSRF/CSP 浏览器
  证据（API 测试不等同浏览器）。
- 独立 UID/挂载域/受信服务；SQLite 同 UID 不是隔离。

在这些完成前，治理台标**部分交付/未启用**，安全敏感实现
`pending-human-review`。
