<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next'

defineProps<{
  id?: string
  modelValue: string
  disabled?: boolean
  invalid?: boolean
  srLabel?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function onChange(event: Event) {
  const target = event.target as HTMLSelectElement | null
  emit('update:modelValue', target?.value ?? '')
}
</script>

<template>
  <div class="relative w-full">
    <select
      :id="id"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="srLabel"
      :aria-invalid="invalid ? 'true' : undefined"
      class="h-9 w-full appearance-none rounded-md border border-input bg-transparent px-2.5 pr-8 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      @change="onChange"
    >
      <slot />
    </select>
    <ChevronDown
      class="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
      aria-hidden="true"
    />
  </div>
</template>
