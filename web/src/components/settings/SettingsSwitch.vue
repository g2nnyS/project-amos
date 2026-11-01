<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'

withDefaults(
  defineProps<{
    modelValue: boolean
    labelledby?: string
    describedby?: string
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <SwitchRoot
    :model-value="modelValue"
    :disabled="disabled"
    :aria-labelledby="labelledby"
    :aria-describedby="describedby"
    class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input bg-muted transition-colors duration-150 hover:border-muted-foreground/40 data-[state=checked]:border-primary/50 data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
    @update:model-value="emit('update:modelValue', $event === true)"
  >
    <SwitchThumb
      class="pointer-events-none block size-4 translate-x-px rounded-full bg-muted-foreground/70 transition-transform duration-150 data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-primary-foreground"
    />
  </SwitchRoot>
</template>
