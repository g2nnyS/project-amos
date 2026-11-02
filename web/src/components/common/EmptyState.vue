<script setup lang="ts">
import { Inbox } from 'lucide-vue-next'

withDefaults(
  defineProps<{
    title: string;
    description?: string;
  }>(),
  { description: '' },
)
</script>

<template>
  <div
    class="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/80 bg-surface/30 px-6 py-12 text-center"
  >
    <div
      class="flex size-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground"
    >
      <Inbox class="size-4" aria-hidden="true" />
    </div>
    <div class="max-w-[38ch]">
      <p class="text-[13px] font-semibold text-foreground">{{ title }}</p>
      <p v-if="description" class="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.default" class="mt-1">
      <slot />
    </div>
  </div>
</template>
