<script setup lang="ts">
import { ref, watch } from 'vue'
import { ScrollText } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n'
import { auditEventLabel } from '@/i18n/labels'
import { useGovernanceStore } from '@/stores/governance'
import type { AuditPage } from '@/types'

const store = useGovernanceStore()
const scope = ref<'project' | 'all'>('project')
const result = ref<AuditPage | null>(null)
const error = ref('')
const loading = ref(false)
const cursors = ref<(number | undefined)[]>([undefined])
const index = ref(0)
let generation = 0

async function load() {
  const ticket = ++generation
  const project = store.activeProjectId
  result.value = null
  error.value = ''
  loading.value = false
  if (scope.value === 'project' && !project) return
  loading.value = true
  try {
    const page = await api.audit({
      ...(scope.value === 'project' && project ? { projectId: project } : {}),
      limit: 25,
      ...(cursors.value[index.value] === undefined ? {} : { before: cursors.value[index.value] })
    })
    if (ticket === generation) result.value = page
  } catch (e) {
    if (ticket === generation) error.value = e instanceof Error ? e.message : t('audit.loadError')
  } finally {
    if (ticket === generation) loading.value = false
  }
}

watch([() => store.activeProjectId, scope], () => { cursors.value = [undefined]; index.value = 0; void load() }, { immediate: true })

function next() {
  if (!result.value?.nextCursor) return
  cursors.value = [...cursors.value.slice(0, index.value + 1), result.value.nextCursor]
  index.value++
  void load()
}

function previous() {
  if (index.value > 0) { index.value--; void load() }
}
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('audit.title')" :description="t('audit.description')">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="loading" @click="load"><ScrollText class="mr-1 size-3.5" />{{ t('common.refresh') }}</Button>
      </template>
    </PageHeader>

    <section class="panel overflow-hidden">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">{{ t('audit.listTitle') }}</h2>
        </div>
      </div>
      <div class="filterbar">
        <label for="audit-scope" class="text-xs text-muted-foreground">{{ t('audit.scope') }}</label>
        <select id="audit-scope" v-model="scope" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
          <option value="project">{{ t('audit.scopeProject') }}</option>
          <option value="all">{{ t('audit.scopeAll') }}</option>
        </select>
        <span class="ml-auto text-xs text-muted-foreground">{{ t('audit.order') }}</span>
      </div>

      <div v-if="scope === 'project' && !store.activeProjectId" class="p-6">
        <EmptyState :title="t('common.selectProject')" :description="t('audit.emptyProject')" />
      </div>
      <div v-else-if="loading" role="status" class="p-6 text-sm">{{ t('audit.loading') }}</div>
      <div v-else-if="error" role="alert" class="p-6 text-sm text-destructive">
        {{ t('common.loadFailed', { error }) }} <button class="ml-2 underline" @click="load">{{ t('common.retry') }}</button>
      </div>
      <div v-else-if="result && !result.items.length" class="p-8">
        <EmptyState :title="t('audit.emptyTitle')" :description="t('audit.emptyDescription')" />
      </div>
      <div v-else-if="result" class="divide-y divide-border">
        <article v-for="event in result.items" :key="event.id" class="p-4">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span class="font-medium text-foreground">{{ auditEventLabel(event.kind) }}</span>
            <span class="text-muted-foreground">#{{ event.id }} · {{ formatDate(event.createdAt) }}</span>
            <span class="text-muted-foreground">{{ event.actor.id }} · {{ event.actor.role }}</span>
          </div>
          <p class="mt-2 break-all text-xs text-muted-foreground">
            {{ t('audit.refs', { project: event.projectId ?? '—', proposal: event.proposalId ?? '—', version: event.version ?? '—' }) }}
          </p>
          <dl v-if="Object.keys(event.metadata).length" class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <div v-for="(value, key) in event.metadata" :key="key" class="break-all">
              <dt class="inline text-muted-foreground">{{ key }}: </dt>
              <dd class="inline font-mono">{{ value === null ? 'null' : value }}</dd>
            </div>
          </dl>
        </article>
      </div>
      <div v-if="result" class="flex items-center justify-between border-t border-hairline p-3 text-xs text-muted-foreground">
        <span>{{ t('audit.page', { page: index + 1, count: result.items.length }) }}</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="index === 0 || loading" @click="previous">{{ t('common.previousPage') }}</Button>
          <Button variant="outline" size="sm" :disabled="result.nextCursor === null || loading" @click="next">{{ t('common.nextPage') }}</Button>
        </div>
      </div>
    </section>
  </div>
</template>
