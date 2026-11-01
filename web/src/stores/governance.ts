import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../lib/api.js'
import { readStoredJson, writeStoredJson, removeStored } from '../lib/storage.js'
import type { CreateProjectInput, Project, Proposal, PublishedVersion, RuntimeStatus } from '../types/index.js'

const KEY = 'amos:console:activeProjectId'
export const useGovernanceStore = defineStore('governance', () => {
  const projects = ref<Project[]>([]), activeProjectId = ref<string | null>(null)
  const policy = ref<PublishedVersion | null>(null), proposals = ref<Proposal[]>([]), versions = ref<PublishedVersion[]>([]), status = ref<RuntimeStatus | null>(null)
  const loading = ref(false), error = ref<string | null>(null)
  const activeProject = computed(() => projects.value.find(p => p.id === activeProjectId.value) ?? null)
  let epoch = 0
  let preferred = readStoredJson(KEY, (value): value is string => typeof value === 'string' && value.length > 0)
  function resetProject() { policy.value = null; proposals.value = []; versions.value = [] }
  function clear() { epoch++; projects.value = []; activeProjectId.value = null; resetProject(); status.value = null; error.value = null; loading.value = false; preferred = null; removeStored(KEY) }
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
      const [p, ps, vs] = await Promise.all([api.policy(id), api.proposals(id), api.versions(id)])
      if (current !== epoch || id !== activeProjectId.value) return
      policy.value = p; proposals.value = ps; versions.value = vs
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
      const [list, runtime] = await Promise.all([api.projects(), api.status()]); if (current !== epoch) return
      projects.value = list; status.value = runtime
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
  return { projects, activeProjectId, activeProject, policy, proposals, versions, status, loading, error, initialize, refreshProjects, selectProject, refreshProject, createProject, clear }
})
