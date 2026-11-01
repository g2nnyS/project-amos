<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { Integration } from '@/types'
import { integrationIcon, syncLabel as integrationSyncLabel } from './integrationMeta'

const props = defineProps<{ integration: Integration }>()

const emit = defineEmits<{ configure: [event: MouseEvent] }>()

const icon = computed(() => integrationIcon(props.integration))
const meta = computed(() => integrationSyncLabel(props.integration))
</script>

<template>
  <li class="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-accent/30 sm:grid-cols-[auto_minmax(0,1fr)_96px_150px_auto]">
    <div
      class="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground"
    >
      <component :is="icon" class="size-4" aria-hidden="true" />
    </div>

    <div class="min-w-0">
      <div class="flex min-w-0 items-center gap-2">
        <p class="truncate text-[13px] font-medium text-foreground">{{ integration.name }}</p>
        <span class="sm:hidden">
          <StatusBadge :status="integration.connected ? 'Connected' : 'Available'" />
        </span>
      </div>
      <p class="mt-0.5 truncate text-[12px] text-muted-foreground">
        {{ integration.description }}
      </p>
      <p class="mt-1 text-[10.5px] text-muted-foreground/75 tabular sm:hidden">{{ meta }}</p>
    </div>

    <div class="hidden sm:block">
      <StatusBadge :status="integration.connected ? 'Connected' : 'Available'" />
    </div>

    <p class="hidden truncate text-[11px] text-muted-foreground/80 tabular sm:block">{{ meta }}</p>

    <button
      type="button"
      class="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-accent"
      :aria-label="`Configure ${integration.name}`"
      @click="emit('configure', $event)"
    >
      Configure
      <ChevronRight class="size-3.5 text-muted-foreground" aria-hidden="true" />
    </button>
  </li>
</template>
