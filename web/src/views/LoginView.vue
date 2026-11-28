<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'
import { t } from '@/i18n'
const auth = useAuthStore()
const password = ref(''), confirmation = ref(''), token = ref('')
const setupRequired = computed(() => auth.authentication?.setupRequired === true)
const needsEnrollmentToken = computed(() => setupRequired.value && !auth.setupGranted)
const mode = ref<'password' | 'token'>('password')

// Default to password setup on every fresh login surface; no persisted skip.
watch(setupRequired, () => { mode.value = 'password' }, { immediate: true })

function setMode(next: 'password' | 'token') {
  mode.value = next
  auth.error = null
}

async function submit() {
  if (auth.loading) return
  if (setupRequired.value && mode.value === 'password') {
    if (password.value.length < 12 || password.value.length > 1024) { auth.error = t('auth.errors.passwordLength'); return }
    if (password.value !== confirmation.value) { auth.error = t('auth.passwordMismatch'); return }
    try {
      await auth.setup(password.value, needsEnrollmentToken.value ? { token: token.value } : undefined)
      password.value = ''; confirmation.value = ''; token.value = ''
    } catch {}
    return
  }
  if (mode.value === 'token') {
    try { await auth.login(token.value); token.value = '' } catch {}
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
            <p class="eyebrow">{{ t('auth.eyebrow') }}</p>
            <h1 id="login-title" class="login-title">
              {{ setupRequired && mode === 'password' ? t('auth.setupTitle') : t('auth.loginTitle') }}
            </h1>
            <p class="login-lede">
              {{ setupRequired
                ? (mode === 'token' ? t('auth.loginTokenLede') : t('auth.setupLede'))
                : (mode === 'token' ? t('auth.loginTokenLede') : t('auth.loginLede')) }}
            </p>
          </div>

          <form class="login-form" :aria-busy="auth.loading" @submit.prevent="submit">
            <template v-if="setupRequired">
              <div class="segmented" role="group" :aria-label="t('auth.setupModeLabel')">
                <button
                  type="button"
                  class="segmented-item"
                  :aria-pressed="mode === 'password'"
                  @click="setMode('password')"
                >
                  {{ t('auth.setupModePassword') }}
                </button>
                <button
                  type="button"
                  class="segmented-item"
                  :aria-pressed="mode === 'token'"
                  @click="setMode('token')"
                >
                  {{ t('auth.setupModeToken') }}
                </button>
              </div>
              <p v-if="mode === 'password'" class="login-hint">{{ t('auth.setupOptionalHint') }}</p>
            </template>

            <template v-if="mode === 'password'">
              <template v-if="setupRequired">
                <label class="field">
                  <span class="field-label">{{ t('auth.newPassword') }}</span>
                  <input v-model="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required class="control login-control" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('auth.confirmPassword') }}</span>
                  <input v-model="confirmation" type="password" autocomplete="new-password" required class="control login-control" />
                </label>
                <label v-if="needsEnrollmentToken" class="field">
                  <span class="field-label">{{ t('auth.enrollmentToken') }}</span>
                  <input v-model="token" type="password" autocomplete="off" required class="control login-control" />
                  <span class="field-hint">{{ t('auth.enrollmentTokenHelp') }}</span>
                </label>
              </template>

              <label v-else class="field">
                <span class="field-label">{{ t('auth.password') }}</span>
                <input v-model="password" type="password" autocomplete="current-password" required class="control login-control" />
              </label>
            </template>

            <template v-else>
              <label class="field">
                <span class="field-label">{{ t('auth.tokenLabel') }}</span>
                <input v-model="token" type="password" autocomplete="off" required class="control login-control" />
                <span class="field-hint">{{ t('auth.tokenHelp') }}</span>
              </label>
            </template>

            <p v-if="auth.error" class="login-error" role="alert">{{ auth.error }}</p>
            <Button type="submit" size="sm" class="login-submit w-full" :disabled="auth.loading">
              {{ auth.loading ? t('common.processing') : setupRequired && mode === 'password' ? t('auth.setupSubmit') : t('auth.loginSubmit') }}
            </Button>

            <p v-if="!setupRequired" class="login-mode-toggle">
              <button
                type="button"
                class="login-mode-link"
                @click="setMode(mode === 'password' ? 'token' : 'password')"
              >
                {{ mode === 'password' ? t('auth.useTokenInstead') : t('auth.usePasswordInstead') }}
              </button>
            </p>
          </form>
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

.login-hint {
  color: hsl(var(--muted-foreground));
  font-size: 11.5px;
  line-height: 1.55;
  margin-top: -4px;
}

.login-mode-toggle {
  text-align: center;
  margin-top: 2px;
}

.login-mode-link {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 4px 2px;
  color: hsl(var(--muted-foreground));
  font-size: 11.5px;
  line-height: 1.5;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  transition: color 90ms linear;
}

.login-mode-link:hover {
  color: hsl(var(--foreground));
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
