<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Plus, Trash2, ChevronDown } from 'lucide-vue-next'
import type { DraftRule, Field, Operator } from './model'
import { conditionText, defaultOperatorForField, fieldOf, operatorsForField, predicate, values } from './model'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'

const props = defineProps<{ rule: DraftRule }>()
const advisoryOnly = computed(() => props.rule.expressivity === 'advisory_only')

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

const previewText = computed(() => props.rule.predicate?.map(conditionText).join(` ${t('ruleForm.conditionBuilder.joiner')} `) ?? '')

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
    <div class="panel-header flex-wrap gap-3">
      <div>
        <h2 class="panel-title">{{ t('ruleForm.title') }}</h2>
        <p class="panel-kicker">{{ t('ruleForm.kicker') }}</p>
      </div>
      <label class="field">
        <span class="field-label">{{ t('ruleFields.expressivity') }}</span>
        <select :value="rule.expressivity" class="control h-9" @change="setExpression">
          <option value="deterministic">{{ t('rules.deterministic') }}</option>
          <option value="advisory_only">{{ t('rules.advisoryOnly') }}</option>
        </select>
      </label>
    </div>
    <div class="panel-body space-y-6 text-xs">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3 id="rule-editor-purpose" class="panel-title">{{ t(advisoryOnly ? 'ruleForm.guidance' : 'ruleForm.conditionBuilder.heading') }}</h3>
            <p id="rule-editor-purpose-note" class="panel-kicker">{{ t(advisoryOnly ? 'ruleForm.advisoryNote' : 'ruleForm.conditionBuilder.description') }}</p>
          </div>
        </div>
        <div class="panel-body space-y-4">
          <textarea v-if="advisoryOnly" v-model="rule.narrative" aria-labelledby="rule-editor-purpose" aria-describedby="rule-editor-purpose-note" rows="3" class="control w-full" />
          <template v-else>
            <!-- Column headers -->
            <div class="condition-header">
              <span>{{ t('ruleForm.conditionBuilder.fieldColumn') }}</span>
              <span>{{ t('ruleForm.conditionBuilder.operatorColumn') }}</span>
              <span>{{ t('ruleForm.conditionBuilder.valueColumn') }}</span>
              <span class="sr-only">{{ t('ruleForm.conditionBuilder.actionsColumn') }}</span>
            </div>

            <div class="space-y-3">
              <div v-for="(p, i) in rule.predicate" :key="i" class="condition-row">
                <div v-if="i > 0" class="condition-joiner">
                  <span class="inline-flex items-center rounded border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {{ t('ruleForm.conditionBuilder.joiner') }}
                  </span>
                </div>
                <div class="condition-grid">
                  <label class="field min-w-0">
                    <span class="field-label lg:sr-only">{{ t('ruleForm.conditionBuilder.fieldColumn') }}</span>
                    <select :value="fieldForRow(p)" class="control h-9 w-full min-w-0" @change="changeField(i, $event)">
                      <option v-for="field in fieldOrder" :key="field" :value="field">
                        {{ t(fieldLabelKey(field)) }}
                      </option>
                    </select>
                  </label>
                  <label class="field min-w-0">
                    <span class="field-label lg:sr-only">{{ t('ruleForm.conditionBuilder.operatorColumn') }}</span>
                    <select :value="p.op" class="control h-9 w-full min-w-0" @change="changeOperator(i, $event)">
                      <option v-for="op in operatorsForRow(p)" :key="op" :value="op">
                        {{ t(operatorLabelKey(op)) }}
                      </option>
                    </select>
                  </label>
                  <div class="field min-w-0">
                    <span class="field-label lg:sr-only">{{ t('ruleForm.conditionBuilder.valueColumn') }}</span>
                    <div class="space-y-2">
                      <div v-for="(_, j) in rowValues(p)" :key="j" class="value-row">
                        <input v-model="rowValues(p)[j]" :aria-label="t('ruleForm.argLabel', { condition: i + 1, arg: j + 1 })" class="control h-9 min-w-0 flex-1" />
                        <Button type="button" variant="outline" size="icon-sm" :title="t('ruleForm.conditionBuilder.removeValue')" :aria-label="t('ruleForm.conditionBuilder.removeValue')" @click="rowValues(p).splice(j, 1)">
                          <Trash2 class="size-3.5" />
                        </Button>
                      </div>
                      <Button type="button" variant="ghost" size="xs" class="w-full justify-start text-muted-foreground" @click="rowValues(p).push('')">
                        <Plus class="size-3" />
                        {{ t('ruleForm.conditionBuilder.addValue') }}
                      </Button>
                    </div>
                  </div>
                  <div class="condition-actions">
                    <Button type="button" variant="outline" size="icon-sm" :title="t('ruleForm.removeCondition')" :aria-label="t('ruleForm.removeCondition')" @click="removeCondition(i)">
                      <Trash2 class="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <Button type="button" variant="secondary" size="sm" @click="addCondition">
              <Plus class="size-3.5" />
              {{ t('ruleForm.addCondition') }}
            </Button>

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
      <section v-if="!advisoryOnly" class="panel">
        <div class="panel-header">
          <div>
            <h3 class="panel-title">{{ t('ruleForm.action.heading') }}</h3>
            <p class="panel-kicker">{{ t('ruleForm.action.description') }}</p>
          </div>
        </div>
        <div class="panel-body">
          <label class="field max-w-md">
            <span class="field-label">{{ t('ruleForm.action.label') }}</span>
            <div class="relative">
              <select v-model="rule.on_hit" class="control h-9 w-full appearance-none pr-8 text-sm font-medium">
                <option value="deny">{{ t('ruleForm.action.deny') }}</option>
                <option value="confirm">{{ t('ruleForm.action.confirm') }}</option>
                <option value="log">{{ t('ruleForm.action.log') }}</option>
              </select>
              <ChevronDown class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            </div>
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
              <input v-model="rule.id" class="control h-9 w-full" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.dimension') }}</span>
              <input v-model="rule.dimension" class="control h-9 w-full" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.level') }}</span>
              <input v-model.number="rule.level" type="number" min="0" step="1" class="control h-9 w-full" />
            </label>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">
              <span class="field-label">{{ t('ruleFields.policyClass') }}</span>
              <div class="relative">
                <select v-model="rule.policy_class" class="control h-9 w-full appearance-none pr-8">
                  <option value="security">{{ t('rules.security') }}</option>
                  <option value="engineering">{{ t('rules.engineering') }}</option>
                </select>
                <ChevronDown class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
            <label v-if="!advisoryOnly" class="field">
              <span class="field-label">{{ t('ruleFields.enforcement') }}</span>
              <div class="relative">
                <select v-model="rule.enforcement" class="control h-9 w-full appearance-none pr-8">
                  <option v-for="checkpoint in (['runtime', 'ci', 'server'] as const)" :key="checkpoint" :value="checkpoint">{{ t(`ruleValues.enforcement.${checkpoint}`) }}</option>
                </select>
                <ChevronDown class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
          </div>
          <div class="grid gap-3 sm:grid-cols-4">
            <label class="field">
              <span class="field-label">{{ t('ruleFields.scope') }}</span>
              <div class="relative">
                <select v-model="rule.scope" class="control h-9 w-full appearance-none pr-8">
                  <option value="project">{{ t('ruleValues.scope.project') }}</option>
                  <option value="session">{{ t('ruleValues.scope.session') }}</option>
                </select>
                <ChevronDown class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.owner') }}</span>
              <div class="relative">
                <select v-model="rule.owner" class="control h-9 w-full appearance-none pr-8">
                  <option value="human">{{ t('roles.human') }}</option>
                  <option value="agent">{{ t('roles.agent') }}</option>
                </select>
                <ChevronDown class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleForm.ttl') }}</span>
              <input :value="rule.ttl ?? ''" :placeholder="t('ruleForm.ttlPlaceholder')" class="control h-9 w-full" @input="rule.ttl = ($event.target as HTMLInputElement).value || null" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('ruleFields.probeField') }}</span>
              <input v-model="rule.probe" class="control h-9 w-full" />
            </label>
          </div>
          <label v-if="!advisoryOnly" class="field">
            <span class="field-label">{{ t('ruleFields.narrativeField') }}</span>
            <textarea v-model="rule.narrative" rows="3" class="control w-full" />
          </label>
          <div class="space-y-2">
            <Button v-if="!hasSource && !sourceExpanded" type="button" variant="outline" size="sm" @click="sourceExpanded = true">
              <Plus class="size-3.5" />
              {{ t('ruleForm.source.add') }}
            </Button>

            <div v-else-if="hasSource && !sourceExpanded" class="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-2">
              <span class="min-w-0 truncate text-muted-foreground" :title="sourceSummary">{{ sourceSummary }}</span>
              <Button type="button" variant="ghost" size="xs" @click="sourceExpanded = true">
                {{ t('ruleForm.source.expand') }}
              </Button>
            </div>

            <div v-if="sourceExpanded" class="rounded-md border border-border p-3">
              <div class="mb-3 flex items-center justify-between gap-2">
                <span class="px-1 font-semibold">{{ t('ruleFields.sourceField') }}</span>
                <Button type="button" variant="ghost" size="xs" @click="sourceExpanded = false">
                  {{ t('ruleForm.source.collapse') }}
                </Button>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <label v-for="key in (['repo', 'rev', 'path', 'section', 'lines', 'quote'] as const)" :key="key" class="field">
                  <span class="field-label">{{ t(`ruleForm.source.labels.${key}`) }}</span>
                  <textarea v-if="key === 'quote'" v-model="sourceDraft[key]" rows="3" class="control w-full" />
                  <input v-else v-model="sourceDraft[key]" class="control h-9 w-full" />
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
  border: 1px solid hsl(var(--input));
  border-radius: 6px;
  background: hsl(var(--background));
  padding: 7px 9px;
  color: hsl(var(--foreground));
  font-size: 12px;
  line-height: 1.25;
}
.control:focus-visible {
  outline: 2px solid hsl(var(--ring) / 0.7);
  outline-offset: 0;
}
select.control {
  appearance: auto;
}
select.control.appearance-none {
  appearance: none;
}

.condition-header {
  display: none;
  align-items: center;
  gap: 12px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
}
.condition-grid {
  display: grid;
  align-items: start;
  gap: 12px;
}
.condition-joiner {
  display: flex;
  align-items: center;
  padding: 2px 0 6px;
}
.condition-actions {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding-top: 18px;
}
.value-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

@media (min-width: 1024px) {
  .condition-header {
    display: grid;
    grid-template-columns: minmax(140px, 1.25fr) minmax(150px, 1fr) minmax(220px, 2fr) 40px;
    padding: 0 2px;
  }
  .condition-grid {
    grid-template-columns: minmax(140px, 1.25fr) minmax(150px, 1fr) minmax(220px, 2fr) 40px;
  }
  .condition-actions {
    padding-top: 0;
  }
}

@media (max-width: 1023px) {
  .condition-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .condition-actions {
    justify-content: flex-start;
    padding-top: 0;
  }
  .value-row {
    max-width: 100%;
  }
}
</style>
