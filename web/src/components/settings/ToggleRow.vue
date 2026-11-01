<script setup lang="ts">
import { useId } from 'vue'
import SettingsSwitch from './SettingsSwitch.vue'

withDefaults(
  defineProps<{
    title: string
    description?: string
    modelValue: boolean
    disabled?: boolean
  }>(),
  {
    description: '',
    disabled: false,
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const uid = useId()
const titleId = `${uid}-title`
const descriptionId = `${uid}-description`
</script>

<template>
  <div class="flex items-start justify-between gap-6 py-4">
    <div class="min-w-0">
      <p :id="titleId" class="text-[12.5px] font-medium text-foreground">{{ title }}</p>
      <p
        v-if="description"
        :id="descriptionId"
        class="mt-1 max-w-[58ch] text-[11.5px] leading-relaxed text-muted-foreground"
      >
        {{ description }}
      </p>
    </div>

    <SettingsSwitch
      :model-value="modelValue"
      :labelledby="titleId"
      :describedby="description ? descriptionId : undefined"
      :disabled="disabled"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>
