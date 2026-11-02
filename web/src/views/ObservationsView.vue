<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Eye, RefreshCw } from 'lucide-vue-next'
import { api } from '@/lib/api'
import type { ObservationReport } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { Button } from '@/components/ui/button'

const report = ref<ObservationReport | null>(null)
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    report.value = await api.observations()
  } catch (e) {
    report.value = null
    error.value = e instanceof Error ? e.message : '观察记录加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <PageHeader title="观察记录" description="只读查看启动时配置的脱敏观察日志；记录不是运行授权。">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="loading" @click="load"><RefreshCw class="mr-1 size-3.5" />刷新</Button>
      </template>
    </PageHeader>

    <div class="mb-4 rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      Stage A 为 log-only。覆盖缺口只提供可见性，不提供保护或完整中介。命中规则基于历史快照元数据，不重新评估当前规则表。
    </div>

    <p v-if="loading" class="p-4 text-sm text-muted-foreground" role="status">加载中…</p>
    <div v-else-if="error" role="alert" class="panel p-4 text-sm text-destructive">
      {{ error }} <button class="ml-2 underline" @click="load">重试</button>
    </div>
    <EmptyState v-else-if="report && !report.available" title="观察数据不可用" description="服务启动时未配置观察日志。网页不能指定服务器文件路径。" />

    <template v-else-if="report">
      <section class="panel mb-4">
        <div class="panel-header">
          <h2 class="panel-title">日志来源</h2>
        </div>
        <ul class="divide-y divide-border">
          <li v-for="source in report.sources" :key="source.name" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs">
            <span class="font-medium">{{ source.name }}</span>
            <span class="text-muted-foreground">
              {{ source.lines }} 行
              <span v-if="source.truncated">· 已截断</span>
              <span v-if="source.error" class="text-destructive"> · {{ source.error }}</span>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="report.queue" class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">审阅队列 · {{ report.queue.records.length }} 条</h2>
            <p class="panel-kicker">zero-level {{ report.queue.zeroLevel.length }} · deny {{ report.queue.nonZeroDeny.length }} · confirm {{ report.queue.confirm.total }} · 缺口 {{ report.queue.gaps.length }}</p>
          </div>
        </div>
        <p v-if="!report.queue.records.length" class="p-6 text-center text-xs text-muted-foreground">没有观察记录。</p>
        <div v-else class="overflow-x-auto">
          <table class="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>来源 / 行</th>
                <th>时间</th>
                <th>动作</th>
                <th>假设裁决</th>
                <th>命中规则</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in report.queue.records" :key="`${record.source}:${record.line}`">
                <td class="font-mono text-xs">{{ record.source }}:{{ record.line }}</td>
                <td>{{ record.ts ?? '—' }}</td>
                <td>
                  <span class="block">{{ record.action?.tool ?? '—' }} · {{ record.action?.operation ?? '—' }}</span>
                  <span class="block break-all text-muted-foreground">{{ record.action?.target ?? '' }}</span>
                </td>
                <td>{{ record.verdict ?? '—' }}</td>
                <td>{{ record.matchedRuleIds.join(', ') || '—' }}</td>
                <td>
                  <span v-for="reason in record.reasons" :key="reason" class="mr-1 inline-block rounded bg-muted px-1 py-0.5 text-[10px]">{{ reason }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
