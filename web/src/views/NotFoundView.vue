<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'
import EmptyState from '@/components/common/EmptyState.vue'
</script>

<template>
  <div class="page">
    <EmptyState title="页面不存在" description="请从导航选择治理页面。">
      <RouterLink to="/" class="inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowLeft class="size-4" />返回项目边界
      </RouterLink>
    </EmptyState>
  </div>
</template>
