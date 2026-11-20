<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { Menu, PanelLeftClose, PanelLeftOpen, Search, Plus, LogOut, ChevronRight, Command } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import ToastViewport from '@/components/layout/ToastViewport.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import LoginView from '@/views/LoginView.vue'
import { navSections, isActivePath, pageLabelForPath } from '@/components/layout/navigation'
import { t } from '@/i18n'
import { usePreferencesStore } from '@/stores/preferences'
import { useAuthStore } from '@/stores/auth'
import { isGlobalProject, shouldClearForAuthState, useGovernanceStore } from '@/stores/governance'

const preferences = usePreferencesStore()
const auth = useAuthStore()
const governance = useGovernanceStore()
const route = useRoute()
const router = useRouter()
const mobileOpen = ref(false)
const createOpen = ref(false)
const commandOpen = ref(false)
const name = ref('')
const workspace = ref('')
const createError = ref('')
const creating = ref(false)
const query = ref('')
const selected = ref(0)
const commandList = ref<HTMLElement | null>(null)
const mainRef = ref<HTMLElement | null>(null)

const results = computed(() => {
  const pages = navSections.flatMap(section => section.items.map(item => ({ label: t(item.labelKey), detail: t(section.labelKey), to: item.to })))
  const rules = (governance.policy?.candidate.rules ?? []).map(rule => ({ label: rule.id, detail: t('app.command.publishedRule'), to: `/rules?id=${encodeURIComponent(rule.id)}` }))
  const proposals = governance.proposals.map(p => ({ label: p.title, detail: t('app.command.proposal'), to: `/proposals/${encodeURIComponent(p.id)}` }))
  const versions = governance.versions.map(v => ({ label: t('common.version', { version: v.version }), detail: t('app.command.historicalVersion'), to: `/versions/${v.version}` }))
  const term = query.value.trim().toLowerCase()
  return [...pages, ...rules, ...proposals, ...versions].filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(term)).slice(0, 30)
})
watch(query, () => { selected.value = 0 })
watch(selected, async index => {
  await nextTick()
  commandList.value?.querySelector<HTMLElement>(`#command-option-${index}`)?.scrollIntoView({ block: 'nearest' })
})
watch(() => route.path, () => { mobileOpen.value = false; if (mainRef.value) mainRef.value.scrollTop = 0 })
watch(() => auth.authenticated, async value => {
  if (value) await governance.initialize().catch(() => {})
  else if (shouldClearForAuthState(value, auth.ready)) { governance.clear(); mobileOpen.value = false; commandOpen.value = false; createOpen.value = false }
}, { immediate: true })
watch(() => preferences.resolvedTheme, value => {
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.classList.toggle('light', value === 'light')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#15171b' : '#ffffff')
}, { immediate: true })
watch(() => preferences.locale, value => { document.documentElement.lang = value }, { immediate: true })
function navigate(to: string) { commandOpen.value = false; void router.push(to) }
function keys(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && auth.authenticated) { event.preventDefault(); commandOpen.value = !commandOpen.value; query.value = ''; return }
  if (!commandOpen.value) return
  if (event.key === 'ArrowDown') { event.preventDefault(); selected.value = Math.min(selected.value + 1, results.value.length - 1) }
  if (event.key === 'ArrowUp') { event.preventDefault(); selected.value = Math.max(0, selected.value - 1) }
  if (event.key === 'Enter' && results.value[selected.value]) { event.preventDefault(); navigate(results.value[selected.value]!.to) }
  if (event.key === 'Escape') { event.preventDefault(); commandOpen.value = false }
}
async function createProject() {
  createError.value = ''
  if (!name.value.trim() || !workspace.value.startsWith('/')) { createError.value = t('app.createProject.invalid'); return }
  creating.value = true
  try { await governance.createProject({ name: name.value.trim(), workspace: workspace.value.trim() }); name.value = ''; workspace.value = ''; createOpen.value = false; await router.push('/') }
  catch (error) { createError.value = error instanceof Error ? error.message : t('app.createProject.failed') }
  finally { creating.value = false }
}
async function logout() { try { await auth.logout() } catch {} }
function selectProject(event: Event) { const id = (event.target as HTMLSelectElement).value; void governance.selectProject(id || null).catch(() => {}) }
const globalProjects = computed(() => governance.projects.filter(p => isGlobalProject(p)))
const workspaceProjects = computed(() => governance.projects.filter(p => !isGlobalProject(p)))
const activeIsGlobal = computed(() => isGlobalProject(governance.activeProject))

const desktopBridge = typeof window !== 'undefined' && window.amosDesktop?.isDesktop === true ? window.amosDesktop : undefined
const nativeWindowControls = desktopBridge?.nativeWindowControls === true
const customWindowControls = desktopBridge !== undefined
  && !nativeWindowControls
  && typeof desktopBridge.minimize === 'function'
  && typeof desktopBridge.toggleMaximize === 'function'
  && typeof desktopBridge.close === 'function'
const windowDraggable = typeof desktopBridge?.startWindowDrag === 'function'

/** Native folder picker for the new-project workspace field. */
const canPickWorkspaceFolder = typeof desktopBridge?.pickWorkspaceFolder === 'function'
const browsing = ref(false)
async function browseWorkspace() {
  if (!canPickWorkspaceFolder || browsing.value) return
  browsing.value = true
  try {
    const picked = await desktopBridge?.pickWorkspaceFolder?.()
    if (typeof picked === 'string' && picked.length > 0) workspace.value = picked
  } catch { /* the picker is dismissed or unavailable; keep the typed path */ }
  finally { browsing.value = false }
}

/** Frameless window: press on the topbar, the login veil or the macOS
 * titlebar spacer moves the window; a double press toggles maximize. */
function windowDragProbe(event: MouseEvent) {
  if (!windowDraggable || event.button !== 0) return
  const target = event.target instanceof Element ? event.target : null
  if (!target?.closest('.app-topbar, .login-shell, .sidebar-titlebar-spacer')) return
  if (target.closest('button, a, input, select, textarea, label, form, kbd, [contenteditable="true"], [data-no-drag]')) return
  if (event.detail === 2 && typeof desktopBridge?.toggleMaximize === 'function') void desktopBridge.toggleMaximize().catch(() => {})
  else void desktopBridge?.startWindowDrag?.().catch(() => {})
}

onMounted(() => {
  window.addEventListener('keydown', keys)
  if (windowDraggable) window.addEventListener('mousedown', windowDragProbe)
  void auth.bootstrap().catch(() => {})
})
onBeforeUnmount(() => { window.removeEventListener('keydown', keys); if (windowDraggable) window.removeEventListener('mousedown', windowDragProbe) })
</script>

<template>
  <div class="app-shell" :data-density="preferences.compact ? 'compact' : 'comfortable'" :data-collapsed="preferences.sidebarCollapsed ? 'true' : 'false'">
    <a class="skip-link" href="#main-content">{{ t('app.skipToContent') }}</a>
    <div v-if="!auth.ready" class="shell-status" role="status">{{ t('app.connecting') }}</div>
    <template v-else>
      <div class="shell-workspace" :inert="!auth.authenticated" :aria-hidden="auth.authenticated ? undefined : 'true'">
        <aside class="app-sidebar" :aria-label="t('app.sidebarLabel')">
          <div v-if="nativeWindowControls" class="sidebar-titlebar-spacer" aria-hidden="true"></div>
          <div class="sidebar-project">
            <label class="sidebar-label" for="project-select">{{ t('app.currentProject') }}</label>
            <select id="project-select" class="project-select" :aria-label="t('app.selectProject')" :value="governance.activeProjectId ?? ''" @change="selectProject">
              <option value="">{{ t('app.selectProject') }}</option>
              <optgroup v-if="globalProjects.length" :label="t('app.globalProject')">
                <option v-for="project in globalProjects" :key="project.id" :value="project.id" :data-kind="project.kind">{{ t('app.globalProject') }}</option>
              </optgroup>
              <optgroup v-if="workspaceProjects.length" :label="t('nav.sections.workspace')">
                <option v-for="project in workspaceProjects" :key="project.id" :value="project.id" :data-kind="project.kind">{{ project.name }}</option>
              </optgroup>
            </select>
            <button type="button" class="sidebar-add" :aria-label="t('app.newProject')" :title="t('app.newProject')" @click="createOpen = true">
              <Plus class="size-3.5" aria-hidden="true" /><span class="sidebar-add-text">{{ t('app.newProject') }}</span>
            </button>
          </div>

          <nav class="sidebar-nav scroll-thin" :aria-label="t('app.mainNav')">
            <div v-for="section in navSections" :key="section.labelKey" class="nav-section">
              <p class="nav-section-label">{{ t(section.labelKey) }}</p>
              <RouterLink
                v-for="item in section.items"
                :key="item.to"
                :to="item.to"
                class="nav-item"
                :aria-label="t(item.labelKey)"
                :aria-current="isActivePath(route.path, item.to) ? 'page' : undefined"
                :title="preferences.sidebarCollapsed ? t(item.labelKey) : undefined"
              >
                <component :is="item.icon" class="nav-icon" aria-hidden="true" />
                <span class="nav-text">{{ t(item.labelKey) }}</span>
              </RouterLink>
            </div>
          </nav>

          <div class="sidebar-footer">
            <button type="button" class="sidebar-toggle" :aria-label="preferences.sidebarCollapsed ? t('app.expandSidebar') : t('app.collapseSidebar')" :title="preferences.sidebarCollapsed ? t('app.expandSidebar') : t('app.collapseSidebar')" @click="preferences.toggleSidebar()">
              <PanelLeftOpen v-if="preferences.sidebarCollapsed" class="size-4" aria-hidden="true" />
              <PanelLeftClose v-else class="size-4" aria-hidden="true" />
              <span class="sidebar-toggle-text">{{ t('app.collapseSidebar') }}</span>
            </button>
          </div>
        </aside>

        <div class="app-main">
          <header class="app-topbar" :class="{ 'app-topbar-window': customWindowControls }">
            <button type="button" class="topbar-icon topbar-menu" :aria-label="t('app.openNav')" @click="mobileOpen = true"><Menu class="size-4" aria-hidden="true" /></button>
            <div class="topbar-crumbs">
              <span class="crumb-project" :class="{ 'crumb-project-global': activeIsGlobal }">
                {{ activeIsGlobal ? t('app.globalProject') : governance.activeProject?.name ?? t('app.noProject') }}
                <span v-if="activeIsGlobal" class="global-badge">{{ t('app.globalBadge') }}</span>
              </span>
              <ChevronRight class="crumb-sep" aria-hidden="true" />
              <span class="crumb-page">{{ pageLabelForPath(route.path) }}</span>
            </div>
            <div class="topbar-actions">
              <span class="topbar-pill topbar-pill-version">{{ t('app.localVersion', { version: governance.policy ? `v${governance.policy.version}` : t('common.notPublished') }) }}</span>
              <button type="button" class="topbar-search" :aria-label="t('app.searchLabel')" @click="commandOpen = true">
                <Search class="size-3.5" aria-hidden="true" /><span>{{ t('app.search') }}</span><kbd class="kbd">⌘K</kbd>
              </button>
              <button type="button" class="topbar-icon" :aria-label="t('app.logout')" :title="t('app.logout')" @click="logout"><LogOut class="size-4" aria-hidden="true" /></button>
            </div>
          </header>

          <main :id="auth.authenticated ? 'main-content' : undefined" ref="mainRef" class="workspace content-scroll app-atmosphere">
            <div class="workspace-inner">
              <RouterView v-if="auth.authenticated" />
              <div v-else class="shell-skeleton">
                <div class="shell-skeleton-head">
                  <span class="shell-skeleton-title"></span>
                  <span class="shell-skeleton-sub"></span>
                </div>
                <div class="shell-skeleton-chips">
                  <span></span><span></span><span></span>
                </div>
                <div class="shell-skeleton-grid">
                  <div class="shell-skeleton-panel">
                    <span class="shell-skeleton-band"></span>
                    <span class="shell-skeleton-row"></span>
                    <span class="shell-skeleton-row"></span>
                    <span class="shell-skeleton-row shell-skeleton-row-short"></span>
                  </div>
                  <div class="shell-skeleton-panel">
                    <span class="shell-skeleton-band"></span>
                    <span class="shell-skeleton-row"></span>
                    <span class="shell-skeleton-row shell-skeleton-row-mid"></span>
                  </div>
                </div>
                <div class="shell-skeleton-panel shell-skeleton-panel-wide">
                  <span class="shell-skeleton-band"></span>
                  <span class="shell-skeleton-row"></span>
                  <span class="shell-skeleton-row shell-skeleton-row-mid"></span>
                  <span class="shell-skeleton-row shell-skeleton-row-short"></span>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>

      <LoginView v-if="!auth.authenticated" />

      <Sheet v-if="auth.authenticated" v-model:open="mobileOpen"><SheetContent side="left" class="w-[288px] overflow-y-auto p-0 pb-16">
        <SheetHeader class="sr-only"><SheetTitle>{{ t('app.mainNav') }}</SheetTitle><SheetDescription>{{ t('app.mobileNavDescription') }}</SheetDescription></SheetHeader>
        <div class="p-4">
          <label class="field-label mb-1.5 block" for="mobile-project">{{ t('app.currentProject') }}</label>
          <select id="mobile-project" class="h-9 w-full rounded-md border border-input bg-background px-2 text-xs" :value="governance.activeProjectId ?? ''" @change="selectProject"><option value="">{{ t('app.selectProject') }}</option><optgroup v-if="globalProjects.length" :label="t('app.globalProject')"><option v-for="project in globalProjects" :key="project.id" :value="project.id" :data-kind="project.kind">{{ t('app.globalProject') }}</option></optgroup><optgroup v-if="workspaceProjects.length" :label="t('nav.sections.workspace')"><option v-for="project in workspaceProjects" :key="project.id" :value="project.id" :data-kind="project.kind">{{ project.name }}</option></optgroup></select>
          <Button class="mt-3 w-full" variant="outline" size="sm" @click="mobileOpen = false; createOpen = true">{{ t('app.newProject') }}</Button>
        </div>
        <nav class="px-2" :aria-label="t('app.mobileNav')">
          <template v-for="section in navSections" :key="section.labelKey">
            <p class="mb-1 mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t(section.labelKey) }}</p>
            <RouterLink v-for="item in section.items" :key="item.to" :to="item.to" class="flex h-9 items-center gap-2 rounded-md px-2 text-sm" :class="isActivePath(route.path, item.to) ? 'bg-accent text-foreground' : 'text-muted-foreground'" @click="mobileOpen = false"><component :is="item.icon" class="size-4" />{{ t(item.labelKey) }}</RouterLink>
          </template>
        </nav>
      </SheetContent></Sheet>

      <Dialog v-if="auth.authenticated" v-model:open="createOpen"><DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"><DialogHeader><DialogTitle>{{ t('app.newProject') }}</DialogTitle><DialogDescription>{{ t('app.createProject.description') }}</DialogDescription></DialogHeader><form class="space-y-4" @submit.prevent="createProject"><label class="field"><span class="field-label">{{ t('app.createProject.name') }}</span><input v-model="name" required maxlength="160" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" /></label><label class="field"><span class="field-label">{{ t('app.createProject.workspace') }}</span><div class="flex gap-2"><input v-model="workspace" required class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" placeholder="/absolute/path" /><Button v-if="canPickWorkspaceFolder" type="button" variant="outline" size="sm" class="h-9 shrink-0" :disabled="browsing" @click="browseWorkspace">{{ t('app.createProject.browse') }}</Button></div></label><p v-if="createError" role="alert" class="text-xs text-destructive">{{ createError }}</p><div class="flex justify-end gap-2"><Button type="button" variant="outline" @click="createOpen = false">{{ t('common.cancel') }}</Button><Button type="submit" :disabled="creating">{{ creating ? t('app.createProject.creating') : t('app.createProject.submit') }}</Button></div></form></DialogContent></Dialog>

      <Dialog v-if="auth.authenticated" v-model:open="commandOpen"><DialogContent class="max-h-[calc(100dvh-2rem)] max-w-xl gap-0 overflow-y-auto p-0">
        <DialogHeader class="border-b border-border p-4 pb-3"><DialogTitle class="flex items-center gap-2"><Command class="size-4" />{{ t('app.command.title') }}</DialogTitle><DialogDescription>{{ t('app.command.description') }}</DialogDescription></DialogHeader>
        <div class="p-3"><input v-model="query" autofocus class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" :placeholder="t('app.command.placeholder')" :aria-label="t('app.search')" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results" :aria-activedescendant="results.length ? 'command-option-' + selected : undefined" /></div>
        <div ref="commandList" id="command-results" class="max-h-72 overflow-y-auto px-2 pb-2" role="listbox" :aria-label="t('app.command.results')">
          <button v-for="(item, index) in results" :id="'command-option-' + index" :key="item.detail + item.label + item.to" type="button" tabindex="-1" role="option" :aria-selected="selected === index" class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm" :class="selected === index ? 'bg-accent' : 'hover:bg-accent'" @mouseenter="selected = index" @click="navigate(item.to)"><span class="truncate">{{ item.label }}</span><span class="shrink-0 text-xs text-muted-foreground">{{ item.detail }}</span></button>
        </div>
        <p v-if="!results.length" role="status" class="px-2 pb-4 text-center text-xs text-muted-foreground">{{ t('app.command.empty') }}</p>
      </DialogContent></Dialog>
    </template>
    <WindowControls />
    <ToastViewport />
  </div>
</template>
