<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ServerCog, Info } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { HarnessDiscoveryItem, HarnessDiscoveryResult } from '@/types'

const discovery = ref<HarnessDiscoveryResult | null>(null)
const loading = ref(false)
const error = ref('')

async function loadDiscovery() {
  loading.value = true
  error.value = ''
  discovery.value = null
  try {
    discovery.value = await api.discoverHarnesses()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '探测 Harness 安装失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => { void loadDiscovery() })

const rows = computed(() => {
  const list = discovery.value?.harnesses ?? []
  return [...list].sort((a, b) => {
    if (a.support !== b.support) return a.support === 'current' ? -1 : 1
    if (a.detected !== b.detected) return a.detected ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})

const detectedCount = computed(() => rows.value.filter(h => h.detected).length)
const managedCount = computed(() => rows.value.filter(h => h.managed).length)

type Tone = 'positive' | 'info' | 'warning' | 'neutral'
const toneClasses: Record<Tone, string> = {
  positive: 'border-positive/30 bg-positive/5 text-positive',
  info: 'border-info/30 bg-info/5 text-info',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  neutral: 'border-border bg-muted/60 text-muted-foreground',
}

function supportBadge(h: HarnessDiscoveryItem): { label: string; classes: string } {
  if (h.support === 'future') {
    return { label: '未来支持', classes: 'border-dashed border-info/40 bg-info/5 text-info' }
  }
  return { label: '当前支持', classes: toneClasses.neutral }
}

function detectedBadge(h: HarnessDiscoveryItem): { label: string; classes: string } {
  return h.detected
    ? { label: '已探测到', classes: toneClasses.positive }
    : { label: '未探测到', classes: toneClasses.neutral }
}

function managedBadge(h: HarnessDiscoveryItem): { label: string; classes: string } {
  return h.managed
    ? { label: '已受到管理', classes: toneClasses.positive }
    : { label: '未受管理', classes: h.detected ? toneClasses.warning : toneClasses.neutral }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Harness 探测"
      description="探测本地已安装的 Harness 实例及其 Amos 插件状态。">
      <template #actions>
        <Button
          size="sm"
          variant="outline"
          @click="loadDiscovery"
          :disabled="loading">
          {{ loading ? '探测中…' : '刷新' }}
        </Button>
      </template>
    </PageHeader>

    <div class="mb-4 rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      <Info class="mb-1 mr-1 inline size-3" />
      <strong class="text-foreground">探测范围：</strong>本功能通过 PATH、常见安装目录（如 ~/.pi、~/.opencode、/opt 等）以及 mise shims 探测 Harness 安装，并检查 Amos 插件的安装状态。
      <strong class="text-foreground">「已受到管理」</strong>仅表示已探测到 Amos 插件，不代表该 Harness 当前正在以 enforcing 模式运行或实时接受治理规则。探测结果为快照，不保证找到所有安装或反映实时运行状态。
    </div>

    <div v-if="error" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">
      {{ error }}
      <button class="ml-2 underline" @click="loadDiscovery">重试</button>
    </div>

    <div v-if="loading" class="py-12 text-center text-sm text-muted-foreground" role="status">
      <ServerCog class="mx-auto mb-3 size-8 animate-pulse" />
      正在探测本地 Harness 安装…
    </div>

    <template v-else-if="discovery">
      <div class="mb-4 grid gap-3 sm:grid-cols-2">
        <article class="panel p-3">
          <p class="eyebrow">已探测到</p>
          <p class="mt-1 text-2xl font-semibold">{{ detectedCount }}</p>
          <p class="mt-1 text-xs text-muted-foreground">发现的 Harness 实例</p>
        </article>
        <article class="panel p-3">
          <p class="eyebrow">已受到管理</p>
          <p class="mt-1 text-2xl font-semibold">{{ managedCount }}</p>
          <p class="mt-1 text-xs text-muted-foreground">Amos 插件已安装</p>
        </article>
      </div>

      <section class="panel mb-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Harness 列表</h2>
            <p class="panel-kicker">所有当前支持及未来预期支持的 Harness 探测结果。</p>
          </div>
        </div>
        <div class="divide-y">
          <article
            v-for="h in rows"
            :key="h.id"
            class="p-4 transition-colors"
            :class="{ 'bg-muted/30 text-muted-foreground': !h.detected }">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="font-medium" :class="{ 'text-foreground': h.detected }">{{ h.name }}</h3>
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
                    :class="supportBadge(h).classes">
                    {{ supportBadge(h).label }}
                  </span>
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
                    :class="detectedBadge(h).classes">
                    {{ detectedBadge(h).label }}
                  </span>
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
                    :class="managedBadge(h).classes">
                    {{ managedBadge(h).label }}
                  </span>
                </div>
                <p
                  v-if="h.detected && h.path"
                  class="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {{ h.path }}
                </p>
                <p
                  v-if="h.supportNote"
                  class="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {{ h.supportNote }}
                </p>
                <dl v-if="h.detected" class="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt class="text-muted-foreground">版本</dt>
                    <dd class="mt-0.5 font-mono">{{ h.version ?? '未知' }}</dd>
                  </div>
                  <div class="sm:col-span-2">
                    <dt class="text-muted-foreground">Amos 插件路径</dt>
                    <dd class="mt-0.5 break-all font-mono" :class="{ 'text-positive': h.managed }">
                      {{ h.amosPluginPath ?? '—' }}
                    </dd>
                  </div>
                </dl>
                <p
                  v-else-if="h.support === 'future' && !h.supportNote"
                  class="mt-3 text-xs text-muted-foreground">
                  该 Harness 属于未来计划支持的候选，当前尚未探测到安装。
                </p>
              </div>
            </div>
          </article>
        </div>
        <div v-if="rows.length === 0" class="p-8 text-center">
          <ServerCog class="mx-auto mb-3 size-12 text-muted-foreground/40" />
          <h3 class="font-medium text-foreground">未发现 Harness</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            未找到任何已支持或计划支持的 Harness。
          </p>
        </div>
      </section>
    </template>
  </div>
</template>
