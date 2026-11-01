<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/common/PageHeader.vue'
import CandidateView from '@/components/governance/CandidateView.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { useGovernanceStore } from '@/stores/governance'
import { useToast } from '@/composables/useToast'
import type { PublishedVersion } from '@/types'
const store = useGovernanceStore(), route = useRoute(), router = useRouter(), { toast } = useToast()
const number = computed(() => Number(route.params.version))
const item = ref<PublishedVersion | null>(null), loading = ref(false), error = ref(''), busy = ref(false), restoreOpen = ref(false)
const title = ref(''), rationale = ref(''), expires = ref('')
let generation = 0
async function load() {
  const ticket = ++generation, project = store.activeProjectId, version = number.value
  item.value = null; error.value = ''; loading.value = false; busy.value = false; restoreOpen.value = false
  if (!project) return
  if (!Number.isSafeInteger(version) || version < 1) { error.value = '版本号无效。'; return }
  loading.value = true
  try { const result = await api.version(project, version); if (ticket === generation && result.projectId === project) item.value = result }
  catch (e) { if (ticket === generation) error.value = e instanceof Error ? e.message : '加载版本失败。' }
  finally { if (ticket === generation) loading.value = false }
}
watch([() => store.activeProjectId, number], load, { immediate: true })
function openRestore() {
  title.value = `恢复版本 ${number.value}`; rationale.value = ''
  const d = new Date(Date.now() + 7 * 86400000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); expires.value = d.toISOString().slice(0,16)
  restoreOpen.value = true
}
async function download(format: 'yaml' | 'json') {
  const project = store.activeProjectId, version = item.value?.version, ticket = generation
  if (!project || !version || busy.value) return
  busy.value = true
  try { await api.exportVersion(project, version, format); if (ticket === generation) toast('导出完成', `${format.toUpperCase()} 文件已下载。`, 'success') }
  catch (e) { if (ticket === generation) toast('导出失败', e instanceof Error ? e.message : '无法下载版本。', 'error') }
  finally { if (ticket === generation) busy.value = false }
}
async function restore() {
  const project = store.activeProjectId, version = item.value?.version, ticket = generation
  const expiry = new Date(expires.value)
  if (!project || !version || busy.value) return
  if (!title.value.trim() || !rationale.value.trim() || !expires.value || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) { error.value = '请填写标题、理由和未来的过期时间。'; return }
  if (store.loading || store.error) { error.value = '当前项目状态不可用，请刷新后重试。'; return }
  busy.value = true; error.value = ''
  try {
    const proposal = await api.restore(project, version, { title: title.value.trim(), rationale: rationale.value.trim(), baseVersion: store.policy?.version ?? 0, expiresAt: expiry.toISOString() })
    if (ticket !== generation || project !== store.activeProjectId) return
    restoreOpen.value = false; toast('回滚提案已创建', '需经审批才会创建新的递增版本。', 'success')
    await store.refreshProject()
    if (ticket === generation && project === store.activeProjectId) await router.push(`/proposals/${encodeURIComponent(proposal.id)}`)
  } catch (e) { if (ticket === generation) { error.value = e instanceof Error ? e.message : '创建回滚提案失败。'; toast('创建失败', error.value, 'error') } }
  finally { if (ticket === generation) busy.value = false }
}
</script>
<template><div class="page"><PageHeader :title="`版本 ${route.params.version}`" description="不可变治理版本；导出和恢复不会直接改变运行时。"><template #actions><RouterLink to="/versions" class="text-xs text-muted-foreground hover:text-foreground">← 返回版本</RouterLink></template></PageHeader>
<div v-if="!store.activeProjectId" class="panel p-5">请先选择项目。</div><div v-else-if="loading" class="panel p-5" role="status">正在加载版本…</div><div v-else-if="!item" class="panel p-5 text-destructive" role="alert">{{ error || '无法加载版本。' }} <button class="underline" @click="load">重试</button></div>
<template v-else><div v-if="error && !restoreOpen" class="mb-4 rounded border border-destructive/30 p-3 text-sm text-destructive" role="alert">{{ error }}</div><section class="panel mb-4 p-5"><h2 class="text-sm font-semibold">版本 {{ item.version }}</h2><dl class="mt-4 grid gap-4 text-xs sm:grid-cols-2"><div><dt class="text-muted-foreground">提案</dt><dd class="break-all font-mono">{{ item.proposalId }}</dd></div><div><dt class="text-muted-foreground">上一版本 / 审批人</dt><dd>{{ item.previousVersion ?? '—' }} / {{ item.approvedBy.id }}</dd></div><div><dt class="text-muted-foreground">发布时间</dt><dd>{{ formatDate(item.createdAt) }}</dd></div><div><dt class="text-muted-foreground">候选 digest</dt><dd class="break-all font-mono">{{ item.snapshot.candidateDigest }}</dd></div><div><dt class="text-muted-foreground">快照 digest</dt><dd class="break-all font-mono">{{ item.snapshot.digest }}</dd></div><div><dt class="text-muted-foreground">Enforcement digest</dt><dd class="break-all font-mono">{{ item.snapshot.enforcementDigest }}</dd></div><div><dt class="text-muted-foreground">Advisory digest</dt><dd class="break-all font-mono">{{ item.snapshot.advisoryDigest }}</dd></div><div><dt class="text-muted-foreground">Schema digest</dt><dd class="break-all font-mono">{{ item.snapshot.schemaDigest }}</dd></div></dl><div class="mt-4 flex flex-wrap gap-2"><Button size="sm" variant="outline" :disabled="busy" @click="download('yaml')">下载 YAML</Button><Button size="sm" variant="outline" :disabled="busy" @click="download('json')">下载 JSON</Button><Button size="sm" :disabled="busy || store.loading || !!store.error" @click="openRestore">创建回滚提案</Button></div></section><CandidateView :candidate="item.candidate" />
<Dialog v-model:open="restoreOpen"><DialogContent class="max-h-[90dvh] overflow-y-auto rounded-md sm:max-w-md"><DialogHeader><DialogTitle>基于版本 {{ item.version }} 创建回滚提案</DialogTitle><DialogDescription>仅创建提案，审批后才生成递增的新版本，不直接移动当前版本指针。</DialogDescription></DialogHeader><form class="space-y-4" @submit.prevent="restore"><div v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</div><p class="text-xs text-muted-foreground">当前基准版本：{{ store.policy?.version ?? 0 }}</p><label class="block text-xs">标题<input v-model="title" required maxlength="160" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"></label><label class="block text-xs">理由<textarea v-model="rationale" required rows="3" class="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm" /></label><label class="block text-xs">过期时间<input v-model="expires" required type="datetime-local" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"></label><DialogFooter><Button type="button" variant="outline" :disabled="busy" @click="restoreOpen = false">取消</Button><Button type="submit" :disabled="busy">{{ busy ? '提交中…' : '创建提案' }}</Button></DialogFooter></form></DialogContent></Dialog></template></div></template>
