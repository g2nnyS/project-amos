<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ShieldAlert } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'
import type { AuthMethod } from '@/types'
const auth = useAuthStore()
const mode = ref<AuthMethod>('password')
const password = ref(''), confirmation = ref(''), token = ref('')
const session = computed(() => auth.session)
const setupRequired = computed(() => auth.authentication?.setupRequired === true)
const needsVerification = computed(() => setupRequired.value && !auth.setupGranted && session.value?.role !== 'human')
const methods = computed(() => auth.methods.filter(method => !setupRequired.value || method !== 'password'))
const systemLabel = computed(() => auth.authentication?.systemLabel ?? '系统认证')
watch(methods, available => { if (!available.includes(mode.value)) mode.value = available[0] ?? 'token' }, { immediate: true })
async function submit() {
  if (auth.loading) return
  if (setupRequired.value) {
    if (password.value.length < 12 || password.value.length > 1024) { auth.error = '密码需为 12 至 1024 个字符。'; return }
    if (password.value !== confirmation.value) { auth.error = '两次输入的密码不一致。'; return }
    if (needsVerification.value && mode.value === 'token' && !token.value) { auth.error = '请提供一次性 human token 完成身份验证。'; return }
    const verification = !needsVerification.value ? undefined : mode.value === 'system' ? { method: 'system' as const } : { token: token.value }
    try { await auth.setup(password.value, verification); password.value = ''; confirmation.value = ''; token.value = '' } catch {}
    return
  }
  try {
    if (mode.value === 'token') await auth.login(token.value)
    else if (mode.value === 'system') await auth.loginWith({ method: 'system' })
    else await auth.loginWith({ method: 'password', password: password.value })
    password.value = ''; token.value = ''
  } catch {}
}
</script>
<template>
  <main id="main-content" class="m-auto w-full max-w-[420px] px-5">
    <div class="mb-8 flex items-center gap-3"><span class="flex size-10 items-center justify-center rounded-md border border-border bg-card text-xl font-bold">A</span><div><p class="text-xl font-bold tracking-tight">Amos</p><p class="text-xs text-muted-foreground">本地治理控制台</p></div></div>
    <section class="panel p-6">
      <p class="eyebrow">本地人类会话</p>
      <h1 class="mt-2 text-xl font-semibold">{{ setupRequired ? '设置登录密码' : '登录控制台' }}</h1>
      <p class="mt-2 text-sm leading-relaxed text-muted-foreground">{{ setupRequired ? '首次使用请设置登录密码。服务仅保存验证摘要，浏览器不保存密码。' : '选择登录方式。凭据仅用于登录，不会存储在浏览器中。' }}</p>
      <form class="mt-6 space-y-4" @submit.prevent="submit">
        <template v-if="setupRequired">
          <label class="field"><span class="field-label">新密码（12 至 1024 个字符）</span><input v-model="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required class="h-10 w-full rounded-md border border-input bg-background px-3" /></label>
          <label class="field"><span class="field-label">确认密码</span><input v-model="confirmation" type="password" autocomplete="new-password" required class="h-10 w-full rounded-md border border-input bg-background px-3" /></label>
          <template v-if="needsVerification">
            <div class="flex gap-2"><button v-if="methods.includes('token')" type="button" :aria-pressed="mode==='token'" class="rounded border px-3 py-2 text-sm" @click="mode='token'">Token 验证</button><button v-if="methods.includes('system')" type="button" :aria-pressed="mode==='system'" class="rounded border px-3 py-2 text-sm" @click="mode='system'">{{ systemLabel }}</button></div>
            <label v-if="mode==='token' && methods.includes('token')" class="field"><span class="field-label">一次性 human token</span><input v-model="token" type="password" autocomplete="off" required class="h-10 w-full rounded-md border border-input bg-background px-3" /></label>
            <p v-else-if="mode==='system'" class="text-sm text-muted-foreground">提交后通过{{ systemLabel }}完成身份验证。</p>
          </template>
        </template>
        <template v-else>
          <div class="flex gap-2"><button v-if="methods.includes('password')" type="button" :aria-pressed="mode==='password'" class="rounded border px-3 py-2 text-sm" @click="mode='password'">密码</button><button v-if="methods.includes('token')" type="button" :aria-pressed="mode==='token'" class="rounded border px-3 py-2 text-sm" @click="mode='token'">Token 恢复</button><button v-if="methods.includes('system')" type="button" :aria-pressed="mode==='system'" class="rounded border px-3 py-2 text-sm" @click="mode='system'">{{ systemLabel }}</button></div>
          <label v-if="mode==='password'" class="field"><span class="field-label">密码</span><input v-model="password" type="password" autocomplete="current-password" required class="h-10 w-full rounded-md border border-input bg-background px-3" /></label>
          <label v-else-if="mode==='token'" class="field"><span class="field-label">Human token</span><input v-model="token" type="password" autocomplete="off" required class="h-10 w-full rounded-md border border-input bg-background px-3" /></label>
          <p v-else class="text-sm text-muted-foreground">登录时通过{{ systemLabel }}验证，无需输入密码或证明。</p>
        </template>
        <p v-if="auth.error" class="text-xs text-destructive" role="alert">{{ auth.error }}</p>
        <Button type="submit" class="w-full" :disabled="auth.loading">{{ auth.loading ? '处理中…' : setupRequired ? '设置密码' : '登录' }}</Button>
      </form>
    </section>
    <div class="mt-5 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning"><ShieldAlert class="mb-1 inline size-4" />默认插件仍为观察模式；受管拦截需在项目中显式启用 managed，且不是 OS 沙箱。同 UID 访问不构成可信隔离。</div>
  </main>
</template>
