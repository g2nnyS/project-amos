import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../lib/api.js'
import { readStoredJson, writeStoredJson, removeStored } from '../lib/storage.js'
import type { CreateProjectInput, GlobalConfigUpdateResult, GlobalHarnessConfig, HarnessRuntimeStatus, ProbeRunRecord, Project, ProjectConfigView, Proposal, PublishedVersion, RolloutEvaluation, RuleRolloutRecord, RuntimeStatus, TemporaryTighteningStatus, UpdateProjectConfigInput } from '../types/index.js'

const KEY = 'amos:console:activeProjectId'
export const useGovernanceStore = defineStore('governance', () => {
  const projects = ref<Project[]>([]), activeProjectId = ref<string | null>(null)
  const policy = ref<PublishedVersion | null>(null), proposals = ref<Proposal[]>([]), versions = ref<PublishedVersion[]>([]), status = ref<RuntimeStatus | null>(null), runtime = ref<HarnessRuntimeStatus | null>(null)
  const config = ref<ProjectConfigView | null>(null), tightenings = ref<TemporaryTighteningStatus | null>(null), probes = ref<ProbeRunRecord[]>([]), rollouts = ref<RuleRolloutRecord[]>([])
  const globalConfig = ref<GlobalHarnessConfig | null>(null), globalConfigSaving = ref(false)
  const loading = ref(false), error = ref<string | null>(null)
  const activeProject = computed(() => projects.value.find(p => p.id === activeProjectId.value) ?? null)
  let epoch = 0
  let preferred = readStoredJson(KEY, (value): value is string => typeof value === 'string' && value.length > 0)
  function resetProject() { policy.value = null; proposals.value = []; versions.value = []; runtime.value = null; config.value = null; tightenings.value = null; probes.value = []; rollouts.value = [] }
  function clear() { epoch++; projects.value = []; activeProjectId.value = null; resetProject(); status.value = null; globalConfig.value = null; globalConfigSaving.value = false; error.value = null; loading.value = false; preferred = null; removeStored(KEY) }
  function save(id: string | null) { preferred = id; if (id) writeStoredJson(KEY, id); else removeStored(KEY) }
  async function refreshProjects() {
    const current = epoch
    try { const result = await api.projects(); if (current !== epoch) return; projects.value = result; if (activeProjectId.value && !result.some(p => p.id === activeProjectId.value)) { activeProjectId.value = null; resetProject(); save(null) } }
    catch (e) { if (current === epoch) { error.value = e instanceof Error ? e.message : '加载项目失败。'; throw e } }
  }
  async function refreshProject() {
    const id = activeProjectId.value, current = epoch
    if (!id) { resetProject(); return }
    loading.value = true; error.value = null
    try {
      const [p, ps, vs, run, cfg, tight, probe, roll] = await Promise.all([
        api.policy(id),
        api.proposals(id),
        api.versions(id),
        api.runtime(id).catch(() => null),
        api.config(id).catch(() => null),
        api.tightenings(id).catch(() => null),
        api.probes(id).catch(() => [] as ProbeRunRecord[]),
        api.rollouts(id).catch(() => [] as RuleRolloutRecord[]),
      ])
      if (current !== epoch || id !== activeProjectId.value) return
      policy.value = p; proposals.value = ps; versions.value = vs; runtime.value = run
      config.value = cfg; tightenings.value = tight; probes.value = probe ?? []; rollouts.value = roll ?? []
    } catch (e) { if (current === epoch) { resetProject(); error.value = e instanceof Error ? e.message : '加载项目失败。'; throw e } }
    finally { if (current === epoch) loading.value = false }
  }
  async function selectProject(id: string | null) {
    if (id !== null && !projects.value.some(p => p.id === id)) throw new Error('项目不存在。')
    epoch++; activeProjectId.value = id; resetProject(); save(id); error.value = null; loading.value = false
    await refreshProject()
  }
  async function initialize() {
    const current = ++epoch; loading.value = true; error.value = null
    try {
      const [list, runtime, global] = await Promise.all([api.projects(), api.status(), api.globalConfig().catch(() => null)]); if (current !== epoch) return
      projects.value = list; status.value = runtime; globalConfig.value = global
      const id = list.find(p => p.id === preferred)?.id ?? list[0]?.id ?? null
      activeProjectId.value = id; save(id); resetProject(); await refreshProject()
    } catch (e) { if (current === epoch) { error.value = e instanceof Error ? e.message : '初始化失败。'; throw e } }
    finally { if (current === epoch) loading.value = false }
  }
  async function createProject(input: CreateProjectInput): Promise<Project> {
    const current = epoch; const project = await api.createProject(input)
    if (current !== epoch) throw new Error('项目上下文已更改。')
    await refreshProjects(); if (current !== epoch) throw new Error('项目上下文已更改。')
    await selectProject(project.id); return project
  }
  async function refreshRuntime() {
    const id = activeProjectId.value
    if (!id) { runtime.value = null; return }
    try { runtime.value = await api.runtime(id) } catch { runtime.value = null }
  }
  async function updateProjectConfig(input: UpdateProjectConfigInput): Promise<ProjectConfigView | null> {
    const id = activeProjectId.value
    if (!id) return null
    const current = epoch
    const result = await api.updateConfig(id, input)
    if (current !== epoch || id !== activeProjectId.value) return null
    config.value = result
    await refreshProject()
    if (current !== epoch) return null
    return result
  }
  async function updateGlobalConfig(input: GlobalHarnessConfig): Promise<GlobalConfigUpdateResult | null> {
    const current = epoch
    globalConfigSaving.value = true
    try {
      const result = await api.updateGlobalConfig(input)
      if (current !== epoch) return null
      globalConfig.value = result.config
      await refreshProject()
      if (current !== epoch) return null
      return result
    } finally {
      if (current === epoch) globalConfigSaving.value = false
    }
  }
  async function applyTightening(templateId: string, ttlMs: number): Promise<TemporaryTighteningStatus | null> {
    const id = activeProjectId.value
    if (!id) return null
    const current = epoch
    const result = await api.applyTightening(id, { templateId, ttlMs })
    if (current !== epoch || id !== activeProjectId.value) return null
    tightenings.value = result
    await refreshRuntime()
    return result
  }
  async function expireTightenings(): Promise<TemporaryTighteningStatus | null> {
    const id = activeProjectId.value
    if (!id) return null
    const current = epoch
    const result = await api.expireTightenings(id)
    if (current !== epoch || id !== activeProjectId.value) return null
    tightenings.value = result
    await refreshRuntime()
    return result
  }
  async function refreshRollout(): Promise<void> {
    const id = activeProjectId.value
    if (!id) { probes.value = []; rollouts.value = []; return }
    try {
      const [probe, roll] = await Promise.all([api.probes(id), api.rollouts(id)])
      probes.value = probe; rollouts.value = roll
    } catch { probes.value = []; rollouts.value = [] }
  }
  async function promoteRollout(ruleId: string, input: Parameters<typeof api.promoteRollout>[2]): Promise<RolloutEvaluation | null> {
    const id = activeProjectId.value
    if (!id) return null
    const current = epoch
    const result = await api.promoteRollout(id, ruleId, input)
    if (current !== epoch || id !== activeProjectId.value) return null
    await refreshRollout()
    return result
  }
  return { projects, activeProjectId, activeProject, policy, proposals, versions, status, runtime, config, globalConfig, globalConfigSaving, tightenings, probes, rollouts, loading, error, initialize, refreshProjects, selectProject, refreshProject, refreshRuntime, refreshRollout, createProject, updateGlobalConfig, updateProjectConfig, applyTightening, expireTightenings, promoteRollout, clear }
})
