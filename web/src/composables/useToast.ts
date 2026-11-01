import { readonly, ref } from 'vue'
import type { ToastItem, ToastVariant } from '../types/index.js'

const items = ref<ToastItem[]>([])
let sequence = 0

export function useToast() {
  function toast(title: string, description?: string, variant: ToastVariant = 'info'): void {
    items.value.push({ id: `toast-${++sequence}`, title, description, variant })
  }
  function dismiss(id: string): void {
    items.value = items.value.filter((item) => item.id !== id)
  }
  return { toasts: readonly(items), toast, dismiss }
}
