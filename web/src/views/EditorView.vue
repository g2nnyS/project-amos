<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { FileUp, Plus, RotateCcw, Save, CheckCircle, AlertCircle } from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import RuleForm from '@/components/rules/RuleForm.vue'
import { activationIssues, clone, newRule, type DraftCandidate } from '@/components/rules/model'
import { api } from '@/lib/api'
import { useGovernanceStore } from '@/stores/governance'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { Button } from '@/components/ui/button'
import type { Candidate, Proposal, ValidationResult } from '@/types'

const governance = useGovernanceStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const { toast } = useToast()

const draft = ref<DraftCandidate | null>(null)
const baseVersion = ref(0)
const initial = ref('')
const selected = ref(0)
const title = ref('')
const rationale = ref('')
const expires = ref('')
const busy = ref(false)
const error = ref('')
const validation = ref<ValidationResult | null>(null)

const dirty = computed(() => !!draft.value && (JSON.stringify(draft.value) !== initial.value || !!title.value || !!rationale.value || !!expires.value))
const issues = computed(() => draft.value ? activationIssues(draft.value) : [])
const selectedRule = computed(() => draft.value?.rules[selected.value])
let epoch = 0

function reset() {
  epoch++
  draft.value = null
  initial.value = ''
  selected.value = 0
  title.value = ''
  rationale.value = ''
  expires.value = ''
  validation.value = null
  error.value = ''
  busy.value = false
}

watch(() => governance.activeProjectId, reset)
watch(() => auth.authenticated, value => { if (!value) reset() })
watch(draft, () => { validation.value = null }, { deep: true })

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
onBeforeRouteLeave(() => !dirty.value || window.confirm('草稿仅保存在内存中，离开将丢失未提交的修改。继续吗？'))

function install(candidate: Candidate, version: number) {
  draft.value = clone(candidate)
  baseVersion.value = version
  initial.value = JSON.stringify(draft.value)
  selected.value = 0
  validation.value = null
  error.value = ''
}

async function load(source: 'current' | 'seed' | 'history') {
  const project = governance.activeProjectId
  if (!project || busy.value) return
  if (dirty.value && !window.confirm('替换当前草稿？未提交的修改将丢失。')) return
  const run = ++epoch
  busy.value = true
  error.value = ''
  try {
    if (source === 'seed') {
      const candidate = await api.seed()
      if (run === epoch) install(candidate, governance.policy?.version ?? 0)
    } else if (source === 'history') {
      const version = Number(route.query.baseVersion)
      if (!Number.isSafeInteger(version) || version < 1) { error.value = '历史基准版本无效。'; return }
      const policy = await api.version(project, version)
      if (run === epoch) install(policy.candidate, governance.policy?.version ?? 0)
    } else if (governance.policy) {
      install(governance.policy.candidate, governance.policy.version)
    } else {
      error.value = '当前项目尚无已发布策略，请从仓库种子开始。'
    }
  } catch (e) {
    if (run === epoch) error.value = e instanceof Error ? e.message : '加载候选失败，请检查连接或项目权限。'
  } finally {
    if (run === epoch) busy.value = false
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !governance.activeProjectId) return
  if (dirty.value && !window.confirm('替换当前草稿？未提交的修改将丢失。')) return
  if (file.size > 60 * 1024) { error.value = '策略文件超过 60 KB。'; return }
  const run = ++epoch
  busy.value = true
  try {
    const text = await file.text()
    if (run !== epoch) return
    const result = await api.importYaml(governance.activeProjectId, text)
    if (run !== epoch) return
    validation.value = { valid: result.valid, issues: result.issues }
    if (!result.valid) { error.value = '导入的候选未通过服务端校验。'; return }
    install(result.candidate, governance.policy?.version ?? 0)
    toast('导入成功', 'YAML/JSON 已通过服务端校验。', 'success')
  } catch {
    if (run === epoch) error.value = '无法导入策略文件，请检查 YAML/JSON 格式或连接。'
  } finally {
    if (run === epoch) busy.value = false
  }
}

async function validate(): Promise<boolean> {
  if (!draft.value || !governance.activeProjectId) { error.value = '请先选择项目并载入候选。'; return false }
  if (issues.value.length) { error.value = issues.value[0] ?? '候选激活策略无效。'; return false }
  if (busy.value) return false
  let candidate: DraftCandidate
  try { candidate = clone(draft.value) } catch { error.value = '无法准备候选，请重新载入来源。'; return false }
  const run = epoch
  const project = governance.activeProjectId
  busy.value = true
  error.value = ''
  try {
    const result = await api.validate(project, candidate)
    if (run !== epoch) return false
    if (JSON.stringify(candidate) !== JSON.stringify(draft.value)) { error.value = '校验期间草稿已更改，请重新校验。'; return false }
    validation.value = result
    if (result.valid) toast('校验通过', '候选符合当前规则 schema。', 'success')
    return result.valid
  } catch {
    if (run === epoch) error.value = '校验请求失败，请检查连接或项目权限。'
    return false
  } finally {
    if (run === epoch) busy.value = false
  }
}

async function submit() {
  if (!draft.value || !governance.activeProjectId) { error.value = '请先选择项目并载入候选。'; return }
  if (busy.value) return
  if (!title.value.trim() || !rationale.value.trim() || !expires.value || !Number.isFinite(Date.parse(expires.value)) || Date.parse(expires.value) <= Date.now()) { error.value = '请填写标题、理由及未来的过期时间。'; return }
  if (!(await validate())) return
  if (!window.confirm('提交后提案正文不可修改，且不会自动发布。是否继续？')) return
  if (!draft.value || !governance.activeProjectId) return
  const run = epoch
  const project = governance.activeProjectId
  busy.value = true
  error.value = ''
  let proposal: Proposal
  try {
    proposal = await api.createProposal(project, {
      title: title.value.trim(),
      rationale: rationale.value.trim(),
      baseVersion: baseVersion.value,
      expiresAt: new Date(expires.value).toISOString(),
      candidate: clone(draft.value)
    })
  } catch {
    if (run === epoch) error.value = '提交失败。基准版本可能已过期，或请求未被接受；草稿仍保留。'
    return
  } finally {
    if (run === epoch) busy.value = false
  }
  if (run !== epoch) return
  reset()
  toast('提案已创建', '请在提案列表中审阅。', 'success')
  try { await governance.refreshProject() }
  catch { toast('提案已创建，但刷新失败', '提案列表可能未更新，请稍后手动刷新。', 'error') }
  await router.push(`/proposals/${encodeURIComponent(proposal.id)}`)
}

function addRule() {
  if (!draft.value) return
  let n = 1
  while (draft.value.rules.some(r => r.id === `new-rule-${n}`)) n++
  draft.value.rules.push(newRule(`new-rule-${n}`))
  selected.value = draft.value.rules.length - 1
}

function removeRule(index: number) {
  if (!draft.value || !window.confirm('从候选中删除这条规则？')) return
  const id = draft.value.rules[index]?.id
  draft.value.rules.splice(index, 1)
  if (id) {
    draft.value.activation.includedRuleIds = draft.value.activation.includedRuleIds?.filter(x => x !== id) ?? null
    draft.value.activation.excludedRuleIds = draft.value.activation.excludedRuleIds.filter(x => x !== id)
  }
  selected.value = Math.min(selected.value, Math.max(0, draft.value.rules.length - 1))
}

function toggle(id: string, field: 'includedRuleIds' | 'excludedRuleIds', checked: boolean) {
  if (!draft.value) return
  const activation = draft.value.activation
  const list = activation[field] ?? []
  activation[field] = checked ? [...list, id] : list.filter(x => x !== id)
  if (checked && field === 'includedRuleIds') activation.excludedRuleIds = activation.excludedRuleIds.filter(x => x !== id)
  if (checked && field === 'excludedRuleIds' && activation.includedRuleIds) activation.includedRuleIds = activation.includedRuleIds.filter(x => x !== id)
}
</script>

<template>
  <div class="page space-y-4">
    <PageHeader title="候选编辑" description="草稿仅保存在内存中。提交创建不可变提案，不会自动发布或授权工具执行。">
      <template #actions>
        <span v-if="dirty" class="inline-flex items-center gap-1 text-xs text-warning"><AlertCircle class="size-3.5" />未提交修改</span>
        <Button v-if="draft" variant="outline" size="sm" :disabled="busy || !!issues.length" @click="validate">
          <CheckCircle class="mr-1 size-3.5" />{{ busy ? '处理中…' : '校验候选' }}
        </Button>
        <Button v-if="draft" size="sm" :disabled="busy || !!issues.length" @click="submit">
          <Save class="mr-1 size-3.5" />{{ busy ? '处理中…' : '提交提案' }}
        </Button>
      </template>
    </PageHeader>

    <EmptyState v-if="!governance.activeProjectId" title="请选择项目" description="选择项目后才能起草候选。" />
    <template v-else>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">候选来源</h2>
            <p class="panel-kicker">{{ draft ? `基准版本 ${baseVersion} · 替换来源会丢弃当前草稿` : '从已发布策略、仓库种子或 JSON 开始' }}</p>
          </div>
        </div>
        <div class="panel-body flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="busy || !governance.policy" @click="load('current')"><RotateCcw class="mr-1 size-3.5" />当前策略</Button>
          <Button type="button" variant="outline" size="sm" :disabled="busy" @click="load('seed')">仓库种子</Button>
          <Button v-if="route.query.baseVersion" type="button" variant="outline" size="sm" :disabled="busy" @click="load('history')">加载历史版本 {{ route.query.baseVersion }}</Button>
          <label class="inline-flex h-8 cursor-pointer items-center rounded-md border border-border bg-card px-3 text-xs hover:bg-accent">
            <FileUp class="mr-1 size-3.5" />导入 YAML/JSON
            <input type="file" accept=".yaml,.yml,.json,application/yaml,application/json" class="sr-only" :disabled="busy" @change="importFile" />
          </label>
        </div>
      </section>

      <div v-if="error" role="alert" class="panel p-5 text-sm text-destructive">{{ error }}</div>

      <section v-if="validation" class="panel p-4 text-xs" aria-live="polite">
        <p class="flex items-center gap-1.5 font-semibold" :class="validation.valid ? 'text-positive' : 'text-destructive'">
          <component :is="validation.valid ? CheckCircle : AlertCircle" class="size-4" />
          {{ validation.valid ? '服务端校验通过' : '服务端校验未通过' }}
        </p>
        <ul v-if="!validation.valid" class="mt-2 space-y-1 text-muted-foreground">
          <li v-for="(issue, i) in validation.issues" :key="i" class="break-all">{{ issue.path }} · {{ issue.code }}</li>
        </ul>
      </section>

      <template v-if="draft">
        <div class="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <section class="panel min-w-0">
            <div class="panel-header">
              <h2 class="panel-title">规则 · {{ draft.rules.length }}</h2>
              <Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs" @click="addRule"><Plus class="mr-1 size-3.5" />添加</Button>
            </div>
            <ul class="p-2">
              <li v-for="(rule, i) in draft.rules" :key="i" class="flex items-center gap-1">
                <button type="button" class="min-w-0 flex-1 rounded p-2 text-left text-xs hover:bg-accent" :class="selected === i ? 'bg-accent' : ''" @click="selected = i">
                  <span class="block truncate font-medium">{{ rule.id || '无 ID' }}</span>
                  <span class="block truncate text-muted-foreground">{{ rule.dimension }} · {{ rule.on_hit }}</span>
                </button>
                <button type="button" class="rounded p-2 text-xs text-muted-foreground hover:text-destructive" :aria-label="`删除规则 ${rule.id}`" @click="removeRule(i)">删除</button>
              </li>
            </ul>
          </section>
          <RuleForm v-if="selectedRule" :key="selected" :rule="selectedRule" />
          <EmptyState v-else title="尚无规则" description="添加规则以继续。" />
        </div>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">项目激活策略</h2>
              <p class="panel-kicker">包含与排除不可重叠；激活结果必须非空。</p>
            </div>
          </div>
          <div class="panel-body space-y-3 text-xs">
            <label class="flex items-center gap-2">
              <input type="checkbox" :checked="draft.activation.includedRuleIds === null" @change="draft.activation.includedRuleIds = ($event.target as HTMLInputElement).checked ? null : []" />
              包含所有规则
            </label>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead>
                  <tr><th scope="col">规则 ID</th><th v-if="draft.activation.includedRuleIds !== null" scope="col">包含</th><th scope="col">排除</th></tr>
                </thead>
                <tbody>
                  <tr v-for="rule in draft.rules" :key="rule.id">
                    <td>{{ rule.id }}</td>
                    <td v-if="draft.activation.includedRuleIds !== null">
                      <input type="checkbox" :aria-label="`包含 ${rule.id}`" :checked="draft.activation.includedRuleIds.includes(rule.id)" @change="toggle(rule.id, 'includedRuleIds', ($event.target as HTMLInputElement).checked)" />
                    </td>
                    <td>
                      <input type="checkbox" :aria-label="`排除 ${rule.id}`" :checked="draft.activation.excludedRuleIds.includes(rule.id)" @change="toggle(rule.id, 'excludedRuleIds', ($event.target as HTMLInputElement).checked)" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ul v-if="issues.length" class="space-y-1 text-destructive"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">提案信息</h2>
            <span class="text-xs text-muted-foreground">基准版本 {{ baseVersion }}</span>
          </div>
          <div class="panel-body grid gap-4 text-xs lg:grid-cols-3">
            <label class="field lg:col-span-1">
              <span class="field-label">标题</span>
              <input v-model="title" class="control" maxlength="160" />
            </label>
            <label class="field lg:col-span-2">
              <span class="field-label">理由</span>
              <textarea v-model="rationale" class="control" rows="2" />
            </label>
            <label class="field lg:col-span-1">
              <span class="field-label">提案过期时间（本地时间）</span>
              <input v-model="expires" type="datetime-local" class="control" />
            </label>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.control { width: 100%; border: 1px solid hsl(var(--input)); border-radius: 6px; background: hsl(var(--background)); padding: 7px 9px; color: hsl(var(--foreground)); }
</style>
