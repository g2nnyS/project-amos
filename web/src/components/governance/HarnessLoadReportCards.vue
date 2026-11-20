<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import { formatDateTime } from '@/lib/format'
import { harnessDefinitions, reportModeLabel, reportView, toneClasses } from './harness-report'
import type { HarnessRuntimeStatus } from '@/types'

const props = defineProps<{ runtime: HarnessRuntimeStatus | null }>()

const reports = computed(() => harnessDefinitions.map(definition => {
  const observation = props.runtime?.harnesses?.[definition.id] ?? null
  return { ...definition, observation, view: reportView(observation) }
}))
</script>

<template>
  <div v-if="!runtime" class="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
    {{ t('harness.cards.unavailable') }}
  </div>
  <div v-else class="grid gap-3 md:grid-cols-2">
    <article v-for="report in reports" :key="report.id" class="rounded-md border border-border bg-surface p-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-xs font-semibold">{{ report.name }}</h3>
          <p class="mt-0.5 text-[10px] text-muted-foreground">{{ t('harness.cards.latest') }}</p>
        </div>
        <span class="inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10px] font-medium" :class="toneClasses[report.view.tone]">{{ report.view.label }}</span>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-muted-foreground">{{ report.view.description }}</p>
      <template v-if="report.observation?.runtime">
        <p class="mt-3 text-xs"><span class="text-muted-foreground">{{ t('harness.cards.reportedMode') }}</span><strong class="font-medium">{{ reportModeLabel(report.observation.runtime) }}</strong></p>
        <dl class="mt-2 grid gap-1 text-[10px] text-muted-foreground">
          <div class="flex justify-between gap-3"><dt>{{ t('harness.cards.loadedAt') }}</dt><dd class="tabular">{{ formatDateTime(report.observation.runtime.loadedAt) }}</dd></div>
          <div class="flex justify-between gap-3"><dt>{{ t('harness.cards.policyVersion') }}</dt><dd class="truncate font-mono" :title="report.observation.runtime.policyVersion">{{ report.observation.runtime.policyVersion }}</dd></div>
          <div v-if="report.observation.runtime.configDigest" class="flex items-start justify-between gap-3"><dt class="shrink-0">{{ t('harness.cards.configDigest') }}</dt><dd class="break-all text-right font-mono" :title="report.observation.runtime.configDigest">{{ report.observation.runtime.configDigest }}</dd></div>
        </dl>
      </template>
    </article>
  </div>
</template>
