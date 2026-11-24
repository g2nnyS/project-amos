<script setup lang="ts">
import { computed } from 'vue'
import type { RuleOnHit, RulePolicyClass, RuleRecord } from '@/types'
import { t } from '@/i18n'

const props = defineProps<{
  title: string
  policyClass: RulePolicyClass
  rules: RuleRecord[]
  selectedIds: ReadonlySet<string>
  isGlobal: boolean
  selected: string | null
}>()

const emit = defineEmits<{
  select: [rule: RuleRecord, event?: Event]
}>()

const counts = computed(() => {
  const total = props.rules.length
  const selected = props.rules.filter(r => props.selectedIds.has(r.id)).length
  return { total, selected }
})

function actionLabel(onHit: RuleOnHit): string {
  switch (onHit) {
    case 'deny': return t('ruleForm.action.deny')
    case 'confirm': return t('ruleForm.action.confirm')
    case 'log': return t('ruleForm.action.log')
  }
}

function actionClass(onHit: RuleOnHit): string {
  switch (onHit) {
    case 'deny': return 'action-deny'
    case 'confirm': return 'action-confirm'
    case 'log':
    default:
      return 'action-log'
  }
}

function statusClass(isSelected: boolean): string {
  return isSelected ? 'status-selected' : 'status-not'
}
</script>

<template>
  <section class="rules-category">
    <div class="rules-category-header">
      <div class="rules-category-title">
        <h3>{{ title }}</h3>
        <span class="rules-category-count">{{ t('rules.categoryCount', { count: counts.total }) }}</span>
      </div>
      <span class="rules-category-count" :class="statusClass(true)">
        {{ t('rules.categorySelected', { count: counts.selected }) }}
      </span>
    </div>

    <div class="rules-category-scroll overflow-x-auto">
      <table class="data-table rules-category-table min-w-[720px]">
        <thead>
          <tr>
            <th class="w-44">{{ t('ruleFields.id') }}</th>
            <th>{{ t('ruleFields.narrative') }}</th>
            <th class="w-40">{{ t('rules.columnMetadata') }}</th>
            <th class="w-28">{{ t('rules.columnOnHit') }}</th>
            <th class="w-32">{{ isGlobal ? t('rules.columnSelectionGlobal') : t('rules.columnSelection') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="rule in rules"
            :key="rule.id"
            :data-selected="selected === rule.id"
          >
            <td class="rules-category-rule">
              <button
                type="button"
                class="rules-category-link"
                @click="emit('select', rule, $event)"
              >
                <span class="rules-category-id">{{ rule.id }}</span>
              </button>
            </td>
            <td class="rules-category-description">
              <span>{{ rule.narrative || '—' }}</span>
            </td>
            <td class="rules-category-meta-cell">
              <div class="rules-category-meta">
                <span class="rules-meta-pill">{{ rule.dimension }}</span>
                <span class="rules-meta-pill">{{ rule.enforcement }}</span>
                <span v-if="rule.expressivity === 'advisory_only'" class="rules-meta-pill advisory">
                  {{ t('rules.advisoryOnly') }}
                </span>
              </div>
            </td>
            <td class="rules-category-action">
              <span class="rules-pill" :class="actionClass(rule.on_hit)">
                {{ actionLabel(rule.on_hit) }}
              </span>
            </td>
            <td class="rules-category-status">
              <span class="rules-pill" :class="statusClass(selectedIds.has(rule.id))">
                {{ selectedIds.has(rule.id) ? t('rules.selected') : t('rules.notSelected') }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!rules.length" class="rules-category-empty">{{ t('rules.noMatch') }}</p>
    </div>
  </section>
</template>

<style scoped>
.rules-category {
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  background: hsl(var(--card));
  box-shadow: var(--shadow-panel);
  overflow: hidden;
  container-type: inline-size;
  container-name: rules-category;
}

.rules-category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-bottom: 1px solid hsl(var(--hairline));
  background: hsl(var(--surface) / 0.45);
}

.rules-category-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.rules-category-title h3 {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: hsl(var(--foreground));
}

.rules-category-count {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  font-size: 10.5px;
  font-weight: 600;
}

.rules-category-count.status-selected {
  background: hsl(var(--info) / 0.1);
  color: hsl(var(--info));
  border-color: hsl(var(--info) / 0.2);
}

.rules-category-table {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12.5px;
}

.rules-category-table tbody td {
  padding: 10px 14px;
  border-bottom: 1px solid hsl(var(--hairline));
  vertical-align: middle;
}

.rules-category-table tbody tr:last-child td {
  border-bottom: 0;
}

.rules-category-rule {
  width: 1%;
  white-space: nowrap;
}

.rules-category-link {
  display: inline-block;
  max-width: 260px;
  text-align: left;
  border: 0;
  background: transparent;
  color: hsl(var(--primary));
  cursor: pointer;
}

.rules-category-link:hover .rules-category-id {
  text-decoration: underline;
}

.rules-category-id {
  display: block;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  word-break: break-all;
}

.rules-category-description {
  max-width: 360px;
  color: hsl(var(--foreground) / 0.9);
  line-height: 1.4;
}

.rules-category-description span {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.rules-category-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.rules-meta-pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  font-size: 10px;
  font-weight: 500;
  text-transform: lowercase;
}

.rules-meta-pill.advisory {
  background: hsl(var(--warning) / 0.1);
  color: hsl(var(--warning));
  border-color: hsl(var(--warning) / 0.18);
}

.rules-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
  font-weight: 600;
}

.action-deny {
  background: hsl(var(--destructive) / 0.1);
  color: hsl(var(--destructive));
  border-color: hsl(var(--destructive) / 0.18);
}

.action-confirm {
  background: hsl(var(--warning) / 0.12);
  color: hsl(var(--warning));
  border-color: hsl(var(--warning) / 0.22);
}

.action-log {
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  border-color: hsl(var(--border));
}

.status-selected {
  background: hsl(var(--info) / 0.1);
  color: hsl(var(--info));
  border-color: hsl(var(--info) / 0.2);
}

.status-not {
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  border-color: hsl(var(--border));
}

.rules-category-empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

@container rules-category (max-width: 560px) {
  .rules-category-scroll {
    overflow: visible;
  }

  .rules-category-table {
    display: block;
    min-width: 0;
  }

  .rules-category-table thead {
    display: none;
  }

  .rules-category-table tbody,
  .rules-category-table tbody tr {
    display: block;
  }

  .rules-category-table tbody tr {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid hsl(var(--hairline));
  }

  .rules-category-table tbody tr:last-child {
    border-bottom: 0;
  }

  .rules-category-table tbody td {
    display: block;
    width: auto;
    padding: 0;
    border-bottom: 0;
  }

  .rules-category-rule {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
    white-space: normal;
  }

  .rules-category-action {
    grid-column: 2;
    grid-row: 1;
  }

  .rules-category-status {
    grid-column: 3;
    grid-row: 1;
  }

  .rules-category-description {
    grid-column: 1 / -1;
    grid-row: 2;
    max-width: none;
    font-size: 12px;
    color: hsl(var(--foreground) / 0.85);
  }

  .rules-category-description span {
    display: block;
    -webkit-line-clamp: unset;
  }

  .rules-category-meta-cell {
    grid-column: 1 / -1;
    grid-row: 3;
  }

  .rules-category-link {
    display: block;
    max-width: none;
  }

  .rules-category-id {
    font-size: 11.5px;
  }
}
</style>
