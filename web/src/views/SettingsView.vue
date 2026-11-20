<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Languages, LogOut, Monitor, Moon, ShieldAlert, Sun } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useAuthStore } from '@/stores/auth'
import { useGovernanceStore } from '@/stores/governance'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { localeNames, locales, t, type MessageKey } from '@/i18n'
import { roleLabel } from '@/i18n/labels'
import type { GlobalHarnessConfig, JevProviderId, JevSettingsInput, JevSettingsView } from '@/types'

const preferences = usePreferencesStore()
const auth = useAuthStore()
const governance = useGovernanceStore()
const themes = [
  { value: 'light' as const, labelKey: 'settings.appearance.light' as const, icon: Sun },
  { value: 'dark' as const, labelKey: 'settings.appearance.dark' as const, icon: Moon },
  { value: 'system' as const, labelKey: 'settings.appearance.system' as const, icon: Monitor }
]
const globalForm = reactive({ enabled: true, mode: 'log-only' as GlobalHarnessConfig['mode'], advisoryInjection: false })
const globalError = ref(''), globalNotice = ref('')
const globalProjectionFailures = ref<string[]>([])
const canEditGlobal = computed(() => auth.session?.role === 'human')
const globalDirty = computed(() => {
  const current = governance.globalConfig
  return current !== null && (globalForm.enabled !== current.enabled || globalForm.mode !== current.mode || globalForm.advisoryInjection !== current.advisoryInjection)
})
function applyGlobalConfig(config: GlobalHarnessConfig) {
  globalForm.enabled = config.enabled
  globalForm.mode = config.mode
  globalForm.advisoryInjection = config.advisoryInjection
}
watch(() => governance.globalConfig, config => { if (config) applyGlobalConfig(config) }, { immediate: true })
watch(globalForm, () => { globalError.value = ''; globalNotice.value = ''; globalProjectionFailures.value = [] })
async function saveGlobalConfig() {
  if (!governance.globalConfig || !canEditGlobal.value || !globalDirty.value || governance.globalConfigSaving) return
  globalError.value = ''; globalNotice.value = ''; globalProjectionFailures.value = []
  try {
    const result = await governance.updateGlobalConfig({ enabled: globalForm.enabled, mode: globalForm.mode, advisoryInjection: globalForm.advisoryInjection })
    if (!result) return
    globalProjectionFailures.value = [...result.projectionFailures]
    globalNotice.value = result.projectionFailures.length
      ? t('settings.harness.savedPartial')
      : t('settings.harness.saved')
  } catch (error) {
    globalError.value = error instanceof Error ? error.message : t('settings.harness.saveFailed')
  }
}
async function reloadGlobalConfig() {
  globalError.value = ''; globalNotice.value = ''
  try { await governance.initialize() }
  catch (error) { globalError.value = error instanceof Error ? error.message : t('settings.harness.reloadFailed') }
}

const providerUrls: Record<JevProviderId, string> = { openrouter: 'https://openrouter.ai/api', typesafe: 'https://api.typesafe.ai' }
const jev = ref<JevSettingsView | null>(null)
const jevForm = reactive({ provider: 'openrouter' as JevProviderId, baseUrl: providerUrls.openrouter, defaultModel: '', apiKey: '' })
const jevLoading = ref(false), jevSaving = ref(false), jevTesting = ref(false)
const jevError = ref(''), jevNotice = ref('')

const sections: ReadonlyArray<{ id: string; labelKey: MessageKey }> = [
  { id: 'pref-harness', labelKey: 'settings.sections.harness' },
  { id: 'pref-appearance', labelKey: 'settings.sections.appearance' },
  { id: 'pref-session', labelKey: 'settings.sections.session' },
  { id: 'pref-jev', labelKey: 'settings.sections.jev' },
  { id: 'pref-about', labelKey: 'settings.sections.about' }
]
const activeSection = ref('pref-harness')
const sectionNav = ref<HTMLElement | null>(null)

function focusSectionTab(id: string) {
  void nextTick(() => {
    const tab = sectionNav.value?.querySelector<HTMLElement>(`[data-section-id="${id}"]`)
    tab?.focus()
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

function onSectionKeydown(event: KeyboardEvent, index: number) {
  const last = sections.length - 1
  let next = -1
  if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
  else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = last
  if (next < 0) return
  event.preventDefault()
  const id = sections[next].id
  activeSection.value = id
  focusSectionTab(id)
}
const developmentCommit = __AMOS_DEV_COMMIT__
const pillClass = 'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium'
const sessionToneClass = computed(() => auth.authenticated
  ? 'border-positive/30 bg-positive/5 text-positive'
  : 'border-warning/30 bg-warning/5 text-warning')

type JevTone = 'error' | 'warning' | 'positive' | 'muted'
const jevStateTone = computed<JevTone>(() => {
  if (!jev.value) return jevError.value ? 'error' : 'muted'
  if (!jev.value.config) return 'warning'
  return jev.value.hasApiKey ? 'positive' : 'warning'
})
const jevStateLabel = computed(() => {
  if (jevLoading.value) return t('settings.jev.stateLoading')
  if (!jev.value) return jevError.value ? t('settings.jev.stateFailed') : t('settings.jev.stateNotLoaded')
  if (!jev.value.config) return t('common.notConfigured')
  return jev.value.hasApiKey ? t('settings.jev.stateConfigured') : t('settings.jev.stateMissingKey')
})
const jevStateClass = computed(() => ({
  error: 'border-destructive/30 bg-destructive/5 text-destructive',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  positive: 'border-positive/30 bg-positive/5 text-positive',
  muted: 'border-border bg-muted/40 text-muted-foreground'
})[jevStateTone.value])

function applyJev(view: JevSettingsView) {
  jev.value = view
  const config = view.config
  jevForm.provider = config?.provider ?? 'openrouter'
  jevForm.baseUrl = config?.baseUrl ?? providerUrls.openrouter
  jevForm.defaultModel = config?.defaultModel ?? ''
  jevForm.apiKey = ''
}
async function reloadJev() {
  if (jevLoading.value) return
  jevLoading.value = true; jevError.value = ''
  try {
    applyJev(await governance.refreshJev())
  } catch (e) {
    jevError.value = e instanceof Error ? e.message : t('settings.jev.loadFailed')
  } finally {
    jevLoading.value = false
  }
}
watch(() => governance.jev, view => { if (view) applyJev(view) }, { immediate: true })

function changeJevProvider() {
  if (jevForm.baseUrl === providerUrls.openrouter || jevForm.baseUrl === providerUrls.typesafe) jevForm.baseUrl = providerUrls[jevForm.provider]
}
async function saveJev() {
  const current = jev.value?.config
  if (!jev.value || jevSaving.value) return
  const baseUrl = jevForm.baseUrl.trim(), defaultModel = jevForm.defaultModel.trim(), apiKey = jevForm.apiKey
  if (!baseUrl || !defaultModel) { jevNotice.value = ''; jevError.value = t('settings.jev.missingFields'); return }
  if (!current && !apiKey) { jevNotice.value = ''; jevError.value = t('settings.jev.keyRequired'); return }
  const models = [...(current?.models ?? [])]
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
    applyJev(await api.saveJevSettings(input))
    await governance.refreshJev().catch(() => null)
    jevNotice.value = t('settings.jev.saved')
  } catch (e) {
    jevError.value = e instanceof Error ? e.message : t('settings.jev.saveFailed')
  } finally {
    jevSaving.value = false; jevForm.apiKey = ''
  }
}
async function testJev() {
  if (!jev.value?.config || jevTesting.value) return
  jevTesting.value = true; jevError.value = ''; jevNotice.value = ''
  try {
    const result = await api.testJevSettings()
    jevNotice.value = t('settings.jev.tested', { model: result.model })
  } catch (e) {
    jevError.value = e instanceof Error ? e.message : t('settings.jev.testFailed')
  } finally {
    jevTesting.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader :title="t('settings.title')" :description="t('settings.description')">
      <template #actions>
        <span :class="[pillClass, sessionToneClass]">
          <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
          {{ auth.authenticated ? t('settings.sessionAuthenticated') : t('settings.sessionAnonymous') }}
        </span>
      </template>
    </PageHeader>

    <nav :aria-label="t('settings.sectionsLabel')" class="settings-sections scroll-thin -mx-1 mb-5 flex items-start overflow-x-auto overscroll-x-contain px-1 py-1">
      <div ref="sectionNav" class="segmented w-max" role="tablist">
        <button
          v-for="(item, index) in sections"
          :id="`${item.id}-tab`"
          :key="item.id"
          type="button"
          role="tab"
          class="segmented-item whitespace-nowrap"
          :data-section-id="item.id"
          :data-active="activeSection === item.id"
          :aria-selected="activeSection === item.id"
          :aria-controls="item.id"
          :tabindex="activeSection === item.id ? 0 : -1"
          @click="activeSection = item.id"
          @keydown="onSectionKeydown($event, index)"
        >
          {{ t(item.labelKey) }}
        </button>
      </div>
    </nav>

    <div class="grid gap-4">
      <section v-show="activeSection === 'pref-harness'" id="pref-harness" class="panel" role="tabpanel" aria-labelledby="pref-harness-tab">
        <div class="panel-header">
          <div>
            <h2 id="pref-harness-title" class="panel-title">{{ t('settings.harness.title') }}</h2>
            <p class="panel-kicker">{{ t('settings.harness.kicker') }}</p>
          </div>
          <span v-if="!canEditGlobal" class="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground">{{ t('common.readOnly') }}</span>
        </div>
        <div v-if="!governance.globalConfig" class="p-4">
          <div class="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
            {{ t('settings.harness.unavailable') }}
          </div>
          <Button class="mt-3" variant="outline" size="sm" :disabled="governance.loading" @click="reloadGlobalConfig">{{ governance.loading ? t('common.loading') : t('common.reload') }}</Button>
        </div>
        <form v-else @submit.prevent="saveGlobalConfig">
          <div class="grid gap-3 p-4 md:grid-cols-3">
            <div class="rounded-md border border-border bg-surface p-3">
              <div class="flex items-center justify-between gap-3">
                <label for="global-harness-enabled" class="text-xs font-semibold">{{ t('settings.harness.enabled') }}</label>
                <Switch id="global-harness-enabled" v-model="globalForm.enabled" :disabled="!canEditGlobal || governance.globalConfigSaving" :aria-label="t('settings.harness.enabledLabel')" />
              </div>
              <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">{{ t('settings.harness.enabledHint') }}</p>
            </div>
            <div class="rounded-md border border-border bg-surface p-3">
              <label id="global-harness-mode-label" class="text-xs font-semibold">{{ t('settings.harness.mode') }}</label>
              <Select v-model="globalForm.mode" :disabled="!canEditGlobal || governance.globalConfigSaving">
                <SelectTrigger class="mt-2 w-full" size="sm" aria-labelledby="global-harness-mode-label"><SelectValue :placeholder="t('settings.harness.modePlaceholder')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="log-only">{{ t('harness.modes.logOnly') }}</SelectItem>
                  <SelectItem value="managed">{{ t('harness.modes.managed') }}</SelectItem>
                </SelectContent>
              </Select>
              <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">{{ t('settings.harness.modeHint') }}</p>
            </div>
            <div class="rounded-md border border-border bg-surface p-3">
              <div class="flex items-center justify-between gap-3">
                <label for="global-advisory-injection" class="text-xs font-semibold">{{ t('settings.harness.advisory') }}</label>
                <Switch id="global-advisory-injection" v-model="globalForm.advisoryInjection" :disabled="!canEditGlobal || governance.globalConfigSaving" :aria-label="t('settings.harness.advisoryLabel')" />
              </div>
              <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">{{ t('settings.harness.advisoryHint') }}</p>
            </div>
          </div>
          <div class="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p class="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">{{ t('settings.harness.saveNote') }}</p>
            <Button type="submit" class="shrink-0" :disabled="!canEditGlobal || !globalDirty || governance.globalConfigSaving">{{ governance.globalConfigSaving ? t('common.saving') : t('settings.harness.save') }}</Button>
          </div>
        </form>
        <div class="px-4 pb-4">
          <p v-if="globalError" class="text-xs text-destructive" role="alert">{{ globalError }}</p>
          <p v-if="globalNotice" class="text-xs" :class="globalProjectionFailures.length ? 'text-warning' : 'text-positive'" role="status">{{ globalNotice }}</p>
          <div v-if="globalProjectionFailures.length" class="mt-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning" role="alert">
            <p>{{ t('settings.harness.projectionFailures') }}</p>
            <ul class="mt-1 list-disc break-all pl-4 font-mono text-[10px]"><li v-for="id in globalProjectionFailures" :key="id">{{ id }}</li></ul>
          </div>
        </div>
      </section>

      <section v-show="activeSection === 'pref-appearance'" id="pref-appearance" class="panel" role="tabpanel" aria-labelledby="pref-appearance-tab">
        <div class="panel-header">
          <div>
            <h2 id="pref-appearance-title" class="panel-title">{{ t('settings.appearance.title') }}</h2>
            <p class="panel-kicker">{{ t('settings.appearance.kicker') }}</p>
          </div>
        </div>
        <div class="divide-y divide-hairline">
          <div class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div class="min-w-0">
              <p id="pref-language-label" class="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground"><Languages class="size-3.5 text-muted-foreground" aria-hidden="true" />{{ t('settings.appearance.language') }}</p>
              <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ t('settings.appearance.languageHint') }}</p>
            </div>
            <div class="segmented shrink-0" role="group" aria-labelledby="pref-language-label">
              <button
                v-for="code in locales"
                :key="code"
                type="button"
                class="segmented-item"
                :lang="code"
                :data-locale="code"
                :aria-pressed="preferences.locale === code"
                @click="preferences.setLocale(code)"
              >
                {{ localeNames[code] }}
              </button>
            </div>
          </div>
          <div class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div class="min-w-0">
              <p id="pref-theme-label" class="text-[12.5px] font-medium text-foreground">{{ t('settings.appearance.theme') }}</p>
              <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ t('settings.appearance.themeHint') }}</p>
            </div>
            <div class="segmented shrink-0" role="group" aria-labelledby="pref-theme-label">
              <button
                v-for="item in themes"
                :key="item.value"
                type="button"
                class="segmented-item"
                :aria-pressed="preferences.theme === item.value"
                @click="preferences.setTheme(item.value)"
              >
                <component :is="item.icon" class="mr-1 inline size-3" aria-hidden="true" />{{ t(item.labelKey) }}
              </button>
            </div>
          </div>
          <div class="flex items-center justify-between gap-6 px-4 py-3">
            <div class="min-w-0">
              <p id="pref-compact-label" class="text-[12.5px] font-medium text-foreground">{{ t('settings.appearance.compact') }}</p>
              <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ t('settings.appearance.compactHint') }}</p>
            </div>
            <Switch
              id="pref-compact"
              :model-value="preferences.compact"
              size="sm"
              aria-labelledby="pref-compact-label"
              @update:model-value="preferences.setCompact"
            />
          </div>
        </div>
      </section>

      <section v-show="activeSection === 'pref-session'" id="pref-session" class="panel" role="tabpanel" aria-labelledby="pref-session-tab">
        <div class="panel-header">
          <div>
            <h2 id="pref-session-title" class="panel-title">{{ t('settings.session.title') }}</h2>
            <p class="panel-kicker">{{ t('settings.session.kicker') }}</p>
          </div>
          <span :class="[pillClass, sessionToneClass]">{{ roleLabel(auth.session?.role) }}</span>
        </div>
        <dl class="divide-y divide-hairline text-[12.5px]">
          <div class="flex items-center justify-between gap-6 px-4 py-2.5">
            <dt class="text-muted-foreground">{{ t('settings.session.status') }}</dt>
            <dd class="text-right text-foreground">{{ auth.authenticated ? t('settings.session.authenticated') : t('settings.session.anonymous') }}</dd>
          </div>
          <div class="flex items-center justify-between gap-6 px-4 py-2.5">
            <dt class="shrink-0 text-muted-foreground">{{ t('settings.session.project') }}</dt>
            <dd class="min-w-0 truncate text-right text-foreground">{{ governance.activeProject?.name ?? t('settings.session.noProject') }}</dd>
          </div>
        </dl>
        <div class="space-y-2.5 border-t border-hairline px-4 py-3">
          <div class="rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 text-[11.5px] leading-relaxed text-warning">
            <ShieldAlert class="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
            {{ t('settings.session.boundary') }}
          </div>
          <p class="text-[11.5px] leading-relaxed text-muted-foreground">{{ t('settings.session.isolation') }}</p>
        </div>
        <div class="flex items-center justify-between gap-4 border-t border-hairline px-4 py-2.5">
          <p class="text-[11.5px] text-muted-foreground">{{ t('settings.session.logoutHint') }}</p>
          <Button variant="outline" size="sm" @click="auth.logout()"><LogOut class="size-3.5" aria-hidden="true" />{{ t('app.logout') }}</Button>
        </div>
      </section>

      <section v-show="activeSection === 'pref-jev'" id="pref-jev" class="panel" role="tabpanel" aria-labelledby="pref-jev-tab">
        <div class="panel-header">
          <div>
            <h2 id="pref-jev-title" class="panel-title">{{ t('settings.jev.title') }}</h2>
            <p class="panel-kicker">{{ t('settings.jev.kicker') }}</p>
          </div>
          <span :class="[pillClass, jevStateClass]" role="status">{{ jevStateLabel }}</span>
        </div>
        <div class="px-4 py-3">
            <p v-if="jevLoading" class="text-[12.5px] text-muted-foreground">{{ t('settings.jev.loading') }}</p>
            <div v-else-if="!jev" class="flex items-center justify-between gap-4">
              <p class="text-[12.5px] text-muted-foreground">{{ t('settings.jev.notLoaded') }}</p>
              <Button variant="outline" size="sm" @click="reloadJev">{{ t('common.reload') }}</Button>
            </div>
            <form v-else class="space-y-3" :aria-busy="jevSaving || jevTesting" @submit.prevent="saveJev">
              <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-hairline bg-surface/40 px-3 py-2 sm:grid-cols-3" :aria-label="t('settings.jev.summary')">
                <div class="min-w-0">
                  <dt class="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{{ t('settings.jev.defaultModel') }}</dt>
                  <dd class="truncate font-mono text-[11.5px] text-foreground">{{ jev.config?.defaultModel || t('common.notSet') }}</dd>
                </div>
                <div>
                  <dt class="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{{ t('settings.jev.credential') }}</dt>
                  <dd class="text-[11.5px] text-foreground">{{ jev.hasApiKey ? t('settings.jev.credentialSaved') : jev.config ? t('settings.jev.credentialMissing') : t('common.notConfigured') }}</dd>
                </div>
                <div>
                  <dt class="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{{ t('settings.jev.timeout') }}</dt>
                  <dd class="text-[11.5px] text-foreground">{{ jev.config ? t('settings.jev.timeoutValue', { ms: jev.config.timeoutMs }) : t('settings.jev.timeoutDefault') }}</dd>
                </div>
              </dl>
              <fieldset :disabled="jevSaving || jevTesting" class="grid gap-3 md:grid-cols-2" :aria-label="t('settings.jev.form')">
                <label class="field">
                  <span class="field-label">Provider</span>
                  <select v-model="jevForm.provider" class="h-8 w-full rounded-md border border-input bg-background px-2 text-[12.5px]" @change="changeJevProvider">
                    <option value="openrouter">OpenRouter</option>
                    <option value="typesafe">Typesafe</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">Base URL</span>
                  <input v-model="jevForm.baseUrl" type="url" required autocomplete="off" class="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-[11.5px]" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.jev.defaultModel') }}</span>
                  <input v-model="jevForm.defaultModel" required autocomplete="off" spellcheck="false" class="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-[11.5px]" />
                </label>
                <label class="field">
                  <span class="field-label">API key</span>
                  <input v-model="jevForm.apiKey" type="password" autocomplete="off" :required="!jev.config" aria-describedby="jev-key-hint" class="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-[11.5px]" />
                  <span id="jev-key-hint" class="mt-0.5 block text-[11px] text-muted-foreground">{{ jev.hasApiKey ? t('settings.jev.keyHintSaved') : jev.config ? t('settings.jev.keyHintKeep') : t('settings.jev.keyRequired') }}</span>
                </label>
              </fieldset>
              <div class="flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-3">
                <Button type="submit" size="sm" :disabled="jevSaving || jevTesting">{{ jevSaving ? t('common.saving') : t('settings.jev.save') }}</Button>
                <Button type="button" variant="outline" size="sm" :disabled="!jev.config || jevSaving || jevTesting" @click="testJev">{{ jevTesting ? t('settings.jev.testing') : t('settings.jev.test') }}</Button>
              </div>
            </form>
          <div class="mt-3 min-h-[1.125rem] text-[11.5px]">
            <p v-if="jevError" role="alert" class="text-destructive">{{ jevError }}</p>
            <p v-else-if="jevNotice" role="status" class="text-positive">{{ jevNotice }}</p>
          </div>
        </div>
      </section>

      <section v-show="activeSection === 'pref-about'" id="pref-about" class="panel" role="tabpanel" aria-labelledby="pref-about-tab">
        <div class="panel-header">
          <div>
            <h2 id="pref-about-title" class="panel-title">{{ t('settings.about.title') }}</h2>
            <p class="panel-kicker">{{ t('settings.about.kicker') }}</p>
          </div>
        </div>
        <dl class="divide-y divide-hairline text-[12.5px]">
          <div class="flex items-baseline justify-between gap-6 px-4 py-2.5">
            <dt class="shrink-0 text-muted-foreground">{{ t('settings.about.project') }}</dt>
            <dd class="text-right font-medium text-foreground">Amos Console</dd>
          </div>
          <div class="flex items-baseline justify-between gap-6 px-4 py-2.5">
            <dt class="shrink-0 text-muted-foreground">{{ t('settings.about.summary') }}</dt>
            <dd class="max-w-[26rem] text-right leading-relaxed text-foreground">{{ t('settings.about.summaryText') }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-6 px-4 py-2.5">
            <dt class="shrink-0 text-muted-foreground">{{ t('settings.about.version') }}</dt>
            <dd class="tabular min-w-0 text-right text-foreground">{{ t('settings.about.build') }} · <span class="font-mono text-[11.5px]">{{ developmentCommit }}</span></dd>
          </div>
          <div class="flex items-baseline justify-between gap-6 px-4 py-2.5">
            <dt class="shrink-0 text-muted-foreground">{{ t('settings.about.license') }}</dt>
            <dd class="text-right text-foreground">Apache License 2.0</dd>
          </div>
          <div class="flex items-baseline justify-between gap-6 px-4 py-2.5">
            <dt class="shrink-0 text-muted-foreground">{{ t('settings.about.repository') }}</dt>
            <dd class="min-w-0 truncate text-right font-mono text-[11.5px] text-foreground">github.com/g2nnyS/project-amos</dd>
          </div>
        </dl>
        <p class="border-t border-hairline px-4 py-2.5 text-[10.5px] text-muted-foreground">{{ t('settings.about.licenseNotice') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-sections .segmented-item {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
}

.settings-sections .segmented-item:not([data-active='true']):hover {
  background: hsl(var(--accent));
}

.settings-sections .segmented-item[data-active='true']:hover {
  background: hsl(var(--card));
}
</style>
