<script setup lang="ts">
import { ref, watch } from 'vue'
import { Play } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { t } from '@/i18n'
import SimulationPresets from './SimulationPresets.vue'
import type { Candidate, PolicyDecision } from '@/types'
import type { SimulationAction } from '@/lib/simulatePresets'

const props = defineProps<{
  projectId: string
  candidate: Candidate
  workspace?: string | null
}>()

const tool = ref('')
const operation = ref('')
const target = ref('')
const loading = ref(false)
const error = ref('')
const result = ref<PolicyDecision | null>(null)
let generation = 0

function snapshot(candidate: Candidate): string {
  return JSON.stringify(candidate)
}

function invalidate() {
  generation++
  result.value = null
  error.value = ''
  loading.value = false
}

function applyPreset(action: SimulationAction) {
  tool.value = action.tool
  operation.value = action.operation
  target.value = action.target
}

watch([() => props.projectId, () => snapshot(props.candidate)], invalidate, { flush: 'sync' })

async function run() {
  const id = props.projectId
  const current = props.candidate
  const currentSnapshot = snapshot(current)
  const request = ++generation
  loading.value = true
  error.value = ''
  result.value = null
  try {
    const response = await api.simulate(id, {
      action: { tool: tool.value, operation: operation.value, target: target.value },
      candidate: current,
    })
    if (generation !== request) return
    if (snapshot(props.candidate) !== currentSnapshot) {
      error.value = t('editor.simulateChanged')
      return
    }
    result.value = response
  } catch (e) {
    if (generation === request) error.value = e instanceof Error ? e.message : t('editor.simulateFailed')
  } finally {
    if (generation === request) loading.value = false
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">{{ t('editor.simulateTitle') }}</h2>
        <p class="panel-kicker">{{ t('editor.simulateKicker') }}</p>
      </div>
    </div>
    <form class="space-y-4 p-4" @submit.prevent="run">
      <SimulationPresets :workspace="workspace" @apply-preset="applyPreset" />
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
      <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
      <Button type="submit" :disabled="loading"><Play class="mr-1 size-3.5" />{{ loading ? t('editor.simulateRunning') : t('editor.simulateRun') }}</Button>
    </form>

    <div class="border-t border-hairline p-4">
      <div v-if="result" class="space-y-3 text-sm">
        <div class="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
          <p class="font-medium">{{ t('editor.simulateDraftLabel') }}</p>
          <p class="mt-1">{{ t('editor.simulateDraftNote') }}</p>
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
      <p v-else class="text-center text-xs text-muted-foreground">{{ t('editor.simulatePlaceholder') }}</p>
    </div>
  </section>
</template>
