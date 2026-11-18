<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { GitPullRequest, Plus } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { Button } from '@/components/ui/button'
import { useGovernanceStore } from '@/stores/governance'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n'
import { proposalStatusLabel, proposalStatuses } from '@/i18n/labels'

const store = useGovernanceStore()
const search = ref('')
const status = ref('all')
const page = ref(1)

const rows = computed(() => store.proposals
  .filter(p => (status.value === 'all' || p.status === status.value) && `${p.title} ${p.id} ${p.author.id}`.toLowerCase().includes(search.value.trim().toLowerCase()))
  .slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / 10)))
const visible = computed(() => rows.value.slice((page.value - 1) * 10, page.value * 10))

watch([search, status, () => store.activeProjectId], () => { page.value = 1 })
watch(pages, n => { page.value = Math.min(page.value, n) })

const badgeStatus: Record<string, string> = { pending: 'pending', approved: 'approved', rejected: 'rejected', withdrawn: 'withdrawn', expired: 'expired' }
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('proposals.title')" :description="t('proposals.description')">
      <template #actions>
        <RouterLink to="/editor">
          <Button size="sm"><Plus class="mr-1 size-3.5" />{{ t('proposals.create') }}</Button>
        </RouterLink>
      </template>
    </PageHeader>

    <EmptyState v-if="!store.activeProjectId" :title="t('common.selectProject')" :description="t('proposals.emptyProject')" />
    <div v-else-if="store.loading" class="panel p-5 text-sm" role="status">{{ t('proposals.loading') }}</div>
    <div v-else-if="store.error" class="panel p-5 text-sm text-destructive" role="alert">
      {{ t('common.loadFailed', { error: store.error }) }} <button class="ml-2 underline" @click="store.refreshProject()">{{ t('common.retry') }}</button>
    </div>
    <section v-else class="panel overflow-hidden">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">{{ t('proposals.listTitle') }}</h2>
          <p class="panel-kicker">{{ t('proposals.listKicker', { count: rows.length, version: store.policy?.version ?? 0 }) }}</p>
        </div>
      </div>
      <div class="filterbar">
        <label class="sr-only" for="proposal-search">{{ t('proposals.search') }}</label>
        <input id="proposal-search" v-model="search" :placeholder="t('proposals.searchPlaceholder')" class="h-8 w-full rounded-md border border-input bg-background px-3 text-xs sm:w-64">
        <label class="sr-only" for="proposal-status">{{ t('proposals.status') }}</label>
        <select id="proposal-status" v-model="status" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
          <option value="all">{{ t('proposals.allStatuses') }}</option>
          <option v-for="key in proposalStatuses" :key="key" :value="key">{{ proposalStatusLabel(key) }}</option>
        </select>
      </div>
      <div v-if="!rows.length" class="p-8 text-center text-sm text-muted-foreground">
        <EmptyState :title="store.proposals.length ? t('proposals.noMatchTitle') : t('proposals.emptyTitle')" :description="store.proposals.length ? t('proposals.noMatchDescription') : t('proposals.emptyDescription')" />
      </div>
      <div v-else class="overflow-x-auto">
        <table class="data-table min-w-[760px]">
          <thead>
            <tr>
              <th scope="col">{{ t('common.title') }}</th>
              <th scope="col">{{ t('proposals.status') }}</th>
              <th scope="col">{{ t('proposals.columnAuthor') }}</th>
              <th scope="col">{{ t('proposals.columnBase') }}</th>
              <th scope="col">{{ t('proposals.columnCreated') }}</th>
              <th scope="col">{{ t('proposals.columnExpires') }}</th>
              <th scope="col">{{ t('proposals.columnPublished') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in visible" :key="p.id">
              <td>
                <RouterLink :to="`/proposals/${encodeURIComponent(p.id)}`" class="font-medium underline-offset-4 hover:underline">{{ p.title }}</RouterLink>
                <span v-if="p.status === 'pending' && p.baseVersion !== (store.policy?.version ?? 0)" class="ml-2 text-[11px] text-warning">{{ t('proposals.staleBase') }}</span>
              </td>
              <td><StatusBadge :status="badgeStatus[p.status]" /></td>
              <td>{{ p.author.id }} · {{ p.author.role }}</td>
              <td>{{ p.baseVersion }}</td>
              <td>{{ formatDate(p.createdAt) }}</td>
              <td>{{ formatDate(p.expiresAt) }}</td>
              <td>{{ p.publishedVersion ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="pages > 1" class="flex items-center justify-end gap-3 border-t border-hairline p-3 text-xs">
        <Button variant="outline" size="sm" :disabled="page === 1" @click="page--">{{ t('common.previousPage') }}</Button>
        <span>{{ page }} / {{ pages }}</span>
        <Button variant="outline" size="sm" :disabled="page === pages" @click="page++">{{ t('common.nextPage') }}</Button>
      </div>
    </section>
  </div>
</template>
