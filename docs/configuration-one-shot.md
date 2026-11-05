# 配置迁移、治理发布与受管启动说明（one-shot）

状态：离线/本地实现说明。SQLite 治理库与 loopback API 已实现并通过本地
测试；**Vue 治理台未交付**，真实宿主接收/生效回执未接入，来源认证未实现。
不得把本文当作生产部署或安全启用批准。

## 1. 单一事实源

- 入口：`openGovernanceDatabase({ path })`（`governance/database.ts`）。
- SQLite schema v1；`journal_mode=WAL`、`synchronous=FULL`、
  `foreign_keys=ON`、`trusted_schema=OFF`。
- 文件必须是绝对路径、普通文件、owner-only `0600`、非符号链接；DB/WAL/
  SHM 同样检查。未知/更高 schema、损坏库、错误权限拒绝打开，不自动删除、
  不重置、不回退项目 YAML。
- 公共 API 不暴露任意 SQL；只有 typed store。
- 秘密只保存 `{env:NAME}` / `env:NAME` 引用；出现字面凭据即拒绝导入/候选。

## 2. 导入预览与迁移

入口：

- 库：`previewImport(sources, current?)`、`buildImportCandidate(sources)`。
- HTTP：`POST /api/import/preview`（human + CSRF）、
  `POST /api/import/apply`（human + CSRF；只创建提案，不发布）。

`ImportSources`：`rulesYaml`、`ruleSchema`、`guidance`，以及可选
`piConfig`、`opencodeOptions`、`jevConfig`（非秘密设置）。

规则：

- 全量等价：YAML 全部规则 + 全部 guidance seeds + 映射的非秘密设置；
  重复 ID、未知字段、非法谓词/表、秘密字面量、非法配置都拒绝；不静默
  丢弃或补默认。
- 预览是确定性的，候选 digest 与发布时编译的候选一致。
- 旧 YAML/JSON 只作为导入/导出/fixture/归档；切换后不读取旧文件作为
  回退，不做双主同步。

迁移步骤（人执行，可逆前先备份）：

1. 停止写入旧配置的进程；用现有 `backupDatabase` 或文件系统快照保留现状。
2. 调用 preview，逐项审阅 `issues`；修复拒绝项后重新预览。
3. 注册项目：`POST /api/projects`（human）。
4. `POST /api/import/apply` 生成提案；不要在同一请求里发布。
5. `POST /api/proposals/:id/decision`（human）批准；审阅 baseVersion/
   candidateDigest/范围/期限。
6. `POST /api/projects/:id/publish`（human）；服务端用现有
   `amos-unified-rule-catalog` v2 编译器编译并 verify，在**一个事务**内写
   审计、不可变 publication、snapshot 并推进 currentVersion。
7. 宿主接收后调用受信 `POST /api/internal/receipts`（host bearer，非
   Agent/human UI），单独记录 receipt；`published` 不等于 `received` 或
   `effective`。
8. 用 `GET /api/projects/:id/status` 核对三个阶段；没有 receipt 不得显示
   已生效。
9. 回滚：`POST /api/projects/:id/rollback`（human，`{toVersion}`）生成新
   版本；旧指针不移动，历史不删除。

## 3. HTTP 安全边界

- 仅绑定 `127.0.0.1`；精确 Host/Origin allowlist；变更请求要求 CSRF
  header；HttpOnly SameSite=Lax 会话 cookie；JSON content-type；请求体
  上限；`default-src 'none'` CSP；稳定 `{error:{code}}`。
- human/agent 会话由服务端构造；Agent 可提交提案和读脱敏视图，但不能
  decision/publish/receipt；单人自批不称四眼审批。
- GET 不写治理状态；无静态资产/GUI 路由、无任意 SQL。
- 这只是 loopback 传输/角色框架，不是独立 UID、来源认证或宿主隔离。

## 4. 备份与恢复

- `backupDatabase(db, destination)`：先 WAL checkpoint，再以独占方式复制到
  新目标（目标已存在拒绝），`0600`，返回 `sha256` 与字节数；不覆盖。
- `restoreDatabase(source, destination)`：源必须普通 `0600` 文件、无未
  checkpoint 的 WAL；先 `quick_check`、schema 版本与必需表校验，再独占
  复制到新目标；损坏/未知/权限不符拒绝，不自动重置，不回退 YAML。
- 跨配置库/审计库不是天然事务；拆分存储前必须另行设计审计先行/恢复。

## 5. 受管文件宿主启动（离线）

`managed/flow.ts` 的组合方式（尚无 harness 默认入口）：

1. 加载并 `createActivationRuntime(snapshot, { projectId, workspace })`；
   snapshot 必须来自 catalog v2 编译且通过结构/identity 校验。该验证不是
   来源认证。
2. 配置 `capability`（闭集 tools、resourceRoots、读写上限、操作上限、
   到期时间）和 `auditPath`；audit 必须在工作区外，否则宿主构造失败。
3. 配置 `sessionId`、可选 `RequirementFrame`、以及 reviewer provider/
   policy/calibration/ceiling（可为 null；null 时 confirm 全部停止）。
4. `createManagedFlow(...)` 后：
   - `execute`：无 grant 时 confirm 先停；
   - `authorize`：只对 confirm 发最小投影给 reviewer，approved 才发一次性
     grant；
   - `executeReviewed`：先停，再走一次 authorize + execute（便利方法）。
5. 真实启用还需要：独立 OS 身份/挂载域、来源认证、真实 provider 校准、
   rollout 阈值/预授权、宿主接收回执。当前均未满足。

不得把 `.pi/amos.json` 或项目内可写文件指向任意 activation snapshot 作为
受信来源；在 O5 未决前，受管入口保持离线/未启用。

## 6. 未完成/阻塞

- Vue 治理台、浏览器登录→项目→规则→发布→回滚流程（AC-12）。
- 真实宿主接收/生效回执；当前只有记录契约与本地测试。
- 全配置文件的自动发现/一次性切换证据；调用方需显式提供 sources。
- 来源认证/秘密存储/引导（O5）、真实 reviewer 校准（O3）、rollout 预授权
  （O4）、独立 OS 隔离（O2）。
- 安全 deny/confirm 未启用；NO-GO 未改变。
