<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useGovernanceStore } from '@/stores/governance'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n'

const store = useGovernanceStore()
const versions = computed(() => store.versions.slice().sort((a, b) => b.version - a.version))
</script>

<template>
  <div class="page space-y-4">
    <PageHeader :title="t('versions.title')" :description="t('versions.description')" />
    <EmptyState v-if="!store.activeProjectId" :title="t('common.selectProject')" :description="t('versions.emptyProject')" />
    <div v-else-if="store.loading" class="panel p-5 text-sm" role="status">{{ t('versions.loading') }}</div>
    <div v-else-if="store.error" class="panel p-5 text-sm text-destructive" role="alert">
      {{ t('common.loadFailed', { error: store.error }) }} <button class="ml-2 underline" @click="store.refreshProject()">{{ t('common.retry') }}</button>
    </div>
    <section v-else class="panel overflow-hidden">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">{{ t('versions.listTitle') }}</h2>
          <p class="panel-kicker">{{ t('versions.listKicker', { count: versions.length, version: store.policy?.version ?? t('common.notPublished') }) }}</p>
        </div>
      </div>
      <div v-if="!versions.length" class="p-8 text-center">
        <EmptyState :title="t('versions.emptyTitle')" :description="t('versions.emptyDescription')" />
      </div>
      <div v-else class="overflow-x-auto">
        <table class="data-table min-w-[720px]">
          <thead>
            <tr>
              <th scope="col">{{ t('versions.columnVersion') }}</th>
              <th scope="col">{{ t('versions.columnProposal') }}</th>
              <th scope="col">{{ t('versions.columnPrevious') }}</th>
              <th scope="col">{{ t('versions.columnPublished') }}</th>
              <th scope="col">{{ t('versions.columnApprover') }}</th>
              <th scope="col" class="num">{{ t('versions.columnRules') }}</th>
              <th scope="col" class="num">{{ t('versions.columnActive') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.version">
              <td>
                <RouterLink :to="`/versions/${v.version}`" class="font-medium underline-offset-4 hover:underline">{{ t('common.version', { version: v.version }) }}</RouterLink>
                <span v-if="store.policy?.version === v.version" class="ml-2 text-[10px] text-info">{{ t('common.current') }}</span>
              </td>
              <td class="break-all font-mono text-xs">{{ v.proposalId }}</td>
              <td>{{ v.previousVersion ?? '—' }}</td>
              <td>{{ formatDate(v.createdAt) }}</td>
              <td>{{ v.approvedBy.id }} · {{ v.approvedBy.role }}</td>
              <td class="num">{{ v.candidate.rules.length }}</td>
              <td class="num">
                {{ v.snapshot.activation.includedRuleIds === null
                  ? v.candidate.rules.length - v.snapshot.activation.excludedRuleIds.length
                  : v.snapshot.activation.includedRuleIds.length }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
