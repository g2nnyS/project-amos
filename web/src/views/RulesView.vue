<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted, nextTick } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Pencil, Table2 } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import RuleInspector from '@/components/rules/RuleInspector.vue'
import RuleMatrix from '@/components/rules/RuleMatrix.vue'
import RulesFilterBar from '@/components/rules/RulesFilterBar.vue'
import RulesCategoryPanel from '@/components/rules/RulesCategoryPanel.vue'
import { isGlobalProject, useGovernanceStore } from '@/stores/governance'
import { t, type MessageKey } from '@/i18n'
import { Button } from '@/components/ui/button'
import type { RuleOnHit, RuleExpressivity, RulePolicyClass, RuleEnforcement, RuleRecord } from '@/types'

const governance = useGovernanceStore()
const route = useRoute()
const router = useRouter()
const isGlobal = computed(() => isGlobalProject(governance.activeProject))

const search = ref('')
const dimension = ref('')
const policyClass = ref<RulePolicyClass | ''>('')
const onHit = ref<RuleOnHit | ''>('')
const enforcement = ref<RuleEnforcement | ''>('')
const expressivity = ref<RuleExpressivity | ''>('')
const selected = ref<string | null>(null)
const tableContainer = ref<HTMLDivElement | null>(null)
const lastFocused = ref<HTMLElement | null>(null)
const matrixExpanded = ref(false)
const matrixPanelId = 'rule-matrix-panel'

const rules = computed(() => governance.policy?.candidate.rules ?? [])
const activation = computed(() => governance.policy?.candidate.activation ?? { includedRuleIds: null, excludedRuleIds: [] })
const publishedVersion = computed(() => governance.policy?.version ?? null)

const dimensions = computed(() => [...new Set(rules.value.map(r => r.dimension))].sort())
const policyClasses: { value: RulePolicyClass; labelKey: MessageKey }[] = [{ value: 'security', labelKey: 'rules.security' }, { value: 'engineering', labelKey: 'rules.engineering' }]
const onHits = computed(() => (['deny', 'confirm', 'log'] as const).map(value => ({ value, label: t(`ruleForm.action.${value}`) })))
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

const selectedIds = computed(() => {
  const inc = activation.value.includedRuleIds
  const exc = activation.value.excludedRuleIds
  if (inc === null) {
    const set = new Set(rules.value.map(r => r.id))
    for (const id of exc) set.delete(id)
    return set
  }
  return new Set(inc.filter(id => !exc.includes(id)))
})

const totalSelected = computed(() => rules.value.filter(r => selectedIds.value.has(r.id)).length)

const groups = computed(() => policyClasses.map(({ value }) => ({
  policyClass: value,
  title: t(value === 'security' ? 'rules.categorySecurity' : 'rules.categoryEngineering'),
  rules: filtered.value.filter(rule => rule.policy_class === value),
})).filter(group => group.rules.length))

const detail = computed(() => rules.value.find(r => r.id === selected.value) ?? null)

function pickQuery<T extends string>(value: unknown, allowed: readonly T[]): T | '' {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : ''
}

function readQuery() {
  if (!governance.policy) return
  const q = route.query
  search.value = typeof q.search === 'string' ? q.search : ''
  dimension.value = pickQuery(q.dimension, dimensions.value)
  policyClass.value = pickQuery(q.policyClass, policyClasses.map(c => c.value))
  onHit.value = pickQuery(q.onHit, onHits.value.map(h => h.value))
  enforcement.value = pickQuery(q.enforcement, enforcements.map(e => e.value))
  expressivity.value = pickQuery(q.expressivity, expressivities.map(e => e.value))
  const id = typeof q.id === 'string' ? q.id : ''
  selected.value = rules.value.some(r => r.id === id) ? id : null
}

function pushQuery() {
  if (!governance.policy) return
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

function selectRule(rule: RuleRecord, event?: Event) {
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
  matrixExpanded.value = false
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

watch([() => route.query, () => governance.policy], readQuery, { immediate: true })
watch([search, dimension, policyClass, onHit, enforcement, expressivity], pushQuery)
watch(() => governance.activeProjectId, (newId, oldId) => {
  if (oldId && oldId !== newId && route.query.id) {
    selected.value = null
    void router.replace({ path: route.path, query: { ...route.query, id: undefined } })
  }
})
onMounted(() => window.addEventListener('keydown', keydown))
onBeforeUnmount(() => window.removeEventListener('keydown', keydown))
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t(isGlobal || !governance.activeProject ? 'rules.title' : 'rules.titleSupplementary')" :description="t(isGlobal || !governance.activeProject ? 'rules.description' : 'rules.descriptionSupplementary')">
      <template #actions>
        <Button
          v-if="governance.policy && !governance.loading && !governance.error"
          type="button"
          variant="outline"
          size="sm"
          :aria-expanded="matrixExpanded"
          :aria-controls="matrixPanelId"
          @click="matrixExpanded = !matrixExpanded"
        >
          <Table2 class="size-3.5" />
          {{ t('ruleMatrix.title') }}
        </Button>
        <Button as-child size="sm">
          <RouterLink to="/editor"><Pencil class="size-3.5" />{{ t('rules.edit') }}</RouterLink>
        </Button>
      </template>
    </PageHeader>
    <div v-if="governance.loading" class="panel p-5 text-sm" role="status">{{ t('rules.loading') }}</div>
    <div v-else-if="governance.error" class="panel p-5 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.activeProjectId ? governance.refreshProject() : governance.initialize()">{{ t('common.retry') }}</button></div>
    <EmptyState v-else-if="!governance.activeProjectId" :title="t('common.selectProject')" :description="t('rules.emptyProject')" />
    <EmptyState v-else-if="!governance.policy" :title="t('rules.noPolicyTitle')" :description="t('rules.noPolicyDescription')" />
    <template v-else>
      <div :id="matrixPanelId" v-show="matrixExpanded">
        <RuleMatrix :rules="rules" @filter="applyMatrixFilter" />
      </div>
      <div class="grid gap-0 lg:grid-cols-[1fr_auto] lg:items-start">
        <section ref="tableContainer" class="min-w-0 space-y-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="panel-title">{{ t(isGlobal ? 'rules.tableTitle' : 'rules.tableTitleSupplementary') }}</h2>
              <p class="panel-kicker">{{ t(isGlobal ? 'rules.tableKicker' : 'rules.tableKickerSupplementary', { version: governance.policy.version, shown: filtered.length, total: rules.length, selected: totalSelected }) }}</p>
            </div>
          </div>
          <RulesFilterBar
            v-model:search="search"
            v-model:dimension="dimension"
            v-model:policy-class="policyClass"
            v-model:on-hit="onHit"
            v-model:enforcement="enforcement"
            v-model:expressivity="expressivity"
            :dimensions="dimensions"
            :policy-classes="policyClasses"
            :on-hits="onHits"
            :enforcements="enforcements"
            :expressivities="expressivities"
            @reset="clearFilters"
          />
          <RulesCategoryPanel
            v-for="group in groups"
            :key="group.policyClass"
            :title="group.title"
            :policy-class="group.policyClass"
            :rules="group.rules"
            :selected-ids="selectedIds"
            :is-global="isGlobal"
            :selected="selected"
            @select="selectRule"
          />
          <p v-if="!filtered.length" class="py-8 text-center text-xs text-muted-foreground">{{ t('rules.noMatch') }}</p>
        </section>
        <RuleInspector v-if="detail" :rule="detail" :activation="activation" :published-version="publishedVersion" @close="closeInspector" />
      </div>
    </template>
  </div>
</template>
