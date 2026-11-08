<script setup lang="ts">
import { computed } from 'vue'
import type { HarnessId, HarnessRuntimeObservation, HarnessRuntimeReport, HarnessRuntimeStatus } from '@/types'

const props = defineProps<{ runtime: HarnessRuntimeStatus | null }>()

type Tone = 'positive' | 'info' | 'warning' | 'danger' | 'neutral'
const definitions: ReadonlyArray<{ id: HarnessId; name: string }> = [
  { id: 'pi', name: 'Pi' },
  { id: 'opencode', name: 'OpenCode' },
]
const toneClasses: Record<Tone, string> = {
  positive: 'border-positive/30 bg-positive/5 text-positive',
  info: 'border-info/30 bg-info/5 text-info',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  danger: 'border-destructive/30 bg-destructive/5 text-destructive',
  neutral: 'border-border bg-muted/60 text-muted-foreground',
}

function modeLabel(report: HarnessRuntimeReport): string {
  if (report.mode === 'enforcing') return 'enforcing · 受管'
  if (report.mode === 'log-only') return 'log-only · 仅观察'
  return 'disabled · 停用'
}

function reportView(observation: HarnessRuntimeObservation | null): { label: string; tone: Tone; description: string } {
  if (!observation) return { label: '状态不可用', tone: 'neutral', description: '没有可读取的 Harness 状态。' }
  const report = observation.runtime
  if (observation.status === 'loaded' && report) {
    if (report.mode === 'enforcing') return { label: '约束已加载', tone: 'positive', description: '最近报告为受管模式，且与当前配置匹配。' }
    if (report.mode === 'log-only') return { label: 'Log-only 已加载', tone: 'info', description: '最近报告为仅观察模式，且与当前配置匹配；不表示约束已加载。' }
    return { label: 'Disabled 已加载', tone: 'neutral', description: '最近报告为停用模式，且与当前配置匹配。' }
  }
  if (observation.status === 'stale') return { label: '旧配置报告', tone: 'warning', description: '最近报告与当前配置不匹配；后续重新加载后再核验。' }
  if (observation.status === 'never') return { label: '尚无加载报告', tone: 'neutral', description: '此 Harness 尚未留下加载报告。保存或发布不等于已加载。' }
  if (observation.status === 'invalid') return { label: '加载报告无效', tone: 'danger', description: '最近报告无法校验，不能据此判断运行状态。' }
  if (observation.status === 'unpublished') return { label: '尚无已发布版本', tone: 'neutral', description: '没有可用于比对的已发布配置；已有报告仅供排查。' }
  return { label: '报告详情缺失', tone: 'warning', description: '状态存在，但没有可展示的加载报告详情。' }
}

const reports = computed(() => definitions.map(definition => {
  const observation = props.runtime?.harnesses?.[definition.id] ?? null
  return { ...definition, observation, view: reportView(observation) }
}))

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN')
}
</script>

<template>
  <div v-if="!runtime" class="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
    最新加载报告不可用，无法确认 Pi 或 OpenCode 的实际回报。
  </div>
  <div v-else class="grid gap-3 md:grid-cols-2">
    <article v-for="report in reports" :key="report.id" class="rounded-md border border-border bg-surface p-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-xs font-semibold">{{ report.name }}</h3>
          <p class="mt-0.5 text-[10px] text-muted-foreground">最新一份加载报告</p>
        </div>
        <span class="inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10px] font-medium" :class="toneClasses[report.view.tone]">{{ report.view.label }}</span>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-muted-foreground">{{ report.view.description }}</p>
      <template v-if="report.observation?.runtime">
        <p class="mt-3 text-xs"><span class="text-muted-foreground">实际回报模式：</span><strong class="font-medium">{{ modeLabel(report.observation.runtime) }}</strong></p>
        <dl class="mt-2 grid gap-1 text-[10px] text-muted-foreground">
          <div class="flex justify-between gap-3"><dt>加载时间</dt><dd class="tabular">{{ formatTime(report.observation.runtime.loadedAt) }}</dd></div>
          <div class="flex justify-between gap-3"><dt>策略标识</dt><dd class="truncate font-mono" :title="report.observation.runtime.policyVersion">{{ report.observation.runtime.policyVersion }}</dd></div>
          <div v-if="report.observation.runtime.configDigest" class="flex items-start justify-between gap-3"><dt class="shrink-0">配置摘要</dt><dd class="break-all text-right font-mono" :title="report.observation.runtime.configDigest">{{ report.observation.runtime.configDigest }}</dd></div>
        </dl>
      </template>
    </article>
  </div>
</template>
