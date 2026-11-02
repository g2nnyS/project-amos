<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ShieldAlert, FileCheck, GitPullRequest, History, Eye, FlaskConical, Lock, AlertTriangle } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useGovernanceStore } from '@/stores/governance'
import { useAuthStore } from '@/stores/auth'
import type { GovernanceEvent } from '@/types'

const governance = useGovernanceStore()
const auth = useAuthStore()
const audit = ref<GovernanceEvent[]>([])
const auditError = ref('')
const auditLoading = ref(false)
let generation = 0

async function loadAudit() {
  const id = governance.activeProjectId
  const request = ++generation
  audit.value = []; auditError.value = ''
  if (!id) return
  auditLoading.value = true
  try {
    const data = await api.audit({ projectId: id, limit: 6 })
    if (request === generation) audit.value = data.items
  } catch (error) {
    if (request === generation) auditError.value = error instanceof Error ? error.message : '审计记录加载失败'
  } finally {
    if (request === generation) auditLoading.value = false
  }
}

watch(() => governance.activeProjectId, () => void loadAudit(), { immediate: true })

const stats = computed(() => [
  { label: '当前版本', value: governance.activeProject?.currentVersion == null ? '尚未发布' : `v${governance.activeProject.currentVersion}`, note: governance.activeProject?.currentVersion == null ? '项目无已发布治理版本' : '已发布本地治理版本' },
  { label: '已发布规则', value: String(governance.policy?.candidate.rules.length ?? 0), note: '当前候选中的规则总数' },
  { label: '本地选中规则', value: String(activeCount.value), note: activationNote.value },
  { label: '待审提案', value: String(governance.proposals.filter(p => p.status === 'pending').length), note: '需审批后才会生成版本' },
  { label: '历史版本', value: String(governance.versions.length), note: '不可变治理快照' },
])

const activeCount = computed(() => {
  const rules = governance.policy?.candidate.rules ?? []
  const activation = governance.policy?.candidate.activation
  if (!activation) return 0
  const included = activation.includedRuleIds
  if (included === null) return rules.filter(r => !activation.excludedRuleIds.includes(r.id)).length
  return rules.filter(r => included.includes(r.id) && !activation.excludedRuleIds.includes(r.id)).length
})

const activationNote = computed(() => {
  const activation = governance.policy?.candidate.activation
  if (!activation) return '—'
  if (activation.includedRuleIds === null) {
    const excluded = activation.excludedRuleIds.length
    return excluded ? `包含全部，排除 ${excluded} 条` : '包含全部规则'
  }
  return `显式包含 ${activation.includedRuleIds.length} 条`
})

const pendingProposals = computed(() => governance.proposals.filter(p => p.status === 'pending').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const staleProposals = computed(() => pendingProposals.value.filter(p => p.baseVersion !== (governance.policy?.version ?? 0)))
const eventLabels: Record<string, string> = { project_created: '创建项目', proposal_created: '创建提案', proposal_approved: '批准提案', proposal_rejected: '拒绝提案', proposal_withdrawn: '撤回提案', proposal_expired: '提案过期', version_published: '发布版本' }
</script>

<template>
  <div class="page">
    <PageHeader title="项目边界" description="查看项目绑定、本地治理配置及运行状态的已知边界。">
      <template #actions>
        <span v-if="auth.session?.role" class="hidden text-xs text-muted-foreground md:inline">当前身份：{{ auth.session.role === 'human' ? '人类' : 'Agent' }}</span>
      </template>
    </PageHeader>

    <div class="mb-4 rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      <strong class="text-foreground">运行边界：</strong>Stage A 为 log-only；本地治理发布不改变运行时配置，不授权工具执行。同 UID 访问并非可信隔离。已发布版本与运行时状态相互独立。
    </div>

    <div v-if="governance.error" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.initialize()">重试</button></div>
    <div v-if="governance.loading" class="py-8 text-sm text-muted-foreground" role="status">正在加载治理数据…</div>
    <div v-else-if="governance.error" class="text-xs text-muted-foreground">项目数据不可用，无法计算配置数量。</div>
    <EmptyState v-else-if="!governance.activeProject" title="尚未选择项目" description="请在侧栏创建或选择项目。新项目不会自动发布策略。" />

    <template v-else>
      <section class="panel mb-4">
        <div class="panel-header"><div><h2 class="panel-title">项目与本地快照</h2><p class="panel-kicker">绑定工作区与已发布治理版本；不是运行时快照。</p></div><RouterLink to="/versions" class="text-xs text-primary hover:underline">版本历史 →</RouterLink></div>
        <dl class="grid gap-4 p-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <div><dt class="field-label">项目</dt><dd class="mt-1 break-all font-medium">{{ governance.activeProject.name }}</dd><dd class="mt-1 break-all font-mono text-muted-foreground">{{ governance.activeProject.id }}</dd></div>
          <div><dt class="field-label">绑定工作区</dt><dd class="mt-1 break-all font-mono">{{ governance.activeProject.workspace }}</dd></div>
          <div><dt class="field-label">本地发布时间</dt><dd class="mt-1">{{ governance.policy ? new Date(governance.policy.createdAt).toLocaleString('zh-CN') : '尚未发布' }}</dd></div>
          <div><dt class="field-label">本地快照摘要</dt><dd class="mt-1 break-all font-mono">{{ governance.policy?.snapshot.digest ?? '尚无快照' }}</dd></div>
        </dl>
      </section>
      <section class="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <article v-for="stat in stats" :key="stat.label" class="panel p-3">
          <p class="eyebrow">{{ stat.label }}</p>
          <p class="mt-3 text-xl font-semibold tabular">{{ stat.value }}</p>
          <p class="mt-1 text-[11px] text-muted-foreground">{{ stat.note }}</p>
        </article>
      </section>

      <div class="grid gap-4 lg:grid-cols-3">
        <section class="panel lg:col-span-2">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">最近治理审计</h2>
              <p class="panel-kicker">实际项目状态变更，不包含规则正文或自由文本备注。</p>
            </div>
            <RouterLink to="/audit" class="text-xs text-muted-foreground hover:text-foreground">查看全部 →</RouterLink>
          </div>
          <p v-if="auditLoading" class="p-4 text-xs text-muted-foreground">加载中…</p>
          <div v-else-if="auditError" class="p-4 text-xs text-destructive">{{ auditError }} <button class="underline" @click="loadAudit">重试</button></div>
          <p v-else-if="!audit.length" class="p-6 text-center text-xs text-muted-foreground">暂无审计记录。</p>
          <table v-else class="data-table">
            <thead>
              <tr><th>事件</th><th>操作者</th><th>时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="event in audit" :key="event.id">
                <td>{{ eventLabels[event.kind] ?? event.kind }}</td>
                <td>{{ event.actor.id }} · {{ event.actor.role }}</td>
                <td class="tabular">{{ new Date(event.createdAt).toLocaleString('zh-CN') }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="space-y-4">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">治理注意</h2>
                <p class="panel-kicker">需要人工关注的状态</p>
              </div>
              <RouterLink to="/proposals" class="text-xs text-muted-foreground hover:text-foreground">提案 →</RouterLink>
            </div>
            <div class="space-y-2 p-3">
              <div v-if="pendingProposals.length === 0" class="flex items-center gap-2 text-xs text-muted-foreground"><FileCheck class="size-4" />无待审提案。</div>
              <div v-else class="flex items-start gap-2 text-xs">
                <GitPullRequest class="mt-0.5 size-4 text-info" />
                <div>
                  <p class="font-medium">{{ pendingProposals.length }} 个待审提案</p>
                  <p v-if="staleProposals.length" class="mt-1 text-warning"><AlertTriangle class="inline size-3" /> {{ staleProposals.length }} 个基准版本已过期，需基于当前策略重新提案。</p>
                </div>
              </div>
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldAlert class="mt-0.5 size-4" />
                <span>运行期策略状态未知：本控制台只显示本地治理发布记录。</span>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">权限与能力</h2>
                <p class="panel-kicker">当前 API 未暴露权限矩阵</p>
              </div>
              <Lock class="size-4 text-muted-foreground" />
            </div>
            <div class="space-y-3 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>权限查询、角色矩阵与能力图谱尚未接入后端。以下状态基于当前会话角色与项目元数据，可能不完整：</p>
              <ul class="list-disc space-y-1 pl-4">
                <li>人类可创建项目、审批、撤回任意提案。</li>
                <li>Agent 可读取、校验、模拟、提交与撤回自己的提案，不能审批。</li>
                <li>权限判定以服务端领域层为准，前端仅展示已知约束。</li>
              </ul>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">目标能力</h2>
                <p class="panel-kicker">规划中的治理与评估能力</p>
              </div>
            </div>
            <div class="grid gap-2 p-3">
              <div class="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
                <Eye class="size-4 text-info" />
                <span>规则覆盖与命中率评估</span>
                <span class="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px]">规划中</span>
              </div>
              <RouterLink to="/simulate" class="flex items-center gap-2 rounded-md border border-border p-2 text-xs hover:bg-accent">
                <FlaskConical class="size-4 text-info" />
                <span>动作假设评估（模拟器）</span>
                <span class="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info">可用</span>
              </RouterLink>
              <RouterLink to="/versions" class="flex items-center gap-2 rounded-md border border-border p-2 text-xs hover:bg-accent">
                <History class="size-4 text-info" />
                <span>版本详情与回滚提案</span>
                <span class="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info">可用</span>
              </RouterLink>
            </div>
          </section>
        </div>
      </div>

      <section class="panel mt-4">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">本地配置与运行状态</h2>
            <p class="panel-kicker">区分已发布治理候选与运行时未知状态</p>
          </div>
        </div>
        <div class="grid gap-4 p-4 text-xs lg:grid-cols-2">
          <div class="rounded-md border border-border bg-surface p-3">
            <p class="font-semibold">已发布候选（本地治理）</p>
            <ul class="mt-2 space-y-1 text-muted-foreground">
              <li>版本：{{ governance.policy ? `v${governance.policy.version}` : '尚未发布' }}</li>
              <li>规则数：{{ governance.policy?.candidate.rules.length ?? 0 }}</li>
              <li>本地选中规则数：{{ activeCount }}</li>
              <li>快照 digest：{{ governance.policy ? `${governance.policy.snapshot.digest.slice(0, 24)}…` : '—' }}</li>
            </ul>
          </div>
          <div class="rounded-md border border-dashed border-border p-3">
            <p class="font-semibold">运行时执行状态</p>
            <p class="mt-2 text-muted-foreground">Stage A 为 log-only。本控制台不显示运行时适配器是否已加载或生效任何规则；运行时状态需通过独立运维路径确认。</p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
