import { computed, ref } from 'vue'
import type { ToastItem, ToastVariant } from '../types/index.js'

const items = ref<ToastItem[]>([])
let sequence = 0
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const visible = computed(() => items.value.slice(0, 2))

function dismiss(id: string): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
  items.value = items.value.filter(item => item.id !== id)
}

export function useToast() {
  function toast(title: string, description?: string, variant: ToastVariant = 'info'): void {
    // Repeated failures stay available until dismissed, without stacking copies.
    if (variant === 'error' && items.value.some(item => item.variant === variant && item.title === title && item.description === description)) return
    const item = { id: `toast-${++sequence}`, title, description, variant }
    items.value.push(item)
    if (variant !== 'error') timers.set(item.id, setTimeout(() => dismiss(item.id), variant === 'success' ? 5000 : 7000))
  }
  return { toasts: visible, toast, dismiss }
}
