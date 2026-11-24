<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Download, RotateCcw } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import CandidateView from '@/components/governance/CandidateView.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { generateRollbackProposalMeta } from '@/lib/editor'
import { formatDate } from '@/lib/format'
import { useGovernanceStore } from '@/stores/governance'
import { useToast } from '@/composables/useToast'
import { t } from '@/i18n'
import type { Proposal, PublishedVersion } from '@/types'

const store = useGovernanceStore()
const route = useRoute()
const router = useRouter()
const { toast } = useToast()

const number = computed(() => Number(route.params.version))
const item = ref<PublishedVersion | null>(null)
const rolloutRows = computed(() => store.rollouts)
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const restoreOpen = ref(false)
let generation = 0

async function load() {
  const ticket = ++generation
  const project = store.activeProjectId
  const version = number.value
  item.value = null
  error.value = ''
  loading.value = false
  busy.value = false
  restoreOpen.value = false
  if (!project) return
  if (!Number.isSafeInteger(version) || version < 1) { error.value = t('version.invalid'); return }
  loading.value = true
  try {
    const result = await api.version(project, version)
    if (ticket === generation && result.projectId === project) item.value = result
  } catch (e) {
    if (ticket === generation) error.value = e instanceof Error ? e.message : t('version.loadError')
  } finally {
    if (ticket === generation) loading.value = false
  }
}

watch([() => store.activeProjectId, number], load, { immediate: true })

function openRestore() {
  restoreOpen.value = true
}

async function download(format: 'yaml' | 'json') {
  const project = store.activeProjectId
  const version = item.value?.version
  const ticket = generation
  if (!project || !version || busy.value) return
  busy.value = true
  try {
    await api.exportVersion(project, version, format)
    if (ticket === generation) toast(t('version.exported'), t('version.exportedNote', { format: format.toUpperCase() }), 'success')
  } catch (e) {
    if (ticket === generation) toast(t('version.exportFailed'), e instanceof Error ? e.message : t('version.exportFailedFallback'), 'error')
  } finally {
    if (ticket === generation) busy.value = false
  }
}

async function restore() {
  const project = store.activeProjectId
  const version = item.value?.version
  const ticket = generation
  if (!project || !version || busy.value) return
  if (store.loading || store.error) { error.value = t('version.restoreProjectUnavailable'); return }
  const baseVersion = store.policy?.version ?? 0
  const meta = generateRollbackProposalMeta(project, baseVersion, version)
  busy.value = true
  error.value = ''
  let proposal: Proposal
  try {
    proposal = await api.restore(project, version, {
      title: meta.title,
      rationale: meta.rationale,
      baseVersion,
      expiresAt: meta.expiresAt
    })
  } catch (e) {
    if (ticket === generation) {
      error.value = e instanceof Error ? e.message : t('version.restoreFailed')
      toast(t('version.createFailed'), error.value, 'error')
    }
    return
  } finally {
    if (ticket === generation) busy.value = false
  }
  if (ticket !== generation || project !== store.activeProjectId) return
  restoreOpen.value = false
  toast(t('version.created'), t('version.createdNote'), 'success')
  try { await store.refreshProject() }
  catch { if (ticket === generation) toast(t('version.refreshFailed'), t('version.refreshFailedNote'), 'error') }
  if (ticket === generation && project === store.activeProjectId) await router.push(`/proposals/${encodeURIComponent(proposal.id)}`)
}
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('common.version', { version: String(route.params.version) })" :description="t('version.description')">
      <template #actions>
        <RouterLink to="/versions" class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft class="size-3.5" />{{ t('version.back') }}</RouterLink>
      </template>
    </PageHeader>

    <EmptyState v-if="!store.activeProjectId" :title="t('common.selectProject')" :description="t('version.emptyProject')" />
    <div v-else-if="loading" class="panel p-5 text-sm" role="status">{{ t('version.loading') }}</div>
    <div v-else-if="!item" class="panel p-5 text-sm text-destructive" role="alert">{{ error || t('version.loadFailed') }} <button class="ml-2 underline" @click="load">{{ t('common.retry') }}</button></div>

    <template v-else>
      <div v-if="error && !restoreOpen" class="panel p-5 text-sm text-destructive" role="alert">{{ error }}</div>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="text-base font-semibold">{{ t('common.version', { version: item.version }) }}</h2>
            <p class="panel-kicker">{{ item.previousVersion == null ? t('version.initial') : t('version.basedOn', { version: item.previousVersion }) }} · {{ t('version.ruleCount', { count: item.candidate.rules.length }) }}</p>
          </div>
        </div>
        <div class="panel-body grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><dt class="text-[11px] text-muted-foreground">{{ t('version.proposal') }}</dt><dd class="break-all font-mono">{{ item.proposalId }}</dd></div>
          <div><dt class="text-[11px] text-muted-foreground">{{ t('version.approver') }}</dt><dd>{{ item.approvedBy.id }} · {{ item.approvedBy.role }}</dd></div>
          <div><dt class="text-[11px] text-muted-foreground">{{ t('version.publishedAt') }}</dt><dd>{{ formatDate(item.createdAt) }}</dd></div>
          <div><dt class="text-[11px] text-muted-foreground">{{ t('version.candidateDigest') }}</dt><dd class="break-all font-mono">{{ item.snapshot.candidateDigest.slice(0, 16) }}…</dd></div>
        </div>
        <div class="panel-body border-t border-hairline text-xs">
          <p class="field-label">{{ t('version.snapshotDigest') }}</p>
          <p class="mt-1 break-all font-mono">{{ item.snapshot.digest }}</p>
        </div>
        <div class="flex flex-wrap gap-2 border-t border-hairline p-4">
          <Button size="sm" variant="outline" :disabled="busy" @click="download('yaml')"><Download class="mr-1 size-3.5" />{{ t('version.downloadYaml') }}</Button>
          <Button size="sm" variant="outline" :disabled="busy" @click="download('json')"><Download class="mr-1 size-3.5" />{{ t('version.downloadJson') }}</Button>
          <Button size="sm" :disabled="busy || store.loading || !!store.error" @click="openRestore"><RotateCcw class="mr-1 size-3.5" />{{ t('version.createRollback') }}</Button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{{ t('version.rolloutTitle') }}</h2>
            <p class="panel-kicker">{{ t('version.rolloutKicker') }}</p>
          </div>
        </div>
        <div v-if="!rolloutRows.length" class="p-4 text-xs text-muted-foreground">{{ t('version.rolloutEmpty') }}</div>
        <div v-else class="overflow-x-auto">
          <table class="data-table min-w-[420px]">
            <thead><tr><th scope="col">{{ t('version.rolloutRule') }}</th><th scope="col">{{ t('version.rolloutVersion') }}</th><th scope="col">{{ t('version.rolloutState') }}</th><th scope="col">{{ t('version.rolloutUpdated') }}</th></tr></thead>
            <tbody>
              <tr v-for="row in rolloutRows" :key="row.ruleId">
                <td class="break-all font-mono text-xs">{{ row.ruleId }}</td>
                <td class="num">v{{ row.ruleVersion }}</td>
                <td>{{ row.state }}</td>
                <td>{{ formatDate(row.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <CandidateView :candidate="item.candidate" />

      <Dialog v-model:open="restoreOpen">
        <DialogContent class="max-h-[90dvh] overflow-y-auto rounded-md sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{{ t('version.restoreTitle', { version: item.version }) }}</DialogTitle>
            <DialogDescription>{{ t('version.restoreDescription') }}</DialogDescription>
          </DialogHeader>
          <form class="space-y-4" @submit.prevent="restore">
            <div v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</div>
            <p class="text-xs text-muted-foreground">{{ t('version.restoreBase', { version: store.policy?.version ?? 0 }) }}</p>
            <DialogFooter>
              <Button type="button" variant="outline" :disabled="busy" @click="restoreOpen = false">{{ t('common.cancel') }}</Button>
              <Button type="submit" :disabled="busy">{{ busy ? t('common.submitting') : t('version.restoreSubmit') }}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
