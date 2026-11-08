<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Download, RotateCcw } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import CandidateView from '@/components/governance/CandidateView.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { useGovernanceStore } from '@/stores/governance'
import { useToast } from '@/composables/useToast'
import type { PublishedVersion } from '@/types'

const store = useGovernanceStore()
const route = useRoute()
const router = useRouter()
const { toast } = useToast()

const number = computed(() => Number(route.params.version))
const item = ref<PublishedVersion | null>(null)
const rolloutRows = computed(() => store.rollouts)
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const restoreOpen = ref(false)
const title = ref('')
const rationale = ref('')
const expires = ref('')
let generation = 0

async function load() {
  const ticket = ++generation
  const project = store.activeProjectId
  const version = number.value
  item.value = null
  error.value = ''
  loading.value = false
  busy.value = false
  restoreOpen.value = false
  if (!project) return
  if (!Number.isSafeInteger(version) || version < 1) { error.value = '版本号无效。'; return }
  loading.value = true
  try {
    const result = await api.version(project, version)
    if (ticket === generation && result.projectId === project) item.value = result
  } catch (e) {
    if (ticket === generation) error.value = e instanceof Error ? e.message : '加载版本失败。'
  } finally {
    if (ticket === generation) loading.value = false
  }
}

watch([() => store.activeProjectId, number], load, { immediate: true })

function openRestore() {
  title.value = `恢复版本 ${number.value}`
  rationale.value = ''
  const d = new Date(Date.now() + 7 * 86400000)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  expires.value = d.toISOString().slice(0, 16)
  restoreOpen.value = true
}

async function download(format: 'yaml' | 'json') {
  const project = store.activeProjectId
  const version = item.value?.version
  const ticket = generation
  if (!project || !version || busy.value) return
  busy.value = true
  try {
    await api.exportVersion(project, version, format)
    if (ticket === generation) toast('导出完成', `${format.toUpperCase()} 文件已下载。`, 'success')
  } catch (e) {
    if (ticket === generation) toast('导出失败', e instanceof Error ? e.message : '无法下载版本。', 'error')
  } finally {
    if (ticket === generation) busy.value = false
  }
}

async function restore() {
  const project = store.activeProjectId
  const version = item.value?.version
  const ticket = generation
  const expiry = new Date(expires.value)
  if (!project || !version || busy.value) return
  if (!title.value.trim() || !rationale.value.trim() || !expires.value || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    error.value = '请填写标题、理由和未来的过期时间。'
    return
  }
  if (store.loading || store.error) { error.value = '当前项目状态不可用，请刷新后重试。'; return }
  busy.value = true
  error.value = ''
  try {
    const proposal = await api.restore(project, version, {
      title: title.value.trim(),
      rationale: rationale.value.trim(),
      baseVersion: store.policy?.version ?? 0,
      expiresAt: expiry.toISOString()
    })
    if (ticket !== generation || project !== store.activeProjectId) return
    restoreOpen.value = false
    toast('回滚提案已创建', '需经审批才会创建新的递增版本。', 'success')
    await store.refreshProject()
    if (ticket === generation && project === store.activeProjectId) await router.push(`/proposals/${encodeURIComponent(proposal.id)}`)
  } catch (e) {
    if (ticket === generation) {
      error.value = e instanceof Error ? e.message : '创建回滚提案失败。'
      toast('创建失败', error.value, 'error')
    }
  } finally {
    if (ticket === generation) busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader :title="`版本 ${route.params.version}`" description="不可变治理版本；导出和恢复不会直接改变运行时。">
      <template #actions>
        <RouterLink to="/versions" class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft class="size-3.5" />返回版本</RouterLink>
      </template>
    </PageHeader>

    <div v-if="!store.activeProjectId" class="panel p-5">请先选择项目。</div>
    <div v-else-if="loading" class="panel p-5" role="status">正在加载版本…</div>
    <div v-else-if="!item" class="panel p-5 text-destructive" role="alert">{{ error || '无法加载版本。' }} <button class="ml-2 underline" @click="load">重试</button></div>

    <template v-else>
      <div v-if="error && !restoreOpen" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">{{ error }}</div>

      <section class="panel mb-4">
        <div class="panel-header">
          <div>
            <h2 class="text-base font-semibold">版本 {{ item.version }}</h2>
            <p class="panel-kicker">{{ item.previousVersion == null ? '初始版本' : `基于版本 ${item.previousVersion}` }} · {{ item.candidate.rules.length }} 条规则</p>
          </div>
        </div>
        <div class="panel-body grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><dt class="text-[11px] text-muted-foreground">提案</dt><dd class="break-all font-mono">{{ item.proposalId }}</dd></div>
          <div><dt class="text-[11px] text-muted-foreground">审批人</dt><dd>{{ item.approvedBy.id }} · {{ item.approvedBy.role }}</dd></div>
          <div><dt class="text-[11px] text-muted-foreground">发布时间</dt><dd>{{ formatDate(item.createdAt) }}</dd></div>
          <div><dt class="text-[11px] text-muted-foreground">候选 digest</dt><dd class="break-all font-mono">{{ item.snapshot.candidateDigest.slice(0, 16) }}…</dd></div>
        </div>
        <div class="panel-body border-t border-hairline text-xs">
          <p class="field-label">快照 digest</p>
          <p class="mt-1 break-all font-mono">{{ item.snapshot.digest }}</p>
        </div>
        <div class="flex flex-wrap gap-2 border-t border-hairline p-4">
          <Button size="sm" variant="outline" :disabled="busy" @click="download('yaml')"><Download class="mr-1 size-3.5" />下载 YAML</Button>
          <Button size="sm" variant="outline" :disabled="busy" @click="download('json')"><Download class="mr-1 size-3.5" />下载 JSON</Button>
          <Button size="sm" :disabled="busy || store.loading || !!store.error" @click="openRestore"><RotateCcw class="mr-1 size-3.5" />创建回滚提案</Button>
        </div>
      </section>

      <section class="panel mb-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">规则 Rollout 状态</h2>
            <p class="panel-kicker">版本发布不自动晋升；状态由绑定的 probe 证据推进。</p>
          </div>
        </div>
        <div v-if="!rolloutRows.length" class="p-4 text-xs text-muted-foreground">尚无 rollout 状态。</div>
        <div v-else class="overflow-x-auto">
          <table class="data-table min-w-[420px]">
            <thead><tr><th>规则</th><th>版本</th><th>状态</th><th>更新时间</th></tr></thead>
            <tbody>
              <tr v-for="row in rolloutRows" :key="row.ruleId">
                <td class="break-all font-mono text-xs">{{ row.ruleId }}</td>
                <td class="num">v{{ row.ruleVersion }}</td>
                <td>{{ row.state }}</td>
                <td>{{ formatDate(row.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <CandidateView :candidate="item.candidate" />

      <Dialog v-model:open="restoreOpen">
        <DialogContent class="max-h-[90dvh] overflow-y-auto rounded-md sm:max-w-md">
          <DialogHeader>
            <DialogTitle>基于版本 {{ item.version }} 创建回滚提案</DialogTitle>
            <DialogDescription>仅创建提案，审批后才生成递增的新版本，不直接移动当前版本指针。</DialogDescription>
          </DialogHeader>
          <form class="space-y-4" @submit.prevent="restore">
            <div v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</div>
            <p class="text-xs text-muted-foreground">当前基准版本：{{ store.policy?.version ?? 0 }}</p>
            <label class="block text-xs">
              标题
              <input v-model="title" required maxlength="160" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
            </label>
            <label class="block text-xs">
              理由
              <textarea v-model="rationale" required rows="3" class="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm" />
            </label>
            <label class="block text-xs">
              过期时间
              <input v-model="expires" required type="datetime-local" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" :disabled="busy" @click="restoreOpen = false">取消</Button>
              <Button type="submit" :disabled="busy">{{ busy ? '提交中…' : '创建提案' }}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
