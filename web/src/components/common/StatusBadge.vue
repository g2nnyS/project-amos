<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status: string }>()
const labels: Record<string, string> = { pending: '待审批', approved: '已批准', rejected: '已拒绝', withdrawn: '已撤回', expired: '已过期' }

type Tone = 'positive' | 'warning' | 'danger' | 'info' | 'neutral'

const tone = computed<Tone>(() => {
  const value = props.status.trim().toLowerCase()
  if (['completed', 'complete', 'success', 'connected', 'live'].includes(value)) {
    return 'positive'
  }
  if (['pending', 'invited', 'warning', 'paused', 'scheduled'].includes(value)) {
    return 'warning'
  }
  if (['failed', 'error', 'disconnected', 'blocked', 'offline'].includes(value)) {
    return 'danger'
  }
  if (['draft', 'info', 'beta', 'new'].includes(value)) {
    return 'info'
  }
  return 'neutral'
})

const toneClass = computed(
  () =>
    ({
      positive: 'border-positive/25 bg-positive/[0.08] text-positive',
      warning: 'border-warning/25 bg-warning/[0.08] text-warning',
      danger: 'border-destructive/25 bg-destructive/[0.08] text-destructive',
      info: 'border-info/25 bg-info/[0.08] text-info',
      neutral: 'border-border bg-muted/60 text-muted-foreground',
    })[tone.value],
)

const dotClass = computed(
  () =>
    ({
      positive: 'bg-positive',
      warning: 'bg-warning',
      danger: 'bg-destructive',
      info: 'bg-info',
      neutral: 'bg-muted-foreground',
    })[tone.value],
)
</script>

<template>
  <span
    class="inline-flex h-[21px] items-center gap-1.5 rounded-[4px] border px-1.5 text-[10.5px] font-semibold tracking-[0.02em] whitespace-nowrap"
    :class="toneClass"
  >
    <span class="size-1 rounded-full" :class="dotClass" aria-hidden="true" />
    {{ labels[status] ?? status }}
  </span>
</template>
