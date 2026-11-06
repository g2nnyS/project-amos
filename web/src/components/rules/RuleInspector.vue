<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { X, FileText, Zap, Bookmark, Code } from 'lucide-vue-next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { CandidateActivation, RuleRecord } from '@/types'

const props = defineProps<{
  rule: RuleRecord
  activation: CandidateActivation
  publishedVersion: number | null
}>()
const emit = defineEmits<{ close: [] }>()

const activeTab = ref('semantics')
const closeButton = ref<HTMLButtonElement | null>(null)

const included = computed(() => {
  const inc = props.activation.includedRuleIds
  if (inc === null) return true
  return inc.includes(props.rule.id)
})
const excluded = computed(() => props.activation.excludedRuleIds.includes(props.rule.id))
const active = computed(() => included.value && !excluded.value)

function predicateSummary(p: RuleRecord['predicate']): string {
  if (!p || p.length === 0) return '无机械命中条件（建议性规则）'
  return p.map(item => `${item.op}(${values(item).join(', ')})`).join(' · ')
}
function values(p: NonNullable<RuleRecord['predicate']>[number]): string[] {
  return Object.values(p.args)[0] ?? []
}
function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

onMounted(() => closeButton.value?.focus())
watch(() => props.rule.id, () => { activeTab.value = 'semantics' })

const activationLabel = computed(() => {
  if (excluded.value) return { text: '本地已排除', tone: 'muted' as const }
  if (active.value) return { text: '本地已选中', tone: 'info' as const }
  return { text: '本地未包含', tone: 'muted' as const }
})
</script>

<template>
  <aside class="rule-inspector flex h-full flex-col border-l border-border bg-card" role="complementary" aria-label="规则上下文检查器">
    <div class="flex h-[60px] shrink-0 items-center justify-between border-b border-border px-4">
      <div class="min-w-0">
        <h2 class="truncate text-sm font-semibold" :title="rule.id">{{ rule.id }}</h2>
        <p class="truncate text-[11px] text-muted-foreground">{{ rule.dimension }} · {{ rule.policy_class }}</p>
      </div>
      <button ref="closeButton" type="button" class="ml-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border hover:bg-accent" aria-label="关闭检查器" @click="emit('close')"><X class="size-4" /></button>
    </div>
    <div class="border-b border-border px-4 py-2.5">
      <div class="flex flex-wrap items-center gap-2 text-[11px]">
        <span class="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5" :class="active ? 'border-info/30 bg-info/10 text-info' : 'border-border bg-muted text-muted-foreground'">
          <span class="size-1.5 rounded-full" :class="active ? 'bg-info' : 'bg-muted-foreground'" />
          {{ activationLabel.text }}
        </span>
        <span class="rounded border border-border px-1.5 py-0.5 text-muted-foreground">{{ rule.on_hit }}</span>
        <span class="rounded border border-border px-1.5 py-0.5 text-muted-foreground">{{ rule.enforcement }}</span>
        <span v-if="publishedVersion" class="text-muted-foreground">版本 {{ publishedVersion }}</span>
      </div>
      <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">本地激活集合只决定治理快照的选取；运行时是否加载未知，发布不授予执行权限。</p>
    </div>
    <Tabs v-model="activeTab" class="min-h-0 flex-1 flex flex-col">
      <TabsList class="mx-4 mt-3 grid w-auto grid-cols-4">
        <TabsTrigger value="semantics" class="text-[11px]"><FileText class="mr-1 size-3" />语义</TabsTrigger>
        <TabsTrigger value="execution" class="text-[11px]"><Zap class="mr-1 size-3" />执行</TabsTrigger>
        <TabsTrigger value="evidence" class="text-[11px]"><Bookmark class="mr-1 size-3" />证据</TabsTrigger>
        <TabsTrigger value="raw" class="text-[11px]"><Code class="mr-1 size-3" />原始</TabsTrigger>
      </TabsList>
      <div class="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <TabsContent value="semantics" class="mt-0 space-y-4 text-xs">
          <div><p class="field-label">说明 narrative</p><p class="mt-1.5 whitespace-pre-wrap break-words leading-relaxed">{{ rule.narrative || '—' }}</p></div>
          <dl class="grid grid-cols-2 gap-3">
            <div><dt class="text-[11px] text-muted-foreground">维度</dt><dd>{{ rule.dimension }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">层级</dt><dd>{{ rule.level }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">分类</dt><dd>{{ rule.policy_class }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">表达力</dt><dd>{{ rule.expressivity }}</dd></div>
          </dl>
          <div><p class="field-label">命中条件 predicate</p><p v-if="!rule.predicate || rule.predicate.length === 0" class="mt-1.5 text-muted-foreground">建议性规则，无机械命中条件。</p><ul v-else class="mt-1.5 space-y-2"><li v-for="(p, i) in rule.predicate" :key="i" class="rounded-md border border-border p-2"><code class="text-[11px]">{{ p.op }}</code><p class="mt-1 break-all text-muted-foreground">{{ values(p).join(' · ') }}</p></li></ul></div>
        </TabsContent>
        <TabsContent value="execution" class="mt-0 space-y-4 text-xs">
          <dl class="grid grid-cols-2 gap-3">
            <div><dt class="text-[11px] text-muted-foreground">命中裁决 on_hit</dt><dd>{{ rule.on_hit }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">范围 scope</dt><dd>{{ rule.scope }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">声明检查点 enforcement</dt><dd>{{ rule.enforcement }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">属主 owner</dt><dd>{{ rule.owner }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">TTL</dt><dd>{{ rule.ttl ?? '无' }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">本地激活集合</dt><dd :class="active ? 'text-info' : 'text-muted-foreground'">{{ activationLabel.text }}</dd></div>
            <div><dt class="text-[11px] text-muted-foreground">运行时部署状态</dt><dd>未知</dd></div>
          </dl>
          <div class="rounded-md border border-warning/30 bg-warning/5 p-3 text-[11px] leading-relaxed text-warning">
            以上为规则声明的治理语义。发布写入版本与快照产物；只有显式启用 managed 的 Harness 会话才会在工具调用前执行这些规则。
          </div>
        </TabsContent>
        <TabsContent value="evidence" class="mt-0 space-y-4 text-xs">
          <div><p class="field-label">探测 probe</p><p class="mt-1.5 whitespace-pre-wrap break-words text-muted-foreground">{{ rule.probe || '—' }}</p></div>
          <div><p class="field-label">来源 source</p><dl class="mt-1.5 space-y-2"><div v-for="(value, key) in rule.source" :key="key"><dt class="text-[11px] text-muted-foreground">{{ key }}</dt><dd class="whitespace-pre-wrap break-words">{{ value || '—' }}</dd></div></dl></div>
        </TabsContent>
        <TabsContent value="raw" class="mt-0 text-xs">
          <pre class="scroll-thin overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed">{{ json(rule) }}</pre>
        </TabsContent>
      </div>
    </Tabs>
  </aside>
</template>

<style scoped>
.rule-inspector { position: fixed; z-index: 40; right: 0; bottom: 0; width: min(100%, 420px); height: min(80dvh, 760px); border-top: 1px solid hsl(var(--border)); box-shadow: 0 0 30px hsl(220 20% 10% / .2); }
@media (min-width: 1024px) {
  .rule-inspector { position: sticky; top: 0; width: 420px; height: calc(100dvh - 60px); box-shadow: none; }
}
</style>
