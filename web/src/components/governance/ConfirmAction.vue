<script setup lang="ts">
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogHeader, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
defineProps<{ open: boolean; title: string; description: string; busy?: boolean; variant?: 'default' | 'destructive' }>()
const emit = defineEmits<{ 'update:open': [boolean]; confirm: [] }>()
</script>
<template>
  <AlertDialog :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogContent class="max-w-[calc(100%-2rem)] rounded-md border border-border sm:max-w-md">
      <AlertDialogHeader><AlertDialogTitle>{{ title }}</AlertDialogTitle><AlertDialogDescription>{{ description }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel :disabled="busy">取消</AlertDialogCancel><Button :variant="variant" :disabled="busy" @click="emit('confirm')">{{ busy ? '处理中…' : '确认' }}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
