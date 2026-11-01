<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description?: string;
  }>(),
  { description: '' },
)
</script>

<template>
  <header class="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h1
        class="text-[22px] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[24px]"
      >
        {{ title }}
      </h1>
      <p v-if="description" class="mt-1.5 max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
