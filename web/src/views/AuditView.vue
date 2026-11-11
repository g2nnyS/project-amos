<script setup lang="ts">
import { ref, watch } from 'vue'
import { ScrollText } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { useGovernanceStore } from '@/stores/governance'
import type { AuditPage } from '@/types'

const store = useGovernanceStore()
const scope = ref<'project' | 'all'>('project')
const result = ref<AuditPage | null>(null)
const error = ref('')
const loading = ref(false)
const cursors = ref<(number | undefined)[]>([undefined])
const index = ref(0)
let generation = 0

const labels: Record<string, string> = {
  project_created: '创建项目',
  proposal_created: '创建提案',
  proposal_approved: '批准提案',
  proposal_rejected: '拒绝提案',
  proposal_withdrawn: '撤回提案',
  proposal_expired: '提案过期',
  version_published: '发布版本'
}

async function load() {
  const ticket = ++generation
  const project = store.activeProjectId
  result.value = null
  error.value = ''
  loading.value = false
  if (scope.value === 'project' && !project) return
  loading.value = true
  try {
    const page = await api.audit({
      ...(scope.value === 'project' && project ? { projectId: project } : {}),
      limit: 25,
      ...(cursors.value[index.value] === undefined ? {} : { before: cursors.value[index.value] })
    })
    if (ticket === generation) result.value = page
  } catch (e) {
    if (ticket === generation) error.value = e instanceof Error ? e.message : '加载审计失败。'
  } finally {
    if (ticket === generation) loading.value = false
  }
}

watch([() => store.activeProjectId, scope], () => { cursors.value = [undefined]; index.value = 0; void load() }, { immediate: true })

function next() {
  if (!result.value?.nextCursor) return
  cursors.value = [...cursors.value.slice(0, index.value + 1), result.value.nextCursor]
  index.value++
  void load()
}

function previous() {
  if (index.value > 0) { index.value--; void load() }
}
</script>

<template>
  <div class="page space-y-4">
    <PageHeader title="治理审计" description="实际治理状态变化的元数据，不包含规则正文、命令或审批自由文本。">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="loading" @click="load"><ScrollText class="mr-1 size-3.5" />刷新</Button>
      </template>
    </PageHeader>

    <section class="panel overflow-hidden">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">治理事件</h2>
          <p class="panel-kicker">元数据时间线 · 不含规则正文</p>
        </div>
      </div>
      <div class="filterbar">
        <label for="audit-scope" class="text-xs text-muted-foreground">范围</label>
        <select id="audit-scope" v-model="scope" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
          <option value="project">当前项目</option>
          <option value="all">全部项目</option>
        </select>
        <span class="ml-auto text-xs text-muted-foreground">按事件 ID 倒序 · 每页 25 条</span>
      </div>

      <div v-if="scope === 'project' && !store.activeProjectId" class="p-6">
        <EmptyState title="请选择项目" description="请选择项目或切换至全部项目。" />
      </div>
      <div v-else-if="loading" role="status" class="p-6 text-sm">正在加载审计记录…</div>
      <div v-else-if="error" role="alert" class="p-6 text-sm text-destructive">
        加载失败：{{ error }} <button class="ml-2 underline" @click="load">重试</button>
      </div>
      <div v-else-if="result && !result.items.length" class="p-8">
        <EmptyState title="暂无审计记录" description="此范围暂无治理事件。" />
      </div>
      <div v-else-if="result" class="divide-y divide-border">
        <article v-for="event in result.items" :key="event.id" class="p-4">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span class="font-medium text-foreground">{{ labels[event.kind] ?? event.kind }}</span>
            <span class="text-muted-foreground">#{{ event.id }} · {{ formatDate(event.createdAt) }}</span>
            <span class="text-muted-foreground">{{ event.actor.id }} · {{ event.actor.role }}</span>
          </div>
          <p class="mt-2 break-all text-xs text-muted-foreground">
            项目 {{ event.projectId ?? '—' }} · 提案 {{ event.proposalId ?? '—' }} · 版本 {{ event.version ?? '—' }}
          </p>
          <dl v-if="Object.keys(event.metadata).length" class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <div v-for="(value, key) in event.metadata" :key="key" class="break-all">
              <dt class="inline text-muted-foreground">{{ key }}: </dt>
              <dd class="inline font-mono">{{ value === null ? 'null' : value }}</dd>
            </div>
          </dl>
        </article>
      </div>
      <div v-if="result" class="flex items-center justify-between border-t border-hairline p-3 text-xs text-muted-foreground">
        <span>第 {{ index + 1 }} 页 · {{ result.items.length }} 条</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="index === 0 || loading" @click="previous">上一页</Button>
          <Button variant="outline" size="sm" :disabled="result.nextCursor === null || loading" @click="next">下一页</Button>
        </div>
      </div>
    </section>
  </div>
</template>
