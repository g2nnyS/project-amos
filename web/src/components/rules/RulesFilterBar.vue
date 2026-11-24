<script setup lang="ts">
import { computed, ref } from 'vue'
import { Search, X, SlidersHorizontal, ChevronDown } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { t, type MessageKey } from '@/i18n'
import type { RuleOnHit, RulePolicyClass, RuleEnforcement, RuleExpressivity } from '@/types'

const search = defineModel<string>('search', { default: '' })
const dimension = defineModel<string>('dimension', { default: '' })
const policyClass = defineModel<RulePolicyClass | ''>('policyClass', { default: '' })
const onHit = defineModel<RuleOnHit | ''>('onHit', { default: '' })
const enforcement = defineModel<RuleEnforcement | ''>('enforcement', { default: '' })
const expressivity = defineModel<RuleExpressivity | ''>('expressivity', { default: '' })

const emit = defineEmits<{ reset: [] }>()

const moreId = 'rules-filter-more'
const moreExpanded = ref(false)

const hasFilters = computed(() =>
  search.value.trim() ||
  dimension.value ||
  policyClass.value ||
  onHit.value ||
  enforcement.value ||
  expressivity.value,
)

defineProps<{
  dimensions: string[]
  policyClasses: { value: RulePolicyClass; labelKey: MessageKey }[]
  onHits: { value: RuleOnHit; label: string }[]
  enforcements: { value: RuleEnforcement; label: string }[]
  expressivities: { value: RuleExpressivity; labelKey: MessageKey }[]
}>()
</script>

<template>
  <div class="rules-filterbar">
    <div class="rules-filterbar-row">
      <div class="rules-filterbar-search">
        <Search class="rules-filterbar-icon" />
        <input
          v-model="search"
          type="text"
          :aria-label="t('rules.search')"
          :placeholder="t('rules.searchPlaceholder')"
          class="focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <button
          v-if="search"
          type="button"
          class="rules-filterbar-clear"
          :aria-label="t('rules.clearSearch')"
          @click="search = ''"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <select v-model="dimension" :aria-label="t('rules.filterDimension')">
        <option value="">{{ t('rules.allDimensions') }}</option>
        <option v-for="d in dimensions" :key="d" :value="d">{{ d }}</option>
      </select>

      <select v-model="onHit" :aria-label="t('rules.filterOnHit')">
        <option value="">{{ t('rules.allOnHits') }}</option>
        <option v-for="h in onHits" :key="h.value" :value="h.value">{{ h.label }}</option>
      </select>

      <button
        type="button"
        class="rules-filterbar-more-toggle"
        :aria-expanded="moreExpanded"
        :aria-controls="moreId"
        @click="moreExpanded = !moreExpanded"
      >
        {{ t('rules.moreFilters') }}
        <ChevronDown class="size-3.5 transition-transform" :class="moreExpanded ? 'rotate-180' : ''" />
      </button>

      <Button
        v-if="hasFilters"
        type="button"
        variant="ghost"
        size="sm"
        class="rules-filterbar-reset"
        @click="emit('reset')"
      >
        <SlidersHorizontal class="size-3.5" />
        {{ t('common.reset') }}
      </Button>
    </div>

    <div :id="moreId" v-show="moreExpanded" class="rules-filterbar-more">
      <select v-model="policyClass" :aria-label="t('rules.filterPolicyClass')">
        <option value="">{{ t('rules.allPolicyClasses') }}</option>
        <option v-for="c in policyClasses" :key="c.value" :value="c.value">{{ t(c.labelKey) }}</option>
      </select>

      <select v-model="enforcement" :aria-label="t('rules.filterEnforcement')">
        <option value="">{{ t('rules.allEnforcements') }}</option>
        <option v-for="e in enforcements" :key="e.value" :value="e.value">{{ e.label }}</option>
      </select>

      <select v-model="expressivity" :aria-label="t('rules.filterExpressivity')">
        <option value="">{{ t('rules.allExpressivities') }}</option>
        <option v-for="e in expressivities" :key="e.value" :value="e.value">{{ t(e.labelKey) }}</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.rules-filterbar {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  border: 1px solid hsl(var(--input));
  border-radius: 8px;
  background: hsl(var(--card));
  overflow: hidden;
  container-type: inline-size;
  container-name: filterbar;
}

.rules-filterbar-row,
.rules-filterbar-more {
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: 0;
  min-height: 38px;
}

.rules-filterbar-more {
  border-top: 1px solid hsl(var(--input));
  background: hsl(var(--surface) / 0.45);
}

.rules-filterbar-search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 180px;
}

.rules-filterbar-search input {
  width: 100%;
  height: 100%;
  padding: 0 28px 0 32px;
  border: 0;
  background: transparent;
  color: hsl(var(--foreground));
  font-size: 12.5px;
  line-height: 1.4;
  border-radius: 0;
}

.rules-filterbar-search input::placeholder {
  color: hsl(var(--muted-foreground));
}

.rules-filterbar-icon {
  position: absolute;
  left: 10px;
  width: 14px;
  height: 14px;
  color: hsl(var(--muted-foreground));
  pointer-events: none;
}

.rules-filterbar-clear {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: hsl(var(--muted-foreground));
}

.rules-filterbar-clear:hover {
  background: hsl(var(--accent));
  color: hsl(var(--foreground));
}

.rules-filterbar select {
  height: auto;
  min-width: 120px;
  padding: 0 22px 0 10px;
  border: 0;
  border-left: 1px solid hsl(var(--input));
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  font-size: 12px;
  appearance: auto;
  cursor: pointer;
}

.rules-filterbar-more select {
  background: hsl(var(--surface) / 0.45);
}

.rules-filterbar select:focus-visible,
.rules-filterbar-more-toggle:focus-visible,
.rules-filterbar-reset:focus-visible {
  outline: 2px solid hsl(var(--ring) / 0.8);
  outline-offset: -2px;
}

.rules-filterbar-more-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 120px;
  padding: 0 10px;
  border: 0;
  border-left: 1px solid hsl(var(--input));
  background: hsl(var(--card));
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.rules-filterbar-more-toggle:hover {
  background: hsl(var(--accent));
  color: hsl(var(--foreground));
}

.rules-filterbar-reset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 12px;
  border: 0;
  border-left: 1px solid hsl(var(--input));
  border-radius: 0;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  font-weight: 500;
}

.rules-filterbar-reset:hover {
  background: hsl(var(--accent));
  color: hsl(var(--foreground));
}

@container filterbar (max-width: 540px) {
  .rules-filterbar-search {
    min-width: 100%;
    height: 40px;
    border-bottom: 1px solid hsl(var(--input));
  }

  .rules-filterbar select,
  .rules-filterbar-more-toggle,
  .rules-filterbar-reset {
    flex: 1 1 auto;
    min-width: 0;
    height: 38px;
    border-top: 1px solid hsl(var(--input));
    border-left: 0;
  }
}
</style>
