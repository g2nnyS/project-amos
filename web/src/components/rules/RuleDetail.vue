<script setup lang="ts">
import type { RuleRecord } from '@/types'
import { values } from './model'
defineProps<{ rule: RuleRecord }>()
</script>
<template>
  <section class="panel min-w-0"><div class="panel-header"><div><p class="panel-kicker">规则详情</p><h2 class="panel-title break-all">{{ rule.id }}</h2></div><span class="text-xs text-muted-foreground">{{ rule.on_hit }}</span></div><div class="panel-body space-y-5 text-xs">
    <dl class="grid grid-cols-2 gap-4 sm:grid-cols-3"><div v-for="item in [['维度', rule.dimension], ['层级', rule.level], ['表达力', rule.expressivity], ['分类', rule.policy_class], ['执行面', rule.enforcement], ['范围', rule.scope], ['属主', rule.owner], ['TTL', rule.ttl ?? '无']]" :key="String(item[0])"><dt class="text-muted-foreground">{{ item[0] }}</dt><dd class="mt-1 break-words">{{ item[1] }}</dd></div></dl>
    <div><h3 class="font-semibold">说明 narrative</h3><p class="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{{ rule.narrative }}</p></div>
    <div><h3 class="font-semibold">命中条件 predicate</h3><p v-if="!rule.predicate" class="mt-2 text-muted-foreground">仅建议，无机械命中条件。</p><ul v-else class="mt-2 space-y-2"><li v-for="(p, i) in rule.predicate" :key="i" class="rounded-md border border-border p-2"><code>{{ p.op }}</code><p class="mt-1 break-all text-muted-foreground">{{ values(p).join(' · ') }}</p></li></ul></div>
    <div><h3 class="font-semibold">来源 source</h3><dl class="mt-2 grid gap-2"><div v-for="(value, key) in rule.source" :key="key"><dt class="text-muted-foreground">{{ key }}</dt><dd class="whitespace-pre-wrap break-words">{{ value }}</dd></div></dl></div><div><h3 class="font-semibold">探测 probe</h3><p class="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{{ rule.probe }}</p></div>
  </div></section>
</template>
