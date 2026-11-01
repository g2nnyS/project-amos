<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Copy,
  Download,
  Eye,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ConfirmDialog from '@/components/management/ConfirmDialog.vue'
import ReportCreateDialog from '@/components/management/ReportCreateDialog.vue'
import ReportDetailDialog from '@/components/management/ReportDetailDialog.vue'
import ReportRenameDialog from '@/components/management/ReportRenameDialog.vue'
import {
  csvTimestamp,
  errorMessage,
  initialsOf,
  parseDateValue,
  REPORT_TYPES,
  reportCsvRows,
  slugify,
  type ReportCreateValues,
} from '@/components/management/utils'
import { useDataStore } from '@/stores/data'
import { useWorkspaceStore } from '@/stores/workspace'
import { useToast } from '@/composables/useToast'
import { downloadCsv } from '@/lib/export'
import { formatDate } from '@/lib/format'
import type { Report } from '@/types'

const data = useDataStore()
const workspace = useWorkspaceStore()
const { toast } = useToast()
const route = useRoute()
const router = useRouter()

const pageSize = 8

const search = ref('')
const typeFilter = ref('all')
const page = ref(1)
const searchInput = ref<HTMLInputElement | null>(null)

const createOpen = ref(false)
const renameOpen = ref(false)
const renameTarget = ref<Report | null>(null)
const detailOpen = ref(false)
const detailTarget = ref<Report | null>(null)
const deleteOpen = ref(false)
const deleteTarget = ref<Report | null>(null)

const workspaceName = computed(() => workspace.activeWorkspace?.name ?? 'this workspace')

const reports = computed<Report[]>(() => data.reports)

const typeCounts = computed(() => {
  const counts: Record<string, number> = { all: reports.value.length }
  for (const type of REPORT_TYPES) counts[type] = 0
  for (const report of reports.value) counts[report.type] = (counts[report.type] ?? 0) + 1
  return counts
})

const normalizedQuery = computed(() => search.value.trim().toLowerCase())

const filteredReports = computed(() => {
  const query = normalizedQuery.value
  return reports.value
    .filter((report) => {
      if (typeFilter.value !== 'all' && report.type !== typeFilter.value) return false
      if (!query) return true
      return [report.name, report.owner, report.description].some((value) =>
        value.toLowerCase().includes(query),
      )
    })
    .slice()
    .sort((a, b) => {
      const aTime = parseDateValue(a.updatedAt)?.getTime() ?? 0
      const bTime = parseDateValue(b.updatedAt)?.getTime() ?? 0
      if (aTime !== bTime) return bTime - aTime
      return a.name.localeCompare(b.name)
    })
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredReports.value.length / pageSize)))
const pagedReports = computed(() => {
  const start = (page.value - 1) * pageSize
  return filteredReports.value.slice(start, start + pageSize)
})
const rangeStart = computed(() =>
  filteredReports.value.length === 0 ? 0 : (page.value - 1) * pageSize + 1,
)
const rangeEnd = computed(() => Math.min(page.value * pageSize, filteredReports.value.length))

const hasFilters = computed(() => normalizedQuery.value.length > 0 || typeFilter.value !== 'all')

const emptyTitle = computed(() =>
  reports.value.length === 0 ? 'No saved reports yet' : 'No reports match',
)
const emptyDescription = computed(() =>
  reports.value.length === 0
    ? `Create the first report for ${workspaceName.value}. Reports stay in this browser.`
    : 'Try a different search term or switch the type filter.',
)

watch([search, typeFilter], () => {
  page.value = 1
})

watch(totalPages, (value) => {
  if (page.value > value) page.value = value
})

watch(
  () => workspace.activeWorkspaceId,
  () => {
    search.value = ''
    typeFilter.value = 'all'
    page.value = 1
    createOpen.value = false
    renameOpen.value = false
    renameTarget.value = null
    detailOpen.value = false
    detailTarget.value = null
    deleteOpen.value = false
    deleteTarget.value = null
  },
)

function clearSearch() {
  search.value = ''
  searchInput.value?.focus()
}

function resetFilters() {
  search.value = ''
  typeFilter.value = 'all'
  searchInput.value?.focus()
}

function openCreate() {
  createOpen.value = true
}

function openRename(report: Report) {
  renameTarget.value = report
  renameOpen.value = true
}

function openDetail(report: Report) {
  detailTarget.value = report
  detailOpen.value = true
}

watch(
  () => [route.query.focus, reports.value] as const,
  ([focus, available]) => {
    if (typeof focus !== 'string') return
    const report = available.find((item) => item.id === focus)
    if (!report) return
    openDetail(report)
    const query = { ...route.query }
    delete query.focus
    void router.replace({ query })
  },
  { immediate: true },
)

function openDelete(report: Report) {
  deleteTarget.value = report
  deleteOpen.value = true
}

function exportRows(rows: Report[]) {
  if (rows.length === 0) {
    toast('Nothing to export', 'Adjust the search or type filter so at least one report is included.', 'info')
    return
  }
  try {
    const filename = `neuralyn-reports-${slugify(workspaceName.value)}-${csvTimestamp()}.csv`
    downloadCsv(filename, reportCsvRows(rows))
    toast(
      'CSV exported',
      `${rows.length} ${rows.length === 1 ? 'report' : 'reports'} downloaded from ${workspaceName.value}.`,
      'success',
    )
  } catch (error) {
    toast('Export failed', errorMessage(error, 'The CSV could not be created.'), 'error')
  }
}

function exportFiltered() {
  exportRows(filteredReports.value)
}

function exportOne(report: Report) {
  exportRows([report])
}

async function createReport(values: ReportCreateValues) {
  try {
    const existingIds = new Set(reports.value.map((report) => report.id))
    await data.createReport(values)
    const created = reports.value.find((report) => !existingIds.has(report.id))
    if (!created) throw new Error('The report could not be created.')
    createOpen.value = false
    page.value = 1
    toast('Report created', `“${created.name}” is now available in ${workspaceName.value}.`, 'success')
  } catch (error) {
    toast('Could not create report', errorMessage(error), 'error')
  }
}

async function renameReport(name: string) {
  const report = renameTarget.value
  if (!report) return
  const previousName = report.name
  try {
    await data.updateReport(report.id, { name })
    const updated = reports.value.find((item) => item.id === report.id)
    if (!updated || updated.name !== name) throw new Error('The new name was not saved.')
    renameOpen.value = false
    toast('Report renamed', `“${previousName}” is now “${name}”.`, 'success')
  } catch (error) {
    toast('Could not rename report', errorMessage(error), 'error')
  }
}

async function duplicateReport(report: Report) {
  try {
    const existingIds = new Set(reports.value.map((item) => item.id))
    await data.duplicateReport(report.id)
    const copy = reports.value.find((item) => !existingIds.has(item.id))
    if (!copy) throw new Error('The report could not be duplicated.')
    toast('Report duplicated', `“${copy.name}” was added to ${workspaceName.value}.`, 'success')
  } catch (error) {
    toast('Could not duplicate report', errorMessage(error), 'error')
  }
}

async function deleteReport() {
  const report = deleteTarget.value
  if (!report) return
  try {
    await data.deleteReport(report.id)
    if (reports.value.some((item) => item.id === report.id)) {
      throw new Error('The report could not be deleted.')
    }
    deleteOpen.value = false
    toast('Report deleted', `“${report.name}” was removed from ${workspaceName.value}.`, 'success')
  } catch (error) {
    toast('Could not delete report', errorMessage(error), 'error')
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Reports"
      description="Saved metric definitions for this workspace. Open one for a summary, duplicate it as a starting point, or export the current view."
    >
      <template #actions>
        <Button variant="outline" size="sm" class="gap-1.5" @click="exportFiltered">
          <Download class="size-3.5" aria-hidden="true" />
          Export CSV
        </Button>
        <Button size="sm" class="gap-1.5" @click="openCreate">
          <Plus class="size-3.5" aria-hidden="true" />
          New report
        </Button>
      </template>
    </PageHeader>

    <section class="panel" aria-labelledby="reports-heading">
      <h2 id="reports-heading" class="sr-only">Saved reports</h2>

      <div class="filterbar">
        <div class="relative w-full sm:w-[260px]">
          <label for="report-search" class="sr-only">Search reports</label>
          <Search
            class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="report-search"
            ref="searchInput"
            v-model="search"
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search reports, owners, descriptions…"
            class="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-[12.5px] text-foreground placeholder:text-muted-foreground/70 transition-colors hover:border-border focus:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            v-if="search"
            type="button"
            class="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <X class="size-3" aria-hidden="true" />
          </button>
        </div>

        <div class="segmented max-w-full flex-wrap" role="group" aria-label="Filter reports by type">
          <button
            type="button"
            class="segmented-item"
            :aria-pressed="typeFilter === 'all'"
            @click="typeFilter = 'all'"
          >
            All
            <span class="ml-1 tabular opacity-60">{{ typeCounts.all ?? 0 }}</span>
          </button>
          <button
            v-for="type in REPORT_TYPES"
            :key="type"
            type="button"
            class="segmented-item"
            :aria-pressed="typeFilter === type"
            @click="typeFilter = type"
          >
            {{ type }}
            <span class="ml-1 tabular opacity-60">{{ typeCounts[type] ?? 0 }}</span>
          </button>
        </div>

        <button
          v-if="hasFilters"
          type="button"
          class="ml-auto h-7 rounded-md px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="resetFilters"
        >
          Reset filters
        </button>

        <p
          v-else
          class="ml-auto hidden text-[11px] text-muted-foreground sm:block"
          aria-live="polite"
        >
          <span class="tabular">{{ filteredReports.length }}</span>
          of
          <span class="tabular">{{ reports.length }}</span>
          shown
        </p>
      </div>

      <div v-if="reports.length === 0" class="p-4 sm:p-5">
        <EmptyState :title="emptyTitle" :description="emptyDescription">
          <Button size="sm" class="gap-1.5" @click="openCreate">
            <Plus class="size-3.5" aria-hidden="true" />
            Create report
          </Button>
        </EmptyState>
      </div>

      <div v-else-if="filteredReports.length === 0" class="p-4 sm:p-5">
        <EmptyState :title="emptyTitle" :description="emptyDescription">
          <button
            type="button"
            class="inline-flex h-8 items-center justify-center rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent"
            @click="resetFilters"
          >
            Clear search and filters
          </button>
        </EmptyState>
      </div>

      <template v-else>
        <div class="overflow-x-auto scroll-thin">
          <table class="data-table min-w-[640px]">
            <caption class="sr-only">
              Reports in {{ workspaceName }}, sorted by most recently updated
            </caption>
            <thead>
              <tr>
                <th scope="col">Report</th>
                <th scope="col" class="w-[104px]">Type</th>
                <th scope="col" class="w-[170px]">Owner</th>
                <th scope="col" class="w-[120px]">Updated</th>
                <th scope="col" class="w-[56px]">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="report in pagedReports" :key="report.id">
                <td>
                  <button
                    type="button"
                    class="group flex max-w-[52ch] flex-col items-start gap-0.5 rounded-sm text-left"
                    @click="openDetail(report)"
                  >
                    <span
                      class="truncate text-[13px] font-medium text-foreground decoration-border underline-offset-4 group-hover:underline"
                    >
                      {{ report.name }}
                    </span>
                    <span class="line-clamp-1 text-[11.5px] text-muted-foreground">
                      {{ report.description || 'No description' }}
                    </span>
                  </button>
                </td>
                <td>
                  <Badge variant="outline" class="font-medium tracking-[0.01em]">
                    {{ report.type }}
                  </Badge>
                </td>
                <td>
                  <span class="flex items-center gap-2">
                    <span
                      class="grid size-5 shrink-0 place-items-center rounded-full border border-border bg-muted text-[9.5px] font-semibold uppercase text-muted-foreground"
                      aria-hidden="true"
                    >
                      {{ initialsOf(report.owner) }}
                    </span>
                    <span class="truncate text-[12.5px] text-foreground/90">{{ report.owner }}</span>
                  </span>
                </td>
                <td class="tabular whitespace-nowrap text-[12px] text-muted-foreground">
                  {{ formatDate(report.updatedAt) }}
                </td>
                <td class="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        class="text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                        :aria-label="`Actions for ${report.name}`"
                      >
                        <MoreHorizontal class="size-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="w-44">
                      <DropdownMenuItem @select="openDetail(report)">
                        <Eye class="size-3.5 text-muted-foreground" aria-hidden="true" />
                        View details
                      </DropdownMenuItem>
                      <DropdownMenuItem @select="exportOne(report)">
                        <Download class="size-3.5 text-muted-foreground" aria-hidden="true" />
                        Export CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem @select="openRename(report)">
                        <Pencil class="size-3.5 text-muted-foreground" aria-hidden="true" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem @select="duplicateReport(report)">
                        <Copy class="size-3.5 text-muted-foreground" aria-hidden="true" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" @select="openDelete(report)">
                        <Trash2 class="size-3.5" aria-hidden="true" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          class="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-3.5 py-2.5 text-[11.5px] text-muted-foreground"
        >
          <p aria-live="polite">
            Showing
            <span class="tabular text-foreground">{{ rangeStart }}–{{ rangeEnd }}</span>
            of
            <span class="tabular text-foreground">{{ filteredReports.length }}</span>
            {{ filteredReports.length === 1 ? 'report' : 'reports' }}
          </p>

          <div v-if="totalPages > 1" class="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="xs"
              :disabled="page <= 1"
              @click="page = Math.max(1, page - 1)"
            >
              Previous
            </Button>
            <span class="tabular px-1 text-muted-foreground">
              {{ page }} / {{ totalPages }}
            </span>
            <Button
              variant="ghost"
              size="xs"
              :disabled="page >= totalPages"
              @click="page = Math.min(totalPages, page + 1)"
            >
              Next
            </Button>
          </div>
        </div>
      </template>
    </section>

    <ReportCreateDialog v-model:open="createOpen" @submit="createReport" />
    <ReportRenameDialog v-model:open="renameOpen" :report="renameTarget" @submit="renameReport" />
    <ReportDetailDialog v-model:open="detailOpen" :report="detailTarget" />
    <ConfirmDialog
      v-model:open="deleteOpen"
      title="Delete report?"
      :description="deleteTarget ? `“${deleteTarget.name}” will be removed from ${workspaceName}. This cannot be undone.` : ''"
      confirm-label="Delete report"
      destructive
      @confirm="deleteReport"
    />
  </div>
</template>
