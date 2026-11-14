<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ServerCog, CheckCircle2, XCircle, Info } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { HarnessDiscoveryResult, HarnessInstallation } from '@/types'

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

function harnessLabel(harness: 'pi' | 'opencode'): string {
  return harness === 'pi' ? 'Pi' : 'OpenCode'
}

function statusTone(installation: HarnessInstallation): string {
  return installation.amosPluginInstalled
    ? 'border-positive/30 bg-positive/5 text-positive'
    : 'border-warning/30 bg-warning/5 text-warning'
}

function statusLabel(installation: HarnessInstallation): string {
  return installation.amosPluginInstalled ? '已安装 Amos 插件' : '未安装 Amos 插件'
}

const managed = () => discovery.value?.installations.filter(i => i.amosPluginInstalled) ?? []
const unmanaged = () => discovery.value?.installations.filter(i => !i.amosPluginInstalled) ?? []
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
      <strong class="text-foreground">探测范围：</strong>本功能扫描常见的 Pi 和 OpenCode 安装路径（如 ~/.pi、~/.opencode、/opt 等），检查 Amos 插件的安装状态。探测结果为快照，不保证找到所有安装或反映实时运行状态。
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
      <div class="mb-4 grid gap-3 sm:grid-cols-3">
        <article class="panel p-3">
          <p class="eyebrow">已扫描路径</p>
          <p class="mt-1 text-2xl font-semibold">{{ discovery.scannedPaths.length }}</p>
          <p class="mt-1 text-xs text-muted-foreground">检查的安装位置</p>
        </article>
        <article class="panel p-3">
          <p class="eyebrow">发现 Harness</p>
          <p class="mt-1 text-2xl font-semibold">{{ discovery.installations.length }}</p>
          <p class="mt-1 text-xs text-muted-foreground">找到的 Harness 实例</p>
        </article>
        <article class="panel p-3">
          <p class="eyebrow">受 Amos 管理</p>
          <p class="mt-1 text-2xl font-semibold">{{ managed().length }}</p>
          <p class="mt-1 text-xs text-muted-foreground">已安装 Amos 插件</p>
        </article>
      </div>

      <section v-if="managed().length > 0" class="panel mb-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">受管理的 Harness</h2>
            <p class="panel-kicker">已安装 Amos 插件，可接受治理规则。</p>
          </div>
        </div>
        <div class="divide-y">
          <article 
            v-for="(installation, idx) in managed()" 
            :key="idx" 
            class="p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <CheckCircle2 class="size-4 shrink-0 text-positive" />
                  <h3 class="font-medium">{{ harnessLabel(installation.harness) }}</h3>
                  <span 
                    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
                    :class="statusTone(installation)">
                    {{ statusLabel(installation) }}
                  </span>
                </div>
                <dl class="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt class="text-muted-foreground">安装路径</dt>
                    <dd class="mt-0.5 break-all font-mono">{{ installation.path }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">版本</dt>
                    <dd class="mt-0.5 font-mono">{{ installation.version ?? '未知' }}</dd>
                  </div>
                  <div class="sm:col-span-2">
                    <dt class="text-muted-foreground">Amos 插件路径</dt>
                    <dd class="mt-0.5 break-all font-mono text-positive">
                      {{ installation.amosPluginPath ?? '—' }}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section v-if="unmanaged().length > 0" class="panel mb-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">未管理的 Harness</h2>
            <p class="panel-kicker">未安装 Amos 插件，无法接受治理规则。</p>
          </div>
        </div>
        <div class="divide-y">
          <article 
            v-for="(installation, idx) in unmanaged()" 
            :key="idx" 
            class="p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <XCircle class="size-4 shrink-0 text-warning" />
                  <h3 class="font-medium">{{ harnessLabel(installation.harness) }}</h3>
                  <span 
                    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
                    :class="statusTone(installation)">
                    {{ statusLabel(installation) }}
                  </span>
                </div>
                <dl class="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt class="text-muted-foreground">安装路径</dt>
                    <dd class="mt-0.5 break-all font-mono">{{ installation.path }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">版本</dt>
                    <dd class="mt-0.5 font-mono">{{ installation.version ?? '未知' }}</dd>
                  </div>
                </dl>
                <div class="mt-3 rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
                  <Info class="mb-1 inline size-3" />
                  需要手动安装 Amos 插件才能使该 Harness 受治理规则管理。
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section v-if="discovery.installations.length === 0" class="panel p-8 text-center">
        <ServerCog class="mx-auto mb-3 size-12 text-muted-foreground/40" />
        <h3 class="font-medium">未发现 Harness 安装</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          扫描了 {{ discovery.scannedPaths.length }} 个路径，未找到 Pi 或 OpenCode 安装。
        </p>
        <p class="mt-2 text-xs text-muted-foreground">
          如果您已安装 Harness 但未被探测到，可能位于非标准路径。
        </p>
      </section>

      <details class="panel mt-4">
        <summary class="cursor-pointer p-3 text-xs font-medium text-muted-foreground hover:text-foreground">
          已扫描路径 ({{ discovery.scannedPaths.length }})
        </summary>
        <div class="border-t px-3 py-2">
          <ul class="space-y-1 text-xs">
            <li 
              v-for="(path, idx) in discovery.scannedPaths" 
              :key="idx" 
              class="font-mono text-muted-foreground">
              {{ path }}
            </li>
          </ul>
        </div>
      </details>
    </template>
  </div>
</template>
