<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Eye, RefreshCw } from 'lucide-vue-next'
import { api } from '@/lib/api'
import type { ObservationReport } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'

const report = ref<ObservationReport | null>(null)
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    report.value = await api.observations()
  } catch (e) {
    report.value = null
    error.value = e instanceof Error ? e.message : t('observations.loadError')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('observations.title')" :description="t('observations.description')">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="loading" @click="load"><RefreshCw class="mr-1 size-3.5" />{{ t('common.refresh') }}</Button>
      </template>
    </PageHeader>

    <div class="rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      {{ t('observations.notice') }}
    </div>

    <div v-if="loading" class="panel p-5 text-sm" role="status">{{ t('observations.loading') }}</div>
    <div v-else-if="error" role="alert" class="panel p-5 text-sm text-destructive">
      {{ error }} <button class="ml-2 underline" @click="load">{{ t('common.retry') }}</button>
    </div>
    <EmptyState v-else-if="report && !report.available" :title="t('observations.unavailableTitle')" :description="t('observations.unavailableDescription')" />

    <template v-else-if="report">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{{ t('observations.sourcesTitle') }}</h2>
            <p class="panel-kicker">{{ t('observations.sourcesKicker') }}</p>
          </div>
        </div>
        <ul class="divide-y divide-border">
          <li v-for="source in report.sources" :key="source.name" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs">
            <span class="font-medium">{{ source.name }}</span>
            <span class="text-muted-foreground">
              {{ t('observations.lines', { count: source.lines }) }}
              <span v-if="source.truncated">{{ t('observations.truncated') }}</span>
              <span v-if="source.error" class="text-destructive"> · {{ source.error }}</span>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="report.queue" class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{{ t('observations.queueTitle', { count: report.queue.records.length }) }}</h2>
            <p class="panel-kicker">{{ t('observations.queueKicker', { zero: report.queue.zeroLevel.length, deny: report.queue.nonZeroDeny.length, confirm: report.queue.confirm.total, gaps: report.queue.gaps.length }) }}</p>
          </div>
        </div>
        <p v-if="!report.queue.records.length" class="p-6 text-center text-xs text-muted-foreground">{{ t('observations.empty') }}</p>
        <div v-else class="overflow-x-auto">
          <table class="data-table min-w-[720px]">
            <thead>
              <tr>
                <th scope="col">{{ t('observations.columnSource') }}</th>
                <th scope="col">{{ t('observations.columnTime') }}</th>
                <th scope="col">{{ t('observations.columnAction') }}</th>
                <th scope="col">{{ t('observations.columnVerdict') }}</th>
                <th scope="col">{{ t('observations.columnRules') }}</th>
                <th scope="col">{{ t('observations.columnReasons') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in report.queue.records" :key="`${record.source}:${record.line}`">
                <td class="font-mono text-xs">{{ record.source }}:{{ record.line }}</td>
                <td>{{ record.ts ?? '—' }}</td>
                <td>
                  <span class="block">{{ record.action?.tool ?? '—' }} · {{ record.action?.operation ?? '—' }}</span>
                  <span class="block break-all text-muted-foreground">{{ record.action?.target ?? '' }}</span>
                </td>
                <td>{{ record.verdict ?? '—' }}</td>
                <td>{{ record.matchedRuleIds.join(', ') || '—' }}</td>
                <td>
                  <span v-for="reason in record.reasons" :key="reason" class="mr-1 inline-block rounded bg-muted px-1 py-0.5 text-[10px]">{{ reason }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
