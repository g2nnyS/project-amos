<script setup lang="ts">
import { Eye, LoaderCircle, ShieldCheck } from 'lucide-vue-next'

const props = defineProps<{
  modelValue: boolean
  label: string
  offLabel: string
  onLabel: string
  id?: string
  describedBy?: string
  busy?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

function set(value: boolean) {
  if (props.disabled || props.busy || value === props.modelValue) return
  emit('update:modelValue', value)
}
</script>

<template>
  <div class="mode-switch" :data-state="modelValue ? 'on' : 'off'" :data-disabled="disabled || undefined">
    <span class="mode-switch-label" :data-active="!modelValue" aria-hidden="true" @click="set(false)">{{ offLabel }}</span>
    <button
      :id="id"
      type="button"
      role="switch"
      class="mode-switch-track"
      :aria-checked="modelValue"
      :aria-label="label"
      :aria-describedby="describedBy"
      :aria-busy="busy || undefined"
      :disabled="disabled"
      @click="set(!modelValue)"
    >
      <span class="mode-switch-thumb">
        <LoaderCircle v-if="busy" class="mode-switch-icon animate-spin" aria-hidden="true" />
        <ShieldCheck v-else-if="modelValue" class="mode-switch-icon" aria-hidden="true" />
        <Eye v-else class="mode-switch-icon" aria-hidden="true" />
      </span>
    </button>
    <span class="mode-switch-label" :data-active="modelValue" aria-hidden="true" @click="set(true)">{{ onLabel }}</span>
  </div>
</template>

<style scoped>
.mode-switch {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.mode-switch-label {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  transition: color 160ms linear;
}

.mode-switch-label[data-active="true"] {
  color: hsl(var(--foreground));
}

.mode-switch[data-state="on"] .mode-switch-label[data-active="true"] {
  color: hsl(var(--positive));
}

.mode-switch[data-disabled] .mode-switch-label {
  cursor: default;
}

.mode-switch-track {
  position: relative;
  flex: none;
  width: 76px;
  height: 40px;
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  background: hsl(var(--muted));
  box-shadow: inset 0 1px 2px hsl(0 0% 0% / 0.06);
  transition: background-color 200ms var(--shell-ease), border-color 200ms var(--shell-ease);
}

.mode-switch[data-state="on"] .mode-switch-track {
  border-color: hsl(var(--positive));
  background: hsl(var(--positive));
}

.mode-switch-track:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 3px;
}

.mode-switch-track:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.mode-switch-track[aria-busy="true"] {
  cursor: progress;
}

.mode-switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: hsl(var(--card));
  color: hsl(var(--muted-foreground));
  box-shadow: 0 1px 3px hsl(0 0% 0% / 0.18), 0 0 0 1px hsl(var(--border));
  transition: transform 200ms var(--shell-ease), color 200ms linear;
}

.mode-switch[data-state="on"] .mode-switch-thumb {
  transform: translateX(36px);
  color: hsl(var(--positive));
  box-shadow: 0 1px 3px hsl(0 0% 0% / 0.22);
}

.mode-switch-icon {
  width: 16px;
  height: 16px;
}
</style>
