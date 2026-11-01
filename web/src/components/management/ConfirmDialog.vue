<script setup lang="ts">
import { computed } from 'vue'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description: string
    confirmLabel?: string
    cancelLabel?: string
    destructive?: boolean
  }>(),
  {
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    destructive: false,
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

function handleConfirm() {
  emit('confirm')
  emit('update:open', false)
}
</script>

<template>
  <AlertDialog v-model:open="isOpen">
    <AlertDialogContent class="sm:max-w-md">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        <AlertDialogDescription>{{ description }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter class="gap-2">
        <AlertDialogCancel>{{ cancelLabel }}</AlertDialogCancel>
        <Button :variant="destructive ? 'destructive' : 'default'" @click="handleConfirm">
          {{ confirmLabel }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
