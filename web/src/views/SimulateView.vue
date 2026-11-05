<script setup lang="ts">
import { ref, watch } from 'vue'
import { FlaskConical, Play } from 'lucide-vue-next'
import { api } from '@/lib/api'
import { useGovernanceStore } from '@/stores/governance'
import type { PolicyDecision } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { Button } from '@/components/ui/button'

const governance = useGovernanceStore()
const tool = ref('')
const operation = ref('')
const target = ref('')
const version = ref('')
const loading = ref(false)
const error = ref('')
const result = ref<PolicyDecision | null>(null)
const provenance = ref<{ projectId: string; projectName: string; version: number; digest: string | null } | null>(null)
let generation = 0

function invalidateResult() {
  generation++
  result.value = null
  provenance.value = null
  error.value = ''
  loading.value = false
}
watch([tool, operation, target, version, () => governance.policy?.version], invalidateResult, { flush: 'sync' })
watch(() => governance.activeProjectId, () => {
  invalidateResult()
  version.value = ''
}, { flush: 'sync' })

async function simulate() {
  const id = governance.activeProjectId
  if (!id || !governance.policy) return
  const selectedVersion = version.value ? Number(version.value) : governance.policy.version
  if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1) { error.value = '请选择有效的已发布版本。'; return }
  const published = governance.policy.version === selectedVersion ? governance.policy : governance.versions.find(item => item.version === selectedVersion && item.projectId === id)
  const context = { projectId: id, projectName: governance.activeProject?.name ?? id, version: selectedVersion, digest: published?.snapshot.digest ?? null }
  const request = ++generation
  loading.value = true
  error.value = ''
  result.value = null
  provenance.value = null
  try {
    const response = await api.simulate(id, {
      action: { tool: tool.value, operation: operation.value, target: target.value },
      version: selectedVersion
    })
    if (generation === request) { result.value = response; provenance.value = context }
  } catch (e) {
    if (generation === request) error.value = e instanceof Error ? e.message : '模拟失败'
  } finally {
    if (generation === request) loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="动作模拟" description="使用已发布策略进行假设评估；不会执行或授权动作。" />

    <div class="mb-4 rounded-md border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-info">
      模拟使用发布快照的运行时规则投影，结果不是执行许可；它不启动 Harness，也不产生工具副作用。仅支持已发布版本。
    </div>

    <div v-if="governance.loading" class="panel p-5 text-sm" role="status">正在加载项目数据…</div>
    <div v-else-if="governance.error" class="panel p-5 text-sm text-destructive" role="alert">{{ governance.error }} <button class="ml-2 underline" @click="governance.activeProjectId ? governance.refreshProject() : governance.initialize()">重试</button></div>
    <EmptyState v-else-if="!governance.activeProject" title="请选择项目" description="请先在侧栏选择项目。" />
    <EmptyState v-else-if="!governance.policy" title="尚无已发布策略" description="请先提交并批准提案，发布后才能模拟。" />

    <div v-else class="grid gap-4 lg:grid-cols-2">
      <section class="panel">
        <div class="panel-header"><h2 class="panel-title">输入动作</h2></div>
        <form class="space-y-4 p-4" @submit.prevent="simulate">
          <label class="field">
            <span class="field-label">工具 tool</span>
            <input v-model="tool" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
          </label>
          <label class="field">
            <span class="field-label">操作 operation</span>
            <input v-model="operation" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
          </label>
          <label class="field">
            <span class="field-label">目标 target</span>
            <input v-model="target" required class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
          </label>
          <label class="field">
            <span class="field-label">已发布版本</span>
            <select v-model="version" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">当前版本</option>
              <option v-for="item in governance.versions" :key="item.version" :value="String(item.version)">版本 {{ item.version }}</option>
            </select>
          </label>
          <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
          <Button type="submit" :disabled="loading"><Play class="mr-1 size-3.5" />{{ loading ? '模拟中…' : '模拟裁决' }}</Button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-header"><h2 class="panel-title">假设结果</h2></div>
        <div v-if="result" class="space-y-3 p-4 text-sm">
          <div v-if="provenance" class="rounded-md border border-border bg-surface p-3 text-xs leading-relaxed">
            <p class="font-medium">评估来源 · 本地治理版本 {{ provenance.version }}</p>
            <p class="mt-1 break-all text-muted-foreground">项目 {{ provenance.projectName }} · {{ provenance.projectId }}</p>
            <p class="mt-1 break-all font-mono text-muted-foreground">本地快照摘要：{{ provenance.digest ?? '不可用' }}</p>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-muted-foreground">裁决</span>
            <span class="rounded border border-border px-1.5 py-0.5 font-medium">{{ result.verdict }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-muted-foreground">决策类型</span>
            <span>{{ result.decision }}</span>
          </div>
          <div>
            <span class="text-[11px] text-muted-foreground">命中规则</span>
            <p class="mt-1 break-all">{{ result.matched_rule_ids.join(', ') || '无' }}</p>
          </div>
          <p v-if="result.error" class="text-destructive">{{ result.error }}</p>
          <ul v-if="result.matched_rules.length" class="space-y-2">
            <li v-for="rule in result.matched_rules" :key="rule.id" class="rounded-md border border-border p-3 text-xs">
              {{ rule.id }} · {{ rule.dimension }} · level {{ rule.level }} · {{ rule.policy_class }} / {{ rule.enforcement }} / {{ rule.on_hit }}
            </li>
          </ul>
        </div>
        <p v-else class="p-6 text-center text-xs text-muted-foreground">提交动作后显示假设裁决。</p>
      </section>
    </div>
  </div>
</template>
