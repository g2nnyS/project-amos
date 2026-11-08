<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
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
import { useGovernanceStore } from '@/stores/governance'

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

const results = computed(() => {
  const pages = navSections.flatMap(section => section.items.map(item => ({ label: item.label, detail: section.label, to: item.to })))
  const rules = (governance.policy?.candidate.rules ?? []).map(rule => ({ label: rule.id, detail: '已发布规则', to: `/rules?id=${encodeURIComponent(rule.id)}` }))
  const proposals = governance.proposals.map(p => ({ label: p.title, detail: '提案', to: `/proposals/${encodeURIComponent(p.id)}` }))
  const versions = governance.versions.map(v => ({ label: `版本 ${v.version}`, detail: '历史版本', to: `/versions/${v.version}` }))
  const term = query.value.trim().toLowerCase()
  return [...pages, ...rules, ...proposals, ...versions].filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(term)).slice(0, 30)
})
watch(query, () => { selected.value = 0 })
watch(() => route.fullPath, () => { mobileOpen.value = false })
watch(() => auth.authenticated, async value => {
  if (value) await governance.initialize().catch(() => {})
  else { governance.clear(); mobileOpen.value = false; commandOpen.value = false; createOpen.value = false }
}, { immediate: true })
watch(() => preferences.resolvedTheme, value => {
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.classList.toggle('light', value === 'light')
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
  <div class="flex h-dvh overflow-hidden bg-background text-foreground" :data-density="preferences.compact ? 'compact' : 'comfortable'">
    <div v-if="!auth.ready" class="m-auto text-sm text-muted-foreground" role="status">正在连接本地治理服务…</div>
    <LoginView v-else-if="!auth.authenticated" />
    <template v-else>
      <aside class="hidden h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex" :class="preferences.sidebarCollapsed ? 'w-16' : 'w-[224px]'">
        <RouterLink to="/" class="flex h-[60px] items-center gap-3 border-b border-sidebar-border px-4" aria-label="Amos 首页">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-[17px] font-bold">A</span>
          <span v-if="!preferences.sidebarCollapsed" class="text-[18px] font-bold tracking-tight">Amos</span>
        </RouterLink>
        <div class="border-b border-sidebar-border p-3">
          <label v-if="!preferences.sidebarCollapsed" for="project-select" class="eyebrow mb-1.5 block">当前项目</label>
          <select id="project-select" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" :aria-label="'选择项目'" :value="governance.activeProjectId ?? ''" @change="selectProject">
            <option value="">选择项目</option>
            <option v-for="project in governance.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
          <button v-if="!preferences.sidebarCollapsed" class="mt-2 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" @click="createOpen = true"><Plus class="size-3.5" />新建项目</button>
          <button v-else class="mt-2 flex w-full justify-center rounded py-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" aria-label="新建项目" title="新建项目" @click="createOpen = true"><Plus class="size-4" /></button>
        </div>
        <nav class="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="主导航">
          <template v-for="section in navSections" :key="section.label">
            <p v-if="!preferences.sidebarCollapsed" class="mb-1 mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-primary/80">{{ section.label }}</p>
            <RouterLink v-for="item in section.items" :key="item.to" :to="item.to" :title="preferences.sidebarCollapsed ? item.label : undefined" :aria-label="item.label" :aria-current="isActivePath(route.path, item.to) ? 'page' : undefined" class="mb-0.5 flex h-8 items-center gap-2.5 rounded-md px-2 text-[12.5px] transition-colors" :class="isActivePath(route.path, item.to) ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'"><component :is="item.icon" class="size-4 shrink-0" /><span v-if="!preferences.sidebarCollapsed">{{ item.label }}</span></RouterLink>
          </template>
        </nav>
        <div class="border-t border-sidebar-border p-2">
          <button class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[11px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" :aria-label="preferences.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'" @click="preferences.toggleSidebar()">
            <PanelLeftOpen v-if="preferences.sidebarCollapsed" class="size-4" />
            <PanelLeftClose v-else class="size-4" />
            <span v-if="!preferences.sidebarCollapsed">折叠侧栏</span>
          </button>
        </div>
      </aside>
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-[60px] shrink-0 items-center gap-3 border-b border-border px-4 sm:px-5">
          <button class="rounded p-1.5 text-muted-foreground lg:hidden" aria-label="打开导航" @click="mobileOpen = true"><Menu class="size-5" /></button>
          <span class="hidden max-w-[160px] truncate text-xs text-muted-foreground sm:block">{{ governance.activeProject?.name ?? '未选择项目' }}</span>
          <ChevronRight class="hidden size-3 text-muted-foreground sm:block" />
          <span class="truncate text-xs font-medium">{{ pageLabelForPath(route.path) }}</span>
          <span class="hidden rounded border border-border px-2 py-1 text-[10px] text-muted-foreground md:block">本地版本 {{ governance.policy ? `v${governance.policy.version}` : '未发布' }}</span>
          <span class="ml-auto hidden items-center gap-1.5 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground sm:inline-flex"><ShieldAlert class="size-3" />Harness 全局默认 · 项目可覆盖</span>
          <button class="flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground hover:bg-accent" aria-label="搜索页面和治理记录" @click="commandOpen = true"><Search class="size-3.5" /><span class="hidden md:block">搜索</span><kbd class="kbd hidden md:inline-flex">⌘ K</kbd></button>
          <button class="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="退出登录" title="退出登录" @click="logout"><LogOut class="size-4" /></button>
        </header>
        <main id="main-content" class="content-scroll app-atmosphere min-h-0 flex-1 overflow-y-auto"><RouterView /></main>
      </div>
      <Sheet v-model:open="mobileOpen"><SheetContent side="left" class="w-[300px] overflow-y-auto p-0 pb-16">
        <SheetHeader class="border-b border-sidebar-border p-4"><SheetTitle>Amos</SheetTitle><SheetDescription>本地治理控制台</SheetDescription></SheetHeader>
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
      <Dialog v-model:open="createOpen"><DialogContent class="sm:max-w-md"><DialogHeader><DialogTitle>新建项目</DialogTitle><DialogDescription>工作区路径用于策略绑定，创建后不可更改；不会授权网页读取目录。</DialogDescription></DialogHeader><form class="space-y-4" @submit.prevent="createProject"><label class="field"><span class="field-label">项目名称</span><input v-model="name" required maxlength="160" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" /></label><label class="field"><span class="field-label">绝对工作区路径</span><input v-model="workspace" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" placeholder="/absolute/path" /></label><p v-if="createError" role="alert" class="text-xs text-destructive">{{ createError }}</p><div class="flex justify-end gap-2"><Button type="button" variant="outline" @click="createOpen = false">取消</Button><Button type="submit" :disabled="creating">{{ creating ? '创建中…' : '创建项目' }}</Button></div></form></DialogContent></Dialog>
      <Dialog v-model:open="commandOpen"><DialogContent class="max-w-xl gap-0 p-0">
        <DialogHeader class="border-b border-border p-4 pb-3"><DialogTitle class="flex items-center gap-2"><Command class="size-4" />搜索治理控制台</DialogTitle><DialogDescription>搜索页面、已发布规则、提案和版本。上下键选择，回车打开。</DialogDescription></DialogHeader>
        <div class="p-3"><input v-model="query" autofocus class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" placeholder="搜索页面、规则、提案或版本" aria-label="搜索" /></div>
        <div class="max-h-72 overflow-y-auto px-2 pb-2" role="listbox">
          <button v-for="(item, index) in results" :key="item.detail + item.label + item.to" type="button" role="option" :aria-selected="selected === index" class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm" :class="selected === index ? 'bg-accent' : 'hover:bg-accent'" @mouseenter="selected = index" @click="navigate(item.to)"><span class="truncate">{{ item.label }}</span><span class="shrink-0 text-xs text-muted-foreground">{{ item.detail }}</span></button>
          <p v-if="!results.length" class="py-6 text-center text-xs text-muted-foreground">没有匹配结果</p>
        </div>
      </DialogContent></Dialog>
    </template>
    <ToastViewport />
  </div>
</template>
