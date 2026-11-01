<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  { description: '' },
)
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <div class="min-w-0">
        <h2 class="panel-title">{{ title }}</h2>
        <p v-if="description" class="panel-kicker">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="panel-actions">
        <slot name="actions" />
      </div>
    </header>

    <div class="panel-body">
      <slot />
    </div>

    <footer
      v-if="$slots.footer"
      class="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-[18px] py-3.5"
    >
      <slot name="footer" />
    </footer>
  </section>
</template>
