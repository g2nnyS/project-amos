<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowRight, CircleCheck, Info, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ModeSwitch from '@/components/governance/ModeSwitch.vue'
import { harnessDefinitions, projectionView, reportModeLabel, reportView, toneClasses, type StatusTone } from '@/components/governance/harness-report'
import { useToast } from '@/composables/useToast'
import { formatDate, formatDateTime } from '@/lib/format'
import { t } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { isGlobalProject, useGovernanceStore } from '@/stores/governance'
import type { GlobalHarnessConfig } from '@/types'

type ModeState = 'managed' | 'logOnly' | 'disabled'
interface Note { key: string; tone: StatusTone; text: string; alert?: boolean }
interface AttentionItem { key: string; tone: StatusTone; text: string; to: string }

const governance = useGovernanceStore()
const auth = useAuthStore()
const { toast } = useToast()
const isGlobal = computed(() => isGlobalProject(governance.activeProject))
const pendingTarget = ref<boolean | null>(null)
const switchError = ref('')
const refreshing = ref(false)

const config = computed(() => governance.config)
const policy = computed(() => governance.policy)
const canEdit = computed(() => auth.session?.role === 'human')
const saving = computed(() => pendingTarget.value !== null)
const savedState = computed<ModeState | null>(() => {
  if (isGlobal.value) {
    const global = governance.globalConfig
    if (!global) return null
    if (!global.enabled) return 'disabled'
    return global.mode === 'managed' ? 'managed' : 'logOnly'
  }
  const effective = config.value?.effectiveHarness
  if (!effective) return null
  if (!effective.enabled) return 'disabled'
  return effective.mode === 'managed' ? 'managed' : 'logOnly'
})
// While a change is saving, the switch and its copy already show the requested mode.
const modeState = computed<ModeState | null>(() => pendingTarget.value === null ? savedState.value : pendingTarget.value ? 'managed' : 'logOnly')
const managing = computed(() => modeState.value === 'managed')
const modeTitle = computed(() => modeState.value === null ? t('common.unknown') : t(`home.mode.${modeState.value}`))
const modeDescription = computed(() => {
  if (modeState.value === null) return ''
  if (isGlobal.value && modeState.value === 'disabled') return t('home.mode.globalDisabledNote')
  return t(`home.mode.${modeState.value}Note`)
})
const modeSource = computed(() => {
  if (isGlobal.value) return ''
  if (!config.value) return ''
  if (config.value.harness.mode === null) return t('home.mode.sourceInherit')
  const globalMode = governance.globalConfig?.mode
  const label = globalMode === undefined ? '—' : globalMode === 'managed' ? t('home.mode.globalManaged') : t('home.mode.globalLogOnly')
  return t('home.mode.sourceOverride', { mode: label })
})

const reviewReady = computed(() => {
  const managed = config.value?.managed
  return !!managed && managed.reviewer === 'jev' && governance.jev?.config != null && managed.ceilingDigest !== null && managed.reviewPolicy !== null && managed.reviewCalibration !== null
})
const globalReviewReady = computed(() => governance.jev?.config != null)
const projection = computed(() => projectionView(governance.runtime?.projection?.status))
const harnessRows = computed(() => harnessDefinitions.map(definition => {
  const observation = governance.runtime?.harnesses?.[definition.id] ?? null
  return { ...definition, observation, view: reportView(observation) }
}))
const loadedHarnesses = computed(() => harnessRows.value.filter(row => row.observation?.status === 'loaded').map(row => row.name))
/** Harness names are Latin words, so both languages keep spaces around the conjunction. */
function joinNames(names: readonly string[]): string {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(t('home.mode.listSeparator'))} ${t('home.mode.listAnd')} ${names[names.length - 1]}`
}

const totalRules = computed(() => policy.value?.candidate.rules.length ?? 0)
const activeRules = computed(() => {
  const candidate = policy.value?.candidate
  if (!candidate) return 0
  const { includedRuleIds, excludedRuleIds } = candidate.activation
  return candidate.rules.filter(rule => (includedRuleIds === null || includedRuleIds.includes(rule.id)) && !excludedRuleIds.includes(rule.id)).length
})
const pendingProposals = computed(() => governance.proposals.filter(proposal => proposal.status === 'pending'))
const staleProposals = computed(() => pendingProposals.value.filter(proposal => proposal.baseVersion !== (policy.value?.version ?? 0)))
const activeTightenings = computed(() => governance.tightenings?.active.length ?? 0)

const modeNotes = computed<Note[]>(() => {
  if (isGlobal.value) {
    if (!governance.globalConfig) return [{ key: 'config', tone: 'warning', text: t('home.mode.globalConfigUnavailable') }]
    const notes: Note[] = []
    if (switchError.value) notes.push({ key: 'error', tone: 'danger', text: switchError.value, alert: true })
    if (saving.value) notes.push({ key: 'saving', tone: 'neutral', text: t('home.mode.saving') })
    if (!canEdit.value) notes.push({ key: 'readonly', tone: 'neutral', text: t('home.mode.readOnly') })
    if (modeState.value === 'disabled') notes.push({ key: 'disabled', tone: 'neutral', text: t('home.mode.disabledHint') })
    if (managing.value && !globalReviewReady.value) notes.push({ key: 'reviewer', tone: 'warning', text: t('home.mode.reviewerMissing') })
    if (saving.value) return notes
    if (!policy.value) notes.push({ key: 'unpublished', tone: 'warning', text: t('home.mode.unpublished') })
    return notes
  }
  if (!config.value) return [{ key: 'config', tone: 'warning', text: t('home.mode.configUnavailable') }]
  const notes: Note[] = []
  if (switchError.value) notes.push({ key: 'error', tone: 'danger', text: switchError.value, alert: true })
  if (saving.value) notes.push({ key: 'saving', tone: 'neutral', text: t('home.mode.saving') })
  if (!canEdit.value) notes.push({ key: 'readonly', tone: 'neutral', text: t('home.mode.readOnly') })
  if (modeState.value === 'disabled') notes.push({ key: 'disabled', tone: 'neutral', text: t('home.mode.disabledHint') })
  if (managing.value && !reviewReady.value) notes.push({ key: 'reviewer', tone: 'warning', text: t('home.mode.reviewerMissing') })
  if (saving.value) return notes
  if (!policy.value) notes.push({ key: 'unpublished', tone: 'warning', text: t('home.mode.unpublished') })
  else if (!governance.runtime) return notes
  else if (governance.runtime.projection.status !== 'written') notes.push({ key: 'projection', tone: 'warning', text: t('home.mode.projectionIssue') })
  else if (loadedHarnesses.value.length) notes.push({ key: 'applied', tone: 'positive', text: t('home.mode.applied', { harnesses: joinNames(loadedHarnesses.value) }) })
  else notes.push({ key: 'reload', tone: 'info', text: t('home.mode.awaitingReload') })
  return notes
})

const stats = computed(() => {
  const items = [
    {
      key: 'version', to: '/versions', label: t('home.stats.version'),
      value: policy.value ? `v${policy.value.version}` : t('common.notYetPublished'),
      note: policy.value ? t('home.stats.versionNote', { date: formatDate(policy.value.createdAt) }) : t('home.stats.versionEmpty'),
    },
    { key: 'rules', to: '/rules', label: isGlobal.value ? t('home.stats.rules') : t('home.stats.rulesSupplementary'), value: `${activeRules.value} / ${totalRules.value}`, note: isGlobal.value ? t('home.stats.rulesNote') : t('home.stats.rulesNoteSupplementary') },
    {
      key: 'proposals', to: '/proposals', label: t('home.stats.proposals'), value: String(pendingProposals.value.length),
      note: staleProposals.value.length ? t('home.stats.proposalsStale', { count: staleProposals.value.length }) : pendingProposals.value.length ? t('home.stats.proposalsNote') : t('home.stats.proposalsNone'),
    },
  ]
  if (!isGlobal.value) {
    items.push({ key: 'review', to: '/boundary', label: t('home.stats.review'), value: reviewReady.value ? t('home.stats.reviewReady') : t('home.stats.reviewMissing'), note: t('home.stats.reviewNote') })
  }
  return items
})

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = []
  if (pendingProposals.value.length) items.push({ key: 'pending', tone: 'info', text: t('home.attention.pending', { count: pendingProposals.value.length }), to: '/proposals' })
  if (staleProposals.value.length) items.push({ key: 'stale', tone: 'warning', text: t('home.attention.stale', { count: staleProposals.value.length }), to: '/proposals' })
  if (!policy.value) items.push({ key: 'unpublished', tone: 'warning', text: t('home.attention.unpublished'), to: '/editor' })
  if (isGlobal.value) return items
  if (policy.value && governance.runtime && governance.runtime.projection.status !== 'written') items.push({ key: 'projection', tone: projection.value.tone, text: t('home.attention.projection', { status: projection.value.label }), to: '/boundary' })
  if (savedState.value === 'managed' && !reviewReady.value) items.push({ key: 'reviewer', tone: 'warning', text: t('home.attention.reviewer'), to: '/boundary' })
  for (const row of harnessRows.value) {
    if (row.observation?.status === 'stale') items.push({ key: `report-${row.id}`, tone: 'warning', text: t('home.attention.staleReport', { harness: row.name }), to: '/boundary' })
  }
  if (activeTightenings.value) items.push({ key: 'tightenings', tone: 'info', text: t('home.attention.tightenings', { count: activeTightenings.value }), to: '/boundary' })
  return items
})

const toneText: Readonly<Record<StatusTone, string>> = {
  positive: 'text-positive',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
}

async function setManaging(next: boolean) {
  switchError.value = ''
  if (isGlobal.value) {
    const current = governance.globalConfig
    if (!current || !canEdit.value || saving.value) return
    pendingTarget.value = next
    const update: GlobalHarnessConfig = {
      enabled: next && !current.enabled ? true : current.enabled,
      mode: next ? 'managed' : 'log-only',
      advisoryInjection: current.advisoryInjection,
    }
    try {
      const saved = await governance.updateGlobalConfig(update)
      if (saved) toast(next ? t('home.mode.switchedOn') : t('home.mode.switchedOff'), t('home.mode.switchedNote'), 'success')
    } catch (error) {
      switchError.value = error instanceof Error ? error.message : t('home.mode.switchFailed')
      toast(t('home.mode.switchFailed'), switchError.value, 'error')
    } finally {
      pendingTarget.value = null
    }
    return
  }
  const current = config.value
  if (!current || !canEdit.value || saving.value) return
  pendingTarget.value = next
  const harness = {
    ...current.harness,
    mode: next ? 'managed' as const : 'log-only' as const,
    ...(next && !current.effectiveHarness.enabled ? { enabled: true } : {}),
  }
  try {
    const saved = await governance.updateProjectConfig({ harness })
    if (saved) toast(next ? t('home.mode.switchedOn') : t('home.mode.switchedOff'), t('home.mode.switchedNote'), 'success')
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : t('home.mode.switchFailed')
    toast(t('home.mode.switchFailed'), switchError.value, 'error')
  } finally {
    pendingTarget.value = null
  }
}

async function refreshStatus() {
  if (refreshing.value) return
  refreshing.value = true
  try { await governance.refreshRuntime() } finally { refreshing.value = false }
}

onMounted(() => { if (!isGlobal.value) void governance.refreshRuntime() })
</script>

<template>
  <div class="page">
    <PageHeader :title="t('home.title')" :description="t(isGlobal ? 'home.global.pageDescription' : 'home.description')" />

    <div v-if="governance.error" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.activeProjectId ? governance.refreshProject() : governance.initialize()">{{ t('common.retry') }}</button></div>
    <div v-if="governance.loading && !config" class="py-8 text-sm text-muted-foreground" role="status">{{ t('home.loading') }}</div>
    <EmptyState v-else-if="!governance.activeProject" :title="t('home.emptyTitle')" :description="t('home.emptyDescription')" />

    <template v-else>
      <section v-if="isGlobal" class="panel home-mode mb-4" :data-state="modeState ?? 'unknown'" aria-labelledby="home-mode-title">
        <div class="panel-header">
          <div class="min-w-0">
            <p class="panel-title truncate">{{ t('app.globalProject') }}</p>
          </div>
          <span class="global-badge">{{ t('app.globalBadge') }}</span>
        </div>
        <div class="home-mode-body">
          <div class="min-w-0">
            <p class="eyebrow">{{ t('home.global.scopeEyebrow') }}</p>
            <h2 id="global-title" class="home-mode-title">{{ t('home.global.title') }}</h2>
            <p class="home-mode-description">{{ t('home.global.description') }}</p>
            <p class="eyebrow mt-4">{{ t('home.mode.eyebrow') }}</p>
            <h3 id="home-mode-title" class="home-mode-title"><span class="home-mode-dot" aria-hidden="true" />{{ modeTitle }}</h3>
            <p id="home-mode-description" class="home-mode-description">{{ modeDescription }}</p>
          </div>
          <ModeSwitch
            id="home-mode-switch"
            :model-value="managing"
            :label="t('home.mode.switchLabel')"
            :off-label="t('home.mode.off')"
            :on-label="t('home.mode.on')"
            described-by="home-mode-description"
            :busy="saving"
            :disabled="!governance.globalConfig || !canEdit"
            @update:model-value="setManaging"
          />
        </div>
        <ul v-if="modeNotes.length" class="home-mode-notes" role="status">
          <li v-for="note in modeNotes" :key="note.key" class="flex items-start gap-2" :class="toneText[note.tone]" :role="note.alert ? 'alert' : undefined">
            <LoaderCircle v-if="note.key === 'saving'" class="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            <CircleCheck v-else-if="note.tone === 'positive'" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <TriangleAlert v-else-if="note.tone === 'warning' || note.tone === 'danger'" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <Info v-else class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{{ note.text }}</span>
          </li>
        </ul>
      </section>

      <section v-else class="panel home-mode mb-4" :data-state="modeState ?? 'unknown'" aria-labelledby="home-mode-title">
        <div class="panel-header">
          <div class="min-w-0">
            <p class="panel-title truncate">{{ governance.activeProject.name }}</p>
            <p class="panel-kicker truncate font-mono" :title="governance.activeProject.workspace ?? undefined">{{ governance.activeProject.workspace }}</p>
          </div>
          <RouterLink to="/boundary" class="shrink-0 text-xs text-muted-foreground hover:text-foreground">{{ t('home.harness.details') }}</RouterLink>
        </div>
        <div class="home-mode-body">
          <div class="min-w-0">
            <p class="eyebrow">{{ t('home.mode.eyebrow') }}</p>
            <h2 id="home-mode-title" class="home-mode-title"><span class="home-mode-dot" aria-hidden="true" />{{ modeTitle }}</h2>
            <p id="home-mode-description" class="home-mode-description">{{ modeDescription }}</p>
            <p v-if="modeSource" class="home-mode-source">{{ modeSource }}</p>
          </div>
          <ModeSwitch
            id="home-mode-switch"
            :model-value="managing"
            :label="t('home.mode.switchLabel')"
            :off-label="t('home.mode.off')"
            :on-label="t('home.mode.on')"
            described-by="home-mode-description"
            :busy="saving"
            :disabled="!config || !canEdit"
            @update:model-value="setManaging"
          />
        </div>
        <ul v-if="modeNotes.length" class="home-mode-notes" role="status">
          <li v-for="note in modeNotes" :key="note.key" class="flex items-start gap-2" :class="toneText[note.tone]" :role="note.alert ? 'alert' : undefined">
            <LoaderCircle v-if="note.key === 'saving'" class="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            <CircleCheck v-else-if="note.tone === 'positive'" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <TriangleAlert v-else-if="note.tone === 'warning' || note.tone === 'danger'" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <Info v-else class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{{ note.text }}</span>
          </li>
        </ul>
      </section>

      <section class="mb-4 grid gap-3 sm:grid-cols-2" :class="stats.length === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3'">
        <RouterLink v-for="stat in stats" :key="stat.key" :to="stat.to" class="panel home-stat p-3" :data-stat="stat.key">
          <p class="eyebrow">{{ stat.label }}</p>
          <p class="mt-3 text-xl font-semibold tabular">{{ stat.value }}</p>
          <p class="mt-1 text-[11px] text-muted-foreground">{{ stat.note }}</p>
        </RouterLink>
      </section>

      <div class="grid grid-cols-1 gap-4" :class="isGlobal ? '' : 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'">
        <section v-if="!isGlobal" class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">{{ t('home.harness.title') }}</h2>
              <p class="panel-kicker">{{ t('home.harness.kicker') }}</p>
            </div>
            <button type="button" class="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" :aria-label="t('home.harness.refresh')" :title="t('home.harness.refresh')" :disabled="refreshing" @click="refreshStatus">
              <RefreshCw class="size-3.5" :class="refreshing ? 'animate-spin' : ''" aria-hidden="true" />
            </button>
          </div>
          <ul class="divide-y divide-hairline">
            <li v-for="row in harnessRows" :key="row.id" class="flex items-center justify-between gap-4 px-4 py-3" :data-harness="row.id">
              <div class="min-w-0">
                <p class="text-[12.5px] font-medium text-foreground">{{ row.name }}</p>
                <p class="mt-0.5 truncate text-[11px] text-muted-foreground">{{ row.observation?.runtime ? `${reportModeLabel(row.observation.runtime)} · ${formatDateTime(row.observation.runtime.loadedAt)}` : row.view.description }}</p>
              </div>
              <span class="inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10.5px] font-medium" :class="toneClasses[row.view.tone]">{{ row.view.label }}</span>
            </li>
            <li class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <p class="text-[12.5px] font-medium text-foreground">{{ t('home.harness.projection') }}</p>
                <p class="mt-0.5 truncate text-[11px] text-muted-foreground">{{ projection.description }}</p>
              </div>
              <span class="inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10.5px] font-medium" :class="toneClasses[projection.tone]">{{ projection.label }}</span>
            </li>
          </ul>
        </section>

        <section class="panel" :class="isGlobal ? 'lg:col-span-1' : ''">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">{{ t('home.attention.title') }}</h2>
            </div>
          </div>
          <p v-if="!attention.length" class="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground"><CircleCheck class="size-4 text-positive" aria-hidden="true" />{{ t('home.attention.none') }}</p>
          <ul v-else class="divide-y divide-hairline">
            <li v-for="item in attention" :key="item.key">
              <RouterLink :to="item.to" class="flex items-center gap-2 px-4 py-2.5 text-xs hover:bg-accent/60">
                <span class="status-dot shrink-0" :class="item.tone === 'positive' ? 'status-dot-positive' : item.tone === 'warning' ? 'status-dot-warning' : item.tone === 'danger' ? 'status-dot-destructive' : 'status-dot-info'" aria-hidden="true" />
                <span class="min-w-0 flex-1 text-foreground">{{ item.text }}</span>
                <ArrowRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </RouterLink>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.home-mode {
  overflow: hidden;
}

.home-mode::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: hsl(var(--muted-foreground) / 0.35);
  transition: background-color 200ms linear;
}

.home-mode[data-state="managed"]::before {
  background: hsl(var(--positive));
}

.home-mode[data-state="logOnly"]::before {
  background: hsl(var(--info));
}

.home-mode-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px 40px;
  padding: 22px 20px 22px 22px;
}

.home-mode-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  font-size: 26px;
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -0.025em;
  color: hsl(var(--foreground));
}

.home-mode-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: hsl(var(--muted-foreground));
  box-shadow: 0 0 0 4px hsl(var(--muted-foreground) / 0.16);
}

.home-mode[data-state="managed"] .home-mode-dot {
  background: hsl(var(--positive));
  box-shadow: 0 0 0 4px hsl(var(--positive) / 0.18);
}

.home-mode[data-state="logOnly"] .home-mode-dot {
  background: hsl(var(--info));
  box-shadow: 0 0 0 4px hsl(var(--info) / 0.16);
}

.home-mode-description {
  max-width: 64ch;
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  color: hsl(var(--muted-foreground));
}

.home-mode-source {
  margin-top: 10px;
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
}

.home-mode-notes {
  display: grid;
  gap: 6px;
  padding: 10px 20px 12px 22px;
  border-top: 1px solid hsl(var(--hairline));
  background: hsl(var(--surface) / 0.55);
  font-size: 12px;
  line-height: 1.5;
}

.home-stat {
  display: block;
  transition: border-color 120ms linear, background-color 120ms linear;
}

.home-stat:hover {
  border-color: hsl(var(--foreground) / 0.2);
  background: hsl(var(--accent) / 0.45);
}

[data-density="compact"] .home-mode-body {
  padding: 16px 16px 16px 18px;
}

@media (max-width: 640px) {
  .home-mode-title {
    font-size: 22px;
  }
}
</style>
