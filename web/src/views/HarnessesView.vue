<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ServerCog } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import { Button } from '@/components/ui/button'
import { harnessIcon } from '@/components/governance/harness-icons'
import { api } from '@/lib/api'
import { t, type MessageKey } from '@/i18n'
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
    error.value = err instanceof Error ? err.message : t('harnesses.loadError')
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

/** The service describes known integrations by harness id; other notes are shown as sent. */
const supportNotes: Readonly<Record<string, MessageKey>> = { dsh: 'harnesses.noteDsh', 'oh-my-pi': 'harnesses.noteOhMyPi' }
function supportNote(h: HarnessDiscoveryItem): string | null {
  if (h.supportNote === null) return null
  const key = supportNotes[h.id]
  return key ? t(key) : h.supportNote
}

function supportBadge(h: HarnessDiscoveryItem): { label: string; classes: string } {
  if (h.support === 'future') {
    return { label: t('harnesses.future'), classes: 'border-dashed border-info/40 bg-info/5 text-info' }
  }
  return { label: t('harnesses.current'), classes: toneClasses.neutral }
}

function detectedBadge(h: HarnessDiscoveryItem): { label: string; classes: string } {
  return h.detected
    ? { label: t('harnesses.detected'), classes: toneClasses.positive }
    : { label: t('harnesses.notDetected'), classes: toneClasses.neutral }
}

function managedBadge(h: HarnessDiscoveryItem): { label: string; classes: string } {
  return h.managed
    ? { label: t('harnesses.managed'), classes: toneClasses.positive }
    : { label: t('harnesses.unmanaged'), classes: h.detected ? toneClasses.warning : toneClasses.neutral }
}
</script>

<template>
  <div class="page">
    <PageHeader
      :title="t('harnesses.title')"
      :description="t('harnesses.description')">
      <template #actions>
        <Button
          size="sm"
          variant="outline"
          @click="loadDiscovery"
          :disabled="loading">
          {{ loading ? t('harnesses.scanning') : t('common.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div v-if="error" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">
      {{ error }}
      <button class="ml-2 underline" @click="loadDiscovery">{{ t('common.retry') }}</button>
    </div>

    <div v-if="loading" class="py-12 text-center text-sm text-muted-foreground" role="status">
      <ServerCog class="mx-auto mb-3 size-8 animate-pulse" />
      {{ t('harnesses.loading') }}
    </div>

    <template v-else-if="discovery">
      <div class="mb-4 grid gap-3 sm:grid-cols-2">
        <article class="panel p-3">
          <p class="eyebrow">{{ t('harnesses.detected') }}</p>
          <p class="mt-1 text-2xl font-semibold">{{ detectedCount }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ t('harnesses.detectedNote') }}</p>
        </article>
        <article class="panel p-3">
          <p class="eyebrow">{{ t('harnesses.managed') }}</p>
          <p class="mt-1 text-2xl font-semibold">{{ managedCount }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ t('harnesses.managedNote') }}</p>
        </article>
      </div>

      <section class="panel mb-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{{ t('harnesses.listTitle') }}</h2>
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
                  <span class="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40"><component :is="harnessIcon(h.id)" class="size-4" aria-hidden="true" /></span>
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
                  v-if="supportNote(h)"
                  class="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {{ supportNote(h) }}
                </p>
                <dl v-if="h.detected" class="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt class="text-muted-foreground">{{ t('harnesses.version') }}</dt>
                    <dd class="mt-0.5 font-mono">{{ h.version ?? t('common.unknown') }}</dd>
                  </div>
                  <div class="sm:col-span-2">
                    <dt class="text-muted-foreground">{{ t('harnesses.plugin') }}</dt>
                    <dd class="mt-0.5 break-all font-mono" :class="{ 'text-positive': h.managed }">
                      {{ h.amosPluginPath ?? '—' }}
                    </dd>
                  </div>
                </dl>
                <p
                  v-else-if="h.support === 'future' && !h.supportNote"
                  class="mt-3 text-xs text-muted-foreground">
                  {{ t('harnesses.futureNote') }}
                </p>
              </div>
            </div>
          </article>
        </div>
        <div v-if="rows.length === 0" class="p-8 text-center">
          <ServerCog class="mx-auto mb-3 size-12 text-muted-foreground/40" />
          <h3 class="font-medium text-foreground">{{ t('harnesses.noneTitle') }}</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ t('harnesses.noneDescription') }}
          </p>
        </div>
      </section>
    </template>
  </div>
</template>
