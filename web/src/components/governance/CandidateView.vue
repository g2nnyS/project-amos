<script setup lang="ts">
import { computed } from 'vue'
import type { Candidate, RuleRecord } from '@/types'

const props = defineProps<{ candidate: Candidate; before?: Candidate | null }>()
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
function fields(a: RuleRecord | undefined, b: RuleRecord | undefined) {
  const left = (a ?? {}) as unknown as Record<string, unknown>
  const right = (b ?? {}) as unknown as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map(key => ({ key, before: show(left[key]), after: show(right[key]) }))
}
function show(value: unknown): string {
  if (value === undefined) return '（无）'
  return JSON.stringify(value, null, 2) ?? 'null'
}
</script>

<template>
  <section class="panel overflow-hidden">
    <div class="panel-header"><div><h2 class="panel-title">{{ before ? '候选差异' : '完整候选' }}</h2><p class="panel-kicker">包含全部规则字段与激活集合；元数据不是工具执行授权。</p></div></div>
    <div v-if="before" class="divide-y divide-border">
      <div class="p-4 text-xs"><h3 class="font-semibold">激活集合</h3><div class="mt-2 grid gap-3 sm:grid-cols-2"><div><p class="text-muted-foreground">当前已发布</p><pre class="mt-1 whitespace-pre-wrap break-all">{{ show(before.activation) }}</pre></div><div><p class="text-muted-foreground">提案候选</p><pre class="mt-1 whitespace-pre-wrap break-all">{{ show(candidate.activation) }}</pre></div></div></div>
      <p v-if="!changes.length" class="p-4 text-xs text-muted-foreground">规则字段没有变化。</p>
      <details v-for="change in changes" :key="change.id" class="p-4" open>
        <summary class="cursor-pointer text-sm font-medium">{{ change.id }} <span class="ml-2 text-xs text-muted-foreground">{{ !change.a ? '新增' : !change.b ? '移除' : '修改' }}</span></summary>
        <div v-for="field in change.fields" :key="field.key" class="mt-3 border-t border-border pt-3 text-xs"><p class="font-mono text-muted-foreground">{{ field.key }}</p><div class="mt-1 grid gap-3 sm:grid-cols-2"><div><span class="text-muted-foreground">当前</span><pre class="whitespace-pre-wrap break-all">{{ field.before }}</pre></div><div><span class="text-muted-foreground">候选</span><pre class="whitespace-pre-wrap break-all">{{ field.after }}</pre></div></div></div>
      </details>
    </div>
    <div v-else class="divide-y divide-border">
      <div class="p-4 text-xs"><h3 class="font-semibold">激活集合</h3><pre class="mt-2 whitespace-pre-wrap break-all">{{ show(candidate.activation) }}</pre><p class="mt-2 text-muted-foreground">includedRuleIds 为 null 表示包含全部规则。</p></div>
      <details v-for="rule in candidate.rules" :key="rule.id" class="p-4"><summary class="cursor-pointer text-sm font-medium">{{ rule.id }} <span class="ml-2 text-xs text-muted-foreground">{{ rule.dimension }} · {{ rule.on_hit }}</span></summary><pre class="mt-3 overflow-x-auto whitespace-pre-wrap break-all text-xs">{{ show(rule) }}</pre></details>
    </div>
  </section>
</template>
