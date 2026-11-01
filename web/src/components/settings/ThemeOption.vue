<script setup lang="ts">
import { computed } from 'vue'
import { RadioGroupItem } from 'reka-ui'
import { Check } from 'lucide-vue-next'
import type { ThemePreference } from '@/types'

const props = defineProps<{
  value: ThemePreference
  label: string
  description: string
}>()

interface PreviewTokens {
  frame: string
  sidebar: string
  card: string
  line: string
  accent: string
}

const preview = computed<PreviewTokens>(() => {
  if (props.value === 'light') {
    return {
      frame: 'border-[#ddd8ce] bg-[#f6f3ec]',
      sidebar: 'border-[#e2ddd3] bg-[#ece8df]',
      card: 'border-[#e0dbd1] bg-white',
      line: 'bg-[#d2cdc3]',
      accent: 'bg-[#3f5a16]',
    }
  }

  if (props.value === 'system') {
    return {
      frame: 'border-border',
      sidebar: 'border-white/10 bg-black/35',
      card: 'border-white/15 bg-white/10',
      line: 'bg-white/25',
      accent: 'bg-[#b8ef5a]',
    }
  }

  return {
    frame: 'border-[#2a2a2a] bg-[#0a0a0a]',
    sidebar: 'border-[#262626] bg-[#161616]',
    card: 'border-[#2a2a2a] bg-[#111111]',
    line: 'bg-[#3d3d3d]',
    accent: 'bg-[#b8ef5a]',
  }
})

const frameStyle = computed(() =>
  props.value === 'system'
    ? 'background: linear-gradient(115deg, #0a0a0a 49.5%, #f3f0e9 50.5%)'
    : undefined,
)
</script>

<template>
  <RadioGroupItem
    :value="value"
    class="group min-w-0 rounded-md border border-border bg-card p-2 text-left transition-colors duration-150 hover:border-foreground/25 data-[state=checked]:border-primary/50 data-[state=checked]:bg-accent/30"
  >
    <div
      class="relative h-[62px] overflow-hidden rounded-[5px] border"
      :class="preview.frame"
      :style="frameStyle"
    >
      <div
        class="absolute inset-y-1.5 left-1.5 w-[18px] rounded-[2px] border"
        :class="preview.sidebar"
        aria-hidden="true"
      />
      <div class="absolute inset-y-1.5 left-[28px] right-1.5 flex flex-col gap-1" aria-hidden="true">
        <div class="h-1 w-8 rounded-full" :class="preview.line" />
        <div class="flex-1 rounded-[2px] border p-1.5" :class="preview.card">
          <div class="h-1 w-6 rounded-full" :class="preview.accent" />
          <div class="mt-1.5 h-1 w-10 rounded-full opacity-50" :class="preview.line" />
          <div class="mt-1 h-1 w-7 rounded-full opacity-30" :class="preview.line" />
        </div>
      </div>
    </div>

    <div class="mt-2.5 flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="text-[12.5px] font-medium text-foreground">{{ label }}</p>
        <p class="mt-0.5 text-[11px] leading-snug text-muted-foreground">{{ description }}</p>
      </div>
      <span
        class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary opacity-0 transition-opacity duration-150 group-data-[state=checked]:opacity-100"
        aria-hidden="true"
      >
        <Check class="size-2.5" :stroke-width="3" />
      </span>
    </div>
  </RadioGroupItem>
</template>
