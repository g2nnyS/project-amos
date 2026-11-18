<script setup lang="ts">
import { computed } from 'vue'
import type { RuleRecord } from '@/types'
import { t } from '@/i18n'

type OnHit = 'deny' | 'confirm' | 'log'
type Expressivity = 'deterministic' | 'advisory_only'

const props = defineProps<{ rules: RuleRecord[] }>()
const emit = defineEmits<{ filter: [{ dimension?: string; onHit?: OnHit; expressivity?: Expressivity }] }>()

const uniqueRules = computed(() => [...new Map(props.rules.map(rule => [rule.id, rule])).values()])
const dimensions = computed(() => [...new Set(uniqueRules.value.map(r => r.dimension))].sort())
const onHits: OnHit[] = ['deny', 'confirm', 'log']
const labels: Record<string, string> = { deny: 'deny', confirm: 'confirm', log: 'log' }

const counts = computed(() => {
  const map = new Map<string, { deterministic: number; advisory: number }>()
  for (const d of dimensions.value) {
    for (const h of onHits) {
      map.set(`${d}:${h}`, { deterministic: 0, advisory: 0 })
    }
  }
  for (const rule of uniqueRules.value) {
    const key = `${rule.dimension}:${rule.on_hit}`
    const cell = map.get(key)
    if (!cell) continue
    if (rule.expressivity === 'advisory_only') cell.advisory++
    else cell.deterministic++
  }
  return map
})

const dimensionTotals = computed(() => {
  const totals = new Map<string, number>()
  for (const d of dimensions.value) totals.set(d, uniqueRules.value.filter(r => r.dimension === d).length)
  return totals
})

const onHitTotals = computed(() => {
  const totals = new Map<string, number>()
  for (const h of onHits) totals.set(h, uniqueRules.value.filter(r => r.on_hit === h).length)
  return totals
})

function cell(d: string, h: OnHit) {
  return counts.value.get(`${d}:${h}`) ?? { deterministic: 0, advisory: 0 }
}
function apply(d: string, h: OnHit) {
  emit('filter', { dimension: d, onHit: h })
}
function applyDimension(d: string) {
  emit('filter', { dimension: d })
}
function applyOnHit(h: OnHit) {
  emit('filter', { onHit: h })
}
</script>

<template>
  <section class="panel overflow-hidden">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">{{ t('ruleMatrix.title') }}</h2>
        <p class="panel-kicker">{{ t('ruleMatrix.kicker') }}</p>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[540px]">
        <thead>
          <tr>
            <th class="w-40">{{ t('ruleMatrix.header') }}</th>
            <th v-for="h in onHits" :key="h" class="num">
              <button type="button" class="font-[inherit] uppercase hover:text-foreground" @click="applyOnHit(h)">{{ labels[h] }}</button>
            </th>
            <th class="num">{{ t('ruleMatrix.total') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in dimensions" :key="d">
            <td><button type="button" class="text-left font-medium hover:underline" @click="applyDimension(d)">{{ d }}</button></td>
            <td v-for="h in onHits" :key="h" class="num">
              <button v-if="cell(d, h).deterministic + cell(d, h).advisory > 0" type="button" class="inline-flex flex-col items-end gap-0.5 rounded px-1.5 py-1 hover:bg-accent" @click="apply(d, h)">
                <span class="tabular">{{ cell(d, h).deterministic + cell(d, h).advisory }}</span>
                <span class="text-[10px] text-muted-foreground">{{ t('ruleMatrix.split', { deterministic: cell(d, h).deterministic, advisory: cell(d, h).advisory }) }}</span>
              </button>
              <span v-else class="text-muted-foreground">—</span>
            </td>
            <td class="num tabular text-muted-foreground">{{ dimensionTotals.get(d) }}</td>
          </tr>
          <tr class="border-t border-border bg-surface/40 font-medium">
            <td>{{ t('ruleMatrix.total') }}</td>
            <td v-for="h in onHits" :key="h" class="num tabular">{{ onHitTotals.get(h) }}</td>
            <td class="num tabular">{{ uniqueRules.length }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!rules.length" class="p-6 text-center text-xs text-muted-foreground">{{ t('ruleMatrix.empty') }}</p>
  </section>
</template>
