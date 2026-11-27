<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { FileUp, Plus, RotateCcw, Save, CheckCircle, AlertCircle, Play } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import RuleForm from '@/components/rules/RuleForm.vue'
import DraftSimulation from '@/components/editor/DraftSimulation.vue'
import { activationIssues, clone, effectLabel, newRule, ruleEffect, type DraftCandidate } from '@/components/rules/model'
import { generateProposalMeta } from '@/lib/editor'
import { api } from '@/lib/api'
import { useGovernanceStore } from '@/stores/governance'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import type { Candidate, Proposal, ValidationResult } from '@/types'

const governance = useGovernanceStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const { toast } = useToast()

const draft = ref<DraftCandidate | null>(null)
const baseVersion = ref(0)
const initial = ref('')
const selected = ref(0)
const busy = ref(false)
const error = ref('')
const validation = ref<ValidationResult | null>(null)
const showSimulation = ref(false)

const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== initial.value)
const issues = computed(() => draft.value ? activationIssues(draft.value) : [])
const selectedRule = computed(() => draft.value?.rules[selected.value])
let epoch = 0

function reset() {
  epoch++
  draft.value = null
  initial.value = ''
  selected.value = 0
  validation.value = null
  error.value = ''
  busy.value = false
  showSimulation.value = false
}

watch(() => governance.activeProjectId, reset)
watch(() => auth.authenticated, value => { if (!value) reset() })
watch(draft, () => { validation.value = null }, { deep: true })

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
onBeforeRouteLeave(() => !dirty.value || window.confirm(t('editor.confirmLeave')))

function replaceDraft(candidate: Candidate, version: number) {
  draft.value = clone(candidate)
  baseVersion.value = version
  initial.value = JSON.stringify(draft.value)
  selected.value = 0
  validation.value = null
  error.value = ''
  showSimulation.value = false
}

async function load(source: 'current' | 'seed' | 'history') {
  const project = governance.activeProjectId
  if (!project || busy.value) return
  if (dirty.value && !window.confirm(t('editor.confirmReplace'))) return
  const run = ++epoch
  busy.value = true
  error.value = ''
  try {
    if (source === 'seed') {
      const candidate = await api.seed()
      if (run === epoch) replaceDraft(candidate, governance.policy?.version ?? 0)
    } else if (source === 'history') {
      const version = Number(route.query.baseVersion)
      if (!Number.isSafeInteger(version) || version < 1) { error.value = t('editor.invalidHistory'); return }
      const policy = await api.version(project, version)
      if (run === epoch) replaceDraft(policy.candidate, governance.policy?.version ?? 0)
    } else if (governance.policy) {
      replaceDraft(governance.policy.candidate, governance.policy.version)
    } else {
      error.value = t('editor.noPolicy')
    }
  } catch (e) {
    if (run === epoch) error.value = e instanceof Error ? e.message : t('editor.loadFailed')
  } finally {
    if (run === epoch) busy.value = false
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !governance.activeProjectId) return
  if (dirty.value && !window.confirm(t('editor.confirmReplace'))) return
  if (file.size > 60 * 1024) { error.value = t('editor.tooLarge'); return }
  const run = ++epoch
  busy.value = true
  try {
    const text = await file.text()
    if (run !== epoch) return
    const result = await api.importYaml(governance.activeProjectId, text)
    if (run !== epoch) return
    validation.value = { valid: result.valid, issues: result.issues }
    if (!result.valid) { error.value = t('editor.importInvalid'); return }
    replaceDraft(result.candidate, governance.policy?.version ?? 0)
    toast(t('editor.imported'), t('editor.importedNote'), 'success')
  } catch {
    if (run === epoch) error.value = t('editor.importFailed')
  } finally {
    if (run === epoch) busy.value = false
  }
}

async function validate(): Promise<boolean> {
  if (!draft.value || !governance.activeProjectId) { error.value = t('editor.noDraft'); return false }
  if (issues.value.length) { error.value = issues.value[0] ?? t('editor.invalidActivation'); return false }
  if (busy.value) return false
  let candidate: DraftCandidate
  try { candidate = clone(draft.value) } catch { error.value = t('editor.prepareFailed'); return false }
  const run = epoch
  const project = governance.activeProjectId
  busy.value = true
  error.value = ''
  try {
    const result = await api.validate(project, candidate)
    if (run !== epoch) return false
    if (JSON.stringify(candidate) !== JSON.stringify(draft.value)) { error.value = t('editor.changedDuringValidation'); return false }
    validation.value = result
    if (result.valid) toast(t('editor.validated'), t('editor.validatedNote'), 'success')
    return result.valid
  } catch {
    if (run === epoch) error.value = t('editor.validateFailed')
    return false
  } finally {
    if (run === epoch) busy.value = false
  }
}

async function submit() {
  if (!draft.value || !governance.activeProjectId) { error.value = t('editor.noDraft'); return }
  if (busy.value) return
  if (!(await validate())) return
  if (!window.confirm(t('editor.confirmSubmit'))) return
  if (!draft.value || !governance.activeProjectId) return
  const run = epoch
  const project = governance.activeProjectId
  busy.value = true
  error.value = ''
  const meta = generateProposalMeta(project, baseVersion.value, draft.value)
  let proposal: Proposal
  try {
    proposal = await api.createProposal(project, {
      title: meta.title,
      rationale: meta.rationale,
      baseVersion: baseVersion.value,
      expiresAt: meta.expiresAt,
      candidate: clone(draft.value)
    })
  } catch {
    if (run === epoch) error.value = t('editor.submitFailed')
    return
  } finally {
    if (run === epoch) busy.value = false
  }
  if (run !== epoch) return
  reset()
  toast(t('editor.created'), t('editor.createdNote'), 'success')
  try { await governance.refreshProject() }
  catch { toast(t('editor.refreshFailed'), t('editor.refreshFailedNote'), 'error') }
  await router.push(`/proposals/${encodeURIComponent(proposal.id)}`)
}

function addRule() {
  if (!draft.value) return
  let n = 1
  while (draft.value.rules.some(r => r.id === `new-rule-${n}`)) n++
  draft.value.rules.push(newRule(`new-rule-${n}`))
  selected.value = draft.value.rules.length - 1
}

function removeRule(index: number) {
  if (!draft.value || !window.confirm(t('editor.confirmRemove'))) return
  const id = draft.value.rules[index]?.id
  draft.value.rules.splice(index, 1)
  if (id) {
    draft.value.activation.includedRuleIds = draft.value.activation.includedRuleIds?.filter(x => x !== id) ?? null
    draft.value.activation.excludedRuleIds = draft.value.activation.excludedRuleIds.filter(x => x !== id)
  }
  selected.value = Math.min(selected.value, Math.max(0, draft.value.rules.length - 1))
}

function toggle(id: string, field: 'includedRuleIds' | 'excludedRuleIds', checked: boolean) {
  if (!draft.value) return
  const activation = draft.value.activation
  const list = activation[field] ?? []
  activation[field] = checked ? [...list, id] : list.filter(x => x !== id)
  if (checked && field === 'includedRuleIds') activation.excludedRuleIds = activation.excludedRuleIds.filter(x => x !== id)
  if (checked && field === 'excludedRuleIds' && activation.includedRuleIds) activation.includedRuleIds = activation.includedRuleIds.filter(x => x !== id)
}
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('editor.title')" :description="t('editor.description')">
      <template #actions>
        <span v-if="dirty" class="inline-flex items-center gap-1 text-xs text-warning"><AlertCircle class="size-3.5" />{{ t('editor.unsaved') }}</span>
        <Button v-if="draft" variant="outline" size="sm" :disabled="busy || !!issues.length" @click="validate">
          <CheckCircle class="mr-1 size-3.5" />{{ busy ? t('common.processing') : t('editor.validate') }}
        </Button>
        <Button v-if="draft" variant="outline" size="sm" :disabled="busy || !!issues.length" @click="showSimulation = !showSimulation">
          <Play class="mr-1 size-3.5" />{{ showSimulation ? t('editor.hideSimulation') : t('editor.showSimulation') }}
        </Button>
        <Button v-if="draft" size="sm" :disabled="busy || !!issues.length" @click="submit">
          <Save class="mr-1 size-3.5" />{{ busy ? t('common.processing') : t('editor.submit') }}
        </Button>
      </template>
    </PageHeader>

    <EmptyState v-if="!governance.activeProjectId" :title="t('common.selectProject')" :description="t('editor.emptyDescription')" />
    <template v-else>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{{ t('editor.sourceTitle') }}</h2>
            <p class="panel-kicker">{{ draft ? t('editor.sourceLoaded', { version: baseVersion }) : t('editor.sourceEmpty') }}</p>
          </div>
        </div>
        <div class="panel-body flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="busy || !governance.policy" @click="load('current')"><RotateCcw class="mr-1 size-3.5" />{{ t('editor.currentPolicy') }}</Button>
          <Button type="button" variant="outline" size="sm" :disabled="busy" @click="load('seed')">{{ t('editor.seed') }}</Button>
          <Button v-if="route.query.baseVersion" type="button" variant="outline" size="sm" :disabled="busy" @click="load('history')">{{ t('editor.history', { version: String(route.query.baseVersion) }) }}</Button>
          <label class="inline-flex h-8 cursor-pointer items-center rounded-md border border-border bg-card px-3 text-xs hover:bg-accent">
            <FileUp class="mr-1 size-3.5" />{{ t('editor.import') }}
            <input type="file" accept=".yaml,.yml,.json,application/yaml,application/json" class="sr-only" :disabled="busy" @change="importFile" />
          </label>
        </div>
      </section>

      <div v-if="error" role="alert" class="panel p-5 text-sm text-destructive">{{ error }}</div>

      <section v-if="validation" class="panel p-4 text-xs" aria-live="polite">
        <p class="flex items-center gap-1.5 font-semibold" :class="validation.valid ? 'text-positive' : 'text-destructive'">
          <component :is="validation.valid ? CheckCircle : AlertCircle" class="size-4" />
          {{ validation.valid ? t('editor.validationPassed') : t('editor.validationFailed') }}
        </p>
        <ul v-if="!validation.valid" class="mt-2 space-y-1 text-muted-foreground">
          <li v-for="(issue, i) in validation.issues" :key="i" class="break-all">{{ issue.path }} · {{ issue.code }}</li>
        </ul>
      </section>

      <DraftSimulation v-if="draft && showSimulation" :project-id="governance.activeProjectId" :candidate="draft" :workspace="governance.activeProject?.workspace" />

      <template v-if="draft">
        <div class="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <section class="panel min-w-0">
            <div class="panel-header">
              <h2 class="panel-title">{{ t('editor.rulesTitle', { count: draft.rules.length }) }}</h2>
              <Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs" @click="addRule"><Plus class="mr-1 size-3.5" />{{ t('common.add') }}</Button>
            </div>
            <ul class="p-2">
              <li v-for="(rule, i) in draft.rules" :key="i" class="flex items-center gap-1">
                <button type="button" class="min-w-0 flex-1 rounded p-2 text-left text-xs hover:bg-accent" :class="selected === i ? 'bg-accent' : ''" @click="selected = i">
                  <span class="block truncate font-medium">{{ rule.id || t('editor.noId') }}</span>
                  <span class="block truncate text-muted-foreground">{{ rule.dimension }} · {{ effectLabel(ruleEffect(rule)) }}</span>
                </button>
                <button type="button" class="rounded p-2 text-xs text-muted-foreground hover:text-destructive" :aria-label="t('editor.deleteRule', { id: rule.id })" @click="removeRule(i)">{{ t('common.delete') }}</button>
              </li>
            </ul>
          </section>
          <RuleForm v-if="selectedRule" :key="selected" :rule="selectedRule" />
          <EmptyState v-else :title="t('editor.noRulesTitle')" :description="t('editor.noRulesDescription')" />
        </div>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">{{ t('editor.activationTitle') }}</h2>
              <p class="panel-kicker">{{ t('editor.activationKicker') }}</p>
            </div>
          </div>
          <div class="panel-body space-y-3 text-xs">
            <label class="flex items-center gap-2">
              <input type="checkbox" :checked="draft.activation.includedRuleIds === null" @change="draft.activation.includedRuleIds = ($event.target as HTMLInputElement).checked ? null : []" />
              {{ t('editor.includeAll') }}
            </label>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead>
                  <tr><th scope="col">{{ t('ruleFields.id') }}</th><th v-if="draft.activation.includedRuleIds !== null" scope="col">{{ t('editor.include') }}</th><th scope="col">{{ t('editor.exclude') }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="rule in draft.rules" :key="rule.id">
                    <td>{{ rule.id }}</td>
                    <td v-if="draft.activation.includedRuleIds !== null">
                      <input type="checkbox" :aria-label="t('editor.includeRule', { id: rule.id })" :checked="draft.activation.includedRuleIds.includes(rule.id)" @change="toggle(rule.id, 'includedRuleIds', ($event.target as HTMLInputElement).checked)" />
                    </td>
                    <td>
                      <input type="checkbox" :aria-label="t('editor.excludeRule', { id: rule.id })" :checked="draft.activation.excludedRuleIds.includes(rule.id)" @change="toggle(rule.id, 'excludedRuleIds', ($event.target as HTMLInputElement).checked)" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ul v-if="issues.length" class="space-y-1 text-destructive"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.control { width: 100%; border: 1px solid hsl(var(--input)); border-radius: 6px; background: hsl(var(--background)); padding: 7px 9px; color: hsl(var(--foreground)); }
</style>
