<script setup lang="ts">
import { t, type MessageKey } from '@/i18n'
import { presetCategories, resolvePreset, type SimulationAction } from '@/lib/simulatePresets'

const props = defineProps<{
  workspace: string | null | undefined
}>()

const emit = defineEmits<{
  'apply-preset': [action: SimulationAction]
}>()

const categoryLabels: Record<string, MessageKey> = {
  files: 'simulate.presets.category.files',
  network: 'simulate.presets.category.network',
  security: 'simulate.presets.category.security',
}

const presetLabels: Record<string, MessageKey> = {
  readSource: 'simulate.presets.readSource',
  writeReadme: 'simulate.presets.writeReadme',
  listDirectory: 'simulate.presets.listDirectory',
  shellCommand: 'simulate.presets.shellCommand',
  httpRequest: 'simulate.presets.httpRequest',
  forwardTunnel: 'simulate.presets.forwardTunnel',
  readSshKey: 'simulate.presets.readSshKey',
  httpWithToken: 'simulate.presets.httpWithToken',
}

function apply(presetId: string) {
  for (const category of presetCategories) {
    const preset = category.presets.find(p => p.id === presetId)
    if (preset) {
      emit('apply-preset', resolvePreset(preset, props.workspace))
      return
    }
  }
}
</script>

<template>
  <div class="field">
    <span class="field-label">{{ t('simulate.presets.label') }}</span>
    <div class="space-y-3">
      <div v-for="category in presetCategories" :key="category.id">
        <span class="field-hint mb-1.5 block">{{ t(categoryLabels[category.id]) }}</span>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="preset in category.presets"
            :key="preset.id"
            type="button"
            class="inline-flex items-center rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="apply(preset.id)"
          >
            {{ t(presetLabels[preset.id]) }}
          </button>
        </div>
      </div>
    </div>
    <span class="field-hint mt-1.5">{{ t('simulate.presets.hint') }}</span>
  </div>
</template>
