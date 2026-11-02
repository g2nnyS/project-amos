<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Candidate, RuleRecord } from '@/types'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const props = defineProps<{ candidate: Candidate; before?: Candidate | null }>()
const activeTab = ref('semantic')

const changes = computed(() => {
  if (!props.before) return []
  const old = new Map(props.before.rules.map(rule => [rule.id, rule]))
  const next = new Map(props.candidate.rules.map(rule => [rule.id, rule]))
  return [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
    const a = old.get(id), b = next.get(id)
    if (JSON.stringify(a) === JSON.stringify(b)) return []
    return [{ id, a, b, fields: fields(a, b) }]
  })
})

const activationChanged = computed(() => {
  if (!props.before) return false
  return JSON.stringify(props.before.activation) !== JSON.stringify(props.candidate.activation)
})

const effectiveBefore = computed(() => effectiveRuleIds(props.before))
const effectiveAfter = computed(() => effectiveRuleIds(props.candidate))
const effectiveDiff = computed(() => {
  const added = effectiveAfter.value.filter(id => !effectiveBefore.value.includes(id))
  const removed = effectiveBefore.value.filter(id => !effectiveAfter.value.includes(id))
  return { added, removed }
})

function effectiveRuleIds(candidate: Candidate | null | undefined): string[] {
  if (!candidate) return []
  const rules = candidate.rules
  const activation = candidate.activation
  const included = activation.includedRuleIds
  if (included === null) {
    return rules.filter(r => !activation.excludedRuleIds.includes(r.id)).map(r => r.id)
  }
  return rules.filter(r => included.includes(r.id) && !activation.excludedRuleIds.includes(r.id)).map(r => r.id)
}

function fields(a: RuleRecord | undefined, b: RuleRecord | undefined) {
  const left = (a ?? {}) as unknown as Record<string, unknown>
  const right = (b ?? {}) as unknown as Record<string, unknown>
  const order = ['narrative', 'on_hit', 'scope', 'enforcement', 'expressivity', 'dimension', 'level', 'policy_class', 'owner', 'ttl', 'predicate', 'source', 'probe']
  const all = [...new Set([...order, ...Object.keys(left), ...Object.keys(right)])]
  return all
    .filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .sort((x, y) => {
      const ix = order.indexOf(x), iy = order.indexOf(y)
      if (ix !== -1 && iy !== -1) return ix - iy
      if (ix !== -1) return -1
      if (iy !== -1) return 1
      return x.localeCompare(y)
    })
    .map(key => ({ key, before: show(left[key]), after: show(right[key]) }))
}

function show(value: unknown): string {
  if (value === undefined) return '（无）'
  return JSON.stringify(value, null, 2) ?? 'null'
}

function changeKind(a: RuleRecord | undefined, b: RuleRecord | undefined): string {
  if (!a) return '新增'
  if (!b) return '移除'
  return '修改'
}

const fieldNames: Record<string, string> = {
  narrative: '说明', on_hit: '命中裁决', scope: '范围', enforcement: '执行面',
  expressivity: '表达力', dimension: '维度', level: '层级', policy_class: '分类',
  owner: '属主', ttl: 'TTL', predicate: '命中条件', source: '来源', probe: '探测'
}
</script>

<template>
  <section class="panel overflow-hidden">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">{{ before ? '候选差异' : '完整候选' }}</h2>
        <p class="panel-kicker">包含全部规则字段与激活集合；元数据不是工具执行授权。</p>
      </div>
    </div>
    <Tabs v-model="activeTab">
      <TabsList class="m-4 mb-0">
        <TabsTrigger value="semantic" class="text-[11px]">语义差异</TabsTrigger>
        <TabsTrigger value="activation" class="text-[11px]">激活集合</TabsTrigger>
        <TabsTrigger value="raw" class="text-[11px]">原始 JSON</TabsTrigger>
      </TabsList>
      <TabsContent value="semantic" class="mt-0">
        <div v-if="before" class="divide-y divide-border">
          <div v-if="!changes.length && !activationChanged" class="p-4 text-xs text-muted-foreground">规则字段与激活集合均无变化。</div>
          <div v-if="effectiveDiff.added.length || effectiveDiff.removed.length" class="p-4">
            <h3 class="text-xs font-semibold">本地选中规则变化</h3>
            <p class="mt-1 text-[11px] text-muted-foreground">候选激活集合选取的规则 ID 变化，不表示运行时生效。</p>
            <div class="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <p class="text-[11px] text-info">新增选中</p>
                <ul v-if="effectiveDiff.added.length" class="mt-1 space-y-0.5"><li v-for="id in effectiveDiff.added" :key="id" class="break-all font-mono">+ {{ id }}</li></ul>
                <p v-else class="text-muted-foreground">无</p>
              </div>
              <div>
                <p class="text-[11px] text-warning">移除选中</p>
                <ul v-if="effectiveDiff.removed.length" class="mt-1 space-y-0.5"><li v-for="id in effectiveDiff.removed" :key="id" class="break-all font-mono">- {{ id }}</li></ul>
                <p v-else class="text-muted-foreground">无</p>
              </div>
            </div>
          </div>
          <details v-for="change in changes" :key="change.id" class="p-4" open>
            <summary class="cursor-pointer text-sm font-medium">{{ change.id }} <span class="ml-2 text-xs text-muted-foreground">{{ changeKind(change.a, change.b) }}</span></summary>
            <div v-for="field in change.fields" :key="field.key" class="mt-3 border-t border-border pt-3 text-xs">
              <p class="font-mono text-muted-foreground">{{ fieldNames[field.key] ?? field.key }}</p>
              <div class="mt-1 grid gap-3 sm:grid-cols-2">
                <div class="rounded-md border border-border bg-surface p-2"><span class="text-[10px] text-muted-foreground">当前</span><pre class="mt-1 overflow-x-auto whitespace-pre-wrap break-all">{{ field.before }}</pre></div>
                <div class="rounded-md border border-border bg-surface p-2"><span class="text-[10px] text-muted-foreground">候选</span><pre class="mt-1 overflow-x-auto whitespace-pre-wrap break-all">{{ field.after }}</pre></div>
              </div>
            </div>
          </details>
        </div>
        <div v-else class="divide-y divide-border">
          <details v-for="rule in candidate.rules" :key="rule.id" class="p-4">
            <summary class="cursor-pointer text-sm font-medium">{{ rule.id }} <span class="ml-2 text-xs text-muted-foreground">{{ rule.dimension }} · {{ rule.on_hit }}</span></summary>
            <div class="mt-3 grid gap-3 text-xs sm:grid-cols-2">
              <div><p class="text-[11px] text-muted-foreground">说明</p><p class="mt-1 whitespace-pre-wrap break-words">{{ rule.narrative }}</p></div>
              <div><p class="text-[11px] text-muted-foreground">命中条件</p><p class="mt-1 break-all">{{ rule.predicate ? rule.predicate.map(p => p.op).join(' · ') : '建议性规则' }}</p></div>
            </div>
          </details>
        </div>
      </TabsContent>
      <TabsContent value="activation" class="mt-0">
        <div class="grid gap-4 p-4 text-xs sm:grid-cols-2">
          <div class="rounded-md border border-border bg-surface p-3">
            <p class="font-semibold">本候选</p>
            <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">{{ show(candidate.activation) }}</pre>
            <p class="mt-2 text-[11px] text-muted-foreground">includedRuleIds 为 null 表示包含全部规则。</p>
          </div>
          <div v-if="before" class="rounded-md border border-border bg-surface p-3">
            <p class="font-semibold">当前已发布</p>
            <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">{{ show(before.activation) }}</pre>
            <p class="mt-2 text-[11px] text-muted-foreground">本地选中规则数：{{ effectiveBefore.length }}</p>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="raw" class="mt-0 p-4">
        <div class="grid gap-4 lg:grid-cols-2">
          <div>
            <p class="mb-2 text-[11px] font-semibold">候选 JSON</p>
            <pre class="scroll-thin max-h-[60vh] overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-[11px]">{{ show(candidate) }}</pre>
          </div>
          <div v-if="before">
            <p class="mb-2 text-[11px] font-semibold">当前已发布 JSON</p>
            <pre class="scroll-thin max-h-[60vh] overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-[11px]">{{ show(before) }}</pre>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  </section>
</template>
