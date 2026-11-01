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
import { Textarea } from '@/components/ui/textarea'
import NativeSelect from './NativeSelect.vue'
import { focusById, isReportType, REPORT_TYPES, type ReportCreateValues } from './utils'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [values: ReportCreateValues]
}>()

const form = reactive({
  name: '',
  type: 'Revenue',
  description: '',
})

const errors = reactive<{ name?: string; type?: string; description?: string }>({})

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

function clearErrors() {
  errors.name = undefined
  errors.type = undefined
  errors.description = undefined
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.name = ''
    form.type = 'Revenue'
    form.description = ''
    clearErrors()
    void nextTick(() => focusById('report-create-name'))
  },
)

function handleSubmit() {
  clearErrors()

  const name = form.name.trim()
  if (!name) {
    errors.name = 'Enter a report name.'
  } else if (name.length > 80) {
    errors.name = 'Use 80 characters or fewer.'
  }

  const type = form.type
  if (!isReportType(type)) {
    errors.type = 'Choose a report type.'
  }

  const description = form.description.trim()
  if (description.length > 240) {
    errors.description = 'Use 240 characters or fewer.'
  }

  if (errors.name || errors.type || errors.description) {
    const firstInvalid = errors.name ? 'report-create-name' : errors.type ? 'report-create-type' : 'report-create-description'
    void nextTick(() => focusById(firstInvalid))
    return
  }

  if (!isReportType(type)) return

  emit('submit', { name, type, description })
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>New report</DialogTitle>
        <DialogDescription>
          Save a report definition for this workspace. It is stored locally and can be searched from the command palette.
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" novalidate @submit.prevent="handleSubmit">
        <div class="space-y-1.5">
          <Label for="report-create-name">Name</Label>
          <Input
            id="report-create-name"
            v-model="form.name"
            type="text"
            autocomplete="off"
            maxlength="100"
            placeholder="e.g. Revenue by channel"
            :aria-invalid="errors.name ? 'true' : undefined"
            :aria-describedby="errors.name ? 'report-create-name-error' : 'report-create-name-hint'"
          />
          <p v-if="errors.name" id="report-create-name-error" role="alert" class="text-xs text-destructive">
            {{ errors.name }}
          </p>
          <p v-else id="report-create-name-hint" class="text-xs text-muted-foreground">
            Keep it short so it scans well in the report list.
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="report-create-type">Type</Label>
          <NativeSelect
            id="report-create-type"
            v-model="form.type"
            :invalid="Boolean(errors.type)"
          >
            <option v-for="type in REPORT_TYPES" :key="type" :value="type">{{ type }}</option>
          </NativeSelect>
          <p v-if="errors.type" id="report-create-type-error" role="alert" class="text-xs text-destructive">
            {{ errors.type }}
          </p>
        </div>

        <div class="space-y-1.5">
          <div class="flex items-baseline justify-between gap-2">
            <Label for="report-create-description">Description</Label>
            <span class="text-[11px] tabular-nums text-muted-foreground">{{ form.description.length }}/240</span>
          </div>
          <Textarea
            id="report-create-description"
            v-model="form.description"
            rows="3"
            placeholder="What does this report answer?"
            :aria-invalid="errors.description ? 'true' : undefined"
            :aria-describedby="errors.description ? 'report-create-description-error' : undefined"
          />
          <p v-if="errors.description" id="report-create-description-error" role="alert" class="text-xs text-destructive">
            {{ errors.description }}
          </p>
        </div>

        <DialogFooter class="gap-2 pt-1">
          <Button type="button" variant="outline" @click="isOpen = false">Cancel</Button>
          <Button type="submit">Create report</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
