<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { Menu, PanelLeftClose, PanelLeftOpen, Search, Plus, LogOut, ChevronRight, ShieldAlert, Command } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import ToastViewport from '@/components/layout/ToastViewport.vue'
import LoginView from '@/views/LoginView.vue'
import { navSections, isActivePath, pageLabelForPath } from '@/components/layout/navigation'
import { usePreferencesStore } from '@/stores/preferences'
import { useAuthStore } from '@/stores/auth'
import { shouldClearForAuthState, useGovernanceStore } from '@/stores/governance'

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
  const pages = navSections.flatMap(section => section.items.map(item => ({ label: item.label, detail: section.label, to: item.to })))
  const rules = (governance.policy?.candidate.rules ?? []).map(rule => ({ label: rule.id, detail: '已发布规则', to: `/rules?id=${encodeURIComponent(rule.id)}` }))
  const proposals = governance.proposals.map(p => ({ label: p.title, detail: '提案', to: `/proposals/${encodeURIComponent(p.id)}` }))
  const versions = governance.versions.map(v => ({ label: `版本 ${v.version}`, detail: '历史版本', to: `/versions/${v.version}` }))
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
  if (!name.value.trim() || !workspace.value.startsWith('/')) { createError.value = '请填写项目名称和规范化绝对工作区路径。'; return }
  creating.value = true
  try { await governance.createProject({ name: name.value.trim(), workspace: workspace.value.trim() }); name.value = ''; workspace.value = ''; createOpen.value = false; await router.push('/') }
  catch (error) { createError.value = error instanceof Error ? error.message : '创建失败，请重试。' }
  finally { creating.value = false }
}
async function logout() { try { await auth.logout() } catch {} }
function selectProject(event: Event) { const id = (event.target as HTMLSelectElement).value; void governance.selectProject(id || null).catch(() => {}) }
onMounted(() => { window.addEventListener('keydown', keys); void auth.bootstrap().catch(() => {}) })
onBeforeUnmount(() => window.removeEventListener('keydown', keys))
</script>

<template>
  <div class="app-shell" :data-density="preferences.compact ? 'compact' : 'comfortable'" :data-collapsed="preferences.sidebarCollapsed ? 'true' : 'false'">
    <a class="skip-link" href="#main-content">跳到主内容</a>
    <div v-if="!auth.ready" class="shell-status" role="status">正在连接本地治理服务…</div>
    <template v-else>
      <div class="shell-workspace" :inert="!auth.authenticated" :aria-hidden="auth.authenticated ? undefined : 'true'">
        <aside class="app-sidebar" aria-label="主导航侧栏">
          <div class="sidebar-project">
            <label class="sidebar-label" for="project-select">当前项目</label>
            <select id="project-select" class="project-select" aria-label="选择项目" :value="governance.activeProjectId ?? ''" @change="selectProject">
              <option value="">选择项目</option>
              <option v-for="project in governance.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
            <button type="button" class="sidebar-add" aria-label="新建项目" title="新建项目" @click="createOpen = true">
              <Plus class="size-3.5" aria-hidden="true" /><span class="sidebar-add-text">新建项目</span>
            </button>
          </div>

          <nav class="sidebar-nav scroll-thin" aria-label="主导航">
            <div v-for="section in navSections" :key="section.label" class="nav-section">
              <p class="nav-section-label">{{ section.label }}</p>
              <RouterLink
                v-for="item in section.items"
                :key="item.to"
                :to="item.to"
                class="nav-item"
                :aria-label="item.label"
                :aria-current="isActivePath(route.path, item.to) ? 'page' : undefined"
                :title="preferences.sidebarCollapsed ? item.label : undefined"
              >
                <component :is="item.icon" class="nav-icon" aria-hidden="true" />
                <span class="nav-text">{{ item.label }}</span>
              </RouterLink>
            </div>
          </nav>

          <div class="sidebar-footer">
            <p class="sidebar-note">受管模式默认关闭；启用后 Pi 工具调用可被阻断。发布不等于宿主已加载。</p>
            <button type="button" class="sidebar-toggle" :aria-label="preferences.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'" :title="preferences.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'" @click="preferences.toggleSidebar()">
              <PanelLeftOpen v-if="preferences.sidebarCollapsed" class="size-4" aria-hidden="true" />
              <PanelLeftClose v-else class="size-4" aria-hidden="true" />
              <span class="sidebar-toggle-text">折叠侧栏</span>
            </button>
          </div>
        </aside>

        <div class="app-main">
          <header class="app-topbar">
            <button type="button" class="topbar-icon topbar-menu" aria-label="打开导航" @click="mobileOpen = true"><Menu class="size-4" aria-hidden="true" /></button>
            <div class="topbar-crumbs">
              <span class="crumb-project">{{ governance.activeProject?.name ?? '未选择项目' }}</span>
              <ChevronRight class="crumb-sep" aria-hidden="true" />
              <span class="crumb-page">{{ pageLabelForPath(route.path) }}</span>
            </div>
            <div class="topbar-actions">
              <span class="topbar-pill topbar-pill-version">本地版本 {{ governance.policy ? `v${governance.policy.version}` : '未发布' }}</span>
              <span class="topbar-pill topbar-pill-managed"><ShieldAlert class="size-3" aria-hidden="true" />Harness 全局默认 · 项目可覆盖</span>
              <button type="button" class="topbar-search" aria-label="搜索页面和治理记录" @click="commandOpen = true">
                <Search class="size-3.5" aria-hidden="true" /><span>搜索</span><kbd class="kbd">⌘K</kbd>
              </button>
              <button type="button" class="topbar-icon" aria-label="退出登录" title="退出登录" @click="logout"><LogOut class="size-4" aria-hidden="true" /></button>
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
        <SheetHeader class="sr-only"><SheetTitle>主导航</SheetTitle><SheetDescription>项目选择与页面导航</SheetDescription></SheetHeader>
        <div class="p-4">
          <label class="field-label mb-1.5 block" for="mobile-project">当前项目</label>
          <select id="mobile-project" class="h-9 w-full rounded-md border border-input bg-background px-2 text-xs" :value="governance.activeProjectId ?? ''" @change="selectProject"><option value="">选择项目</option><option v-for="project in governance.projects" :key="project.id" :value="project.id">{{ project.name }}</option></select>
          <Button class="mt-3 w-full" variant="outline" size="sm" @click="mobileOpen = false; createOpen = true">新建项目</Button>
        </div>
        <nav class="px-2" aria-label="移动导航">
          <template v-for="section in navSections" :key="section.label">
            <p class="mb-1 mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ section.label }}</p>
            <RouterLink v-for="item in section.items" :key="item.to" :to="item.to" class="flex h-9 items-center gap-2 rounded-md px-2 text-sm" :class="isActivePath(route.path, item.to) ? 'bg-accent text-foreground' : 'text-muted-foreground'" @click="mobileOpen = false"><component :is="item.icon" class="size-4" />{{ item.label }}</RouterLink>
          </template>
        </nav>
        <p class="mt-4 border-t border-sidebar-border p-4 text-xs text-muted-foreground">Harness 行为由全局默认与项目覆盖决定，Workflow Gate 独立配置。保存或发布不等于宿主已加载；Managed 仅覆盖已接管工具入口，不是 OS 沙箱。</p>
      </SheetContent></Sheet>

      <Dialog v-if="auth.authenticated" v-model:open="createOpen"><DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"><DialogHeader><DialogTitle>新建项目</DialogTitle><DialogDescription>工作区路径用于策略绑定，创建后不可更改；不会授权网页读取目录。</DialogDescription></DialogHeader><form class="space-y-4" @submit.prevent="createProject"><label class="field"><span class="field-label">项目名称</span><input v-model="name" required maxlength="160" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" /></label><label class="field"><span class="field-label">绝对工作区路径</span><input v-model="workspace" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" placeholder="/absolute/path" /></label><p v-if="createError" role="alert" class="text-xs text-destructive">{{ createError }}</p><div class="flex justify-end gap-2"><Button type="button" variant="outline" @click="createOpen = false">取消</Button><Button type="submit" :disabled="creating">{{ creating ? '创建中…' : '创建项目' }}</Button></div></form></DialogContent></Dialog>

      <Dialog v-if="auth.authenticated" v-model:open="commandOpen"><DialogContent class="max-h-[calc(100dvh-2rem)] max-w-xl gap-0 overflow-y-auto p-0">
        <DialogHeader class="border-b border-border p-4 pb-3"><DialogTitle class="flex items-center gap-2"><Command class="size-4" />搜索治理控制台</DialogTitle><DialogDescription>搜索页面、已发布规则、提案和版本。上下键选择，回车打开。</DialogDescription></DialogHeader>
        <div class="p-3"><input v-model="query" autofocus class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" placeholder="搜索页面、规则、提案或版本" aria-label="搜索" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results" :aria-activedescendant="results.length ? 'command-option-' + selected : undefined" /></div>
        <div ref="commandList" id="command-results" class="max-h-72 overflow-y-auto px-2 pb-2" role="listbox" aria-label="搜索结果">
          <button v-for="(item, index) in results" :id="'command-option-' + index" :key="item.detail + item.label + item.to" type="button" tabindex="-1" role="option" :aria-selected="selected === index" class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm" :class="selected === index ? 'bg-accent' : 'hover:bg-accent'" @mouseenter="selected = index" @click="navigate(item.to)"><span class="truncate">{{ item.label }}</span><span class="shrink-0 text-xs text-muted-foreground">{{ item.detail }}</span></button>
        </div>
        <p v-if="!results.length" role="status" class="px-2 pb-4 text-center text-xs text-muted-foreground">没有匹配结果</p>
      </DialogContent></Dialog>
    </template>
    <ToastViewport />
  </div>
</template>
