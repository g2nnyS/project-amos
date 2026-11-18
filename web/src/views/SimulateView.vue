<script setup lang="ts">
import { ref, watch } from 'vue'
import { FlaskConical, Play } from 'lucide-vue-next'
import { api } from '@/lib/api'
import { useGovernanceStore } from '@/stores/governance'
import type { PolicyDecision } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'

const governance = useGovernanceStore()
const tool = ref('')
const operation = ref('')
const target = ref('')
const version = ref('')
const loading = ref(false)
const error = ref('')
const result = ref<PolicyDecision | null>(null)
const provenance = ref<{ projectId: string; projectName: string; version: number; digest: string | null } | null>(null)
let generation = 0

function invalidateResult() {
  generation++
  result.value = null
  provenance.value = null
  error.value = ''
  loading.value = false
}
watch([tool, operation, target, version, () => governance.policy?.version], invalidateResult, { flush: 'sync' })
watch(() => governance.activeProjectId, () => {
  invalidateResult()
  version.value = ''
}, { flush: 'sync' })

async function simulate() {
  const id = governance.activeProjectId
  if (!id || !governance.policy) return
  const selectedVersion = version.value ? Number(version.value) : governance.policy.version
  if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1) { error.value = t('simulate.invalidVersion'); return }
  const published = governance.policy.version === selectedVersion ? governance.policy : governance.versions.find(item => item.version === selectedVersion && item.projectId === id)
  const context = { projectId: id, projectName: governance.activeProject?.name ?? id, version: selectedVersion, digest: published?.snapshot.digest ?? null }
  const request = ++generation
  loading.value = true
  error.value = ''
  result.value = null
  provenance.value = null
  try {
    const response = await api.simulate(id, {
      action: { tool: tool.value, operation: operation.value, target: target.value },
      version: selectedVersion
    })
    if (generation === request) { result.value = response; provenance.value = context }
  } catch (e) {
    if (generation === request) error.value = e instanceof Error ? e.message : t('simulate.failed')
  } finally {
    if (generation === request) loading.value = false
  }
}
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('simulate.title')" :description="t('simulate.description')" />

    <div class="rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      {{ t('simulate.notice') }}
    </div>

    <div v-if="governance.loading" class="panel p-5 text-sm" role="status">{{ t('simulate.loading') }}</div>
    <div v-else-if="governance.error" class="panel p-5 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.activeProjectId ? governance.refreshProject() : governance.initialize()">{{ t('common.retry') }}</button></div>
    <EmptyState v-else-if="!governance.activeProject" :title="t('common.selectProject')" :description="t('simulate.emptyProject')" />
    <EmptyState v-else-if="!governance.policy" :title="t('simulate.noPolicyTitle')" :description="t('simulate.noPolicyDescription')" />

    <div v-else class="grid gap-4 lg:grid-cols-2">
      <section class="panel">
        <div class="panel-header"><div><h2 class="panel-title">{{ t('simulate.inputTitle') }}</h2><p class="panel-kicker">{{ t('simulate.inputKicker') }}</p></div></div>
        <form class="space-y-4 p-4" @submit.prevent="simulate">
          <label class="field">
            <span class="field-label">{{ t('simulate.tool') }}</span>
            <input v-model="tool" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('simulate.operation') }}</span>
            <input v-model="operation" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('simulate.target') }}</span>
            <input v-model="target" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('simulate.version') }}</span>
            <select v-model="version" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">{{ t('simulate.currentVersion') }}</option>
              <option v-for="item in governance.versions" :key="item.version" :value="String(item.version)">{{ t('common.version', { version: item.version }) }}</option>
            </select>
          </label>
          <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
          <Button type="submit" :disabled="loading"><Play class="mr-1 size-3.5" />{{ loading ? t('simulate.running') : t('simulate.run') }}</Button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-header"><div><h2 class="panel-title">{{ t('simulate.resultTitle') }}</h2><p class="panel-kicker">{{ t('simulate.resultKicker') }}</p></div></div>
        <div v-if="result" class="space-y-3 p-4 text-sm">
          <div v-if="provenance" class="rounded-md border border-border bg-surface p-3 text-xs leading-relaxed">
            <p class="font-medium">{{ t('simulate.provenance', { version: provenance.version }) }}</p>
            <p class="mt-1 break-all text-muted-foreground">{{ t('simulate.project', { name: provenance.projectName, id: provenance.projectId }) }}</p>
            <p class="mt-1 break-all font-mono text-muted-foreground">{{ t('simulate.digest', { digest: provenance.digest ?? t('common.unavailable') }) }}</p>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-muted-foreground">{{ t('simulate.verdict') }}</span>
            <span class="rounded border border-border px-1.5 py-0.5 font-medium">{{ result.verdict }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-muted-foreground">{{ t('simulate.decision') }}</span>
            <span>{{ result.decision }}</span>
          </div>
          <div>
            <span class="text-[11px] text-muted-foreground">{{ t('simulate.matched') }}</span>
            <p class="mt-1 break-all">{{ result.matched_rule_ids.join(', ') || t('common.none') }}</p>
          </div>
          <p v-if="result.error" class="text-destructive">{{ result.error }}</p>
          <ul v-if="result.matched_rules.length" class="space-y-2">
            <li v-for="rule in result.matched_rules" :key="rule.id" class="rounded-md border border-border p-3 text-xs">
              {{ rule.id }} · {{ rule.dimension }} · level {{ rule.level }} · {{ rule.policy_class }} / {{ rule.enforcement }} / {{ rule.on_hit }}
            </li>
          </ul>
        </div>
        <p v-else class="p-6 text-center text-xs text-muted-foreground">{{ t('simulate.placeholder') }}</p>
      </section>
    </div>
  </div>
</template>
