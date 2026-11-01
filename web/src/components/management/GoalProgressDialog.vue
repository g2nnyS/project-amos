<script setup lang="ts">
import { computed, nextTick, reactive, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  focusById,
  formatMetricValue,
  formatPercent,
  goalProgress,
  parseNumberInput,
} from './utils'
import type { Goal } from '@/types'

const props = defineProps<{
  open: boolean
  goal: Goal | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [value: number]
}>()

const form = reactive({ current: '' })
const errors = reactive<{ current?: string }>({})

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

const requiresWholeNumbers = computed(() => props.goal?.metric === 'Users' || props.goal?.metric === 'Events')

const preview = computed(() => {
  const goal = props.goal
  const current = parseNumberInput(form.current)
  if (!goal || current === null || current < 0) return null
  const progress = goalProgress(current, goal.target)
  return {
    label: formatPercent(progress.percent),
    barPercent: progress.barPercent,
    overTarget: progress.overTarget,
    detail: `${formatMetricValue(current, goal.metric)} of ${formatMetricValue(goal.target, goal.metric)}`,
    remaining: Math.max(goal.target - current, 0),
  }
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.current = props.goal ? String(props.goal.current) : '0'
    errors.current = undefined
    void nextTick(() => focusById('goal-progress-current'))
  },
)

function setToTarget() {
  if (!props.goal) return
  form.current = String(props.goal.target)
  errors.current = undefined
}

function handleSubmit() {
  errors.current = undefined
  const current = parseNumberInput(form.current)

  if (current === null) {
    errors.current = 'Enter a number for current progress.'
  } else if (current < 0) {
    errors.current = 'Progress cannot be negative.'
  } else if (current > 1_000_000_000) {
    errors.current = 'Progress must be 1 billion or less.'
  } else if (requiresWholeNumbers.value && !Number.isInteger(current)) {
    errors.current = 'Use a whole number for this metric.'
  }

  if (errors.current || current === null) {
    void nextTick(() => focusById('goal-progress-current'))
    return
  }

  emit('submit', current)
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Update progress</DialogTitle>
        <DialogDescription>
          {{ goal ? `Record the latest value for “${goal.name}”.` : 'Choose a goal to update.' }}
        </DialogDescription>
      </DialogHeader>

      <form v-if="goal" class="space-y-4" novalidate @submit.prevent="handleSubmit">
        <dl class="grid grid-cols-2 gap-3 text-sm">
          <div class="space-y-0.5">
            <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Target</dt>
            <dd class="tabular-nums text-foreground">{{ formatMetricValue(goal.target, goal.metric) }}</dd>
          </div>
          <div class="space-y-0.5">
            <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Saved progress</dt>
            <dd class="tabular-nums text-foreground">{{ formatMetricValue(goal.current, goal.metric) }}</dd>
          </div>
        </dl>

        <div class="space-y-1.5">
          <Label for="goal-progress-current">New current value</Label>
          <div class="flex gap-2">
            <Input
              id="goal-progress-current"
              v-model="form.current"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              class="flex-1"
              :aria-invalid="errors.current ? 'true' : undefined"
              :aria-describedby="errors.current ? 'goal-progress-current-error' : 'goal-progress-current-hint'"
            />
            <Button type="button" variant="outline" @click="setToTarget">Set to target</Button>
          </div>
          <p v-if="errors.current" id="goal-progress-current-error" role="alert" class="text-xs text-destructive">
            {{ errors.current }}
          </p>
          <p v-else id="goal-progress-current-hint" class="text-xs text-muted-foreground">
            Enter a value of 0 or more. Values above the target are kept and marked as over target.
          </p>
        </div>

        <div v-if="preview" class="rounded-md border border-border px-3 py-2" aria-hidden="true">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span class="text-muted-foreground">After saving</span>
            <span class="font-medium tabular-nums text-foreground">
              {{ preview.label }}<span v-if="preview.overTarget" class="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">over target</span>
            </span>
          </div>
          <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full bg-foreground" :style="{ width: `${preview.barPercent}%` }" />
          </div>
          <p class="mt-1 text-[11px] tabular-nums text-muted-foreground">
            {{ preview.detail }}<span v-if="!preview.overTarget"> · {{ formatMetricValue(preview.remaining, goal.metric) }} remaining</span>
          </p>
        </div>

        <DialogFooter class="gap-2 pt-1">
          <Button type="button" variant="outline" @click="isOpen = false">Cancel</Button>
          <Button type="submit">Save progress</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
