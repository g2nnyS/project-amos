<script setup lang="ts">
import { Monitor, Moon, Sun, LogOut, ShieldAlert, User } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'

const preferences = usePreferencesStore()
const auth = useAuthStore()
const themes = [
  { value: 'light' as const, label: '浅色', icon: Sun },
  { value: 'dark' as const, label: '深色', icon: Moon },
  { value: 'system' as const, label: '跟随系统', icon: Monitor }
]
</script>

<template>
  <div class="page">
    <PageHeader title="设置" description="本地外观和当前会话。" />

    <div class="grid gap-4 lg:grid-cols-2">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">外观</h2>
        </div>
        <div class="space-y-5 p-4">
          <fieldset>
            <legend class="field-label mb-2">主题</legend>
            <div class="segmented">
              <button v-for="item in themes" :key="item.value" type="button" class="segmented-item" :aria-pressed="preferences.theme === item.value" @click="preferences.setTheme(item.value)">
                <component :is="item.icon" class="mr-1 inline size-3" />{{ item.label }}
              </button>
            </div>
          </fieldset>
          <label class="flex items-center justify-between gap-4 text-sm">
            <span>紧凑密度<span class="mt-1 block text-xs text-muted-foreground">缩小页面、面板和表格间距。</span></span>
            <input type="checkbox" :checked="preferences.compact" class="size-4 accent-[hsl(var(--primary))]" @change="preferences.setCompact(($event.target as HTMLInputElement).checked)" />
          </label>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">会话与边界</h2>
        </div>
        <div class="space-y-4 p-4 text-xs leading-relaxed">
          <div class="flex items-center gap-2 text-foreground">
            <User class="size-4 text-info" />
            <span>当前会话：{{ auth.session?.role === 'human' ? '人类' : auth.session?.role === 'agent' ? 'Agent' : '已认证' }}</span>
          </div>
          <div class="rounded-md border border-warning/30 bg-warning/5 p-3 text-warning">
            <ShieldAlert class="mb-1 inline size-4" />
            默认保留 log-only 观察插件；受管拦截需在项目 .pi/amos.json 中显式启用 managed。该模式只覆盖已接管 Harness 工具入口，不是 OS 沙箱。
          </div>
          <p class="text-muted-foreground">本地数据库和凭据与同 UID 进程共享可访问域，不构成可信隔离。会话在退出或服务重启后失效。</p>
          <Button variant="outline" size="sm" @click="auth.logout()"><LogOut class="mr-1 size-3.5" />退出登录</Button>
        </div>
      </section>
    </div>
  </div>
</template>
