<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { History } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useGovernanceStore } from '@/stores/governance'
import { formatDate } from '@/lib/format'

const store = useGovernanceStore()
const versions = computed(() => store.versions.slice().sort((a, b) => b.version - a.version))
</script>

<template>
  <div class="page">
    <PageHeader title="版本历史" description="已批准的治理快照；发布不改变运行时配置，也不是工具调用授权。" />
    <EmptyState v-if="!store.activeProjectId" title="请选择项目" description="选择项目后查看版本历史。" />
    <div v-else-if="store.loading" class="panel p-5 text-sm" role="status">正在加载版本…</div>
    <div v-else-if="store.error" class="panel p-5 text-sm text-destructive" role="alert">
      加载失败：{{ store.error }} <button class="ml-2 underline" @click="store.refreshProject()">重试</button>
    </div>
    <section v-else class="panel overflow-hidden">
      <div v-if="!versions.length" class="p-8 text-center">
        <EmptyState title="尚无已发布版本" description="批准提案后将创建版本。" />
      </div>
      <div v-else class="overflow-x-auto">
        <table class="data-table min-w-[720px]">
          <thead>
            <tr>
              <th>版本</th>
              <th>提案</th>
              <th>上一版本</th>
              <th>发布时间</th>
              <th>审批人</th>
              <th class="num">规则数</th>
              <th class="num">已激活</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.version">
              <td>
                <RouterLink :to="`/versions/${v.version}`" class="font-medium underline-offset-4 hover:underline">版本 {{ v.version }}</RouterLink>
                <span v-if="store.policy?.version === v.version" class="ml-2 text-[10px] text-info">当前</span>
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
