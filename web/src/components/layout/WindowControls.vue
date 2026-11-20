<script setup lang="ts">
import { Minus, Square, X } from 'lucide-vue-next'
import { t } from '@/i18n'

const bridge = typeof window !== 'undefined' && window.amosDesktop?.isDesktop === true ? window.amosDesktop : undefined
/** Native traffic lights already provide the controls on macOS. */
const active = bridge !== undefined
  && bridge.nativeWindowControls !== true
  && typeof bridge.minimize === 'function'
  && typeof bridge.toggleMaximize === 'function'
  && typeof bridge.close === 'function'

function callWindow(action: 'minimize' | 'toggleMaximize' | 'close') {
  if (bridge === undefined) return
  const request = action === 'minimize' ? bridge.minimize?.() : action === 'toggleMaximize' ? bridge.toggleMaximize?.() : bridge.close?.()
  request?.catch(() => {})
}
</script>

<template>
  <div v-if="active" class="window-controls" role="group" :aria-label="t('app.windowControls')">
    <button type="button" class="window-control" :aria-label="t('app.windowMinimize')" :title="t('app.windowMinimize')" @click="callWindow('minimize')"><Minus class="size-3.5" aria-hidden="true" /></button>
    <button type="button" class="window-control" :aria-label="t('app.windowMaximize')" :title="t('app.windowMaximize')" @click="callWindow('toggleMaximize')"><Square class="size-3" aria-hidden="true" /></button>
    <button type="button" class="window-control window-control-close" :aria-label="t('app.windowClose')" :title="t('app.windowClose')" @click="callWindow('close')"><X class="size-4" aria-hidden="true" /></button>
  </div>
</template>

<style scoped>
.window-controls {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 65;
  display: flex;
  height: var(--topbar-h);
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--background) / 0.9);
  backdrop-filter: blur(8px);
}

.window-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 100%;
  border: 0;
  background: transparent;
  color: hsl(var(--muted-foreground));
  transition: background-color 90ms linear, color 90ms linear;
}

.window-control:hover {
  background: hsl(var(--accent));
  color: hsl(var(--foreground));
}

.window-control-close:hover {
  background: hsl(var(--destructive));
  color: hsl(var(--destructive-foreground));
}
</style>
