<script setup lang="ts">
import { computed } from 'vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { Info, Plug, X } from 'lucide-vue-next'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { Integration } from '@/types'
import { formatLastSynced, integrationIcon } from './integrationMeta'

const props = defineProps<{
  open: boolean
  integration: Integration | null
  returnFocus?: HTMLElement | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  toggle: []
}>()

const connected = computed(() => props.integration?.connected ?? false)
const providerName = computed(() => props.integration?.name ?? 'Integration')
const providerDescription = computed(
  () => props.integration?.description ?? 'Local demo integration.',
)
const icon = computed(() =>
  props.integration ? integrationIcon(props.integration) : Plug,
)
const lastSyncedText = computed(() => {
  const current = props.integration
  if (!current || !current.connected) return '—'
  return current.lastSynced ? formatLastSynced(current.lastSynced, true) : 'Not synced yet'
})
const actionLabel = computed(() => (connected.value ? 'Disconnect demo' : 'Connect demo'))
const actionClass = computed(() =>
  connected.value
    ? 'inline-flex h-8 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-3 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/15'
    : 'inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90',
)

function handleCloseAutoFocus(event: Event) {
  if (!props.returnFocus) return
  event.preventDefault()
  props.returnFocus.focus()
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/65" />

      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl focus:outline-none"
        @close-auto-focus="handleCloseAutoFocus"
      >
        <div class="flex items-start gap-3 border-b border-hairline p-[18px]">
          <div
            class="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-muted/50 text-foreground"
          >
            <component :is="icon" class="size-4" aria-hidden="true" />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <DialogTitle class="text-[14px] font-semibold tracking-[-0.01em]">
                {{ providerName }}
              </DialogTitle>
              <StatusBadge :status="connected ? 'Connected' : 'Available'" />
            </div>
            <DialogDescription class="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {{ providerDescription }}
            </DialogDescription>
          </div>

          <DialogClose
            class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close integration settings"
          >
            <X class="size-3.5" aria-hidden="true" />
          </DialogClose>
        </div>

        <div class="space-y-4 p-[18px]">
          <div class="rounded-md border border-border bg-surface/60 px-3 py-2.5">
            <p class="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
              <Info class="size-3.5 text-info" aria-hidden="true" />
              Demo connection
            </p>
            <p class="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              No credentials are collected, stored, or sent to {{ providerName }}. Connecting
              only updates local demo state in this browser.
            </p>
          </div>

          <dl class="grid grid-cols-[104px_minmax(0,1fr)] gap-y-2.5 text-[12px]">
            <dt class="text-muted-foreground">Provider</dt>
            <dd class="truncate text-foreground">{{ providerName }}</dd>

            <dt class="text-muted-foreground">Status</dt>
            <dd class="text-foreground">{{ connected ? 'Connected (demo)' : 'Not connected' }}</dd>

            <dt class="text-muted-foreground">Demo timestamp</dt>
            <dd class="text-foreground tabular">{{ lastSyncedText }}</dd>

            <dt class="text-muted-foreground">Data scope</dt>
            <dd class="text-foreground">This workspace · this browser</dd>
          </dl>
        </div>

        <div
          class="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-[18px] py-3.5"
        >
          <p class="eyebrow">Local simulation</p>
          <div class="flex items-center gap-2">
            <DialogClose
              class="inline-flex h-8 items-center justify-center rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent"
            >
              Cancel
            </DialogClose>
            <button type="button" :class="actionClass" @click="emit('toggle')">
              {{ actionLabel }}
            </button>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
