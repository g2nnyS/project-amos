<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { DraftRule, Field, Operator } from './model'
import { defaultOperatorForField, fieldOf, operatorsForField, predicate, values } from './model'
import { t } from '@/i18n'

const props = defineProps<{ rule: DraftRule }>()

const fieldOrder: Field[] = ['operations', 'target', 'url_query_key', 'scheme', 'host']

const sourceExpanded = ref(false)
const hasSource = computed(() => props.rule.source !== null)
const sourceSummary = computed(() => {
  if (!props.rule.source) return ''
  const parts = [props.rule.source.repo, props.rule.source.path].map(s => s.trim()).filter(Boolean)
  return parts.length ? parts.join(' · ') : t('ruleForm.source.filled')
})

function setExpression(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'advisory_only') {
    props.rule.expressivity = 'advisory_only'
    props.rule.predicate = null
    props.rule.enforcement = 'advisory'
  } else {
    props.rule.expressivity = 'deterministic'
    props.rule.predicate = [predicate('op_in')]
    props.rule.enforcement = 'runtime'
  }
}

function fieldForRow(p: NonNullable<DraftRule['predicate']>[number]): Field {
  return fieldOf(p.op)
}

function operatorsForRow(p: NonNullable<DraftRule['predicate']>[number]): Operator[] {
  return operatorsForField(fieldForRow(p))
}

function changeField(index: number, event: Event) {
  const field = (event.target as HTMLSelectElement).value as Field
  const op = defaultOperatorForField(field)
  if (props.rule.predicate) props.rule.predicate[index] = predicate(op)
}

function changeOperator(index: number, event: Event) {
  const op = (event.target as HTMLSelectElement).value as Operator
  if (!props.rule.predicate) return
  const prev = props.rule.predicate[index]
  const next = predicate(op)
  // Preserve values when the underlying argument key is the same (e.g. the two path globs).
  if (prev && fieldOf(prev.op) === fieldOf(op) && Object.keys(prev.args)[0] === Object.keys(next.args)[0]) {
    const list = Object.values(next.args)[0]
    const prevList = Object.values(prev.args)[0]
    if (list && prevList) list.push(...prevList)
  }
  props.rule.predicate[index] = next
}

function addCondition() {
  props.rule.predicate?.push(predicate('op_in'))
}

function removeCondition(index: number) {
  props.rule.predicate?.splice(index, 1)
}

function rowValues(p: NonNullable<DraftRule['predicate']>[number]): string[] {
  return values(p)
}

const fieldLabelKey = (field: Field) => `ruleForm.conditionBuilder.fields.${field}` as const
const operatorLabelKey = (op: Operator) => `ruleForm.conditionBuilder.operators.${op}` as const

const previewText = computed(() => {
  const predicateList = props.rule.predicate
  if (!predicateList || predicateList.length === 0) return ''
  const joiner = ` ${t('ruleForm.conditionBuilder.joiner')} `
  return predicateList.map(p => {
    const field = fieldForRow(p)
    const vals = values(p)
    const valueSet = vals.length ? `{${vals.join(', ')}}` : '{}'
    return `${t(fieldLabelKey(field))} ${t(operatorLabelKey(p.op))} ${valueSet}`
  }).join(joiner)
})

// Source citations are optional: edits go through a local draft and write back
// an object only when at least one field is filled, otherwise null.
const sourceDraft = reactive({
  repo: props.rule.source?.repo ?? '',
  rev: props.rule.source?.rev ?? '',
  path: props.rule.source?.path ?? '',
  section: props.rule.source?.section ?? '',
  lines: props.rule.source?.lines ?? '',
  quote: props.rule.source?.quote ?? '',
})
watch(sourceDraft, () => {
  const filled = Object.values(sourceDraft).some(value => value.trim() !== '')
  props.rule.source = filled ? { ...sourceDraft } : null
})
</script>

<template>
  <div class="panel min-w-0">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">{{ t('ruleForm.title') }}</h2>
        <p class="panel-kicker">{{ t('ruleForm.kicker') }}</p>
      </div>
    </div>
    <div class="panel-body space-y-5 text-xs">
      <!-- Condition builder -->
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3 class="panel-title">{{ t('ruleForm.conditionBuilder.heading') }}</h3>
            <p class="panel-kicker">{{ t('ruleForm.conditionBuilder.description') }}</p>
          </div>
        </div>
        <div class="panel-body space-y-4">
          <p v-if="rule.expressivity === 'advisory_only'" class="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground">
            {{ t('ruleForm.advisoryNote') }}
          </p>
          <template v-else>
            <!-- Column headers -->
            <div class="condition-grid hidden text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid">
              <span>{{ t('ruleForm.conditionBuilder.fieldColumn') }}</span>
              <span>{{ t('ruleForm.conditionBuilder.operatorColumn') }}</span>
              <span>{{ t('ruleForm.conditionBuilder.valueColumn') }}</span>
              <span class="sr-only">{{ t('ruleForm.conditionBuilder.actionsColumn') }}</span>
            </div>

            <div v-for="(p, i) in rule.predicate" :key="i" class="space-y-2">
              <div v-if="i > 0" class="flex items-center gap-2 py-1">
                <span class="inline-flex items-center rounded border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                  {{ t('ruleForm.conditionBuilder.joiner') }}
                </span>
              </div>
              <div class="condition-grid items-start gap-3">
                <label class="field">
                  <span class="field-label sm:sr-only">{{ t('ruleForm.conditionBuilder.fieldColumn') }}</span>
                  <select :value="fieldForRow(p)" class="control" @change="changeField(i, $event)">
                    <option v-for="field in fieldOrder" :key="field" :value="field">
                      {{ t(fieldLabelKey(field)) }}
                    </option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label sm:sr-only">{{ t('ruleForm.conditionBuilder.operatorColumn') }}</span>
                  <select :value="p.op" class="control" @change="changeOperator(i, $event)">
                    <option v-for="op in operatorsForRow(p)" :key="op" :value="op">
                      {{ t(operatorLabelKey(op)) }}
                    </option>
                  </select>
                </label>
                <div class="field min-w-0">
                  <span class="field-label sm:sr-only">{{ t('ruleForm.conditionBuilder.valueColumn') }}</span>
                  <div class="space-y-2">
                    <div v-for="(_, j) in rowValues(p)" :key="j" class="flex gap-2">
                      <input v-model="rowValues(p)[j]" :aria-label="t('ruleForm.argLabel', { condition: i + 1, arg: j + 1 })" class="control min-w-0 flex-1" />
                      <button type="button" class="shrink-0 rounded border border-border px-2 py-1 hover:bg-accent" :aria-label="t('ruleForm.removeItem')" @click="rowValues(p).splice(j, 1)">
                        {{ t('ruleForm.removeItem') }}
                      </button>
                    </div>
                    <button type="button" class="w-full rounded border border-dashed border-border px-2 py-1 text-left text-muted-foreground hover:bg-accent" @click="rowValues(p).push('')">
                      + {{ t('ruleForm.addItem') }}
                    </button>
                  </div>
                </div>
                <button type="button" class="shrink-0 self-start rounded border border-border px-2 py-1 hover:bg-accent" :aria-label="t('ruleForm.removeCondition')" @click="removeCondition(i)">
                  {{ t('ruleForm.removeCondition') }}
                </button>
              </div>
            </div>

            <button type="button" class="inline-flex items-center gap-1 rounded border border-border bg-muted px-3 py-1.5 hover:bg-accent" @click="addCondition">
              <span aria-hidden="true">+</span>
              {{ t('ruleForm.addCondition') }}
            </button>

            <!-- Expression preview -->
            <div class="rounded-md border border-border bg-muted/40 p-3">
              <div class="mb-1.5 flex items-center justify-between">
                <span class="field-label">{{ t('ruleForm.conditionBuilder.previewLabel') }}</span>
              </div>
              <div class="min-h-[2.75rem] rounded border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed text-foreground">
                <span v-if="previewText" class="break-words">{{ previewText }}</span>
                <span v-else class="text-muted-foreground">{{ t('ruleForm.conditionBuilder.emptyPreview') }}</span>
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- Action -->
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3 class="panel-title">{{ t('ruleForm.action.heading') }}</h3>
            <p class="panel-kicker">{{ t('ruleForm.action.description') }}</p>
          </div>
        </div>
        <div class="panel-body">
          <label class="field max-w-md">
            <span class="field-label">{{ t('ruleForm.action.label') }}</span>
            <select v-model="rule.on_hit" class="control text-sm font-medium">
              <option value="deny">{{ t('ruleForm.action.deny') }}</option>
              <option value="confirm">{{ t('ruleForm.action.confirm') }}</option>
              <option value="log">{{ t('ruleForm.action.log') }}</option>
            </select>
          </label>
        </div>
      </section>

      <!-- Attributes -->
      <section class="panel">
        <div class="panel-header">
          <h3 class="panel-title">{{ t('ruleForm.attributes.heading') }}</h3>
        </div>
        <div class="panel-body space-y-4">
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="field">
              <span class="field-label">{{ t('ruleFields.id') }}</span>
              <input v-model="rule.id" class="control" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.dimension') }}</span>
              <input v-model="rule.dimension" class="control" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.level') }}</span>
              <input v-model.number="rule.level" type="number" min="0" step="1" class="control" />
            </label>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="field">
              <span class="field-label">{{ t('ruleFields.expressivity') }}</span>
              <select :value="rule.expressivity" class="control" @change="setExpression">
                <option value="deterministic">{{ t('rules.deterministic') }}</option>
                <option value="advisory_only">{{ t('rules.advisoryOnly') }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.policyClass') }}</span>
              <select v-model="rule.policy_class" class="control">
                <option>security</option>
                <option>engineering</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.enforcement') }}</span>
              <select v-model="rule.enforcement" class="control">
                <option v-if="rule.expressivity === 'advisory_only'">advisory</option>
                <template v-else>
                  <option>runtime</option>
                  <option>ci</option>
                  <option>server</option>
                </template>
              </select>
            </label>
          </div>
          <div class="grid gap-3 sm:grid-cols-4">
            <label class="field">
              <span class="field-label">{{ t('ruleFields.scope') }}</span>
              <select v-model="rule.scope" class="control">
                <option>project</option>
                <option>session</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.owner') }}</span>
              <select v-model="rule.owner" class="control">
                <option>human</option>
                <option>agent</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleForm.ttl') }}</span>
              <input :value="rule.ttl ?? ''" :placeholder="t('ruleForm.ttlPlaceholder')" class="control" @input="rule.ttl = ($event.target as HTMLInputElement).value || null" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.probeField') }}</span>
              <input v-model="rule.probe" class="control" />
            </label>
          </div>
          <label class="field">
            <span class="field-label">{{ t('ruleFields.narrativeField') }}</span>
            <textarea v-model="rule.narrative" rows="3" class="control" />
          </label>
          <div class="space-y-2">
            <button v-if="!hasSource && !sourceExpanded" type="button" class="inline-flex items-center gap-1 rounded border border-dashed border-border px-3 py-1.5 text-muted-foreground hover:bg-accent" @click="sourceExpanded = true">
              <span aria-hidden="true">+</span>
              {{ t('ruleForm.source.add') }}
            </button>

            <div v-else-if="hasSource && !sourceExpanded" class="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-2">
              <span class="min-w-0 truncate text-muted-foreground" :title="sourceSummary">{{ sourceSummary }}</span>
              <button type="button" class="shrink-0 rounded border border-border px-2 py-1 hover:bg-accent" @click="sourceExpanded = true">
                {{ t('ruleForm.source.expand') }}
              </button>
            </div>

            <div v-if="sourceExpanded" class="rounded-md border border-border p-3">
              <div class="mb-3 flex items-center justify-between gap-2">
                <span class="px-1 font-semibold">{{ t('ruleFields.sourceField') }}</span>
                <button type="button" class="rounded border border-border px-2 py-1 hover:bg-accent" @click="sourceExpanded = false">
                  {{ t('ruleForm.source.collapse') }}
                </button>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <label v-for="key in (['repo', 'rev', 'path', 'section', 'lines', 'quote'] as const)" :key="key" class="field">
                  <span class="field-label">{{ key }}</span>
                  <textarea v-if="key === 'quote'" v-model="sourceDraft[key]" rows="3" class="control" />
                  <input v-else v-model="sourceDraft[key]" class="control" />
                </label>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.control {
  width: 100%;
  border: 1px solid hsl(var(--input));
  border-radius: 6px;
  background: hsl(var(--background));
  padding: 7px 9px;
  color: hsl(var(--foreground));
}
.condition-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 2fr auto;
}
@media (max-width: 640px) {
  .condition-grid {
    grid-template-columns: 1fr;
  }
}
</style>
