<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ShieldAlert, FileCheck, GitPullRequest, History, Eye, FlaskConical, Lock, AlertTriangle, Timer, Activity } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import HarnessLoadReportCards from '@/components/governance/HarnessLoadReportCards.vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { useGovernanceStore } from '@/stores/governance'
import { useAuthStore } from '@/stores/auth'
import type { GovernanceEvent } from '@/types'

const governance = useGovernanceStore()
const auth = useAuthStore()
const audit = ref<GovernanceEvent[]>([])
const auditError = ref('')
const auditLoading = ref(false)
const configSaving = ref(false)
const configError = ref('')
const nowMs = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
let generation = 0

onMounted(() => { ticker = setInterval(() => { nowMs.value = Date.now() }, 1000) })
onUnmounted(() => { if (ticker) clearInterval(ticker) })

async function loadAudit() {
  const id = governance.activeProjectId
  const request = ++generation
  audit.value = []; auditError.value = ''
  if (!id) return
  auditLoading.value = true
  try {
    const data = await api.audit({ projectId: id, limit: 6 })
    if (request === generation) audit.value = data.items
  } catch (error) {
    if (request === generation) auditError.value = error instanceof Error ? error.message : '审计记录加载失败'
  } finally {
    if (request === generation) auditLoading.value = false
  }
}

watch(() => governance.activeProjectId, () => { void loadAudit(); void governance.refreshRuntime() }, { immediate: true })
onMounted(() => { void loadAudit(); void governance.refreshRuntime() })

const stats = computed(() => [
  { label: '当前版本', value: governance.currentVersion == null ? '尚未发布' : `v${governance.currentVersion}`, note: governance.currentVersion == null ? '项目无已发布治理版本' : '已发布本地治理版本' },
  { label: '已发布规则', value: String(governance.policy?.candidate.rules.length ?? 0), note: '当前候选中的规则总数' },
  { label: '本地选中规则', value: String(activeCount.value), note: activationNote.value },
  { label: '待审提案', value: String(governance.proposals.filter(p => p.status === 'pending').length), note: '需审批后才会生成版本' },
  { label: '历史版本', value: String(governance.versions.length), note: '不可变治理快照' },
])

const activeCount = computed(() => {
  const rules = governance.policy?.candidate.rules ?? []
  const activation = governance.policy?.candidate.activation
  if (!activation) return 0
  const included = activation.includedRuleIds
  if (included === null) return rules.filter(r => !activation.excludedRuleIds.includes(r.id)).length
  return rules.filter(r => included.includes(r.id) && !activation.excludedRuleIds.includes(r.id)).length
})

const activationNote = computed(() => {
  const activation = governance.policy?.candidate.activation
  if (!activation) return '—'
  if (activation.includedRuleIds === null) {
    const excluded = activation.excludedRuleIds.length
    return excluded ? `包含全部，排除 ${excluded} 条` : '包含全部规则'
  }
  return `显式包含 ${activation.includedRuleIds.length} 条`
})

const projectionView = computed(() => {
  switch (governance.runtime?.projection?.status) {
    case 'written': return { label: '当前配置投影已写入', tone: 'border-positive/30 bg-positive/5 text-positive', note: '宿主文件与当前生效配置匹配；仍需 Harness 后续加载。' }
    case 'missing': return { label: '宿主投影缺失', tone: 'border-warning/30 bg-warning/5 text-warning', note: '未找到宿主配置投影，不能据此认定 Harness 已加载。' }
    case 'stale': return { label: '旧配置投影', tone: 'border-warning/30 bg-warning/5 text-warning', note: '宿主文件与当前生效配置不匹配，请重新保存配置或发布。' }
    case 'invalid': return { label: '宿主投影无效', tone: 'border-destructive/30 bg-destructive/5 text-destructive', note: '宿主配置投影无法校验，请检查工作区中的投影文件。' }
    default: return { label: '投影状态不可用', tone: 'border-border bg-muted/60 text-muted-foreground', note: '运行状态不可用，无法确认宿主投影。' }
  }
})

const activeTightenings = computed(() => governance.tightenings?.active ?? [])
const expiredTightenings = computed(() => (governance.tightenings?.expired ?? []).slice(0, 3))
const recentProbes = computed(() => governance.probes.slice(0, 5))
const canEditConfig = computed(() => auth.session?.role === 'human')

function remainingTtl(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - nowMs.value)
  const seconds = Math.ceil(remaining / 1000)
  if (seconds <= 0) return '已到期（等待清理）'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}

function booleanOverrideValue(value: boolean | null): string {
  return value === null ? 'inherit' : value ? 'enabled' : 'disabled'
}

type HarnessOverridePatch = {
  enabled?: boolean | null
  mode?: 'log-only' | 'managed' | null
  advisoryInjection?: boolean | null
}

async function saveHarnessOverride(patch: HarnessOverridePatch): Promise<void> {
  if (!governance.config || !canEditConfig.value || configSaving.value) return
  configSaving.value = true
  configError.value = ''
  try {
    await governance.updateProjectConfig({
      harness: { ...governance.config.harness, ...patch },
    })
  } catch (error) {
    configError.value = error instanceof Error ? error.message : '保存项目 Harness 配置失败。'
  } finally {
    configSaving.value = false
  }
}

function setHarnessEnabled(value: unknown): void {
  const enabled = value === 'inherit' ? null : value === 'enabled' ? true : value === 'disabled' ? false : undefined
  if (enabled !== undefined) void saveHarnessOverride({ enabled })
}

function setHarnessMode(value: unknown): void {
  const mode = value === 'inherit' ? null : value === 'log-only' || value === 'managed' ? value : undefined
  if (mode !== undefined) void saveHarnessOverride({ mode })
}

function setAdvisoryInjection(value: unknown): void {
  const advisoryInjection = value === 'inherit' ? null : value === 'enabled' ? true : value === 'disabled' ? false : undefined
  if (advisoryInjection !== undefined) void saveHarnessOverride({ advisoryInjection })
}

async function setTighteningEnabled(enabled: boolean): Promise<void> {
  if (!governance.config || configSaving.value) return
  configSaving.value = true
  configError.value = ''
  try {
    await governance.updateProjectConfig({
      tightening: { ...governance.config.tightening, enabled },
    })
  } catch (error) {
    configError.value = error instanceof Error ? error.message : '保存项目配置失败。'
  } finally {
    configSaving.value = false
  }
}

async function expireTightenings(): Promise<void> {
  if (configSaving.value) return
  configSaving.value = true
  configError.value = ''
  try {
    await governance.expireTightenings()
  } catch (error) {
    configError.value = error instanceof Error ? error.message : '临时收紧过期失败。'
  } finally {
    configSaving.value = false
  }
}

const pendingProposals = computed(() => governance.proposals.filter(p => p.status === 'pending').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const staleProposals = computed(() => pendingProposals.value.filter(p => p.baseVersion !== (governance.policy?.version ?? 0)))
const eventLabels: Record<string, string> = { project_created: '创建项目', proposal_created: '创建提案', proposal_approved: '批准提案', proposal_rejected: '拒绝提案', proposal_withdrawn: '撤回提案', proposal_expired: '提案过期', version_published: '发布版本' }
</script>

<template>
  <div class="page">
    <PageHeader title="项目边界" description="查看项目绑定、本地治理配置及运行状态的已知边界。">
      <template #actions>
        <span v-if="auth.session?.role" class="hidden text-xs text-muted-foreground md:inline">当前身份：{{ auth.session.role === 'human' ? '人类' : 'Agent' }}</span>
      </template>
    </PageHeader>

    <div class="mb-4 rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      <strong class="text-foreground">运行边界：</strong>全局默认与项目覆盖决定生效配置，宿主投影供后续 Harness 加载。保存或发布不等于已加载；请以 Pi/OpenCode 各自最新加载报告核验。Managed 仅覆盖已接管工具入口，不是 OS 沙箱。
    </div>

    <div v-if="governance.error" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.initialize()">重试</button></div>
    <div v-if="governance.loading" class="py-8 text-sm text-muted-foreground" role="status">正在加载治理数据…</div>
    <div v-else-if="governance.error" class="text-xs text-muted-foreground">项目数据不可用，无法计算配置数量。</div>
    <EmptyState v-else-if="!governance.activeProject" title="尚未选择项目" description="请在侧栏创建或选择项目。新项目不会自动发布策略。" />

    <template v-else>
      <section class="panel mb-4">
        <div class="panel-header"><div><h2 class="panel-title">项目与本地快照</h2><p class="panel-kicker">绑定工作区与已发布治理版本；不是运行时快照。</p></div><RouterLink to="/versions" class="text-xs text-primary hover:underline">版本历史 →</RouterLink></div>
        <dl class="grid gap-4 p-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <div><dt class="field-label">项目</dt><dd class="mt-1 break-all font-medium">{{ governance.activeProject.name }}</dd><dd class="mt-1 break-all font-mono text-muted-foreground">{{ governance.activeProject.id }}</dd></div>
          <div><dt class="field-label">绑定工作区</dt><dd class="mt-1 break-all font-mono">{{ governance.activeProject.workspace }}</dd></div>
          <div><dt class="field-label">本地发布时间</dt><dd class="mt-1">{{ governance.policy ? new Date(governance.policy.createdAt).toLocaleString('zh-CN') : '尚未发布' }}</dd></div>
          <div><dt class="field-label">本地快照摘要</dt><dd class="mt-1 break-all font-mono">{{ governance.policy?.snapshot.digest ?? '尚无快照' }}</dd></div>
        </dl>
      </section>
      <section class="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <article v-for="stat in stats" :key="stat.label" class="panel p-3">
          <p class="eyebrow">{{ stat.label }}</p>
          <p class="mt-3 text-xl font-semibold tabular">{{ stat.value }}</p>
          <p class="mt-1 text-[11px] text-muted-foreground">{{ stat.note }}</p>
        </article>
      </section>

      <div class="grid gap-4 lg:grid-cols-3">
        <section class="panel lg:col-span-2">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">最近治理审计</h2>
              <p class="panel-kicker">实际项目状态变更，不包含规则正文或自由文本备注。</p>
            </div>
            <RouterLink to="/audit" class="text-xs text-muted-foreground hover:text-foreground">查看全部 →</RouterLink>
          </div>
          <p v-if="auditLoading" role="status" class="p-4 text-xs text-muted-foreground">加载中…</p>
          <div v-else-if="auditError" role="alert" class="p-4 text-xs text-destructive">{{ auditError }} <button class="underline" @click="loadAudit">重试</button></div>
          <p v-else-if="!audit.length" class="p-6 text-center text-xs text-muted-foreground">暂无审计记录。</p>
          <div v-else class="overflow-x-auto">
            <table class="data-table min-w-[420px]">
              <thead>
                <tr><th>事件</th><th>操作者</th><th>时间</th></tr>
              </thead>
              <tbody>
                <tr v-for="event in audit" :key="event.id">
                  <td>{{ eventLabels[event.kind] ?? event.kind }}</td>
                  <td>{{ event.actor.id }} · {{ event.actor.role }}</td>
                  <td class="tabular">{{ new Date(event.createdAt).toLocaleString('zh-CN') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="space-y-4">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">治理注意</h2>
                <p class="panel-kicker">需要人工关注的状态</p>
              </div>
              <RouterLink to="/proposals" class="text-xs text-muted-foreground hover:text-foreground">提案 →</RouterLink>
            </div>
            <div class="space-y-2 p-3">
              <div v-if="pendingProposals.length === 0" class="flex items-center gap-2 text-xs text-muted-foreground"><FileCheck class="size-4" />无待审提案。</div>
              <div v-else class="flex items-start gap-2 text-xs">
                <GitPullRequest class="mt-0.5 size-4 text-info" />
                <div>
                  <p class="font-medium">{{ pendingProposals.length }} 个待审提案</p>
                  <p v-if="staleProposals.length" class="mt-1 text-warning"><AlertTriangle class="inline size-3" /> {{ staleProposals.length }} 个基准版本已过期，需基于当前策略重新提案。</p>
                </div>
              </div>
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldAlert class="mt-0.5 size-4" />
                <span>运行期状态来自受管 Harness 的加载报告；数据库发布成功不等于宿主已加载。</span>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">权限与能力</h2>
                <p class="panel-kicker">当前 API 未暴露权限矩阵</p>
              </div>
              <Lock class="size-4 text-muted-foreground" />
            </div>
            <div class="space-y-3 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>权限查询、角色矩阵与能力图谱尚未接入后端。以下状态基于当前会话角色与项目元数据，可能不完整：</p>
              <ul class="list-disc space-y-1 pl-4">
                <li>人类可创建项目、审批、撤回任意提案。</li>
                <li>Agent 可读取、校验、模拟、提交与撤回自己的提案，不能审批。</li>
                <li>权限判定以服务端领域层为准，前端仅展示已知约束。</li>
              </ul>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">目标能力</h2>
                <p class="panel-kicker">规划中的治理与评估能力</p>
              </div>
            </div>
            <div class="grid gap-2 p-3">
              <div class="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
                <Eye class="size-4 text-info" />
                <span>规则覆盖与命中率评估</span>
                <span class="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px]">规划中</span>
              </div>
              <RouterLink to="/simulate" class="flex items-center gap-2 rounded-md border border-border p-2 text-xs hover:bg-accent">
                <FlaskConical class="size-4 text-info" />
                <span>动作假设评估（模拟器）</span>
                <span class="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info">可用</span>
              </RouterLink>
              <RouterLink to="/versions" class="flex items-center gap-2 rounded-md border border-border p-2 text-xs hover:bg-accent">
                <History class="size-4 text-info" />
                <span>版本详情与回滚提案</span>
                <span class="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info">可用</span>
              </RouterLink>
            </div>
          </section>
        </div>
      </div>

      <section class="panel mt-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">配置投影与 Harness 加载</h2>
            <p class="panel-kicker">本地发布、宿主投影和每个 Harness 的实际回报分层展示。</p>
          </div>
        </div>
        <div class="grid gap-4 p-4 text-xs lg:grid-cols-2">
          <div class="rounded-md border border-border bg-surface p-3">
            <p class="font-semibold">已发布候选（本地治理）</p>
            <ul class="mt-2 space-y-1 text-muted-foreground">
              <li>版本：{{ governance.policy ? `v${governance.policy.version}` : '尚未发布' }}</li>
              <li>规则数：{{ governance.policy?.candidate.rules.length ?? 0 }}</li>
              <li>本地选中规则数：{{ activeCount }}</li>
              <li>快照 digest：{{ governance.policy ? `${governance.policy.snapshot.digest.slice(0, 24)}…` : '—' }}</li>
            </ul>
          </div>
          <div class="rounded-md border border-border bg-surface p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-semibold">宿主配置投影</p>
              <span class="rounded border px-2 py-0.5 text-[10px] font-medium" :class="projectionView.tone">{{ projectionView.label }}</span>
            </div>
            <p class="mt-2 leading-relaxed text-muted-foreground">由生效配置生成的宿主文件，不是加载证明。{{ projectionView.note }}</p>
            <p v-if="governance.runtime?.projection?.configDigest" class="mt-2 break-all font-mono text-[10px] text-muted-foreground">configDigest：{{ governance.runtime.projection.configDigest }}</p>
          </div>
        </div>
        <div class="border-t border-border p-4">
          <div class="mb-3">
            <h3 class="text-xs font-semibold">最新加载报告（实际回报）</h3>
            <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">每个 Harness 仅展示最新一份报告，不代表所有会话或实时状态。只有报告显示 enforcing 且与当前配置匹配时，才标记“约束已加载”。</p>
          </div>
          <HarnessLoadReportCards :runtime="governance.runtime" />
        </div>
      </section>

      <section class="panel mt-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">项目配置（SQLite 单一主库）</h2>
            <p class="panel-kicker">宿主投影与运行状态均由本地治理配置派生；凭据只保存环境变量名。</p>
          </div>
          <Lock class="size-4 text-muted-foreground" />
        </div>
        <div v-if="configError" class="mx-4 mt-3 rounded-md border border-destructive/30 p-2 text-xs text-destructive" role="alert">{{ configError }}</div>
        <div v-if="!governance.config" class="p-4 text-xs text-muted-foreground">当前项目配置不可用。</div>
        <div v-else class="grid gap-4 p-4 text-xs lg:grid-cols-2">
          <div class="rounded-md border border-border p-3">
            <div class="flex items-center justify-between gap-3">
              <p class="font-semibold">Harness 项目覆盖</p>
              <span v-if="!canEditConfig" class="text-[10px] text-muted-foreground">当前角色只读</span>
            </div>
            <p class="mt-1 leading-relaxed text-muted-foreground">每项都可跟随全局或单独覆盖；保存期望配置并尝试更新宿主投影，不代表已加载。</p>
            <div class="mt-4 space-y-3">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div><span id="project-harness-enabled-label" class="font-medium">启用 Amos</span><p class="mt-0.5 text-[10px] text-muted-foreground">harness.enabled</p></div>
                <Select :model-value="booleanOverrideValue(governance.config.harness.enabled)" :disabled="!canEditConfig || configSaving" @update:model-value="setHarnessEnabled">
                  <SelectTrigger class="w-full sm:w-[164px] sm:shrink-0" size="sm" aria-labelledby="project-harness-enabled-label"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">跟随全局</SelectItem>
                    <SelectItem value="enabled">项目覆盖：启用</SelectItem>
                    <SelectItem value="disabled">项目覆盖：停用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div><span id="project-harness-mode-label" class="font-medium">Harness 模式</span><p class="mt-0.5 text-[10px] text-muted-foreground">harness.mode</p></div>
                <Select :model-value="governance.config.harness.mode ?? 'inherit'" :disabled="!canEditConfig || configSaving" @update:model-value="setHarnessMode">
                  <SelectTrigger class="w-full sm:w-[164px] sm:shrink-0" size="sm" aria-labelledby="project-harness-mode-label"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">跟随全局</SelectItem>
                    <SelectItem value="log-only">Log-only（仅观察）</SelectItem>
                    <SelectItem value="managed">Managed（受管）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div><span id="project-advisory-injection-label" class="font-medium">建议注入</span><p class="mt-0.5 text-[10px] text-muted-foreground">harness.advisoryInjection</p></div>
                <Select :model-value="booleanOverrideValue(governance.config.harness.advisoryInjection)" :disabled="!canEditConfig || configSaving" @update:model-value="setAdvisoryInjection">
                  <SelectTrigger class="w-full sm:w-[164px] sm:shrink-0" size="sm" aria-labelledby="project-advisory-injection-label"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">跟随全局</SelectItem>
                    <SelectItem value="enabled">项目覆盖：允许</SelectItem>
                    <SelectItem value="disabled">项目覆盖：抑制</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p class="mt-3 text-[10px] leading-relaxed text-muted-foreground">建议注入独立控制；关闭只抑制建议内容，不改变 Harness 开关、运行模式或 Workflow Gate。</p>
            <div class="mt-4 rounded-md border border-info/25 bg-info/5 p-3">
              <p class="font-semibold text-info">生效配置（非加载证明）</p>
              <p class="mt-1 text-[10px] leading-relaxed text-muted-foreground">由全局默认与项目覆盖合并得到，用于生成宿主投影。</p>
              <dl class="mt-3 grid grid-cols-3 gap-2">
                <div><dt class="text-[10px] text-muted-foreground">Amos</dt><dd class="mt-1 font-medium">{{ governance.config.effectiveHarness.enabled ? '启用' : '停用' }}</dd></div>
                <div><dt class="text-[10px] text-muted-foreground">模式</dt><dd class="mt-1 font-medium">{{ governance.config.effectiveHarness.mode === 'managed' ? 'Managed' : 'Log-only' }}</dd></div>
                <div><dt class="text-[10px] text-muted-foreground">建议注入</dt><dd class="mt-1 font-medium">{{ governance.config.effectiveHarness.advisoryInjection ? '允许' : '抑制' }}</dd></div>
              </dl>
            </div>
            <div class="mt-3 border-t border-border pt-3 text-muted-foreground">
              <p class="leading-relaxed">Managed 的 confirm 仍需独立 reviewer 与一次性授权；审查参数和 Workflow Gate 不随上述默认值自动启用。</p>
              <p class="mt-2 break-all font-mono text-[10px]">requirementEgress: {{ governance.config.managed.requirementEgress }} · grantTtlMs: {{ governance.config.managed.grantTtlMs }}</p>
              <p class="mt-1 break-all font-mono text-[10px]">reviewer: {{ governance.config.managed.reviewer ?? '未配置' }} · jevConfigPath: {{ governance.config.managed.jevConfigPath ?? '未配置' }}</p>
            </div>
          </div>
          <div class="rounded-md border border-border p-3">
            <p class="font-semibold">临时收紧</p>
            <p class="mt-1 text-muted-foreground">仅允许人预授权的非 0 层确定性 deny/confirm 模板；TTL、配额与 epoch 由服务端执行。</p>
            <label class="mt-3 flex items-center justify-between gap-3">
              <span>tightening.enabled</span>
              <input
                type="checkbox"
                class="size-4 accent-[hsl(var(--primary))]"
                :checked="governance.config.tightening.enabled"
                :disabled="!canEditConfig || configSaving"
                @change="setTighteningEnabled(($event.target as HTMLInputElement).checked)"
              >
            </label>
            <p class="mt-2 text-muted-foreground">模板 {{ governance.config.tightening.templates.length }} 个 · 配额 maxActive {{ governance.config.tightening.quota.maxActive }} / maxApplications {{ governance.config.tightening.quota.maxApplications }}</p>
          </div>
        </div>
      </section>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">临时收紧状态</h2>
              <p class="panel-kicker">epoch {{ governance.tightenings?.epoch ?? '—' }} · {{ activeTightenings.length }} 条生效中</p>
            </div>
            <Timer class="size-4 text-muted-foreground" />
          </div>
          <div v-if="!activeTightenings.length && !expiredTightenings.length" class="p-4 text-xs text-muted-foreground">当前没有临时收紧记录。</div>
          <div v-else class="space-y-3 p-4 text-xs">
            <div v-for="item in activeTightenings" :key="item.id" class="rounded-md border border-warning/30 bg-warning/5 p-3">
              <p class="font-medium">{{ item.templateId }} · {{ item.ruleRef.id }}@v{{ item.ruleRef.version }}</p>
              <p class="mt-1 text-muted-foreground">epoch {{ item.epoch }} · 剩余 {{ remainingTtl(item.expiresAt) }}</p>
              <p class="mt-1 break-all font-mono text-[10px] text-muted-foreground">{{ item.activationDigest }}</p>
            </div>
            <div v-if="expiredTightenings.length" class="text-muted-foreground">
              <p class="mb-1">最近过期</p>
              <p v-for="item in expiredTightenings" :key="item.id" class="break-all font-mono text-[10px]">{{ item.templateId }} · {{ item.ruleRef.id }} · epoch {{ item.epoch }}</p>
            </div>
            <button v-if="activeTightenings.length" type="button" class="text-xs underline disabled:opacity-50" :disabled="configSaving" @click="expireTightenings">立即清理已到期条目</button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Rollout 与 Probe</h2>
              <p class="panel-kicker">证据绑定规则版本、激活快照、宿主与环境。</p>
            </div>
            <Activity class="size-4 text-muted-foreground" />
          </div>
          <div v-if="!governance.rollouts.length && !recentProbes.length" class="p-4 text-xs text-muted-foreground">尚无 rollout 状态或 probe 证据。</div>
          <div v-else class="space-y-3 p-4 text-xs">
            <div v-if="governance.rollouts.length" class="overflow-x-auto">
              <table class="data-table min-w-[360px]">
                <thead><tr><th>规则</th><th>版本</th><th>状态</th></tr></thead>
                <tbody>
                  <tr v-for="row in governance.rollouts" :key="row.ruleId">
                    <td class="break-all font-mono text-[10px]">{{ row.ruleId }}</td>
                    <td class="num">v{{ row.ruleVersion }}</td>
                    <td>{{ row.state }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="recentProbes.length">
              <p class="mb-1 text-muted-foreground">最近 probe 证据</p>
              <p v-for="probe in recentProbes" :key="probe.id" class="break-all font-mono text-[10px]">{{ probe.ruleRef.id }}@v{{ probe.ruleRef.version }} · {{ probe.run.outcome }} · violations {{ probe.run.cases.violations }} / controls {{ probe.run.cases.controls }}</p>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
