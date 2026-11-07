<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { Monitor, Moon, Sun, LogOut, ShieldAlert, User } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useAuthStore } from '@/stores/auth'
import { useGovernanceStore } from '@/stores/governance'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { JevProviderId, JevSettingsInput, JevSettingsView } from '@/types'

const preferences = usePreferencesStore()
const auth = useAuthStore()
const governance = useGovernanceStore()
const themes = [
  { value: 'light' as const, label: '浅色', icon: Sun },
  { value: 'dark' as const, label: '深色', icon: Moon },
  { value: 'system' as const, label: '跟随系统', icon: Monitor }
]
const providerUrls: Record<JevProviderId, string> = { openrouter: 'https://openrouter.ai/api', typesafe: 'https://api.typesafe.ai' }
const jev = ref<JevSettingsView | null>(null)
const jevForm = reactive({ provider: 'openrouter' as JevProviderId, baseUrl: providerUrls.openrouter, defaultModel: '', apiKey: '' })
const jevLoading = ref(false), jevSaving = ref(false), jevTesting = ref(false)
const jevError = ref(''), jevNotice = ref('')
let jevEpoch = 0

function applyJev(view: JevSettingsView) {
  jev.value = view
  const config = view.config
  jevForm.provider = config?.provider ?? 'openrouter'
  jevForm.baseUrl = config?.baseUrl ?? providerUrls.openrouter
  jevForm.defaultModel = config?.defaultModel ?? ''
  jevForm.apiKey = ''
}
async function loadJev(id: string | null) {
  const epoch = ++jevEpoch
  jev.value = null; jevForm.apiKey = ''; jevError.value = ''; jevNotice.value = ''
  jevSaving.value = false; jevTesting.value = false
  if (!id) { jevLoading.value = false; return }
  jevLoading.value = true
  try {
    const view = await api.jevSettings(id)
    if (epoch === jevEpoch && id === governance.activeProjectId) applyJev(view)
  } catch (e) {
    if (epoch === jevEpoch) jevError.value = e instanceof Error ? e.message : '加载 Jev 配置失败。'
  } finally {
    if (epoch === jevEpoch) jevLoading.value = false
  }
}
watch(() => governance.activeProjectId, id => { void loadJev(id) }, { immediate: true })

function changeJevProvider() {
  if (jevForm.baseUrl === providerUrls.openrouter || jevForm.baseUrl === providerUrls.typesafe) jevForm.baseUrl = providerUrls[jevForm.provider]
}
async function saveJev() {
  const id = governance.activeProjectId, current = jev.value?.config
  if (!id || !jev.value || jevSaving.value) return
  const baseUrl = jevForm.baseUrl.trim(), defaultModel = jevForm.defaultModel.trim(), apiKey = jevForm.apiKey
  if (!baseUrl || !defaultModel) { jevNotice.value = ''; jevError.value = '请填写 Base URL 和默认模型。'; return }
  if (!current && !apiKey) { jevNotice.value = ''; jevError.value = '新配置必须填写 API key。'; return }
  const epoch = jevEpoch, models = [...(current?.models ?? [])]
  if (!models.includes(defaultModel)) models.push(defaultModel)
  const input: JevSettingsInput = {
    provider: jevForm.provider, baseUrl, defaultModel, models,
    timeoutMs: current?.timeoutMs ?? 8000,
    assessmentRequired: current?.assessmentRequired ?? true,
    policy: current ? { ...current.policy } : { reviewRisk: 0.6, denyRisk: 0.9, minConfidence: 0.6 },
    allowCredentialEgress: current?.allowCredentialEgress ?? false,
    ...(apiKey ? { apiKey } : {})
  }
  jevSaving.value = true; jevError.value = ''; jevNotice.value = ''
  try {
    const view = await api.saveJevSettings(id, input)
    if (epoch !== jevEpoch || id !== governance.activeProjectId) return
    applyJev(view)
    await governance.refreshProject()
    if (epoch === jevEpoch) jevNotice.value = 'Jev 配置已保存。'
  } catch (e) {
    if (epoch === jevEpoch) jevError.value = e instanceof Error ? e.message : '保存 Jev 配置失败。'
  } finally {
    if (epoch === jevEpoch) { jevSaving.value = false; jevForm.apiKey = '' }
  }
}
async function testJev() {
  const id = governance.activeProjectId
  if (!id || !jev.value?.config || jevTesting.value) return
  const epoch = jevEpoch
  jevTesting.value = true; jevError.value = ''; jevNotice.value = ''
  try {
    const result = await api.testJevSettings(id)
    if (epoch === jevEpoch) jevNotice.value = `Jev 连接成功，模型：${result.model}。`
  } catch (e) {
    if (epoch === jevEpoch) jevError.value = e instanceof Error ? e.message : 'Jev 连接测试失败。'
  } finally {
    if (epoch === jevEpoch) jevTesting.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="设置" description="本地外观、Jev 连接和当前会话。" />

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

      <section class="panel lg:col-span-2">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Jev 应用内设置</h2>
            <p class="panel-kicker">{{ governance.activeProject ? `当前项目：${governance.activeProject.name}` : '配置当前项目的 Jev 评估服务。' }}</p>
          </div>
        </div>
        <div class="p-4">
          <p v-if="!governance.activeProject" class="text-sm text-muted-foreground">请先到项目页选择项目。</p>
          <template v-else>
            <p v-if="jevLoading" class="text-sm text-muted-foreground" role="status">正在加载 Jev 配置…</p>
            <div v-else-if="!jev">
              <Button variant="outline" size="sm" @click="loadJev(governance.activeProjectId)">重新加载</Button>
            </div>
            <form v-else class="space-y-4" @submit.prevent="saveJev">
              <fieldset :disabled="jevSaving || jevTesting" class="grid gap-4 md:grid-cols-2">
                <label class="field">
                  <span class="field-label">Provider</span>
                  <select v-model="jevForm.provider" class="h-10 w-full rounded-md border border-input bg-background px-3" @change="changeJevProvider">
                    <option value="openrouter">OpenRouter</option>
                    <option value="typesafe">Typesafe</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">Base URL</span>
                  <input v-model="jevForm.baseUrl" type="url" required autocomplete="off" class="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" />
                </label>
                <label class="field">
                  <span class="field-label">默认模型</span>
                  <input v-model="jevForm.defaultModel" required autocomplete="off" spellcheck="false" class="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" />
                </label>
                <label class="field">
                  <span class="field-label">API key</span>
                  <input v-model="jevForm.apiKey" type="password" autocomplete="off" :required="!jev.config" class="h-10 w-full rounded-md border border-input bg-background px-3" />
                  <span class="mt-1 block text-xs text-muted-foreground">{{ jev.hasApiKey ? '已保存 API key；留空将保留现有密钥。' : jev.config ? '留空将保留当前密钥状态。' : '新配置必须填写 API key。' }}</span>
                </label>
              </fieldset>
              <div class="flex flex-wrap gap-2">
                <Button type="submit" :disabled="jevSaving || jevTesting">{{ jevSaving ? '保存中…' : '保存配置' }}</Button>
                <Button type="button" variant="outline" :disabled="!jev.config || jevSaving || jevTesting" @click="testJev">{{ jevTesting ? '测试中…' : '测试已保存配置' }}</Button>
              </div>
            </form>
            <p v-if="jevError" class="mt-3 text-xs text-destructive" role="alert">{{ jevError }}</p>
            <p v-if="jevNotice" class="mt-3 text-xs text-success" role="status">{{ jevNotice }}</p>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
