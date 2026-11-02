<script setup lang="ts">
import { useToast } from '@/composables/useToast'
const { toasts, dismiss } = useToast()
</script>
<template><div class="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite"><div v-for="item in toasts" :key="item.id" class="pointer-events-auto flex gap-3 rounded-md border border-border bg-popover p-3 shadow-lg"><div class="min-w-0 flex-1"><p class="text-sm font-medium">{{ item.title }}</p><p v-if="item.description" class="mt-1 text-xs text-muted-foreground">{{ item.description }}</p></div><button type="button" class="self-start rounded px-1 text-xs text-muted-foreground hover:text-foreground" :aria-label="`关闭提示：${item.title}`" @click="dismiss(item.id)">关闭</button></div></div></template>
