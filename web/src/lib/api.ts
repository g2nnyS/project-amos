import type { AmosDesktopBridge, LoginCredentials, SetupVerification, AuditPage, AuditQuery, BrowserSession, Candidate, CreateProjectInput, CreateProposalInput, CreateRollbackProposalInput, DecideProposalInput, EvaluateRulePromotionInput, HarnessRuntimeStatus, JevSettingsInput, JevSettingsView, ObservationReport, PolicyDecision, ProbeRunRecord, Project, ProjectConfig, Proposal, PublishedVersion, RolloutEvaluation, RuleRolloutRecord, RuntimeStatus, SimulateInput, TemporaryTighteningStatus, UpdateProjectConfigInput, ValidationResult } from '../types/index.js'

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) { super(message); this.name = 'ApiError' }
}
const safeCode = (status: number) => status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : status >= 500 ? 'server_error' : 'request_failed'
const safeMessage = (status: number) => status === 401 ? '会话已过期或无效，请重新登录。' : status === 403 ? '没有权限执行此操作。' : status === 404 ? '请求的资源不存在。' : status === 409 ? '数据已变更，请刷新后重试。' : status >= 500 ? '服务暂时不可用，请稍后重试。' : '请求未成功，请检查输入后重试。'
const stale = () => new ApiError('stale_request', '请求已过期，请重试。')
const pathId = (id: string | number) => encodeURIComponent(String(id))
const authErrorCodes = new Set(['password_invalid', 'password_busy', 'enrollment_required', 'setup_already_complete', 'invalid_credentials', 'rate_limited'])
const desktopBridge = (): AmosDesktopBridge | undefined => typeof window !== 'undefined' && window.amosDesktop?.isDesktop === true ? window.amosDesktop : undefined

/** CSRF and request generations live only in this in-memory client. */
export class ApiClient {
  private csrf = ''
  private generation = 0
  private setupGrant: Promise<string | null> | null = null
  private logoutPending: Promise<void> | null = null
  private unauthorizedListeners = new Set<() => void>()
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
  get systemAuthAvailable(): boolean { return typeof desktopBridge()?.authenticateSystem === 'function' }
  private getSetupGrant(): Promise<string | null> {
    const bridge = desktopBridge()
    if (!this.setupGrant && typeof bridge?.getSetupGrant === 'function') {
      this.setupGrant = Promise.resolve().then(() => bridge.getSetupGrant()).then(value => typeof value === 'string' && value.length > 0 ? value : null, () => null)
    }
    return this.setupGrant ?? Promise.resolve(null)
  }
  async hasSetupGrant(): Promise<boolean> { return (await this.getSetupGrant()) !== null }
  onUnauthorized(listener: () => void): () => void { this.unauthorizedListeners.add(listener); return () => this.unauthorizedListeners.delete(listener) }
  invalidate(): void { this.generation++; this.csrf = '' }
  private async request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, epoch = this.generation): Promise<Response> {
    if (epoch !== this.generation) throw stale()
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method === 'POST') {
      if (!this.csrf) throw new ApiError('missing_csrf', '会话不可用，请重新登录。')
      headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = this.csrf
    }
    let response: Response
    try { response = await this.fetcher(path, { method, headers, credentials: 'same-origin', ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) }) }
    catch { if (epoch !== this.generation) throw stale(); throw new ApiError('network_error', '无法连接本地治理服务。') }
    if (epoch !== this.generation) throw stale()
    if (!response.ok) {
      let code = safeCode(response.status)
      const authRequest = path === '/api/login' || path === '/api/setup'
      if (authRequest) {
        try {
          const value: unknown = await response.json()
          if (value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error && typeof value.error.code === 'string' && authErrorCodes.has(value.error.code)) code = value.error.code
        } catch {}
        if (epoch !== this.generation) throw stale()
      }
      if (response.status === 401) { this.invalidate(); if (!authRequest) for (const listener of this.unauthorizedListeners) listener() }
      throw new ApiError(code, safeMessage(response.status), response.status)
    }
    return response
  }
  private async json<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, epoch = this.generation): Promise<T> {
    const response = await this.request(path, method, body, epoch)
    try { const result = await response.json() as T; if (epoch !== this.generation) throw stale(); return result }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('invalid_response', '服务返回的数据无效。') }
  }
  private async getSession(epoch: number): Promise<BrowserSession> {
    const session = await this.json<BrowserSession>('/api/session', 'GET', undefined, epoch)
    if (!session || typeof session.authenticated !== 'boolean' || typeof session.csrfToken !== 'string' || !session.csrfToken || (session.role !== undefined && session.role !== 'human' && session.role !== 'agent')) throw new ApiError('invalid_response', '服务返回的数据无效。')
    if (session.auth !== undefined && (!session.auth || typeof session.auth.setupRequired !== 'boolean' || !Array.isArray(session.auth.methods) || session.auth.methods.some(method => !['password', 'token', 'system'].includes(method)) || (session.auth.systemLabel !== undefined && typeof session.auth.systemLabel !== 'string'))) throw new ApiError('invalid_response', '服务返回的数据无效。')
    this.csrf = session.csrfToken
    return session
  }
  session(): Promise<BrowserSession> { return this.getSession(this.generation) }
  private async beginAuthentication(): Promise<{ session: BrowserSession; epoch: number }> {
    this.invalidate(); const epoch = this.generation
    if (this.logoutPending) { try { await this.logoutPending } catch { /* A fresh bootstrap follows even after logout failure. */ } }
    if (epoch !== this.generation) throw stale()
    return { session: await this.getSession(epoch), epoch }
  }
  private async systemProof(session: BrowserSession, epoch: number): Promise<string> {
    const bridge = desktopBridge()
    if (!session.auth?.methods.includes('system') || typeof bridge?.authenticateSystem !== 'function') throw new ApiError('system_auth_unavailable', '当前环境未提供系统认证。')
    let proof: string
    try { proof = await bridge.authenticateSystem(session.csrfToken) }
    catch { if (epoch !== this.generation) throw stale(); throw new ApiError('system_auth_cancelled', '系统认证已取消，请重试。') }
    if (epoch !== this.generation) throw stale()
    if (typeof proof !== 'string' || !proof) throw new ApiError('system_auth_cancelled', '系统认证已取消，请重试。')
    return proof
  }
  private async finishAuthentication(path: '/api/login' | '/api/setup', body: unknown, epoch: number): Promise<BrowserSession> {
    const result = await this.json<BrowserSession>(path, 'POST', body, epoch)
    if (!result || result.authenticated !== true || typeof result.csrfToken !== 'string' || !result.csrfToken || (result.role !== 'human' && result.role !== 'agent')) throw new ApiError('invalid_response', '服务返回的数据无效。')
    this.csrf = result.csrfToken
    return result
  }
  async login(token: string): Promise<BrowserSession> { return this.loginWith({ token }) }
  async loginWith(credentials: LoginCredentials): Promise<BrowserSession> {
    const { session, epoch } = await this.beginAuthentication()
    const body = 'method' in credentials && credentials.method === 'system' ? { method: 'system', proof: await this.systemProof(session, epoch) } : credentials
    return this.finishAuthentication('/api/login', body, epoch)
  }
  async setup(password: string, verification?: SetupVerification): Promise<BrowserSession> {
    if (password.length < 12 || password.length > 1024) throw new ApiError('password_invalid', '密码需为 12 至 1024 个字符。')
    const { session, epoch } = await this.beginAuthentication()
    let identity: { token: string } | { proof: string } | { setupGrant: string } | undefined
    if (verification && 'method' in verification) identity = { proof: await this.systemProof(session, epoch) }
    else if (verification) identity = verification
    else if (session.authenticated && session.role === 'human') identity = undefined
    else {
      const grant = await this.getSetupGrant()
      if (epoch !== this.generation) throw stale()
      if (!grant) throw new ApiError('enrollment_required', '请使用一次性 human token 或系统认证完成身份验证。')
      identity = { setupGrant: grant }
    }
    const result = await this.finishAuthentication('/api/setup', { password, ...identity }, epoch)
    this.setupGrant = null
    return result
  }
  logout(): Promise<void> {
    const token = this.csrf
    this.invalidate()
    const operation = (async () => {
      if (!token) throw new ApiError('missing_csrf', '会话不可用，请重新登录。')
      let response: Response
      try { response = await this.fetcher('/api/logout', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': token }, credentials: 'same-origin', body: '{}' }) }
      catch { throw new ApiError('network_error', '无法连接本地治理服务。') }
      if (!response.ok) throw new ApiError(safeCode(response.status), safeMessage(response.status), response.status)
    })()
    this.logoutPending = operation
    void operation.then(() => { if (this.logoutPending === operation) this.logoutPending = null }, () => { if (this.logoutPending === operation) this.logoutPending = null })
    return operation
  }
  status(): Promise<RuntimeStatus> { return this.json('/api/status') }
  projects(): Promise<Project[]> { return this.json('/api/projects') }
  createProject(input: CreateProjectInput): Promise<Project> { return this.json('/api/projects', 'POST', input) }
  policy(id: string): Promise<PublishedVersion | null> { return this.json(`/api/projects/${pathId(id)}/policy`) }
  seed(): Promise<Candidate> { return this.json('/api/seed') }
  schema(): Promise<Record<string, unknown>> { return this.json('/api/schema') }
  validate(id: string, candidate: Candidate): Promise<ValidationResult> { return this.json(`/api/projects/${pathId(id)}/validate`, 'POST', { candidate }) }
  importYaml(id: string, yaml: string): Promise<{ valid: boolean; issues: ValidationResult['issues']; candidate: Candidate }> { return this.json(`/api/projects/${pathId(id)}/import`, 'POST', { yaml }) }
  runtime(id: string): Promise<HarnessRuntimeStatus> { return this.json(`/api/projects/${pathId(id)}/runtime`) }
  config(id: string): Promise<ProjectConfig> { return this.json(`/api/projects/${pathId(id)}/config`) }
  updateConfig(id: string, input: UpdateProjectConfigInput): Promise<ProjectConfig> { return this.json(`/api/projects/${pathId(id)}/config`, 'POST', input) }
  jevSettings(id: string): Promise<JevSettingsView> { return this.json(`/api/projects/${pathId(id)}/jev`) }
  saveJevSettings(id: string, input: JevSettingsInput): Promise<JevSettingsView> { return this.json(`/api/projects/${pathId(id)}/jev`, 'POST', input) }
  testJevSettings(id: string): Promise<{ ok: true; model: string }> { return this.json(`/api/projects/${pathId(id)}/jev/test`, 'POST', {}) }
  tightenings(id: string): Promise<TemporaryTighteningStatus> { return this.json(`/api/projects/${pathId(id)}/tighten`) }
  applyTightening(id: string, input: { templateId: string; ttlMs: number }): Promise<TemporaryTighteningStatus> { return this.json(`/api/projects/${pathId(id)}/tighten`, 'POST', input) }
  expireTightenings(id: string): Promise<TemporaryTighteningStatus> { return this.json(`/api/projects/${pathId(id)}/tighten/expire`, 'POST', {}) }
  probes(id: string): Promise<ProbeRunRecord[]> { return this.json(`/api/projects/${pathId(id)}/probes`) }
  rollouts(id: string): Promise<RuleRolloutRecord[]> { return this.json(`/api/projects/${pathId(id)}/rollout`) }
  promoteRollout(id: string, ruleId: string, input: EvaluateRulePromotionInput): Promise<RolloutEvaluation> { return this.json(`/api/projects/${pathId(id)}/rollout/promote`, 'POST', { ruleId, ...input }) }
  proposals(id: string): Promise<Proposal[]> { return this.json(`/api/projects/${pathId(id)}/proposals`) }
  proposal(id: string): Promise<Proposal> { return this.json(`/api/proposals/${pathId(id)}`) }
  createProposal(id: string, input: CreateProposalInput): Promise<Proposal> { return this.json(`/api/projects/${pathId(id)}/proposals`, 'POST', input) }
  decide(id: string, input: DecideProposalInput): Promise<Proposal> { return this.json(`/api/proposals/${pathId(id)}/decision`, 'POST', input) }
  withdraw(id: string): Promise<Proposal> { return this.json(`/api/proposals/${pathId(id)}/withdraw`, 'POST', {}) }
  versions(id: string): Promise<PublishedVersion[]> { return this.json(`/api/projects/${pathId(id)}/versions`) }
  version(id: string, version: number): Promise<PublishedVersion> { return this.json(`/api/projects/${pathId(id)}/versions/${pathId(version)}`) }
  restore(id: string, version: number, input: CreateRollbackProposalInput): Promise<Proposal> { return this.json(`/api/projects/${pathId(id)}/versions/${pathId(version)}/restore`, 'POST', input) }
  audit(query: AuditQuery = {}): Promise<AuditPage> { const params = new URLSearchParams(); if (query.projectId !== undefined) params.set('projectId', query.projectId); if (query.limit !== undefined) params.set('limit', String(query.limit)); if (query.before !== undefined) params.set('before', String(query.before)); return this.json(`/api/audit${params.size ? `?${params}` : ''}`) }
  observations(): Promise<ObservationReport> { return this.json('/api/audit/observations') }
  simulate(id: string, input: SimulateInput): Promise<PolicyDecision> { return this.json(`/api/projects/${pathId(id)}/simulate`, 'POST', input) }
  async exportVersion(id: string, version: number, format: 'yaml' | 'json'): Promise<void> {
    if (format !== 'yaml' && format !== 'json') throw new ApiError('invalid_format', '导出格式无效。')
    const epoch = this.generation
    const response = await this.request(`/api/projects/${pathId(id)}/versions/${pathId(version)}/export?format=${format}`, 'GET', undefined, epoch)
    const type = response.headers.get('content-type') ?? ''
    if (!(format === 'json' ? type.includes('application/json') : type.includes('application/yaml'))) throw new ApiError('invalid_response', '服务返回的数据无效。')
    let blob: Blob
    try { blob = await response.blob() } catch { throw new ApiError('invalid_response', '服务返回的数据无效。') }
    if (epoch !== this.generation) throw stale()
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') throw new ApiError('download_unavailable', '当前环境无法下载文件。')
    const url = URL.createObjectURL(blob); const link = document.createElement('a')
    link.href = url; link.download = `amos-policy-${id.replace(/[^a-z0-9_-]/gi, '-')}-v${version}.${format}`; link.hidden = true
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
export const api = new ApiClient()
