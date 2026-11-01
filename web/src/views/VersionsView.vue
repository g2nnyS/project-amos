<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import PageHeader from '@/components/common/PageHeader.vue'
import { useGovernanceStore } from '@/stores/governance'
import { formatDate } from '@/lib/format'
const store = useGovernanceStore()
const versions = computed(() => store.versions.slice().sort((a,b) => b.version - a.version))
</script>
<template><div class="page"><PageHeader title="版本历史" description="已批准的治理快照；发布不改变运行时配置，也不是工具调用授权。" />
  <div v-if="!store.activeProjectId" class="panel p-5 text-sm">请先选择项目。</div><div v-else-if="store.loading" class="panel p-5 text-sm" role="status">正在加载版本…</div><div v-else-if="store.error" class="panel p-5 text-sm text-destructive" role="alert">加载失败：{{ store.error }} <button class="underline" @click="store.refreshProject()">重试</button></div>
  <section v-else class="panel overflow-hidden"><div v-if="!versions.length" class="p-8 text-center text-sm text-muted-foreground">尚无已发布版本。批准提案后将创建版本。</div><div v-else class="overflow-x-auto"><table class="data-table min-w-[700px]"><thead><tr><th>版本</th><th>提案</th><th>上一版本</th><th>发布时间</th><th>审批人</th><th>规则数</th></tr></thead><tbody><tr v-for="v in versions" :key="v.version"><td><RouterLink :to="`/versions/${v.version}`" class="font-medium underline-offset-4 hover:underline">版本 {{ v.version }}</RouterLink><span v-if="store.policy?.version === v.version" class="ml-2 text-xs text-primary">当前</span></td><td class="font-mono text-xs">{{ v.proposalId }}</td><td>{{ v.previousVersion ?? '—' }}</td><td>{{ formatDate(v.createdAt) }}</td><td>{{ v.approvedBy.id }} · {{ v.approvedBy.role }}</td><td>{{ v.candidate.rules.length }}</td></tr></tbody></table></div></section>
</div></template>
