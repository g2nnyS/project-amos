<script setup lang="ts">
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogHeader, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
defineProps<{ open: boolean; title: string; description: string; busy?: boolean; variant?: 'default' | 'destructive' }>()
const emit = defineEmits<{ 'update:open': [boolean]; confirm: [] }>()
</script>
<template>
  <AlertDialog :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogContent class="max-w-[calc(100%-2rem)] rounded-md border border-border sm:max-w-md">
      <AlertDialogHeader><AlertDialogTitle>{{ title }}</AlertDialogTitle><AlertDialogDescription>{{ description }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel :disabled="busy">{{ t('common.cancel') }}</AlertDialogCancel><Button :variant="variant" :disabled="busy" @click="emit('confirm')">{{ busy ? t('common.processing') : t('common.confirm') }}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
