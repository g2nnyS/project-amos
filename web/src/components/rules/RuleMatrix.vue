<script setup lang="ts">
import { computed } from 'vue'
import type { RuleExpressivity, RuleOnHit, RuleRecord } from '@/types'
import { t } from '@/i18n'
import { effectLabel, ruleEffect, type RuleEffect } from './model'

const effects: RuleEffect[] = ['deny', 'confirm', 'log', 'advisory_only']

const props = defineProps<{ rules: RuleRecord[] }>()
const emit = defineEmits<{ filter: [{ dimension?: string; onHit?: RuleOnHit; expressivity?: RuleExpressivity }] }>()

function emptyCounts() {
  return { deny: 0, confirm: 0, log: 0, advisory_only: 0, total: 0 }
}

const matrix = computed(() => {
  const byId = new Map<string, RuleRecord>()
  for (const rule of props.rules) byId.set(rule.id, rule)
  const rows = new Map<string, ReturnType<typeof emptyCounts>>()
  const totals = emptyCounts()
  for (const rule of byId.values()) {
    let row = rows.get(rule.dimension)
    if (!row) {
      row = emptyCounts()
      rows.set(rule.dimension, row)
    }
    const effect = ruleEffect(rule)
    row[effect]++
    row.total++
    totals[effect]++
    totals.total++
  }
  return { rows: [...rows].sort(([a], [b]) => a.localeCompare(b)), totals }
})

function filterEffect(effect: RuleEffect, dimension?: string) {
  emit('filter', effect === 'advisory_only' ? { dimension, expressivity: effect } : { dimension, onHit: effect })
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
            <th v-for="effect in effects" :key="effect" class="num">
              <button type="button" class="font-[inherit] hover:text-foreground" @click="filterEffect(effect)">{{ effectLabel(effect) }}</button>
            </th>
            <th class="num">{{ t('ruleMatrix.total') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="([dimension, row]) in matrix.rows" :key="dimension">
            <td><button type="button" class="text-left font-medium hover:underline" @click="emit('filter', { dimension })">{{ dimension }}</button></td>
            <td v-for="effect in effects" :key="effect" class="num">
              <button v-if="row[effect]" type="button" class="tabular rounded px-1.5 py-1 hover:bg-accent" @click="filterEffect(effect, dimension)">
                {{ row[effect] }}
              </button>
              <span v-else class="text-muted-foreground">—</span>
            </td>
            <td class="num tabular text-muted-foreground">{{ row.total }}</td>
          </tr>
          <tr class="border-t border-border bg-surface/40 font-medium">
            <td>{{ t('ruleMatrix.total') }}</td>
            <td v-for="effect in effects" :key="effect" class="num tabular">{{ matrix.totals[effect] }}</td>
            <td class="num tabular">{{ matrix.totals.total }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!rules.length" class="p-6 text-center text-xs text-muted-foreground">{{ t('ruleMatrix.empty') }}</p>
  </section>
</template>
