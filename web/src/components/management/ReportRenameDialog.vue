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
import { focusById } from './utils'
import type { Report } from '@/types'

const props = defineProps<{
  open: boolean
  report: Report | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [name: string]
}>()

const form = reactive({ name: '' })
const errors = reactive<{ name?: string }>({})

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.name = props.report?.name ?? ''
    errors.name = undefined
    void nextTick(() => focusById('report-rename-name'))
  },
)

function handleSubmit() {
  errors.name = undefined
  const name = form.name.trim()

  if (!name) {
    errors.name = 'Enter a report name.'
  } else if (name.length > 80) {
    errors.name = 'Use 80 characters or fewer.'
  }

  if (errors.name) {
    void nextTick(() => focusById('report-rename-name'))
    return
  }

  emit('submit', name)
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Rename report</DialogTitle>
        <DialogDescription>
          Update the name shown across this workspace. The report contents and owner stay the same.
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" novalidate @submit.prevent="handleSubmit">
        <div class="space-y-1.5">
          <Label for="report-rename-name">Name</Label>
          <Input
            id="report-rename-name"
            v-model="form.name"
            type="text"
            autocomplete="off"
            maxlength="100"
            :aria-invalid="errors.name ? 'true' : undefined"
            :aria-describedby="errors.name ? 'report-rename-name-error' : undefined"
          />
          <p v-if="errors.name" id="report-rename-name-error" role="alert" class="text-xs text-destructive">
            {{ errors.name }}
          </p>
        </div>

        <DialogFooter class="gap-2 pt-1">
          <Button type="button" variant="outline" @click="isOpen = false">Cancel</Button>
          <Button type="submit" :disabled="!report">Save name</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
