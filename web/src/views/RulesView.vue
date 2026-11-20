<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted, nextTick } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Search, X, SlidersHorizontal } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import RuleInspector from '@/components/rules/RuleInspector.vue'
import RuleMatrix from '@/components/rules/RuleMatrix.vue'
import { useGovernanceStore } from '@/stores/governance'
import { t, type MessageKey } from '@/i18n'
import type { RuleOnHit, RuleExpressivity, RulePolicyClass, RuleEnforcement } from '@/types'

const governance = useGovernanceStore()
const route = useRoute()
const router = useRouter()

const search = ref('')
const dimension = ref('')
const policyClass = ref<RulePolicyClass | ''>('')
const onHit = ref<RuleOnHit | ''>('')
const enforcement = ref<RuleEnforcement | ''>('')
const expressivity = ref<RuleExpressivity | ''>('')
const selected = ref<string | null>(null)
const tableContainer = ref<HTMLDivElement | null>(null)
const lastFocused = ref<HTMLElement | null>(null)

const rules = computed(() => governance.policy?.candidate.rules ?? [])
const activation = computed(() => governance.policy?.candidate.activation ?? { includedRuleIds: null, excludedRuleIds: [] })
const publishedVersion = computed(() => governance.policy?.version ?? null)

const dimensions = computed(() => [...new Set(rules.value.map(r => r.dimension))].sort())
const policyClasses: { value: RulePolicyClass; labelKey: MessageKey }[] = [{ value: 'security', labelKey: 'rules.security' }, { value: 'engineering', labelKey: 'rules.engineering' }]
const onHits: { value: RuleOnHit; label: string }[] = [{ value: 'deny', label: 'deny' }, { value: 'confirm', label: 'confirm' }, { value: 'log', label: 'log' }]
const enforcements: { value: RuleEnforcement; label: string }[] = [{ value: 'runtime', label: 'runtime' }, { value: 'ci', label: 'ci' }, { value: 'server', label: 'server' }, { value: 'advisory', label: 'advisory' }]
const expressivities: { value: RuleExpressivity; labelKey: MessageKey }[] = [{ value: 'deterministic', labelKey: 'rules.deterministic' }, { value: 'advisory_only', labelKey: 'rules.advisoryOnly' }]

const filtered = computed(() => rules.value.filter(r => {
  const term = search.value.trim().toLowerCase()
  const matchesSearch = !term || [r.id, r.dimension, r.narrative, r.probe].join(' ').toLowerCase().includes(term)
  return matchesSearch
    && (!dimension.value || r.dimension === dimension.value)
    && (!policyClass.value || r.policy_class === policyClass.value)
    && (!onHit.value || r.on_hit === onHit.value)
    && (!enforcement.value || r.enforcement === enforcement.value)
    && (!expressivity.value || r.expressivity === expressivity.value)
}))

const detail = computed(() => rules.value.find(r => r.id === selected.value) ?? null)
function locallySelected(id: string) {
  return (activation.value.includedRuleIds === null || activation.value.includedRuleIds.includes(id)) && !activation.value.excludedRuleIds.includes(id)
}

function pickQuery<T extends string>(value: unknown, allowed: readonly T[]): T | '' {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : ''
}

function readQuery() {
  const q = route.query
  search.value = typeof q.search === 'string' ? q.search : ''
  dimension.value = pickQuery(q.dimension, dimensions.value)
  policyClass.value = pickQuery(q.policyClass, policyClasses.map(c => c.value))
  onHit.value = pickQuery(q.onHit, onHits.map(h => h.value))
  enforcement.value = pickQuery(q.enforcement, enforcements.map(e => e.value))
  expressivity.value = pickQuery(q.expressivity, expressivities.map(e => e.value))
  const id = typeof q.id === 'string' ? q.id : ''
  selected.value = id && (rules.value.length === 0 || rules.value.some(r => r.id === id)) ? id : null
}

function pushQuery() {
  const query: Record<string, string> = {}
  if (search.value.trim()) query.search = search.value.trim()
  if (dimension.value) query.dimension = dimension.value
  if (policyClass.value) query.policyClass = policyClass.value
  if (onHit.value) query.onHit = onHit.value
  if (enforcement.value) query.enforcement = enforcement.value
  if (expressivity.value) query.expressivity = expressivity.value
  if (selected.value && detail.value) query.id = selected.value
  void router.replace({ path: route.path, query })
}

function clearFilters() {
  search.value = ''; dimension.value = ''; policyClass.value = ''; onHit.value = ''; enforcement.value = ''; expressivity.value = ''; selected.value = null
  void router.replace({ path: route.path, query: {} })
}

function selectRule(rule: { id: string }, event?: Event) {
  lastFocused.value = (event?.currentTarget as HTMLElement) ?? null
  selected.value = rule.id
  pushQuery()
}

function closeInspector() {
  selected.value = null
  pushQuery()
  nextTick(() => {
    if (lastFocused.value && typeof lastFocused.value.focus === 'function') {
      lastFocused.value.focus()
    }
  })
}

function applyMatrixFilter(filters: { dimension?: string; onHit?: RuleOnHit; expressivity?: RuleExpressivity }) {
  search.value = ''; policyClass.value = ''; enforcement.value = ''
  dimension.value = filters.dimension ?? ''
  onHit.value = filters.onHit ?? ''
  expressivity.value = filters.expressivity ?? ''
  selected.value = null
  pushQuery()
  tableContainer.value?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && selected.value) {
    event.preventDefault()
    closeInspector()
  }
}

watch(() => route.query, readQuery, { immediate: true })
watch([search, dimension, policyClass, onHit, enforcement, expressivity], () => { pushQuery() }, { deep: true })
watch(() => governance.activeProjectId, () => { if (selected.value) { selected.value = null; pushQuery() } })
onMounted(() => window.addEventListener('keydown', keydown))
onBeforeUnmount(() => window.removeEventListener('keydown', keydown))
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('rules.title')" :description="t('rules.description')">
      <template #actions>
        <RouterLink to="/editor" class="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-xs hover:bg-accent">{{ t('rules.edit') }}</RouterLink>
      </template>
    </PageHeader>
    <div v-if="governance.loading" class="panel p-5 text-sm" role="status">{{ t('rules.loading') }}</div>
    <div v-else-if="governance.error" class="panel p-5 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.activeProjectId ? governance.refreshProject() : governance.initialize()">{{ t('common.retry') }}</button></div>
    <EmptyState v-else-if="!governance.activeProjectId" :title="t('common.selectProject')" :description="t('rules.emptyProject')" />
    <EmptyState v-else-if="!governance.policy" :title="t('rules.noPolicyTitle')" :description="t('rules.noPolicyDescription')" />
    <template v-else>
      <RuleMatrix :rules="rules" @filter="applyMatrixFilter" />
      <div class="grid gap-0 lg:grid-cols-[1fr_auto] lg:items-start">
        <section ref="tableContainer" class="panel min-w-0">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">{{ t('rules.tableTitle') }}</h2>
              <p class="panel-kicker">{{ t('rules.tableKicker', { version: governance.policy.version, shown: filtered.length, total: rules.length, selected: rules.filter(r => locallySelected(r.id)).length }) }}</p>
            </div>
          </div>
          <div class="filterbar">
            <div class="relative flex-1 basis-48">
              <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input v-model="search" :aria-label="t('rules.search')" :placeholder="t('rules.searchPlaceholder')" class="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-xs" />
              <button v-if="search" type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" :aria-label="t('rules.clearSearch')" @click="search = ''"><X class="size-3.5" /></button>
            </div>
            <select v-model="dimension" :aria-label="t('rules.filterDimension')" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="">{{ t('rules.allDimensions') }}</option>
              <option v-for="d in dimensions" :key="d" :value="d">{{ d }}</option>
            </select>
            <select v-model="policyClass" :aria-label="t('rules.filterPolicyClass')" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="">{{ t('rules.allPolicyClasses') }}</option>
              <option v-for="c in policyClasses" :key="c.value" :value="c.value">{{ t(c.labelKey) }}</option>
            </select>
            <select v-model="onHit" :aria-label="t('rules.filterOnHit')" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="">{{ t('rules.allOnHits') }}</option>
              <option v-for="h in onHits" :key="h.value" :value="h.value">{{ h.label }}</option>
            </select>
            <select v-model="enforcement" :aria-label="t('rules.filterEnforcement')" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="">{{ t('rules.allEnforcements') }}</option>
              <option v-for="e in enforcements" :key="e.value" :value="e.value">{{ e.label }}</option>
            </select>
            <select v-model="expressivity" :aria-label="t('rules.filterExpressivity')" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="">{{ t('rules.allExpressivities') }}</option>
              <option v-for="e in expressivities" :key="e.value" :value="e.value">{{ t(e.labelKey) }}</option>
            </select>
            <button v-if="search || dimension || policyClass || onHit || enforcement || expressivity" type="button" class="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent" @click="clearFilters"><SlidersHorizontal class="size-3.5" />{{ t('common.reset') }}</button>
          </div>
          <div class="overflow-x-auto">
            <table class="data-table min-w-[780px]">
              <thead>
                <tr>
                  <th>{{ t('rules.columnRule') }}</th>
                  <th>{{ t('ruleFields.dimension') }}</th>
                  <th>{{ t('rules.columnSelection') }}</th>
                  <th>{{ t('rules.columnOnHit') }}</th>
                  <th>{{ t('rules.columnEnforcement') }}</th>
                  <th>{{ t('ruleFields.source') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="rule in filtered" :key="rule.id" :data-selected="selected === rule.id">
                  <td class="max-w-[300px]"><button class="block max-w-full text-left font-medium text-primary underline-offset-4 hover:underline" type="button" @click="selectRule(rule, $event)"><span class="block line-clamp-2">{{ rule.narrative || rule.id }}</span><span class="mt-1 block break-all font-mono text-[10px] font-normal text-muted-foreground">{{ rule.id }}</span></button></td>
                  <td>{{ rule.dimension }}<span class="mt-1 block text-[10px] text-muted-foreground">L{{ rule.level }} · {{ rule.policy_class }}</span></td>
                  <td>{{ locallySelected(rule.id) ? t('rules.selected') : t('rules.notSelected') }}</td>
                  <td>{{ rule.on_hit }}<span v-if="rule.expressivity === 'advisory_only'" class="mt-1 block text-[10px] text-muted-foreground">{{ t('rules.advisoryOnly') }}</span></td>
                  <td>{{ rule.enforcement }}<span class="mt-1 block text-[10px] text-muted-foreground">{{ t('rules.deploymentUnknown') }}</span></td>
                  <td class="max-w-[160px] break-all">{{ rule.source.path || '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="!filtered.length" class="p-6 text-center text-xs text-muted-foreground">{{ t('rules.noMatch') }}</p>
          </div>
        </section>
        <RuleInspector v-if="detail" :rule="detail" :activation="activation" :published-version="publishedVersion" @close="closeInspector" />
      </div>
    </template>
  </div>
</template>
