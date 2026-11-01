<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  CheckCircle2,
  Gauge,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Target,
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
import StatusBadge from '@/components/common/StatusBadge.vue'
import ConfirmDialog from '@/components/management/ConfirmDialog.vue'
import GoalFormDialog from '@/components/management/GoalFormDialog.vue'
import GoalProgressDialog from '@/components/management/GoalProgressDialog.vue'
import NativeSelect from '@/components/management/NativeSelect.vue'
import {
  errorMessage,
  formatDateOnly,
  formatMetricValue,
  formatPercent,
  GOAL_METRICS,
  goalProgress,
  initialsOf,
  isOverdue,
  parseDateValue,
  type GoalFormValues,
} from '@/components/management/utils'
import { useDataStore } from '@/stores/data'
import { useWorkspaceStore } from '@/stores/workspace'
import { useToast } from '@/composables/useToast'
import type { Goal } from '@/types'

type StatusTab = 'active' | 'completed'

interface GoalRow {
  goal: Goal
  percentLabel: string
  barPercent: number
  ariaNow: number
  ariaText: string
  overTarget: boolean
  overdue: boolean
}

const data = useDataStore()
const workspace = useWorkspaceStore()
const { toast } = useToast()

const today = new Date()

const statusTab = ref<StatusTab>('active')
const search = ref('')
const metricFilter = ref('all')
const searchInput = ref<HTMLInputElement | null>(null)

const formOpen = ref(false)
const formTarget = ref<Goal | null>(null)
const progressOpen = ref(false)
const progressTarget = ref<Goal | null>(null)
const completeOpen = ref(false)
const completeTarget = ref<Goal | null>(null)
const deleteOpen = ref(false)
const deleteTarget = ref<Goal | null>(null)

const workspaceName = computed(() => workspace.activeWorkspace?.name ?? 'this workspace')
const defaultOwner = computed(() => workspace.profile?.name ?? '')

const counts = computed(() => {
  let active = 0
  let completed = 0
  for (const goal of data.goals) {
    if (goal.status === 'completed') completed += 1
    else active += 1
  }
  return { active, completed }
})

const statusTabs = computed(() => [
  { value: 'active' as const, label: 'Active', count: counts.value.active },
  { value: 'completed' as const, label: 'Completed', count: counts.value.completed },
])

const normalizedQuery = computed(() => search.value.trim().toLowerCase())
const hasFilters = computed(() => normalizedQuery.value.length > 0 || metricFilter.value !== 'all')

const rows = computed<GoalRow[]>(() => {
  const query = normalizedQuery.value
  return data.goals
    .filter((goal) => goal.status === statusTab.value)
    .filter((goal) => metricFilter.value === 'all' || goal.metric === metricFilter.value)
    .filter((goal) => {
      if (!query) return true
      return goal.name.toLowerCase().includes(query) || goal.owner.toLowerCase().includes(query)
    })
    .slice()
    .sort((a, b) => {
      const aTime = parseDateValue(a.deadline)?.getTime() ?? Number.MAX_SAFE_INTEGER
      const bTime = parseDateValue(b.deadline)?.getTime() ?? Number.MAX_SAFE_INTEGER
      if (aTime !== bTime) return aTime - bTime
      return a.name.localeCompare(b.name)
    })
    .map((goal) => {
      const progress = goalProgress(goal.current, goal.target)
      return {
        goal,
        percentLabel: formatPercent(progress.percent),
        barPercent: progress.barPercent,
        ariaNow: Math.min(100, Math.max(0, Math.round(progress.percent))),
        ariaText: `${formatPercent(progress.percent)} of target — ${formatMetricValue(goal.current, goal.metric)} of ${formatMetricValue(goal.target, goal.metric)}`,
        overTarget: progress.overTarget,
        overdue: goal.status === 'active' && isOverdue(goal.deadline, today),
      }
    })
})

const emptyTitle = computed(() => {
  if (!hasFilters.value) {
    return statusTab.value === 'active' ? 'No active goals' : 'No completed goals'
  }
  return statusTab.value === 'active' ? 'No active goals match' : 'No completed goals match'
})

const emptyDescription = computed(() => {
  if (!hasFilters.value) {
    return statusTab.value === 'active'
      ? `Create a measurable target for ${workspaceName.value}. Goals stay in this browser.`
      : 'Goals you mark complete will be collected here.'
  }
  return 'Try a different search term or switch the metric filter.'
})

const completedPercent = computed(() => {
  const total = counts.value.active + counts.value.completed
  if (total === 0) return 0
  return Math.round((counts.value.completed / total) * 100)
})

watch(
  () => workspace.activeWorkspaceId,
  () => {
    statusTab.value = 'active'
    search.value = ''
    metricFilter.value = 'all'
    formOpen.value = false
    formTarget.value = null
    progressOpen.value = false
    progressTarget.value = null
    completeOpen.value = false
    completeTarget.value = null
    deleteOpen.value = false
    deleteTarget.value = null
  },
)

function selectTab(value: StatusTab) {
  statusTab.value = value
}

function clearSearch() {
  search.value = ''
  searchInput.value?.focus()
}

function resetFilters() {
  search.value = ''
  metricFilter.value = 'all'
  searchInput.value?.focus()
}

function openCreate() {
  formTarget.value = null
  formOpen.value = true
}

function openEdit(goal: Goal) {
  formTarget.value = goal
  formOpen.value = true
}

function openProgress(goal: Goal) {
  progressTarget.value = goal
  progressOpen.value = true
}

function openComplete(goal: Goal) {
  completeTarget.value = goal
  completeOpen.value = true
}

function openDelete(goal: Goal) {
  deleteTarget.value = goal
  deleteOpen.value = true
}

async function saveGoal(values: GoalFormValues) {
  const editing = formTarget.value
  try {
    if (editing) {
      await data.updateGoal(editing.id, values)
      const updated = data.goals.find((goal) => goal.id === editing.id)
      if (!updated || updated.name !== values.name || updated.target !== values.target) {
        throw new Error('The goal changes were not saved.')
      }
      formOpen.value = false
      toast('Goal updated', `“${values.name}” was saved for ${workspaceName.value}.`, 'success')
      return
    }

    const existingIds = new Set(data.goals.map((goal) => goal.id))
    await data.createGoal({ ...values, status: 'active' })
    const created = data.goals.find((goal) => !existingIds.has(goal.id))
    if (!created) throw new Error('The goal could not be created.')
    formOpen.value = false
    statusTab.value = 'active'
    toast('Goal created', `“${created.name}” is now tracked as an active goal.`, 'success')
  } catch (error) {
    toast('Could not save goal', errorMessage(error), 'error')
  }
}

async function saveProgress(value: number) {
  const goal = progressTarget.value
  if (!goal) return
  try {
    await data.updateGoal(goal.id, { current: value })
    const updated = data.goals.find((item) => item.id === goal.id)
    if (!updated || updated.current !== value) throw new Error('The progress was not saved.')
    progressOpen.value = false
    const percent = goalProgress(value, goal.target).percent
    toast(
      'Progress updated',
      `${goal.name} is now at ${formatPercent(percent)} of target.`,
      'success',
    )
  } catch (error) {
    toast('Could not update progress', errorMessage(error), 'error')
  }
}

async function completeGoal() {
  const goal = completeTarget.value
  if (!goal) return
  try {
    const nextCurrent = Math.max(goal.current, goal.target)
    await data.updateGoal(goal.id, { status: 'completed', current: nextCurrent })
    const updated = data.goals.find((item) => item.id === goal.id)
    if (!updated || updated.status !== 'completed') {
      throw new Error('The goal was not marked complete.')
    }
    completeOpen.value = false
    toast('Goal completed', `“${goal.name}” was moved to completed goals.`, 'success')
  } catch (error) {
    toast('Could not complete goal', errorMessage(error), 'error')
  }
}

async function deleteGoal() {
  const goal = deleteTarget.value
  if (!goal) return
  try {
    await data.deleteGoal(goal.id)
    if (data.goals.some((item) => item.id === goal.id)) {
      throw new Error('The goal could not be deleted.')
    }
    deleteOpen.value = false
    toast('Goal deleted', `“${goal.name}” was removed from ${workspaceName.value}.`, 'success')
  } catch (error) {
    toast('Could not delete goal', errorMessage(error), 'error')
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Goals"
      description="Targets for this workspace with an owner, a deadline, and progress you record by hand. Values stay local to this browser."
    >
      <template #actions>
        <span class="hidden items-center gap-2 text-[11.5px] text-muted-foreground sm:inline-flex">
          <span class="tabular">{{ counts.active }}</span>
          active
          <span class="text-muted-foreground/50">·</span>
          <span class="tabular">{{ completedPercent }}%</span>
          complete
        </span>
        <Button size="sm" class="gap-1.5" @click="openCreate">
          <Plus class="size-3.5" aria-hidden="true" />
          New goal
        </Button>
      </template>
    </PageHeader>

    <section class="panel" aria-labelledby="goals-heading">
      <h2 id="goals-heading" class="sr-only">Goals</h2>

      <div class="filterbar">
        <div
          class="segmented"
          role="group"
          aria-label="Filter goals by status"
        >
          <button
            v-for="tab in statusTabs"
            :key="tab.value"
            type="button"
            class="segmented-item"
            :aria-pressed="statusTab === tab.value"
            @click="selectTab(tab.value)"
          >
            {{ tab.label }}
            <span class="ml-1 tabular opacity-60">{{ tab.count }}</span>
          </button>
        </div>

        <div class="relative w-full sm:w-[230px]">
          <label for="goal-search" class="sr-only">Search goals</label>
          <Search
            class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="goal-search"
            ref="searchInput"
            v-model="search"
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search goals or owners…"
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

        <div class="w-full sm:w-[150px]">
          <label for="goal-metric-filter" class="sr-only">Filter by metric</label>
          <NativeSelect id="goal-metric-filter" v-model="metricFilter">
            <option value="all">All metrics</option>
            <option v-for="metric in GOAL_METRICS" :key="metric" :value="metric">
              {{ metric }}
            </option>
          </NativeSelect>
        </div>

        <button
          v-if="hasFilters"
          type="button"
          class="ml-auto h-7 rounded-md px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="resetFilters"
        >
          Reset filters
        </button>

        <p v-else class="ml-auto hidden text-[11px] text-muted-foreground sm:block" aria-live="polite">
          <span class="tabular">{{ rows.length }}</span>
          shown
        </p>
      </div>

      <div v-if="rows.length === 0" class="p-4 sm:p-5">
        <EmptyState :title="emptyTitle" :description="emptyDescription">
          <Button v-if="hasFilters" variant="outline" size="sm" @click="resetFilters">
            Clear search and filters
          </Button>
          <Button
            v-else-if="statusTab === 'completed' && counts.active > 0"
            variant="outline"
            size="sm"
            @click="selectTab('active')"
          >
            View active goals
          </Button>
          <Button v-else size="sm" class="gap-1.5" @click="openCreate">
            <Plus class="size-3.5" aria-hidden="true" />
            Create goal
          </Button>
        </EmptyState>
      </div>

      <div v-else class="overflow-x-auto scroll-thin">
        <table class="data-table min-w-[760px]">
          <caption class="sr-only">
            {{ statusTab === 'active' ? 'Active' : 'Completed' }} goals in {{ workspaceName }}, sorted by deadline
          </caption>
          <thead>
            <tr>
              <th scope="col">Goal</th>
              <th scope="col" class="w-[210px]">Progress</th>
              <th scope="col" class="w-[130px]">Deadline</th>
              <th scope="col" class="w-[160px]">Owner</th>
              <th scope="col" class="w-[56px]">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.goal.id">
              <td>
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="truncate text-[13px] font-medium text-foreground">
                    {{ row.goal.name }}
                  </span>
                  <Badge variant="outline" class="font-normal">{{ row.goal.metric }}</Badge>
                  <StatusBadge v-if="row.goal.status === 'completed'" status="Completed" />
                </div>
                <span class="mt-0.5 block text-[11px] text-muted-foreground sm:hidden">
                  {{ row.goal.owner }}
                </span>
              </td>
              <td>
                <div class="flex items-center gap-2">
                  <div
                    class="h-1.5 w-[76px] shrink-0 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    :aria-label="`${row.goal.name} progress`"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="row.ariaNow"
                    :aria-valuetext="row.ariaText"
                  >
                    <div
                      class="h-full rounded-full bg-foreground transition-[width] duration-200 motion-reduce:transition-none"
                      :style="{ width: `${row.barPercent}%` }"
                    />
                  </div>
                  <span class="tabular text-[12px] font-medium text-foreground">
                    {{ row.percentLabel }}
                  </span>
                  <span
                    v-if="row.overTarget"
                    class="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
                  >
                    Over target
                  </span>
                </div>
                <p class="tabular mt-0.5 text-[11px] text-muted-foreground">
                  {{ formatMetricValue(row.goal.current, row.goal.metric) }}
                  of
                  {{ formatMetricValue(row.goal.target, row.goal.metric) }}
                </p>
              </td>
              <td>
                <span class="tabular whitespace-nowrap text-[12px] text-foreground/90">
                  {{ formatDateOnly(row.goal.deadline) }}
                </span>
                <span
                  v-if="row.overdue"
                  class="mt-0.5 block text-[10.5px] font-medium text-destructive"
                >
                  Overdue
                </span>
              </td>
              <td>
                <span class="flex items-center gap-2">
                  <span
                    class="grid size-5 shrink-0 place-items-center rounded-full border border-border bg-muted text-[9.5px] font-semibold uppercase text-muted-foreground"
                    aria-hidden="true"
                  >
                    {{ initialsOf(row.goal.owner) }}
                  </span>
                  <span class="truncate text-[12.5px] text-foreground/90">{{ row.goal.owner }}</span>
                </span>
              </td>
              <td class="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                      :aria-label="`Actions for ${row.goal.name}`"
                    >
                      <MoreHorizontal class="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-48">
                    <DropdownMenuItem @select="openEdit(row.goal)">
                      <Pencil class="size-3.5 text-muted-foreground" aria-hidden="true" />
                      Edit goal
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      v-if="row.goal.status === 'active'"
                      @select="openProgress(row.goal)"
                    >
                      <Gauge class="size-3.5 text-muted-foreground" aria-hidden="true" />
                      Update progress
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      v-if="row.goal.status === 'active'"
                      @select="openComplete(row.goal)"
                    >
                      <CheckCircle2 class="size-3.5 text-muted-foreground" aria-hidden="true" />
                      Mark complete
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" @select="openDelete(row.goal)">
                      <Trash2 class="size-3.5" aria-hidden="true" />
                      Delete goal
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="rows.length > 0"
        class="flex flex-wrap items-center gap-2 border-t border-hairline px-3.5 py-2.5 text-[11px] text-muted-foreground"
      >
        <Target class="size-3.5 shrink-0" aria-hidden="true" />
        <p>
          Showing
          <span class="tabular text-foreground">{{ rows.length }}</span>
          {{ statusTab === 'active' ? 'active' : 'completed' }}
          {{ rows.length === 1 ? 'goal' : 'goals' }}.
        </p>
      </div>
    </section>

    <GoalFormDialog
      v-model:open="formOpen"
      :goal="formTarget"
      :default-owner="defaultOwner"
      @submit="saveGoal"
    />
    <GoalProgressDialog v-model:open="progressOpen" :goal="progressTarget" @submit="saveProgress" />

    <ConfirmDialog
      v-model:open="completeOpen"
      title="Mark goal complete?"
      :description="completeTarget ? `“${completeTarget.name}” will move to completed goals. Progress is kept, and is raised to the target if it is below it.` : ''"
      confirm-label="Mark complete"
      @confirm="completeGoal"
    />

    <ConfirmDialog
      v-model:open="deleteOpen"
      title="Delete goal?"
      :description="deleteTarget ? `“${deleteTarget.name}” will be removed from ${workspaceName}. This cannot be undone.` : ''"
      confirm-label="Delete goal"
      destructive
      @confirm="deleteGoal"
    />
  </div>
</template>
