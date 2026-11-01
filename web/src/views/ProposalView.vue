<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import PageHeader from '@/components/common/PageHeader.vue'
import CandidateView from '@/components/governance/CandidateView.vue'
import ConfirmAction from '@/components/governance/ConfirmAction.vue'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { useGovernanceStore } from '@/stores/governance'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import type { Candidate, Proposal } from '@/types'
const store = useGovernanceStore(), auth = useAuthStore(), route = useRoute(), { toast } = useToast()
const proposal = ref<Proposal | null>(null), loading = ref(false), error = ref(''), busy = ref(false), note = ref('')
const action = ref<'approve' | 'reject' | 'withdraw' | null>(null)
let generation = 0
const id = computed(() => String(route.params.id ?? ''))
const baseline = computed<Candidate>(() => store.policy?.candidate ?? { rules: [], activation: { includedRuleIds: null, excludedRuleIds: [] } })
const stale = computed(() => !!proposal.value && proposal.value.baseVersion !== (store.policy?.version ?? 0))
const expired = computed(() => !!proposal.value && Date.parse(proposal.value.expiresAt) <= Date.now())
const pending = computed(() => proposal.value?.status === 'pending' && !expired.value)
const labels: Record<string,string> = { pending:'待审批', approved:'已批准', rejected:'已拒绝', withdrawn:'已撤回', expired:'已过期' }
async function load() {
  const ticket = ++generation, project = store.activeProjectId, proposalId = id.value
  proposal.value = null; error.value = ''; action.value = null; note.value = ''; busy.value = false; loading.value = false
  if (!project || !proposalId) return
  loading.value = true
  try { const result = await api.proposal(proposalId); if (ticket !== generation) return; if (result.projectId !== project) throw new Error('该提案不属于当前项目。'); proposal.value = result }
  catch (e) { if (ticket === generation) error.value = e instanceof Error ? e.message : '加载提案失败。' }
  finally { if (ticket === generation) loading.value = false }
}
watch([() => store.activeProjectId, id], load, { immediate: true })
async function submit() {
  const current = proposal.value, selected = action.value, project = store.activeProjectId, ticket = generation
  if (!current || !selected || !project || busy.value || !pending.value || (selected === 'approve' && stale.value)) return
  busy.value = true
  try {
    const result = selected === 'withdraw' ? await api.withdraw(current.id) : await api.decide(current.id, { decision: selected, note: note.value.trim(), expectedDigest: current.digest })
    if (ticket !== generation || project !== store.activeProjectId) return
    proposal.value = result; action.value = null
    toast('操作已完成', selected === 'approve' ? '已发布治理版本；这不授权工具调用。' : '提案状态已更新。', 'success')
    await store.refreshProject()
  } catch (e) { if (ticket === generation) { const message = e instanceof Error ? e.message : '操作失败。'; error.value = message; toast('操作失败', message, 'error') } }
  finally { if (ticket === generation) busy.value = false }
}
</script>
<template><div class="page"><PageHeader title="提案详情" description="审批绑定候选摘要和基准版本；发布不是工具执行授权。"><template #actions><RouterLink to="/proposals" class="text-xs text-muted-foreground hover:text-foreground">← 返回提案</RouterLink></template></PageHeader>
  <div v-if="!store.activeProjectId" class="panel p-5 text-sm">请先选择项目。</div><div v-else-if="loading" class="panel p-5 text-sm" role="status">正在加载提案…</div><div v-else-if="!proposal" class="panel p-5 text-sm text-destructive" role="alert">{{ error || '无法加载提案。' }} <button class="underline" @click="load">重试</button></div>
  <template v-else><div v-if="error" role="alert" class="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive">{{ error }}</div><section class="panel mb-4 p-5"><div class="flex flex-wrap items-center gap-2"><h2 class="text-base font-semibold">{{ proposal.title }}</h2><span class="rounded border border-border px-2 py-0.5 text-xs">{{ expired && proposal.status === 'pending' ? '已到期（待服务端确认）' : labels[proposal.status] }}</span></div><dl class="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-3"><div><dt class="text-muted-foreground">提案 ID</dt><dd class="break-all font-mono">{{ proposal.id }}</dd></div><div><dt class="text-muted-foreground">作者</dt><dd>{{ proposal.author.id }} · {{ proposal.author.role }}</dd></div><div><dt class="text-muted-foreground">基准 / 当前版本</dt><dd>{{ proposal.baseVersion }} / {{ store.policy?.version ?? 0 }}</dd></div><div><dt class="text-muted-foreground">候选 digest</dt><dd class="break-all font-mono">{{ proposal.digest }}</dd></div><div><dt class="text-muted-foreground">创建 / 到期</dt><dd>{{ formatDate(proposal.createdAt) }} / {{ formatDate(proposal.expiresAt) }}</dd></div><div><dt class="text-muted-foreground">发布 / 恢复来源版本</dt><dd>{{ proposal.publishedVersion ?? '—' }} / {{ proposal.restoreFromVersion ?? '—' }}</dd></div></dl><p class="mt-4 whitespace-pre-wrap text-sm">{{ proposal.rationale }}</p><p v-if="proposal.decision" class="mt-3 text-xs text-muted-foreground">{{ proposal.decision.decision === 'approve' ? '批准' : '拒绝' }} · {{ proposal.decision.actor.id }} · {{ formatDate(proposal.decision.decidedAt) }} · {{ proposal.decision.note }}</p></section>
  <div v-if="stale && proposal.status === 'pending'" class="mb-4 rounded-md border border-warning/40 p-3 text-xs text-warning">基准版本已变化，不能批准。请基于当前策略创建新提案。</div>
  <div v-if="store.loading" class="panel mb-4 p-4 text-sm">正在加载当前策略以比较…</div><div v-else-if="store.error" class="panel mb-4 p-4 text-sm text-destructive">当前策略加载失败，无法安全比较或批准。<button class="underline" @click="store.refreshProject()">重试</button></div><CandidateView v-else :candidate="proposal.candidate" :before="baseline" />
  <section v-if="pending" class="panel mt-4 p-5"><h2 class="text-sm font-semibold">审批操作</h2><p class="mt-1 text-xs text-muted-foreground">批准创建新治理版本，不改变运行时配置，不授权单次工具调用。</p><label for="decision-note" class="mt-4 block text-xs">审批备注</label><textarea id="decision-note" v-model="note" rows="2" class="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm" /><div class="mt-3 flex flex-wrap gap-2"><Button v-if="auth.session?.role === 'human'" size="sm" :disabled="busy || stale || store.loading || !!store.error" @click="action = 'approve'">批准并发布</Button><Button v-if="auth.session?.role === 'human'" size="sm" variant="outline" :disabled="busy" @click="action = 'reject'">拒绝</Button><Button size="sm" variant="outline" :disabled="busy" @click="action = 'withdraw'">撤回</Button></div></section>
  <ConfirmAction :open="action !== null" :busy="busy" :title="action === 'approve' ? '批准并发布？' : action === 'reject' ? '拒绝提案？' : '撤回提案？'" :description="action === 'approve' ? '将以此摘要绑定的候选创建新的治理版本，不授权工具执行。' : action === 'reject' ? '拒绝后提案不可修改或恢复。' : '撤回后提案不可恢复。'" @update:open="value => { if (!value && !busy) action = null }" @confirm="submit" />
  </template></div></template>
