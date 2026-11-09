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

const labels: Record<string, string> = { pending: '待审批', approved: '已批准', rejected: '已拒绝', withdrawn: '已撤回', expired: '已过期' }
const badgeStatus: Record<string, string> = { pending: 'pending', approved: 'approved', rejected: 'rejected', withdrawn: 'withdrawn', expired: 'expired' }
</script>

<template>
  <div class="page">
    <PageHeader title="提案" description="审阅不可变候选。治理发布不授权工具调用。">
      <template #actions>
        <RouterLink to="/editor">
          <Button size="sm"><Plus class="mr-1 size-3.5" />新建提案</Button>
        </RouterLink>
      </template>
    </PageHeader>

    <EmptyState v-if="!store.activeProjectId" title="请选择项目" description="选择项目后查看提案。" />
    <div v-else-if="store.loading" class="panel p-5 text-sm" role="status">正在加载提案…</div>
    <div v-else-if="store.error" class="panel p-5 text-sm text-destructive" role="alert">
      加载失败：{{ store.error }} <button class="ml-2 underline" @click="store.refreshProject()">重试</button>
    </div>
    <section v-else class="panel overflow-hidden">
      <div class="filterbar">
        <label class="sr-only" for="proposal-search">搜索提案</label>
        <input id="proposal-search" v-model="search" placeholder="搜索标题、ID 或作者" class="h-8 w-full rounded-md border border-input bg-background px-3 text-xs sm:w-64">
        <label class="sr-only" for="proposal-status">状态</label>
        <select id="proposal-status" v-model="status" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
          <option value="all">全部状态</option>
          <option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option>
        </select>
        <span class="ml-auto text-xs text-muted-foreground">{{ rows.length }} 条</span>
      </div>
      <div v-if="!rows.length" class="p-8 text-center text-sm text-muted-foreground">
        <EmptyState :title="store.proposals.length ? '没有匹配的提案' : '尚无提案'" :description="store.proposals.length ? '请调整筛选条件' : '请在候选编辑器中创建。'" />
      </div>
      <div v-else class="overflow-x-auto">
        <table class="data-table min-w-[760px]">
          <thead>
            <tr>
              <th scope="col">标题</th>
              <th scope="col">状态</th>
              <th scope="col">作者</th>
              <th scope="col">基准</th>
              <th scope="col">提交时间</th>
              <th scope="col">过期时间</th>
              <th scope="col">发布版本</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in visible" :key="p.id">
              <td>
                <RouterLink :to="`/proposals/${encodeURIComponent(p.id)}`" class="font-medium underline-offset-4 hover:underline">{{ p.title }}</RouterLink>
                <span v-if="p.status === 'pending' && p.baseVersion !== (store.policy?.version ?? 0)" class="ml-2 text-[11px] text-warning">基准已过期</span>
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
      <div v-if="pages > 1" class="flex items-center justify-end gap-3 border-t border-border p-3 text-xs">
        <Button variant="outline" size="sm" :disabled="page === 1" @click="page--">上一页</Button>
        <span>{{ page }} / {{ pages }}</span>
        <Button variant="outline" size="sm" :disabled="page === pages" @click="page++">下一页</Button>
      </div>
    </section>
  </div>
</template>
