<script setup lang="ts">
import type { RuleRecord } from '@/types'
import { fieldOf, values, type Field, type Operator } from './model'
import { t } from '@/i18n'

defineProps<{ rule: RuleRecord }>()

const fieldLabelKey = (field: Field) => `ruleForm.conditionBuilder.fields.${field}` as const
const operatorLabelKey = (op: Operator) => `ruleForm.conditionBuilder.operators.${op}` as const
</script>

<template>
  <section class="panel min-w-0">
    <div class="panel-header">
      <div>
        <p class="panel-kicker">{{ t('ruleDetail.kicker') }}</p>
        <h2 class="panel-title break-all">{{ rule.id }}</h2>
      </div>
      <span class="text-xs text-muted-foreground">{{ rule.on_hit }}</span>
    </div>
    <div class="panel-body space-y-5 text-xs">
      <dl class="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div v-for="item in [[t('ruleFields.dimension'), rule.dimension], [t('ruleFields.level'), rule.level], [t('ruleFields.expressivity'), rule.expressivity], [t('ruleFields.policyClass'), rule.policy_class], [t('ruleFields.enforcement'), rule.enforcement], [t('ruleFields.scope'), rule.scope], [t('ruleFields.owner'), rule.owner], [t('ruleFields.ttl'), rule.ttl ?? t('common.none')]]" :key="String(item[0])">
          <dt class="text-muted-foreground">{{ item[0] }}</dt>
          <dd class="mt-1 break-words">{{ item[1] }}</dd>
        </div>
      </dl>
      <div>
        <h3 class="font-semibold">{{ t('ruleFields.narrativeField') }}</h3>
        <p class="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{{ rule.narrative }}</p>
      </div>
      <div>
        <h3 class="font-semibold">{{ t('ruleFields.predicateField') }}</h3>
        <p v-if="!rule.predicate" class="mt-2 text-muted-foreground">{{ t('ruleDetail.advisory') }}</p>
        <ul v-else class="mt-2 space-y-2">
          <li v-for="(p, i) in rule.predicate" :key="i" class="rounded-md border border-border p-3">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="font-medium">{{ t(fieldLabelKey(fieldOf(p.op))) }}</span>
              <span class="text-muted-foreground">{{ t(operatorLabelKey(p.op)) }}</span>
            </div>
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              <span v-for="v in values(p)" :key="v" class="inline-block rounded border border-border bg-muted/50 px-1.5 py-0.5 break-all text-muted-foreground">{{ v }}</span>
              <span v-if="!values(p).length" class="text-muted-foreground">{{ t('ruleForm.conditionBuilder.emptyPreview') }}</span>
            </div>
          </li>
        </ul>
      </div>
      <div v-if="rule.source">
        <h3 class="font-semibold">{{ t('ruleFields.sourceField') }}</h3>
        <dl class="mt-2 grid gap-2">
          <div v-for="(value, key) in rule.source" :key="key">
            <dt class="text-muted-foreground">{{ key }}</dt>
            <dd class="whitespace-pre-wrap break-words">{{ value }}</dd>
          </div>
        </dl>
      </div>
      <div>
        <h3 class="font-semibold">{{ t('ruleFields.probeField') }}</h3>
        <p class="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{{ rule.probe }}</p>
      </div>
    </div>
  </section>
</template>
