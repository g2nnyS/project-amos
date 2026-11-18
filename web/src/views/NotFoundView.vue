<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'
import EmptyState from '@/components/common/EmptyState.vue'
import { t } from '@/i18n'
</script>

<template>
  <div class="page">
    <EmptyState :title="t('notFound.title')" :description="t('notFound.description')">
      <RouterLink to="/" class="inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowLeft class="size-4" />{{ t('notFound.back') }}
      </RouterLink>
    </EmptyState>
  </div>
</template>
