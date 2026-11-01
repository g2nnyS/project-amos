<script setup lang="ts">
import { computed } from 'vue'
import { Download } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/composables/useToast'
import { downloadCsv } from '@/lib/export'
import { formatDate } from '@/lib/format'
import type { Report } from '@/types'
import { csvTimestamp, errorMessage, initialsOf, reportCsvRows, slugify } from './utils'

const props = defineProps<{
  open: boolean
  report: Report | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const { toast } = useToast()

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

const lastUpdated = computed(() => {
  if (!props.report) return '\u2014'
  const formatted = formatDate(props.report.updatedAt)
  return formatted || '\u2014'
})

function exportReport() {
  const report = props.report
  if (!report) return
  try {
    downloadCsv(`neuralyn-report-${slugify(report.name)}-${csvTimestamp()}.csv`, reportCsvRows([report]))
    toast('CSV exported', `“${report.name}” was downloaded as a single-row CSV.`, 'success')
  } catch (error) {
    toast('Export failed', errorMessage(error, 'The CSV could not be created.'), 'error')
  }
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="pr-6">{{ report?.name ?? 'Report' }}</DialogTitle>
        <DialogDescription>Report summary for this workspace.</DialogDescription>
      </DialogHeader>

      <div v-if="report" class="space-y-4">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div class="space-y-1">
            <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Type</dt>
            <dd><Badge variant="outline" class="font-normal">{{ report.type }}</Badge></dd>
          </div>
          <div class="space-y-1">
            <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Owner</dt>
            <dd class="flex items-center gap-1.5 text-foreground">
              <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium uppercase text-muted-foreground" aria-hidden="true">
                {{ initialsOf(report.owner) }}
              </span>
              <span class="truncate">{{ report.owner }}</span>
            </dd>
          </div>
          <div class="space-y-1">
            <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Updated</dt>
            <dd class="text-foreground">{{ lastUpdated }}</dd>
          </div>
          <div class="space-y-1">
            <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Report ID</dt>
            <dd class="truncate font-mono text-xs text-muted-foreground">{{ report.id }}</dd>
          </div>
        </dl>

        <div class="space-y-1 border-t border-border pt-3">
          <p class="text-[11px] uppercase tracking-wider text-muted-foreground">Description</p>
          <p class="text-sm leading-relaxed text-foreground">
            {{ report.description || 'No description was added for this report.' }}
          </p>
        </div>
      </div>

      <DialogFooter class="gap-2">
        <Button variant="outline" @click="isOpen = false">Close</Button>
        <Button class="gap-1.5" :disabled="!report" @click="exportReport">
          <Download class="h-4 w-4" aria-hidden="true" />
          Export CSV
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
