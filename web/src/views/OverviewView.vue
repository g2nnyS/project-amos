<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ShieldAlert, FileCheck, GitPullRequest, History, Eye, FlaskConical, Lock, AlertTriangle, Timer, Activity } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import HarnessLoadReportCards from '@/components/governance/HarnessLoadReportCards.vue'
import { projectionView as describeProjection, toneClasses } from '@/components/governance/harness-report'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { t } from '@/i18n'
import { auditEventLabel, roleLabel } from '@/i18n/labels'
import { isGlobalProject, useGovernanceStore } from '@/stores/governance'
import { useAuthStore } from '@/stores/auth'
import type { GovernanceEvent } from '@/types'

const governance = useGovernanceStore()
const auth = useAuthStore()
const isGlobal = computed(() => isGlobalProject(governance.activeProject))
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
    if (request === generation) auditError.value = error instanceof Error ? error.message : t('overview.audit.loadFailed')
  } finally {
    if (request === generation) auditLoading.value = false
  }
}

watch(() => governance.activeProjectId, () => { void loadAudit(); if (!isGlobal.value) void governance.refreshRuntime() }, { immediate: true })
onMounted(() => { void loadAudit(); if (!isGlobal.value) void governance.refreshRuntime() })

const stats = computed(() => [
  { label: t('overview.stats.currentVersion'), value: governance.currentVersion == null ? t('common.notYetPublished') : `v${governance.currentVersion}`, note: governance.currentVersion == null ? t('overview.stats.noPublishedVersion') : t('overview.stats.publishedVersion') },
  { label: t('overview.stats.publishedRules'), value: String(governance.policy?.candidate.rules.length ?? 0), note: t('overview.stats.publishedRulesNote') },
  { label: t('overview.stats.selectedRules'), value: String(activeCount.value), note: activationNote.value },
  { label: t('overview.stats.pendingProposals'), value: String(governance.proposals.filter(p => p.status === 'pending').length), note: t('overview.stats.pendingNote') },
  { label: t('overview.stats.versions'), value: String(governance.versions.length), note: t('overview.stats.versionsNote') },
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
    return excluded ? t('overview.activation.allExcluded', { count: excluded }) : t('overview.activation.all')
  }
  return t('overview.activation.explicit', { count: activation.includedRuleIds.length })
})

const projectionView = computed(() => describeProjection(governance.runtime?.projection?.status))

const activeTightenings = computed(() => governance.tightenings?.active ?? [])
const expiredTightenings = computed(() => (governance.tightenings?.expired ?? []).slice(0, 3))
const recentProbes = computed(() => governance.probes.slice(0, 5))
const canEditConfig = computed(() => auth.session?.role === 'human')

function remainingTtl(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - nowMs.value)
  const seconds = Math.ceil(remaining / 1000)
  if (seconds <= 0) return t('overview.tightening.ttlExpired')
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? t('overview.tightening.ttlMinutes', { minutes, seconds: rest }) : t('overview.tightening.ttlSeconds', { seconds: rest })
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
    configError.value = error instanceof Error ? error.message : t('overview.config.saveHarnessFailed')
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
    configError.value = error instanceof Error ? error.message : t('overview.config.saveFailed')
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
    configError.value = error instanceof Error ? error.message : t('overview.tightening.expireFailed')
  } finally {
    configSaving.value = false
  }
}

const pendingProposals = computed(() => governance.proposals.filter(p => p.status === 'pending').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const staleProposals = computed(() => pendingProposals.value.filter(p => p.baseVersion !== (governance.policy?.version ?? 0)))
</script>

<template>
  <div class="page">
    <PageHeader :title="t('overview.title')" :description="t('overview.description')">
      <template #actions>
        <span v-if="auth.session?.role" class="hidden text-xs text-muted-foreground md:inline">{{ t('overview.currentRole', { role: roleLabel(auth.session.role) }) }}</span>
      </template>
    </PageHeader>

    <div class="mb-4 rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      <strong class="text-foreground">{{ t('overview.boundaryLead') }}</strong>{{ t('overview.boundaryText') }}
    </div>

    <div v-if="governance.error" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.initialize()">{{ t('common.retry') }}</button></div>
    <div v-if="governance.loading" class="py-8 text-sm text-muted-foreground" role="status">{{ t('overview.loading') }}</div>
    <div v-else-if="governance.error" class="text-xs text-muted-foreground">{{ t('overview.dataUnavailable') }}</div>
    <EmptyState v-else-if="!governance.activeProject" :title="t('overview.emptyTitle')" :description="t('overview.emptyDescription')" />

    <template v-else>
      <section class="panel mb-4">
        <div class="panel-header"><div><h2 class="panel-title">{{ t('overview.snapshot.title') }}</h2><p class="panel-kicker">{{ t('overview.snapshot.kicker') }}</p></div><RouterLink to="/versions" class="text-xs text-primary hover:underline">{{ t('overview.snapshot.history') }}</RouterLink></div>
        <dl class="grid gap-4 p-4 text-xs" :class="isGlobal ? 'sm:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2 xl:grid-cols-4'">
          <div><dt class="field-label">{{ t('overview.snapshot.project') }}</dt><dd class="mt-1 break-all font-medium">{{ isGlobal ? t('app.globalProject') : governance.activeProject.name }}</dd><dd class="mt-1 break-all font-mono text-muted-foreground">{{ governance.activeProject.id }}</dd></div>
          <div v-if="!isGlobal"><dt class="field-label">{{ t('overview.snapshot.workspace') }}</dt><dd class="mt-1 break-all font-mono">{{ governance.activeProject.workspace }}</dd></div>
          <div v-else><dt class="field-label">{{ t('overview.snapshot.workspace') }}</dt><dd class="mt-1 text-muted-foreground">{{ t('overview.snapshot.globalNote') }}</dd></div>
          <div><dt class="field-label">{{ t('overview.snapshot.publishedAt') }}</dt><dd class="mt-1">{{ governance.policy ? formatDateTime(governance.policy.createdAt) : t('common.notYetPublished') }}</dd></div>
          <div><dt class="field-label">{{ t('overview.snapshot.digest') }}</dt><dd class="mt-1 break-all font-mono">{{ governance.policy?.snapshot.digest ?? t('overview.snapshot.noSnapshot') }}</dd></div>
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
              <h2 class="panel-title">{{ t('overview.audit.title') }}</h2>
              <p class="panel-kicker">{{ t('overview.audit.kicker') }}</p>
            </div>
            <RouterLink to="/audit" class="text-xs text-muted-foreground hover:text-foreground">{{ t('overview.audit.viewAll') }}</RouterLink>
          </div>
          <p v-if="auditLoading" role="status" class="p-4 text-xs text-muted-foreground">{{ t('common.loading') }}</p>
          <div v-else-if="auditError" role="alert" class="p-4 text-xs text-destructive">{{ auditError }} <button class="underline" @click="loadAudit">{{ t('common.retry') }}</button></div>
          <p v-else-if="!audit.length" class="p-6 text-center text-xs text-muted-foreground">{{ t('overview.audit.empty') }}</p>
          <div v-else class="overflow-x-auto">
            <table class="data-table min-w-[420px]">
              <thead>
                <tr><th>{{ t('overview.audit.event') }}</th><th>{{ t('overview.audit.actor') }}</th><th>{{ t('overview.audit.time') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="event in audit" :key="event.id">
                  <td>{{ auditEventLabel(event.kind) }}</td>
                  <td>{{ event.actor.id }} · {{ event.actor.role }}</td>
                  <td class="tabular">{{ formatDateTime(event.createdAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="space-y-4">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">{{ t('overview.attention.title') }}</h2>
                <p class="panel-kicker">{{ t('overview.attention.kicker') }}</p>
              </div>
              <RouterLink to="/proposals" class="text-xs text-muted-foreground hover:text-foreground">{{ t('overview.attention.proposals') }}</RouterLink>
            </div>
            <div class="space-y-2 p-3">
              <div v-if="pendingProposals.length === 0" class="flex items-center gap-2 text-xs text-muted-foreground"><FileCheck class="size-4" />{{ t('overview.attention.noPending') }}</div>
              <div v-else class="flex items-start gap-2 text-xs">
                <GitPullRequest class="mt-0.5 size-4 text-info" />
                <div>
                  <p class="font-medium">{{ t('overview.attention.pending', { count: pendingProposals.length }) }}</p>
                  <p v-if="staleProposals.length" class="mt-1 text-warning"><AlertTriangle class="inline size-3" /> {{ t('overview.attention.stale', { count: staleProposals.length }) }}</p>
                </div>
              </div>
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldAlert class="mt-0.5 size-4" />
                <span>{{ t('overview.attention.runtimeNote') }}</span>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">{{ t('overview.permissions.title') }}</h2>
                <p class="panel-kicker">{{ t('overview.permissions.kicker') }}</p>
              </div>
              <Lock class="size-4 text-muted-foreground" />
            </div>
            <div class="space-y-3 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>{{ t('overview.permissions.lead') }}</p>
              <ul class="list-disc space-y-1 pl-4">
                <li>{{ t('overview.permissions.human') }}</li>
                <li>{{ t('overview.permissions.agent') }}</li>
                <li>{{ t('overview.permissions.server') }}</li>
              </ul>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">{{ t('overview.capabilities.title') }}</h2>
                <p class="panel-kicker">{{ t('overview.capabilities.kicker') }}</p>
              </div>
            </div>
            <div class="grid gap-2 p-3">
              <div class="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
                <Eye class="size-4 text-info" />
                <span>{{ t('overview.capabilities.coverage') }}</span>
                <span class="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px]">{{ t('overview.capabilities.planned') }}</span>
              </div>
              <RouterLink to="/simulate" class="flex items-center gap-2 rounded-md border border-border p-2 text-xs hover:bg-accent">
                <FlaskConical class="size-4 text-info" />
                <span>{{ t('overview.capabilities.simulator') }}</span>
                <span class="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info">{{ t('overview.capabilities.available') }}</span>
              </RouterLink>
              <RouterLink to="/versions" class="flex items-center gap-2 rounded-md border border-border p-2 text-xs hover:bg-accent">
                <History class="size-4 text-info" />
                <span>{{ t('overview.capabilities.rollback') }}</span>
                <span class="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info">{{ t('overview.capabilities.available') }}</span>
              </RouterLink>
            </div>
          </section>
        </div>
      </div>

      <section v-if="!isGlobal" class="panel mt-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{{ t('overview.projection.title') }}</h2>
            <p class="panel-kicker">{{ t('overview.projection.kicker') }}</p>
          </div>
        </div>
        <div class="grid gap-4 p-4 text-xs lg:grid-cols-2">
          <div class="rounded-md border border-border bg-surface p-3">
            <p class="font-semibold">{{ t('overview.projection.published') }}</p>
            <ul class="mt-2 space-y-1 text-muted-foreground">
              <li>{{ t('overview.projection.version', { version: governance.policy ? `v${governance.policy.version}` : t('common.notYetPublished') }) }}</li>
              <li>{{ t('overview.projection.rules', { count: governance.policy?.candidate.rules.length ?? 0 }) }}</li>
              <li>{{ t('overview.projection.selected', { count: activeCount }) }}</li>
              <li>{{ t('overview.projection.digest', { digest: governance.policy ? `${governance.policy.snapshot.digest.slice(0, 24)}…` : '—' }) }}</li>
            </ul>
          </div>
          <div class="rounded-md border border-border bg-surface p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-semibold">{{ t('overview.projection.host') }}</p>
              <span class="rounded border px-2 py-0.5 text-[10px] font-medium" :class="toneClasses[projectionView.tone]">{{ projectionView.label }}</span>
            </div>
            <p class="mt-2 leading-relaxed text-muted-foreground">{{ t('overview.projection.hostNote') }}{{ projectionView.description }}</p>
            <p v-if="governance.runtime?.projection?.configDigest" class="mt-2 break-all font-mono text-[10px] text-muted-foreground">{{ t('overview.projection.configDigest', { digest: governance.runtime.projection.configDigest }) }}</p>
          </div>
        </div>
        <div class="border-t border-border p-4">
          <div class="mb-3">
            <h3 class="text-xs font-semibold">{{ t('overview.projection.reportsTitle') }}</h3>
            <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">{{ t('overview.projection.reportsNote') }}</p>
          </div>
          <HarnessLoadReportCards :runtime="governance.runtime" />
        </div>
      </section>

      <section class="panel mt-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{{ t('overview.config.title') }}</h2>
            <p class="panel-kicker">{{ t('overview.config.kicker') }}</p>
          </div>
          <Lock class="size-4 text-muted-foreground" />
        </div>
        <div v-if="configError" class="mx-4 mt-3 rounded-md border border-destructive/30 p-2 text-xs text-destructive" role="alert">{{ configError }}</div>
        <div v-if="isGlobal" class="p-4 text-xs text-muted-foreground">{{ t('overview.config.globalNote') }}</div>
        <div v-else-if="!governance.config" class="p-4 text-xs text-muted-foreground">{{ t('overview.config.unavailable') }}</div>
        <div v-else class="grid gap-4 p-4 text-xs lg:grid-cols-2">
          <div class="rounded-md border border-border p-3">
            <div class="flex items-center justify-between gap-3">
              <p class="font-semibold">{{ t('overview.config.overrides') }}</p>
              <span v-if="!canEditConfig" class="text-[10px] text-muted-foreground">{{ t('common.readOnly') }}</span>
            </div>
            <p class="mt-1 leading-relaxed text-muted-foreground">{{ t('overview.config.overridesNote') }}</p>
            <div class="mt-4 space-y-3">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div><span id="project-harness-enabled-label" class="font-medium">{{ t('overview.config.enabled') }}</span><p class="mt-0.5 text-[10px] text-muted-foreground">harness.enabled</p></div>
                <Select :model-value="booleanOverrideValue(governance.config.harness.enabled)" :disabled="!canEditConfig || configSaving" @update:model-value="setHarnessEnabled">
                  <SelectTrigger class="w-full sm:w-[164px] sm:shrink-0" size="sm" aria-labelledby="project-harness-enabled-label"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{{ t('overview.config.inherit') }}</SelectItem>
                    <SelectItem value="enabled">{{ t('overview.config.enable') }}</SelectItem>
                    <SelectItem value="disabled">{{ t('overview.config.disable') }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div><span id="project-harness-mode-label" class="font-medium">{{ t('overview.config.mode') }}</span><p class="mt-0.5 text-[10px] text-muted-foreground">harness.mode</p></div>
                <Select :model-value="governance.config.harness.mode ?? 'inherit'" :disabled="!canEditConfig || configSaving" @update:model-value="setHarnessMode">
                  <SelectTrigger class="w-full sm:w-[164px] sm:shrink-0" size="sm" aria-labelledby="project-harness-mode-label"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{{ t('overview.config.inherit') }}</SelectItem>
                    <SelectItem value="log-only">{{ t('harness.modes.logOnly') }}</SelectItem>
                    <SelectItem value="managed">{{ t('harness.modes.managed') }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div><span id="project-advisory-injection-label" class="font-medium">{{ t('overview.config.advisory') }}</span><p class="mt-0.5 text-[10px] text-muted-foreground">harness.advisoryInjection</p></div>
                <Select :model-value="booleanOverrideValue(governance.config.harness.advisoryInjection)" :disabled="!canEditConfig || configSaving" @update:model-value="setAdvisoryInjection">
                  <SelectTrigger class="w-full sm:w-[164px] sm:shrink-0" size="sm" aria-labelledby="project-advisory-injection-label"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{{ t('overview.config.inherit') }}</SelectItem>
                    <SelectItem value="enabled">{{ t('overview.config.allow') }}</SelectItem>
                    <SelectItem value="disabled">{{ t('overview.config.suppress') }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p class="mt-3 text-[10px] leading-relaxed text-muted-foreground">{{ t('overview.config.advisoryNote') }}</p>
            <div class="mt-4 rounded-md border border-info/25 bg-info/5 p-3">
              <p class="font-semibold text-info">{{ t('overview.config.effective') }}</p>
              <p class="mt-1 text-[10px] leading-relaxed text-muted-foreground">{{ t('overview.config.effectiveNote') }}</p>
              <dl class="mt-3 grid grid-cols-3 gap-2">
                <div><dt class="text-[10px] text-muted-foreground">Amos</dt><dd class="mt-1 font-medium">{{ governance.config.effectiveHarness.enabled ? t('overview.config.on') : t('overview.config.off') }}</dd></div>
                <div><dt class="text-[10px] text-muted-foreground">{{ t('overview.config.effectiveMode') }}</dt><dd class="mt-1 font-medium">{{ governance.config.effectiveHarness.mode === 'managed' ? 'Managed' : 'Log-only' }}</dd></div>
                <div><dt class="text-[10px] text-muted-foreground">{{ t('overview.config.advisory') }}</dt><dd class="mt-1 font-medium">{{ governance.config.effectiveHarness.advisoryInjection ? t('overview.config.allowed') : t('overview.config.suppressed') }}</dd></div>
              </dl>
            </div>
            <div class="mt-3 border-t border-border pt-3 text-muted-foreground">
              <p class="leading-relaxed">{{ t('overview.config.managedNote') }}</p>
              <p class="mt-2 break-all font-mono text-[10px]">requirementEgress: {{ governance.config.managed.requirementEgress }} · grantTtlMs: {{ governance.config.managed.grantTtlMs }}</p>
              <p class="mt-1 break-all font-mono text-[10px]">reviewer: {{ governance.config.managed.reviewer ?? t('common.notConfigured') }} · jev: {{ governance.jev?.config ? t('settings.jev.stateConfigured') : t('common.notConfigured') }}</p>
            </div>
          </div>
          <div class="rounded-md border border-border p-3">
            <p class="font-semibold">{{ t('overview.tightening.title') }}</p>
            <p class="mt-1 text-muted-foreground">{{ t('overview.tightening.description') }}</p>
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
            <p class="mt-2 text-muted-foreground">{{ t('overview.tightening.summary', { templates: governance.config.tightening.templates.length, maxActive: governance.config.tightening.quota.maxActive, maxApplications: governance.config.tightening.quota.maxApplications }) }}</p>
          </div>
        </div>
      </section>

      <div v-if="!isGlobal" class="mt-4 grid gap-4 lg:grid-cols-2">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">{{ t('overview.tightening.statusTitle') }}</h2>
              <p class="panel-kicker">{{ t('overview.tightening.statusKicker', { epoch: governance.tightenings?.epoch ?? '—', count: activeTightenings.length }) }}</p>
            </div>
            <Timer class="size-4 text-muted-foreground" />
          </div>
          <div v-if="!activeTightenings.length && !expiredTightenings.length" class="p-4 text-xs text-muted-foreground">{{ t('overview.tightening.empty') }}</div>
          <div v-else class="space-y-3 p-4 text-xs">
            <div v-for="item in activeTightenings" :key="item.id" class="rounded-md border border-warning/30 bg-warning/5 p-3">
              <p class="font-medium">{{ item.templateId }} · {{ item.ruleRef.id }}@v{{ item.ruleRef.version }}</p>
              <p class="mt-1 text-muted-foreground">{{ t('overview.tightening.remaining', { epoch: item.epoch, ttl: remainingTtl(item.expiresAt) }) }}</p>
              <p class="mt-1 break-all font-mono text-[10px] text-muted-foreground">{{ item.activationDigest }}</p>
            </div>
            <div v-if="expiredTightenings.length" class="text-muted-foreground">
              <p class="mb-1">{{ t('overview.tightening.recentlyExpired') }}</p>
              <p v-for="item in expiredTightenings" :key="item.id" class="break-all font-mono text-[10px]">{{ item.templateId }} · {{ item.ruleRef.id }} · epoch {{ item.epoch }}</p>
            </div>
            <button v-if="activeTightenings.length" type="button" class="text-xs underline disabled:opacity-50" :disabled="configSaving" @click="expireTightenings">{{ t('overview.tightening.expireNow') }}</button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">{{ t('overview.rollout.title') }}</h2>
              <p class="panel-kicker">{{ t('overview.rollout.kicker') }}</p>
            </div>
            <Activity class="size-4 text-muted-foreground" />
          </div>
          <div v-if="!governance.rollouts.length && !recentProbes.length" class="p-4 text-xs text-muted-foreground">{{ t('overview.rollout.empty') }}</div>
          <div v-else class="space-y-3 p-4 text-xs">
            <div v-if="governance.rollouts.length" class="overflow-x-auto">
              <table class="data-table min-w-[360px]">
                <thead><tr><th>{{ t('overview.rollout.rule') }}</th><th>{{ t('overview.rollout.version') }}</th><th>{{ t('overview.rollout.state') }}</th></tr></thead>
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
              <p class="mb-1 text-muted-foreground">{{ t('overview.rollout.probes') }}</p>
              <p v-for="probe in recentProbes" :key="probe.id" class="break-all font-mono text-[10px]">{{ probe.ruleRef.id }}@v{{ probe.ruleRef.version }} · {{ probe.run.outcome }} · violations {{ probe.run.cases.violations }} / controls {{ probe.run.cases.controls }}</p>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
