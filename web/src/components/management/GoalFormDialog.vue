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
import NativeSelect from './NativeSelect.vue'
import {
  focusById,
  formatMetricValue,
  formatPercent,
  GOAL_METRICS,
  goalProgress,
  isGoalMetric,
  parseDateValue,
  parseNumberInput,
  toDateInputValue,
  type GoalFormValues,
} from './utils'
import type { Goal } from '@/types'

const props = defineProps<{
  open: boolean
  goal: Goal | null
  defaultOwner: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [values: GoalFormValues]
}>()

type FieldKey = 'name' | 'owner' | 'metric' | 'deadline' | 'target' | 'current'

const form = reactive({
  name: '',
  owner: '',
  metric: 'Revenue',
  deadline: '',
  target: '',
  current: '0',
})

const errors = reactive<Record<FieldKey, string | undefined>>({
  name: undefined,
  owner: undefined,
  metric: undefined,
  deadline: undefined,
  target: undefined,
  current: undefined,
})

const fieldIds: Record<FieldKey, string> = {
  name: 'goal-form-name',
  owner: 'goal-form-owner',
  metric: 'goal-form-metric',
  deadline: 'goal-form-deadline',
  target: 'goal-form-target',
  current: 'goal-form-current',
}

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

const isEditing = computed(() => Boolean(props.goal))
const metric = computed<Goal['metric']>(() => (isGoalMetric(form.metric) ? form.metric : 'Revenue'))
const requiresWholeNumbers = computed(() => metric.value === 'Users' || metric.value === 'Events')
const unitLabel = computed(() => {
  if (metric.value === 'Revenue') return 'USD amount'
  if (metric.value === 'Conversion') return 'percentage points'
  return 'people or events'
})

const preview = computed(() => {
  const target = parseNumberInput(form.target)
  const current = parseNumberInput(form.current)
  if (target === null || current === null || target <= 0 || current < 0) return null
  const progress = goalProgress(current, target)
  return {
    label: formatPercent(progress.percent),
    barPercent: progress.barPercent,
    overTarget: progress.overTarget,
    detail: `${formatMetricValue(current, metric.value)} of ${formatMetricValue(target, metric.value)}`,
  }
})

function defaultDeadline(): string {
  const date = new Date()
  date.setDate(date.getDate() + 30)
  return toDateInputValue(date.toISOString())
}

function clearErrors() {
  for (const key of Object.keys(errors) as FieldKey[]) {
    errors[key] = undefined
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const goal = props.goal
    form.name = goal?.name ?? ''
    form.owner = goal?.owner ?? props.defaultOwner
    form.metric = goal?.metric ?? 'Revenue'
    form.deadline = goal ? toDateInputValue(goal.deadline) : defaultDeadline()
    form.target = goal ? String(goal.target) : ''
    form.current = goal ? String(goal.current) : '0'
    clearErrors()
    void nextTick(() => focusById(fieldIds.name))
  },
)

function validate(): boolean {
  clearErrors()

  const name = form.name.trim()
  if (!name) {
    errors.name = 'Enter a goal name.'
  } else if (name.length > 80) {
    errors.name = 'Use 80 characters or fewer.'
  }

  const owner = form.owner.trim()
  if (!owner) {
    errors.owner = 'Enter an owner for this goal.'
  } else if (owner.length > 60) {
    errors.owner = 'Use 60 characters or fewer.'
  }

  if (!isGoalMetric(form.metric)) {
    errors.metric = 'Choose a metric.'
  }

  if (!parseDateValue(form.deadline)) {
    errors.deadline = 'Choose a valid deadline date.'
  }

  const target = parseNumberInput(form.target)
  if (target === null) {
    errors.target = 'Enter a number for the target.'
  } else if (target <= 0) {
    errors.target = 'Target must be greater than 0.'
  } else if (target > 1_000_000_000) {
    errors.target = 'Target must be 1 billion or less.'
  } else if (requiresWholeNumbers.value && !Number.isInteger(target)) {
    errors.target = 'Use a whole number for this metric.'
  }

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

  const firstInvalid = (Object.keys(errors) as FieldKey[]).find((key) => errors[key])
  if (firstInvalid) {
    void nextTick(() => focusById(fieldIds[firstInvalid]))
    return false
  }

  return true
}

function handleSubmit() {
  if (!validate()) return
  const target = parseNumberInput(form.target)
  const current = parseNumberInput(form.current)
  const metricValue = form.metric
  if (target === null || current === null || !isGoalMetric(metricValue)) return

  emit('submit', {
    name: form.name.trim(),
    owner: form.owner.trim(),
    deadline: form.deadline,
    current,
    target,
    metric: metricValue,
  })
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ isEditing ? 'Edit goal' : 'New goal' }}</DialogTitle>
        <DialogDescription>
          {{ isEditing ? 'Update the target, deadline, or owner. Progress changes have their own action.' : 'Define a measurable target for this workspace. New goals start as active.' }}
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" novalidate @submit.prevent="handleSubmit">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <Label :for="fieldIds.name">Goal name</Label>
            <Input
              :id="fieldIds.name"
              v-model="form.name"
              type="text"
              autocomplete="off"
              maxlength="100"
              placeholder="e.g. Grow qualified signups"
              :aria-invalid="errors.name ? 'true' : undefined"
              :aria-describedby="errors.name ? 'goal-form-name-error' : undefined"
            />
            <p v-if="errors.name" id="goal-form-name-error" role="alert" class="text-xs text-destructive">
              {{ errors.name }}
            </p>
          </div>

          <div class="space-y-1.5">
            <Label :for="fieldIds.metric">Metric</Label>
            <NativeSelect :id="fieldIds.metric" v-model="form.metric" :invalid="Boolean(errors.metric)">
              <option v-for="option in GOAL_METRICS" :key="option" :value="option">{{ option }}</option>
            </NativeSelect>
            <p v-if="errors.metric" id="goal-form-metric-error" role="alert" class="text-xs text-destructive">
              {{ errors.metric }}
            </p>
            <p v-else class="text-xs text-muted-foreground">Stored as {{ unitLabel }}.</p>
          </div>

          <div class="space-y-1.5">
            <Label :for="fieldIds.deadline">Deadline</Label>
            <Input
              :id="fieldIds.deadline"
              v-model="form.deadline"
              type="date"
              :aria-invalid="errors.deadline ? 'true' : undefined"
              :aria-describedby="errors.deadline ? 'goal-form-deadline-error' : undefined"
            />
            <p v-if="errors.deadline" id="goal-form-deadline-error" role="alert" class="text-xs text-destructive">
              {{ errors.deadline }}
            </p>
          </div>

          <div class="space-y-1.5 sm:col-span-2">
            <Label :for="fieldIds.owner">Owner</Label>
            <Input
              :id="fieldIds.owner"
              v-model="form.owner"
              type="text"
              autocomplete="off"
              maxlength="60"
              placeholder="Who is accountable for this goal?"
              :aria-invalid="errors.owner ? 'true' : undefined"
              :aria-describedby="errors.owner ? 'goal-form-owner-error' : undefined"
            />
            <p v-if="errors.owner" id="goal-form-owner-error" role="alert" class="text-xs text-destructive">
              {{ errors.owner }}
            </p>
          </div>

          <div class="space-y-1.5">
            <Label :for="fieldIds.target">Target</Label>
            <Input
              :id="fieldIds.target"
              v-model="form.target"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="0"
              :aria-invalid="errors.target ? 'true' : undefined"
              :aria-describedby="errors.target ? 'goal-form-target-error' : 'goal-form-values-hint'"
            />
            <p v-if="errors.target" id="goal-form-target-error" role="alert" class="text-xs text-destructive">
              {{ errors.target }}
            </p>
          </div>

          <div class="space-y-1.5">
            <Label :for="fieldIds.current">Current progress</Label>
            <Input
              :id="fieldIds.current"
              v-model="form.current"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="0"
              :aria-invalid="errors.current ? 'true' : undefined"
              :aria-describedby="errors.current ? 'goal-form-current-error' : 'goal-form-values-hint'"
            />
            <p v-if="errors.current" id="goal-form-current-error" role="alert" class="text-xs text-destructive">
              {{ errors.current }}
            </p>
          </div>
        </div>

        <p id="goal-form-values-hint" class="text-xs text-muted-foreground">
          Values use plain numbers for the selected metric. Progress above the target is allowed and shown as over target.
        </p>

        <div v-if="preview" class="rounded-md border border-border px-3 py-2" aria-hidden="true">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span class="text-muted-foreground">Preview</span>
            <span class="font-medium tabular-nums text-foreground">
              {{ preview.label }}<span v-if="preview.overTarget" class="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">over target</span>
            </span>
          </div>
          <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full bg-foreground" :style="{ width: `${preview.barPercent}%` }" />
          </div>
          <p class="mt-1 text-[11px] tabular-nums text-muted-foreground">{{ preview.detail }}</p>
        </div>

        <DialogFooter class="gap-2 pt-1">
          <Button type="button" variant="outline" @click="isOpen = false">Cancel</Button>
          <Button type="submit">{{ isEditing ? 'Save goal' : 'Create goal' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
