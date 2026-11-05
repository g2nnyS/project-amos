<script setup lang="ts">
import { ref } from 'vue'
import { ShieldAlert } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const token = ref('')
async function submit() {
  const value = token.value
  token.value = ''
  try { await auth.login(value) } catch {}
}
</script>

<template>
  <main class="m-auto w-full max-w-[420px] px-5">
    <div class="mb-8 flex items-center gap-3">
      <span class="flex size-10 items-center justify-center rounded-md border border-border bg-card text-xl font-bold">A</span>
      <div>
        <p class="text-xl font-bold tracking-tight">Amos</p>
        <p class="text-xs text-muted-foreground">本地治理控制台</p>
      </div>
    </div>
    <section class="panel p-6">
      <p class="eyebrow">本地人类会话</p>
      <h1 class="mt-2 text-xl font-semibold">登录控制台</h1>
      <p class="mt-2 text-sm leading-relaxed text-muted-foreground">请输入服务启动时创建的 human.token。令牌仅用于登录，不存储在浏览器中。</p>
      <form class="mt-6 space-y-4" @submit.prevent="submit">
        <label class="field">
          <span class="field-label">Human token</span>
          <input v-model="token" type="password" autocomplete="off" required class="h-10 w-full rounded-md border border-input bg-background px-3" />
        </label>
        <p v-if="auth.error" class="text-xs text-destructive" role="alert">{{ auth.error }}</p>
        <Button type="submit" class="w-full" :disabled="auth.loading">{{ auth.loading ? '登录中…' : '登录' }}</Button>
      </form>
    </section>
    <div class="mt-5 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
      <ShieldAlert class="mb-1 inline size-4" />
      默认插件仍为观察模式；受管拦截需在项目中显式启用 managed，且不是 OS 沙箱。同 UID 访问不构成可信隔离。
    </div>
  </main>
</template>
