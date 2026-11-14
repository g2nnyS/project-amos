<script setup lang="ts">
import { computed, ref } from 'vue'
import { ShieldAlert } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'
const auth = useAuthStore()
const password = ref(''), confirmation = ref('')
const setupRequired = computed(() => auth.authentication?.setupRequired === true)
async function submit() {
  if (auth.loading) return
  if (setupRequired.value) {
    if (password.value.length < 12 || password.value.length > 1024) { auth.error = '密码需为 12 至 1024 个字符。'; return }
    if (password.value !== confirmation.value) { auth.error = '两次输入的密码不一致。'; return }
    try { await auth.setup(password.value); password.value = ''; confirmation.value = '' } catch {}
    return
  }
  try { await auth.loginWith({ method: 'password', password: password.value }); password.value = '' } catch {}
}
</script>
<template>
  <main id="main-content" class="login-shell content-scroll">
    <div class="login-frame">
      <section class="login-surface" aria-labelledby="login-title">
        <div class="login-body">
          <div class="login-head">
            <p class="eyebrow">本地人类会话</p>
            <h1 id="login-title" class="login-title">{{ setupRequired ? '设置登录密码' : '登录控制台' }}</h1>
            <p class="login-lede">{{ setupRequired ? '首次使用请设置登录密码。服务仅保存验证摘要，应用不保存密码。' : '输入密码以解锁本地控制台。应用不会保存密码明文。' }}</p>
          </div>

          <form class="login-form" :aria-busy="auth.loading" @submit.prevent="submit">
            <template v-if="setupRequired">
              <label class="field">
                <span class="field-label">新密码（12 至 1024 个字符）</span>
                <input v-model="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required class="control login-control" />
              </label>
              <label class="field">
                <span class="field-label">确认密码</span>
                <input v-model="confirmation" type="password" autocomplete="new-password" required class="control login-control" />
              </label>
            </template>

            <label v-else class="field">
              <span class="field-label">密码</span>
              <input v-model="password" type="password" autocomplete="current-password" required class="control login-control" />
            </label>

            <p v-if="auth.error" class="login-error" role="alert">{{ auth.error }}</p>
            <Button type="submit" size="sm" class="login-submit w-full" :disabled="auth.loading">{{ auth.loading ? '处理中…' : setupRequired ? '设置密码' : '登录' }}</Button>
          </form>
        </div>

        <div class="login-notice">
          <ShieldAlert class="size-3.5" aria-hidden="true" />
          <p>全局默认与项目覆盖决定 Harness 期望配置；实际模式须以各 Harness 最新加载报告为准。Workflow Gate 独立配置，Managed 不是 OS 沙箱。同 UID 访问不构成可信隔离。</p>
        </div>
      </section>
    </div>
  </main>
</template>
<style scoped>
/* Sits above the inert shell, below toasts (70) and the skip link (80). */
.login-shell {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  padding: 40px 24px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* The veiled, blurred layer is its own fixed element: the scroll container
   stays filter-free, and the shell behind it is the backdrop of this layer. */
.login-shell::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  background-color: hsl(var(--login-scrim));
  backdrop-filter: blur(14px) saturate(1.25) brightness(var(--login-dim));
}

.login-frame {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 400px;
  margin: auto;
}

.login-surface {
  overflow: hidden;
  border: 1px solid hsl(var(--border));
  border-radius: 12px;
  background: hsl(var(--card) / 0.95);
  box-shadow: var(--shadow-pop), inset 0 1px 0 hsl(0 0% 100% / 0.05);
}

.login-body {
  padding: 22px 20px 20px;
}

.login-head {
  display: grid;
  gap: 5px;
}

.login-head .eyebrow {
  display: flex;
  align-items: center;
  gap: 7px;
}

.login-head .eyebrow::before {
  content: "";
  width: 14px;
  height: 1px;
  background: hsl(var(--muted-foreground) / 0.5);
}

.login-title {
  font-size: 17.5px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: hsl(var(--foreground));
}

.login-lede {
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  line-height: 1.6;
}

.login-form {
  display: grid;
  gap: 11px;
  margin-top: 18px;
}

.login-control {
  height: 34px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12.5px;
  transition: border-color 90ms linear, background-color 90ms linear;
}

.login-control:hover {
  border-color: hsl(var(--foreground) / 0.24);
}

.login-control:focus-visible {
  border-color: hsl(var(--ring));
  outline: 2px solid hsl(var(--ring) / 0.5);
  outline-offset: 0;
}

.login-error {
  padding: 7px 9px;
  border: 1px solid hsl(var(--destructive) / 0.25);
  border-radius: 5px;
  background: hsl(var(--destructive) / 0.06);
  color: hsl(var(--destructive));
  font-size: 11.5px;
  line-height: 1.5;
}

.login-submit {
  height: 34px;
  margin-top: 3px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 550;
  letter-spacing: 0.01em;
}

.login-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 20px 14px;
  border-top: 1px solid hsl(var(--hairline));
  background: hsl(var(--surface) / 0.55);
  color: hsl(var(--muted-foreground));
  font-size: 11px;
  line-height: 1.65;
}

.login-notice svg {
  flex: none;
  margin-top: 1px;
  color: hsl(var(--warning));
}

@media (max-width: 480px) {
  .login-shell {
    padding: 20px 14px;
  }
}

@media (max-height: 600px) {
  .login-shell {
    padding-block: 16px;
  }
}
</style>
