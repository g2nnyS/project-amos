const PREDICATE_LABELS = {
  op_in: '操作属于',
  target_glob: '路径匹配',
  target_outside_glob: '路径不在范围内',
  url_query_key_in: 'URL 查询键包含',
  target_scheme_in: 'URL 协议属于',
  target_host_in: 'URL 主机属于',
  target_host_not_in: 'URL 主机不属于',
};

const VERDICT_LABELS = {
  allow: '允许',
  deny: '拒绝',
  confirm: '需确认',
  log: '记录',
};

const DECISION_KIND_LABELS = {
  matched: '命中规则',
  no_match: '未命中',
  error: '错误',
  not_evaluated: '未评估',
};

const STATUS_LABELS = {
  pending: '待审批',
  approved: '已通过并发布',
  rejected: '已拒绝',
  withdrawn: '已撤回',
  expired: '已过期',
};

const ROLE_LABELS = {
  human: '人类',
  agent: 'Agent',
};

const EXPRESSIVITY_LABELS = {
  deterministic: '确定性',
  advisory_only: '仅建议',
};

const POLICY_CLASS_LABELS = {
  security: '安全',
  engineering: '工程',
};

const ENFORCEMENT_LABELS = {
  runtime: '运行期',
  ci: 'CI',
  server: '服务端',
  advisory: '建议',
};

const SCOPE_LABELS = {
  project: '项目',
  session: '会话',
};

const OWNER_LABELS = {
  human: '人类',
  agent: 'Agent',
};

const COVERAGE_REASON_LABELS = {
  unsupported_tool: '不支持的工具',
  opaque_action: '不透明动作',
  unstructured_tool: '非结构化工具',
};

const AUDIT_ERROR_LABELS = {
  engine_error: '引擎错误',
  parse_error: '解析错误',
  unknown_payload: '未知载荷',
  snapshot_error: '快照错误',
};

const ASSESSMENT_KIND_LABELS = {
  jev_assessment: 'Jev 评估',
  user_literal_grant: '用户字面授权',
};

const state = {
  session: null,
  status: null,
  projects: [],
  selectedProjectId: null,
  project: null,
  policy: null,
  proposals: [],
  versions: [],
  audit: { items: [], nextCursor: null, loading: false, limit: 20 },
  observations: { available: false, sources: [], queue: [], loading: false, error: null },
  view: 'overview',
  viewParam: null,
  candidate: null,
  candidateBase: null,
  candidateBaseVersion: null,
  selectedRuleId: null,
  messages: [],
  navOpen: false,
  editorDirty: false,
};

function $(sel, el = document) {
  return el.querySelector(sel);
}

function $$(sel, el = document) {
  return Array.from(el.querySelectorAll(sel));
}

function empty(el) {
  while (el && el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function el(tag, opts = {}) {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.text !== undefined) e.textContent = opts.text;
  if (opts.htmlFor !== undefined) e.htmlFor = opts.htmlFor;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
  }
  if (opts.children) {
    for (const c of opts.children) {
      if (c !== null && c !== undefined) e.appendChild(c);
    }
  }
  if (opts.events) {
    for (const [k, fn] of Object.entries(opts.events)) {
      e.addEventListener(k, fn);
    }
  }
  if (opts.props) {
    for (const [k, v] of Object.entries(opts.props)) {
      e[k] = v;
    }
  }
  return e;
}

function addMessage(type, text, detail) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.messages.push({ type, text, detail, id });
  renderMessages();
}

function clearMessages() {
  state.messages = [];
  renderMessages();
}

function renderMessages(container) {
  const target = container || $('#message-area');
  if (!target) return;
  empty(target);
  for (const m of state.messages) {
    const row = el('div', { className: `message message-${m.type}` });
    row.appendChild(el('span', { text: m.text }));
    if (m.detail) {
      row.appendChild(el('pre', { text: m.detail }));
    }
    target.appendChild(row);
  }
}

async function apiCall(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.session && state.session.csrfToken) {
    headers['X-CSRF-Token'] = state.session.csrfToken;
  }
  const init = {
    method,
    headers,
    credentials: 'include',
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { code: 'invalid_json' } };
    }
  }
  if (!res.ok) {
    const code = data && data.error && data.error.code ? data.error.code : `http_${res.status}`;
    if (res.status === 401) {
      state.session = null;
      addMessage('error', '会话已过期或无效，请重新登录。');
      render();
    }
    const err = new Error(code);
    err.code = code;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadSession() {
  const s = await apiCall('GET', '/api/session');
  state.session = s;
  return s;
}

export async function login(token) {
  await loadSession();
  await apiCall('POST', '/api/login', { token });
  return loadSession();
}

async function logout() {
  await apiCall('POST', '/api/logout', {});
  state.session = null;
  state.projects = [];
  state.selectedProjectId = null;
  state.project = null;
  state.policy = null;
  state.proposals = [];
  state.versions = [];
  state.candidate = null;
  state.candidateBase = null;
  state.candidateBaseVersion = null;
  state.messages = [];
  render();
}

async function loadStatus() {
  try {
    state.status = await apiCall('GET', '/api/status');
  } catch (e) {
    state.status = null;
  }
}

async function loadProjects() {
  state.projects = await apiCall('GET', '/api/projects');
  if (!state.selectedProjectId && state.projects.length > 0) {
    state.selectedProjectId = state.projects[0].id;
  }
}

async function loadProjectData(projectId) {
  if (!projectId) return;
  try {
    state.project = await apiCall('GET', `/api/projects/${encodeURIComponent(projectId)}`);
  } catch (e) {
    state.project = null;
    throw e;
  }
  await Promise.all([
    loadPolicy(projectId),
    loadProposals(projectId),
    loadVersions(projectId),
  ]);
}

async function loadPolicy(projectId) {
  try {
    state.policy = await apiCall('GET', `/api/projects/${encodeURIComponent(projectId)}/policy`);
  } catch (e) {
    state.policy = null;
  }
}

async function loadProposals(projectId) {
  state.proposals = await apiCall('GET', `/api/projects/${encodeURIComponent(projectId)}/proposals`);
}

async function loadVersions(projectId) {
  state.versions = await apiCall('GET', `/api/projects/${encodeURIComponent(projectId)}/versions`);
}

async function loadProposal(proposalId) {
  return apiCall('GET', `/api/proposals/${encodeURIComponent(proposalId)}`);
}

async function loadAudit(cursor) {
  if (state.audit.loading) return;
  state.audit.loading = true;
  const params = new URLSearchParams();
  if (state.selectedProjectId) params.set('projectId', state.selectedProjectId);
  params.set('limit', String(state.audit.limit));
  if (cursor) params.set('before', String(cursor));
  try {
    const result = await apiCall('GET', `/api/audit?${params.toString()}`);
    if (cursor) {
      state.audit.items = state.audit.items.concat(result.items || []);
    } else {
      state.audit.items = result.items || [];
    }
    state.audit.nextCursor = result.nextCursor || null;
  } finally {
    state.audit.loading = false;
  }
}

async function loadObservations() {
  if (state.observations.loading) return;
  state.observations.loading = true;
  state.observations.error = null;
  try {
    const result = await apiCall('GET', '/api/audit/observations');
    const normalized = normalizeObservationsResult(result);
    state.observations.available = normalized.available;
    state.observations.sources = normalized.sources;
    state.observations.queue = normalized.queue;
  } catch (e) {
    state.observations.available = false;
    state.observations.sources = [];
    state.observations.queue = [];
    state.observations.error = e.code || e.message;
  } finally {
    state.observations.loading = false;
  }
}

/**
 * HTTP returns `{ available, sources, queue: ReviewQueue }`, where the queue is
 * an object with `records`. Keep the honest availability/source/truncation
 * metadata and expose the records the renderer expects.
 */
export function normalizeObservationsResult(result) {
  const queue = result && result.queue;
  const records = queue && Array.isArray(queue.records) ? queue.records : [];
  return {
    available: !!(result && result.available),
    sources: result && Array.isArray(result.sources) ? result.sources : [],
    queue: records,
  };
}

function parseHash() {
  const loc = typeof location !== 'undefined' ? location : { hash: '' };
  const hash = (loc.hash || '').replace(/^#/, '');
  const parts = hash.split('/');
  return { view: parts[0] || 'overview', param: parts[1] || null };
}

function navigate(view, param) {
  if (state.editorDirty && view !== 'editor') {
    confirmDialog('候选规则有未保存的更改，离开将丢失当前草案。是否继续？', () => {
      state.editorDirty = false;
      location.hash = param ? `#${view}/${param}` : `#${view}`;
    });
    return;
  }
  location.hash = param ? `#${view}/${param}` : `#${view}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortDigest(digest, len = 12) {
  if (!digest) return '—';
  if (digest.length <= len) return digest;
  return `${digest.slice(0, len)}…`;
}

function snapshotDigest(snapshot, lane) {
  if (!snapshot) return null;
  if (lane === 'enforcement') return snapshot.enforcementDigest || (snapshot.enforcement && snapshot.enforcement.digest) || null;
  if (lane === 'advisory') return snapshot.advisoryDigest || (snapshot.advisory && snapshot.advisory.digest) || null;
  return snapshot.digest || null;
}

function fmtActor(actor) {
  if (!actor) return '—';
  const role = ROLE_LABELS[actor.role] || actor.role;
  return `${actor.id}（${role}）`;
}

function emptyCandidate() {
  return { rules: [], activation: { includedRuleIds: null, excludedRuleIds: [] } };
}

function cloneCandidate(c) {
  return JSON.parse(JSON.stringify(c || emptyCandidate()));
}

function ensureCandidateActivation(c) {
  if (!c.activation) c.activation = { includedRuleIds: null, excludedRuleIds: [] };
  if (c.activation.includedRuleIds === undefined) c.activation.includedRuleIds = null;
  if (!Array.isArray(c.activation.excludedRuleIds)) c.activation.excludedRuleIds = [];
}

function newRule() {
  return {
    id: '',
    dimension: '',
    level: 0,
    expressivity: 'deterministic',
    policy_class: 'security',
    enforcement: 'runtime',
    predicate: [{ op: 'op_in', args: { operations: [] } }],
    narrative: '',
    on_hit: 'deny',
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: { repo: '', rev: '', path: '', section: '', lines: '', quote: '' },
    probe: '',
  };
}

function candidateFromPolicy() {
  if (state.policy && state.policy.candidate) {
    return cloneCandidate(state.policy.candidate);
  }
  return emptyCandidate();
}

function ruleIsExpired(rule, now) {
  if (!rule || !rule.ttl) return false;
  const t = new Date(rule.ttl).getTime();
  return Number.isFinite(t) && now >= t;
}

function activationLabel(candidate) {
  ensureCandidateActivation(candidate);
  if (candidate.activation.includedRuleIds === null) {
    const ex = candidate.activation.excludedRuleIds.length;
    return ex > 0 ? `全部生效（排除 ${ex} 条）` : '全部生效';
  }
  const inc = candidate.activation.includedRuleIds.length;
  const ex = candidate.activation.excludedRuleIds.length;
  return `显式包含 ${inc} 条，排除 ${ex} 条`;
}

export function setDiff(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((id) => !beforeSet.has(id));
  const removed = before.filter((id) => !afterSet.has(id));
  return { added, removed };
}

export function diffCandidates(base, proposed) {
  const baseNorm = base || emptyCandidate();
  const propNorm = proposed || emptyCandidate();
  ensureCandidateActivation(baseNorm);
  ensureCandidateActivation(propNorm);
  const baseMap = new Map(baseNorm.rules.map((r) => [r.id, r]));
  const propMap = new Map(propNorm.rules.map((r) => [r.id, r]));
  const rules = [];
  for (const [id, after] of propMap) {
    if (!baseMap.has(id)) {
      rules.push({ type: 'added', id, after });
    } else {
      const before = baseMap.get(id);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        rules.push({ type: 'modified', id, before, after });
      }
    }
  }
  for (const [id, before] of baseMap) {
    if (!propMap.has(id)) {
      rules.push({ type: 'removed', id, before });
    }
  }
  const activation = { before: baseNorm.activation, after: propNorm.activation };
  const activationChanged = JSON.stringify(activation.before) !== JSON.stringify(activation.after);
  return { rules, activation, activationChanged };
}

function currentBaseVersion() {
  return state.project && state.project.currentVersion !== null ? state.project.currentVersion : 0;
}

function formatVersion(version) {
  if (version === null || version === undefined) return '0（尚未发布）';
  return String(version);
}

function clearProjectScopedState() {
  state.candidate = null;
  state.candidateBase = null;
  state.candidateBaseVersion = null;
  state.selectedRuleId = null;
  state.pendingProposal = null;
  state.audit.items = [];
  state.audit.nextCursor = null;
  state.editorDirty = false;
}

function switchToProject(id) {
  state.selectedProjectId = id;
  clearProjectScopedState();
}

function isStaleProposal(proposal) {
  if (!proposal || proposal.status !== 'pending') return false;
  if (!state.project) return false;
  const current = state.project.currentVersion ?? 0;
  return proposal.baseVersion !== current;
}

function render() {
  const app = $('#app');
  if (!app) return;
  empty(app);
  if (!state.session || !state.session.authenticated) {
    renderLogin(app);
    return;
  }
  if (!state.selectedProjectId) {
    renderProjectOnboarding(app);
    return;
  }
  renderLayout(app);
}

function renderLogin(parent) {
  parent.appendChild(stageBanner());
  const container = el('div', { className: 'container login-container' });
  const card = el('div', { className: 'card' });
  card.appendChild(el('h2', { text: 'Amos 本地治理控制台' }));
  card.appendChild(el('p', { className: 'subtitle', text: '请输入人类访问令牌以建立服务端会话。令牌不会保存在浏览器中。' }));
  card.appendChild(el('div', { attrs: { id: 'message-area' } }));
  const form = el('form', { className: 'editor-form' });
  const tokenGroup = el('div', { className: 'form-group' });
  tokenGroup.appendChild(el('label', { text: '访问令牌', htmlFor: 'login-token' }));
  const tokenInput = el('input', {
    props: { type: 'password', id: 'login-token', name: 'token', required: true, autocomplete: 'off' },
  });
  tokenGroup.appendChild(tokenInput);
  form.appendChild(tokenGroup);
  const submit = el('button', { className: 'button button-primary', props: { type: 'submit' }, text: '登录' });
  form.appendChild(submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearMessages();
    const token = tokenInput.value.trim();
    if (!token) return;
    submit.disabled = true;
    try {
      await login(token);
      tokenInput.value = '';
      await loadInitialData();
      const r = parseHash();
      state.view = r.view;
      state.viewParam = r.param;
      render();
    } catch (e) {
      addMessage('error', '登录失败', e.code || e.message);
    } finally {
      submit.disabled = false;
    }
  });
  card.appendChild(form);
  container.appendChild(card);
  parent.appendChild(container);
  tokenInput.focus();
}

function renderProjectOnboarding(parent) {
  parent.appendChild(stageBanner());
  const container = el('div', { className: 'container' });
  container.appendChild(el('div', { attrs: { id: 'message-area' } }));
  container.appendChild(el('h2', { text: '创建或选择项目' }));
  container.appendChild(el('p', { className: 'subtitle', text: '项目是治理的最小单位。每个项目绑定一个已规范化的绝对工作区路径。' }));

  const createCard = el('div', { className: 'card' });
  createCard.appendChild(el('h3', { text: '新建项目' }));
  const form = el('form', { className: 'editor-form' });
  const nameGroup = el('div', { className: 'form-group' });
  nameGroup.appendChild(el('label', { text: '项目名称', htmlFor: 'project-name' }));
  const nameInput = el('input', { props: { type: 'text', id: 'project-name', required: true } });
  nameGroup.appendChild(nameInput);
  form.appendChild(nameGroup);

  const wsGroup = el('div', { className: 'form-group' });
  wsGroup.appendChild(el('label', { text: '绝对工作区路径', htmlFor: 'project-workspace' }));
  const wsInput = el('input', { props: { type: 'text', id: 'project-workspace', required: true, placeholder: '/home/user/projects/example' } });
  wsGroup.appendChild(wsInput);
  wsGroup.appendChild(el('span', { className: 'hint', text: '创建后不可变更；用于 ${SESSION_WORKSPACE} 替换。' }));
  form.appendChild(wsGroup);

  const submit = el('button', { className: 'button button-primary', props: { type: 'submit' }, text: '创建项目' });
  form.appendChild(submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearMessages();
    if (state.editorDirty && state.candidate) {
      confirmDialog('创建新项目将丢弃当前未保存的候选草案。是否继续？', async () => {
        await createProject();
      });
      return;
    }
    await createProject();

    async function createProject() {
      submit.disabled = true;
      try {
        const project = await apiCall('POST', '/api/projects', {
          name: nameInput.value.trim(),
          workspace: wsInput.value.trim(),
        });
        await loadProjects();
        switchToProject(project.id);
        await loadProjectData(project.id);
        render();
      } catch (e) {
        addMessage('error', '创建项目失败', e.code || e.message);
        submit.disabled = false;
      }
    }
  });
  createCard.appendChild(form);
  container.appendChild(createCard);

  if (state.projects.length > 0) {
    const listCard = el('div', { className: 'card' });
    listCard.appendChild(el('h3', { text: '已有项目' }));
    const list = el('div', { className: 'rule-list' });
    for (const p of state.projects) {
      const item = el('div', { className: 'rule-list-item' });
      item.appendChild(el('div', { className: 'id', text: p.name }));
      item.appendChild(el('div', { className: 'dim', text: p.workspace }));
      item.addEventListener('click', async () => {
        const proceed = async () => {
          switchToProject(p.id);
          await loadProjectData(p.id);
          render();
        };
        if (state.editorDirty && state.candidate) {
          confirmDialog('选择其他项目将丢弃当前未保存的候选草案。是否继续？', proceed);
          return;
        }
        await proceed();
      });
      list.appendChild(item);
    }
    listCard.appendChild(list);
    container.appendChild(listCard);
  }

  parent.appendChild(container);
  nameInput.focus();
}

function stageBanner() {
  return el('div', {
    className: 'stage-banner',
    children: [
      el('strong', { text: '阶段 A · 仅观察记录' }),
      el('span', { text: '本控制台用于规则治理提案与审批，不授权具体工具调用执行，也不构成受信安全边界。' }),
      el('span', { className: 'disclosure', text: '数据库与当前用户同 UID，无法防御同账户下的恶意进程。' }),
    ],
  });
}

function renderLayout(parent) {
  parent.appendChild(stageBanner());
  const top = el('div', { className: 'top-bar' });
  const brand = el('div', { className: 'brand' });
  brand.appendChild(el('h1', { text: 'Amos 治理' }));
  brand.appendChild(el('span', { className: 'tagline', text: '本地规则治理控制台' }));
  top.appendChild(brand);

  const menuToggle = el('button', { className: 'menu-toggle button-ghost button-small', text: '菜单' });
  menuToggle.addEventListener('click', () => {
    state.navOpen = !state.navOpen;
    const nav = $('#main-nav');
    if (nav) nav.classList.toggle('open', state.navOpen);
  });
  top.appendChild(menuToggle);

  const userBar = el('div', { className: 'user-bar' });
  const projectSelect = el('select', { props: { value: state.selectedProjectId || '' } });
  for (const p of state.projects) {
    projectSelect.appendChild(el('option', { props: { value: p.id }, text: p.name }));
  }
  projectSelect.addEventListener('change', async () => {
    const id = projectSelect.value;
    if (!id || id === state.selectedProjectId) return;
    const proceed = () => {
      switchToProject(id);
      loadProjectData(id).then(() => {
        navigate('overview');
        render();
      }).catch(() => render());
    };
    if (state.editorDirty && state.candidate) {
      confirmDialog('切换项目将丢弃当前未保存的候选草案。是否继续？', proceed);
      projectSelect.value = state.selectedProjectId || '';
      return;
    }
    proceed();
  });
  userBar.appendChild(projectSelect);
  userBar.appendChild(el('span', { className: 'role', text: `当前身份：${state.session.role ? ROLE_LABELS[state.session.role] : '—'}` }));

  const manageBtn = el('button', { className: 'button button-ghost button-small', text: '管理项目' });
  manageBtn.addEventListener('click', () => {
    const proceed = () => {
      switchToProject(null);
      state.project = null;
      state.policy = null;
      state.proposals = [];
      state.versions = [];
      navigate('overview');
      render();
    };
    if (state.editorDirty && state.candidate) {
      confirmDialog('返回项目管理将丢弃当前未保存的候选草案。是否继续？', proceed);
      return;
    }
    proceed();
  });
  userBar.appendChild(manageBtn);

  const logoutBtn = el('button', { className: 'button button-ghost button-small', text: '退出' });
  logoutBtn.addEventListener('click', logout);
  userBar.appendChild(logoutBtn);
  top.appendChild(userBar);
  parent.appendChild(top);

  const layout = el('div', { className: 'layout' });
  const nav = el('nav', { className: 'nav', attrs: { id: 'main-nav' } });
  nav.classList.toggle('open', state.navOpen);

  const links = [
    { view: 'overview', label: '总览' },
    { view: 'rules', label: '规则库' },
    { view: 'editor', label: '候选编辑' },
    { view: 'proposals', label: '提案' },
    { view: 'versions', label: '版本' },
    { view: 'audit', label: '审计' },
    { view: 'observations', label: '观察日志' },
    { view: 'simulate', label: '模拟' },
  ];
  nav.appendChild(el('div', { className: 'nav-group', text: '治理' }));
  for (const l of links) {
    const isActive = state.view === l.view || (l.view === 'proposals' && state.view === 'proposal') || (l.view === 'versions' && state.view === 'version');
    const btn = el('button', { className: isActive ? 'active' : '', text: l.label });
    btn.addEventListener('click', () => {
      navigate(l.view);
      state.navOpen = false;
      nav.classList.remove('open');
    });
    nav.appendChild(btn);
  }
  layout.appendChild(nav);

  const main = el('main', { className: 'main' });
  main.appendChild(el('div', { className: 'container', attrs: { id: 'message-area' } }));
  const content = el('div', { attrs: { id: 'page-content' } });
  main.appendChild(content);
  layout.appendChild(main);
  parent.appendChild(layout);

  renderMessages($('#message-area'));
  renderView(content);
}

export function resolveView(view, param) {
  if (view === 'proposals' && param) return { view: 'proposal', param };
  if (view === 'proposal') return { view: 'proposal', param };
  if (view === 'versions' && param) return { view: 'version', param };
  if (view === 'version') return { view: 'version', param };
  return { view, param: null };
}

function renderView(container) {
  empty(container);
  const target = resolveView(state.view, state.viewParam);
  switch (target.view) {
    case 'overview':
      renderOverview(container);
      break;
    case 'rules':
      renderRules(container);
      break;
    case 'editor':
      renderEditor(container);
      break;
    case 'proposals':
      renderProposals(container);
      break;
    case 'proposal':
      renderProposalDetail(container, target.param);
      break;
    case 'versions':
      renderVersions(container);
      break;
    case 'version':
      renderVersionDetail(container, target.param);
      break;
    case 'audit':
      renderAudit(container);
      break;
    case 'observations':
      renderObservations(container);
      break;
    case 'simulate':
      renderSimulate(container);
      break;
    default:
      container.appendChild(el('div', { className: 'empty-state', text: '未知页面' }));
  }
}

function renderOverview(parent) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('div', { children: [
    el('h2', { text: state.project ? state.project.name : '总览' }),
    el('div', { className: 'subtitle', text: state.project ? state.project.workspace : '' }),
  ] }));
  header.appendChild(el('button', { className: 'button button-primary', text: '新建提案', events: { click: () => navigate('editor') } }));
  parent.appendChild(header);

  const statusCard = el('div', { className: 'card' });
  statusCard.appendChild(el('h3', { text: '运行状态' }));
  const statusGrid = el('div', { className: 'grid grid-4' });
  const mode = state.status ? (state.status.mode || 'log-only') : '—';
  const enforcement = state.status && state.status.enforcement === true ? '已启用' : '未启用';
  const trustBoundary = state.status && state.status.trustBoundary === true ? '已建立' : '未建立';
  statusGrid.appendChild(statCard('运行模式', mode, '阶段 A 观察'));
  statusGrid.appendChild(statCard('执行拦截', enforcement, '安全适配器不拦截'));
  statusGrid.appendChild(statCard('受信边界', trustBoundary, '同 UID 下不可靠'));
  statusGrid.appendChild(statCard('当前项目数', String(state.projects.length), '本地 SQLite'));
  statusCard.appendChild(statusGrid);
  parent.appendChild(statusCard);

  const policyCard = el('div', { className: 'card' });
  policyCard.appendChild(el('h3', { text: '当前已发布策略' }));
  if (!state.policy) {
    policyCard.appendChild(el('div', { className: 'empty-state', children: [
      el('h3', { text: '尚未发布策略' }),
      el('p', { text: '当前项目没有已批准版本。请在候选编辑器中起草提案并审批发布。' }),
    ] }));
  } else {
    const detail = el('div', { className: 'detail-grid' });
    detail.appendChild(detailItem('版本', String(state.policy.version)));
    detail.appendChild(detailItem('提案', state.policy.proposalId));
    detail.appendChild(detailItem('发布时间', fmtDate(state.policy.createdAt)));
    detail.appendChild(detailItem('审批人', fmtActor(state.policy.approvedBy)));
    detail.appendChild(detailItem('生效规则数', String((state.policy.candidate && state.policy.candidate.rules) ? state.policy.candidate.rules.length : 0)));
    detail.appendChild(detailItem('激活策略', activationLabel(state.policy.candidate)));
    detail.appendChild(detailItem('快照摘要', shortDigest(snapshotDigest(state.policy.snapshot, 'enforcement'))));
    policyCard.appendChild(detail);
    const actions = el('div', { className: 'toolbar mt-3' });
    actions.appendChild(el('button', { className: 'button button-ghost button-small', text: '查看规则库', events: { click: () => navigate('rules') } }));
    actions.appendChild(el('button', { className: 'button button-ghost button-small', text: '查看版本历史', events: { click: () => navigate('versions') } }));
    policyCard.appendChild(actions);
  }
  parent.appendChild(policyCard);

  const countsCard = el('div', { className: 'card' });
  countsCard.appendChild(el('h3', { text: '治理动态' }));
  const countsGrid = el('div', { className: 'grid grid-4' });
  const pending = state.proposals.filter((p) => p.status === 'pending').length;
  const approved = state.proposals.filter((p) => p.status === 'approved').length;
  countsGrid.appendChild(statCard('待审批提案', String(pending), '需人类审批'));
  countsGrid.appendChild(statCard('已发布提案', String(approved), '生成新版本'));
  countsGrid.appendChild(statCard('历史版本', String(state.versions.length), '可回滚'));
  countsGrid.appendChild(statCard('审计事件', String(state.audit.items.length), '治理操作记录'));
  countsCard.appendChild(countsGrid);
  parent.appendChild(countsCard);

  const info = el('div', { className: 'message message-info' });
  info.appendChild(el('span', { text: '提示：在单人模式下，您可以审批自己起草的提案；这仅为本地治理记录，不等于独立复核。Agent 提交的提案不能由 Agent 自己审批。' }));
  parent.appendChild(info);
}

function statCard(label, value, meta) {
  const card = el('div', { className: 'stat' });
  card.appendChild(el('div', { className: 'label', text: label }));
  card.appendChild(el('div', { className: 'value', text: value }));
  card.appendChild(el('div', { className: 'meta', text: meta }));
  return card;
}

function detailItem(label, value) {
  const item = el('div', { className: 'detail-item' });
  item.appendChild(el('dt', { text: label }));
  item.appendChild(el('dd', { text: value }));
  return item;
}

function renderRules(parent) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '规则库' }));
  header.appendChild(el('button', { className: 'button button-primary', text: '编辑候选', events: { click: () => navigate('editor') } }));
  parent.appendChild(header);

  const candidate = state.policy && state.policy.candidate ? state.policy.candidate : emptyCandidate();
  ensureCandidateActivation(candidate);
  const rules = candidate.rules || [];

  const toolbar = el('div', { className: 'toolbar' });
  const search = el('input', { props: { type: 'text', placeholder: '搜索 ID、维度、说明或探测…' } });
  const dimFilter = el('select');
  dimFilter.appendChild(el('option', { props: { value: '' }, text: '全部维度' }));
  const dims = Array.from(new Set(rules.map((r) => r.dimension).filter(Boolean))).sort();
  for (const d of dims) dimFilter.appendChild(el('option', { props: { value: d }, text: d }));
  const classFilter = el('select');
  classFilter.appendChild(el('option', { props: { value: '' }, text: '全部分类' }));
  for (const c of ['security', 'engineering']) classFilter.appendChild(el('option', { props: { value: c }, text: POLICY_CLASS_LABELS[c] }));
  const hitFilter = el('select');
  hitFilter.appendChild(el('option', { props: { value: '' }, text: '全部裁决' }));
  for (const h of ['deny', 'confirm', 'log']) hitFilter.appendChild(el('option', { props: { value: h }, text: VERDICT_LABELS[h] }));
  toolbar.appendChild(el('div', { className: 'group', children: [search, dimFilter, classFilter, hitFilter] }));
  parent.appendChild(toolbar);

  const tableWrap = el('div', { className: 'table-wrap' });
  const table = el('table');
  const thead = el('thead');
  thead.appendChild(el('tr', { children: [
    el('th', { text: 'ID' }), el('th', { text: '维度' }), el('th', { text: '层级' }),
    el('th', { text: '分类' }), el('th', { text: '执行面' }), el('th', { text: '命中' }),
    el('th', { text: '范围' }), el('th', { text: '过期' }), el('th', { text: '说明' }),
  ] }));
  table.appendChild(thead);
  const tbody = el('tbody');
  const now = Date.now();

  function applyFilters() {
    const q = search.value.trim().toLowerCase();
    const dim = dimFilter.value;
    const pc = classFilter.value;
    const hit = hitFilter.value;
    empty(tbody);
    let count = 0;
    for (const r of rules) {
      if (dim && r.dimension !== dim) continue;
      if (pc && r.policy_class !== pc) continue;
      if (hit && r.on_hit !== hit) continue;
      if (q && !((r.id || '').toLowerCase().includes(q) || (r.dimension || '').toLowerCase().includes(q) || (r.narrative || '').toLowerCase().includes(q) || (r.probe || '').toLowerCase().includes(q))) continue;
      count += 1;
      const tr = el('tr');
      tr.appendChild(el('td', { children: [el('code', { text: r.id })] }));
      tr.appendChild(el('td', { text: r.dimension }));
      tr.appendChild(el('td', { text: String(r.level) }));
      tr.appendChild(el('td', { text: POLICY_CLASS_LABELS[r.policy_class] || r.policy_class }));
      tr.appendChild(el('td', { text: ENFORCEMENT_LABELS[r.enforcement] || r.enforcement }));
      tr.appendChild(el('td', { children: [verdictBadge(r.on_hit)] }));
      tr.appendChild(el('td', { text: SCOPE_LABELS[r.scope] || r.scope }));
      const expired = ruleIsExpired(r, now);
      tr.appendChild(el('td', { text: r.ttl ? (expired ? '已过期' : fmtDate(r.ttl)) : '无' }));
      tr.appendChild(el('td', { text: r.narrative }));
      tr.addEventListener('click', () => {
        const detail = $('#rule-detail');
        if (detail) {
          empty(detail);
          detail.appendChild(renderRuleDetailCard(r));
        }
      });
      tbody.appendChild(tr);
    }
    if (count === 0) {
      tbody.appendChild(el('tr', { children: [el('td', { attrs: { colspan: '9' }, children: [el('div', { className: 'empty-state', text: '没有匹配的规则' })] })] }));
    }
  }
  search.addEventListener('input', applyFilters);
  dimFilter.addEventListener('change', applyFilters);
  classFilter.addEventListener('change', applyFilters);
  hitFilter.addEventListener('change', applyFilters);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  parent.appendChild(tableWrap);
  applyFilters();

  const detail = el('div', { className: 'card', attrs: { id: 'rule-detail' } });
  detail.appendChild(el('div', { className: 'empty-state', text: '点击规则行查看完整详情' }));
  parent.appendChild(detail);
}

function renderRuleDetailCard(rule) {
  const card = el('div');
  const header = el('div', { className: 'page-header mb-3' });
  header.appendChild(el('h3', { text: `规则 ${rule.id}` }));
  header.appendChild(verdictBadge(rule.on_hit));
  card.appendChild(header);

  const grid = el('div', { className: 'detail-grid' });
  grid.appendChild(detailItem('维度', rule.dimension));
  grid.appendChild(detailItem('层级', String(rule.level)));
  grid.appendChild(detailItem('表达力', EXPRESSIVITY_LABELS[rule.expressivity] || rule.expressivity));
  grid.appendChild(detailItem('分类', POLICY_CLASS_LABELS[rule.policy_class] || rule.policy_class));
  grid.appendChild(detailItem('执行面', ENFORCEMENT_LABELS[rule.enforcement] || rule.enforcement));
  grid.appendChild(detailItem('范围', SCOPE_LABELS[rule.scope] || rule.scope));
  grid.appendChild(detailItem('属主', OWNER_LABELS[rule.owner] || rule.owner));
  grid.appendChild(detailItem('TTL', rule.ttl ? fmtDate(rule.ttl) : '无'));
  card.appendChild(grid);

  const narrative = el('div', { className: 'source-block my-3' });
  narrative.appendChild(el('dt', { text: '说明 narrative' }));
  narrative.appendChild(el('dd', { text: rule.narrative }));
  card.appendChild(narrative);

  const predSection = el('div', { className: 'card plain-card' });
  predSection.appendChild(el('h4', { text: '命中条件 predicate' }));
  if (rule.expressivity === 'advisory_only' || !rule.predicate) {
    predSection.appendChild(el('p', { className: 'subtitle', text: '本规则为建议性规则，无机械命中条件。' }));
  } else {
    const plist = el('div', { className: 'predicate-list' });
    for (const p of rule.predicate) {
      plist.appendChild(renderPredicateRead(p));
    }
    predSection.appendChild(plist);
  }
  card.appendChild(predSection);

  if (rule.source) {
    const src = el('div', { className: 'source-block' });
    src.appendChild(el('dt', { text: '来源' }));
    src.appendChild(el('dd', { text: `${rule.source.repo}@${rule.source.rev} / ${rule.source.path}` }));
    src.appendChild(el('dt', { text: '章节 / 行号' }));
    src.appendChild(el('dd', { text: `${rule.source.section} · ${rule.source.lines}` }));
    src.appendChild(el('dt', { text: '引用' }));
    src.appendChild(el('dd', { className: 'quote', text: rule.source.quote }));
    card.appendChild(src);
  }

  const probe = el('div', { className: 'source-block mt-3' });
  probe.appendChild(el('dt', { text: '攻击探测 probe' }));
  probe.appendChild(el('dd', { text: rule.probe }));
  card.appendChild(probe);

  return card;
}

function renderPredicateRead(predicate) {
  const label = PREDICATE_LABELS[predicate.op] || predicate.op;
  const argsText = formatPredicateArgs(predicate);
  const row = el('div', { className: 'predicate' });
  row.appendChild(el('div', { className: 'op', text: label }));
  row.appendChild(el('div', { className: 'args', text: argsText }));
  return row;
}

function formatPredicateArgs(predicate) {
  const args = predicate.args || {};
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (Array.isArray(v)) {
      parts.push(`${k}: [${v.join(', ')}]`);
    } else {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.join(' · ');
}

function verdictBadge(verdict) {
  const map = {
    allow: 'badge-allow',
    deny: 'badge-deny',
    confirm: 'badge-confirm',
    log: 'badge-log',
  };
  return el('span', { className: `badge ${map[verdict] || 'badge-muted'}`, text: VERDICT_LABELS[verdict] || verdict });
}

function statusBadge(status) {
  const map = {
    pending: 'badge-confirm',
    approved: 'badge-allow',
    rejected: 'badge-deny',
    withdrawn: 'badge-muted',
    expired: 'badge-muted',
  };
  return el('span', { className: `badge ${map[status] || 'badge-muted'}`, text: STATUS_LABELS[status] || status });
}

function renderEditor(parent) {
  empty(parent);
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '候选编辑' }));
  const actions = el('div', { className: 'group' });
  const validateBtn = el('button', { className: 'button button-ghost', text: '校验候选' });
  const submitBtn = el('button', { className: 'button button-primary', text: '提交提案' });
  actions.appendChild(validateBtn);
  actions.appendChild(submitBtn);
  header.appendChild(actions);
  parent.appendChild(header);

  if (!state.candidate) {
    const initCard = el('div', { className: 'card' });
    initCard.appendChild(el('h3', { text: '开始编辑候选' }));
    initCard.appendChild(el('p', { className: 'subtitle', text: '基于当前已发布策略、仓库种子或 JSON 候选开始起草。不会自动发布。' }));
    const group = el('div', { className: 'group' });
    const fromPolicyBtn = el('button', { className: 'button button-ghost', text: '从当前策略开始' });
    fromPolicyBtn.addEventListener('click', () => {
      state.candidate = candidateFromPolicy();
      state.candidateBase = cloneCandidate(state.candidate);
      state.candidateBaseVersion = currentBaseVersion();
      state.editorDirty = false;
      state.selectedRuleId = state.candidate.rules.length > 0 ? state.candidate.rules[0].id : null;
      renderEditor(parent);
    });
    const fromSeedBtn = el('button', { className: 'button button-ghost', text: '从仓库种子导入' });
    fromSeedBtn.addEventListener('click', async () => {
      try {
        const seed = await apiCall('GET', '/api/seed');
        state.candidate = cloneCandidate(seed);
        state.candidateBase = cloneCandidate(state.candidate);
        state.candidateBaseVersion = currentBaseVersion();
        state.editorDirty = false;
        state.selectedRuleId = state.candidate.rules.length > 0 ? state.candidate.rules[0].id : null;
        renderEditor(parent);
      } catch (e) {
        addMessage('error', '导入种子失败', e.code || e.message);
      }
    });
    const importLabel = el('label', { className: 'button button-ghost', text: '导入 JSON 候选', htmlFor: 'candidate-import' });
    const importInput = el('input', { className: 'hidden', props: { type: 'file', id: 'candidate-import', accept: '.json,application/json' } });
    importInput.addEventListener('change', (ev) => importCandidateFile(ev.target.files[0]));
    group.appendChild(fromPolicyBtn);
    group.appendChild(fromSeedBtn);
    group.appendChild(importLabel);
    group.appendChild(importInput);
    initCard.appendChild(group);
    parent.appendChild(initCard);
    return;
  }

  ensureCandidateActivation(state.candidate);

  const split = el('div', { className: 'split-view' });
  const left = el('div', { className: 'pane pane-narrow' });
  const right = el('div', { className: 'pane' });

  const leftHeader = el('div', { className: 'pane-header' });
  leftHeader.appendChild(el('h4', { text: '规则列表' }));
  const addBtn = el('button', { className: 'button button-small button-success', text: '添加规则' });
  addBtn.addEventListener('click', () => {
    const r = newRule();
    let suffix = 1;
    while (state.candidate.rules.some((x) => x.id === r.id)) {
      r.id = `new-rule-${suffix}`;
      suffix += 1;
    }
    state.candidate.rules.push(r);
    state.selectedRuleId = r.id;
    state.editorDirty = true;
    renderEditor(parent);
  });
  leftHeader.appendChild(addBtn);
  left.appendChild(leftHeader);

  const search = el('input', { props: { type: 'text', placeholder: '过滤规则…' } });
  left.appendChild(search);

  const list = el('div', { className: 'rule-list' });
  function renderList() {
    empty(list);
    const q = search.value.trim().toLowerCase();
    for (const r of state.candidate.rules) {
      if (q && !((r.id || '').toLowerCase().includes(q) || (r.dimension || '').toLowerCase().includes(q))) continue;
      const item = el('div', { className: `rule-list-item ${r.id === state.selectedRuleId ? 'active' : ''}` });
      const leftPart = el('div');
      leftPart.appendChild(el('div', { className: 'id', text: r.id || '（无 ID）' }));
      leftPart.appendChild(el('div', { className: 'dim', text: `${r.dimension || '—'} · ${r.on_hit || '—'}` }));
      item.appendChild(leftPart);
      const delBtn = el('button', { className: 'button button-small button-danger', text: '删除' });
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        confirmDialog(`删除规则 ${r.id || '（无 ID）'}？`, () => {
          state.candidate.rules = state.candidate.rules.filter((x) => x !== r);
          if (state.selectedRuleId === r.id) state.selectedRuleId = state.candidate.rules[0]?.id || null;
          state.editorDirty = true;
          renderEditor(parent);
        });
      });
      item.appendChild(delBtn);
      item.addEventListener('click', () => {
        state.selectedRuleId = r.id;
        renderEditor(parent);
      });
      list.appendChild(item);
    }
    if (state.candidate.rules.length === 0) {
      list.appendChild(el('div', { className: 'empty-state', text: '尚无规则' }));
    }
  }
  search.addEventListener('input', renderList);
  left.appendChild(list);
  renderList();

  const selectedRule = state.candidate.rules.find((r) => r.id === state.selectedRuleId);
  if (selectedRule) {
    right.appendChild(renderRuleForm(selectedRule, () => {
      state.editorDirty = true;
      renderList();
    }));
  } else {
    right.appendChild(el('div', { className: 'empty-state', text: '请选择或添加规则' }));
  }

  split.appendChild(left);
  split.appendChild(right);
  parent.appendChild(split);

  parent.appendChild(renderActivationEditor(state.candidate));

  const metaCard = el('div', { className: 'card' });
  metaCard.appendChild(el('h3', { text: '提案信息' }));
  const metaForm = el('form', { className: 'editor-form' });
  const titleGroup = el('div', { className: 'form-group' });
  titleGroup.appendChild(el('label', { text: '标题', htmlFor: 'proposal-title' }));
  const titleInput = el('input', { props: { type: 'text', id: 'proposal-title', required: true, value: state.pendingProposal ? state.pendingProposal.title : '' } });
  titleGroup.appendChild(titleInput);
  metaForm.appendChild(titleGroup);

  const rationaleGroup = el('div', { className: 'form-group' });
  rationaleGroup.appendChild(el('label', { text: '理由', htmlFor: 'proposal-rationale' }));
  const rationaleInput = el('textarea', { props: { id: 'proposal-rationale', rows: 3, value: state.pendingProposal ? state.pendingProposal.rationale : '' } });
  rationaleGroup.appendChild(rationaleInput);
  metaForm.appendChild(rationaleGroup);

  const baseGroup = el('div', { className: 'form-group' });
  baseGroup.appendChild(el('label', { text: '基准版本 baseVersion（起草时锁定）' }));
  const baseDisplay = el('input', { props: { type: 'text', readOnly: true, value: formatVersion(state.candidateBaseVersion) } });
  baseGroup.appendChild(baseDisplay);
  metaForm.appendChild(baseGroup);

  const expiryGroup = el('div', { className: 'form-group' });
  expiryGroup.appendChild(el('label', { text: '提案过期时间', htmlFor: 'proposal-expires' }));
  const expiryInput = el('input', { props: { type: 'datetime-local', id: 'proposal-expires', value: state.pendingProposal ? state.pendingProposal.expiresAt : '' } });
  expiryGroup.appendChild(expiryInput);
  metaForm.appendChild(expiryGroup);

  metaForm.addEventListener('submit', (ev) => ev.preventDefault());
  metaCard.appendChild(metaForm);
  parent.appendChild(metaCard);

  validateBtn.addEventListener('click', async () => {
    clearMessages();
    validateBtn.disabled = true;
    try {
      const result = await apiCall('POST', `/api/projects/${encodeURIComponent(state.selectedProjectId)}/validate`, { candidate: state.candidate });
      if (result.valid) {
        addMessage('success', '候选校验通过');
      } else {
        addMessage('warning', `候选存在 ${result.issues.length} 个问题`, result.issues.map((i) => `${i.path}: ${i.code}`).join('\n'));
      }
    } catch (e) {
      addMessage('error', '校验请求失败', e.code || e.message);
    } finally {
      validateBtn.disabled = false;
    }
  });

  submitBtn.addEventListener('click', async () => {
    clearMessages();
    const title = titleInput.value.trim();
    const rationale = rationaleInput.value.trim();
    const expiresAt = expiryInput.value ? new Date(expiryInput.value).toISOString() : null;
    if (!title) {
      addMessage('error', '请填写提案标题');
      return;
    }
    const baseVersion = state.candidateBaseVersion !== null && state.candidateBaseVersion !== undefined ? state.candidateBaseVersion : currentBaseVersion();
    state.pendingProposal = { title, rationale, baseVersion, expiresAt };

    confirmDialog('提交后提案正文不可修改。是否继续？', async () => {
      submitBtn.disabled = true;
      try {
        const candidate = cloneCandidate(state.candidate);
        ensureCandidateActivation(candidate);
        const proposal = await apiCall('POST', `/api/projects/${encodeURIComponent(state.selectedProjectId)}/proposals`, {
          title,
          rationale,
          baseVersion,
          expiresAt,
          candidate,
        });
        state.pendingProposal = null;
        state.candidate = null;
        state.candidateBase = null;
        state.candidateBaseVersion = null;
        state.editorDirty = false;
        await loadProposals(state.selectedProjectId);
        navigate('proposals', proposal.id);
      } catch (e) {
        addMessage('error', '提交提案失败', e.code || e.message);
        submitBtn.disabled = false;
      }
    });
  });
}

async function importCandidateFile(file) {
  if (!file) return;
  const text = await file.text();
  try {
    const candidate = JSON.parse(text);
    state.candidate = cloneCandidate(candidate);
    state.candidateBase = cloneCandidate(candidate);
    state.candidateBaseVersion = currentBaseVersion();
    state.editorDirty = false;
    state.selectedRuleId = state.candidate.rules.length > 0 ? state.candidate.rules[0].id : null;
    render();
  } catch (e) {
    addMessage('error', 'JSON 候选解析失败', e.message);
  }
}

function renderRuleForm(rule, onChange) {
  const form = el('form', { className: 'editor-form card' });
  form.addEventListener('submit', (ev) => ev.preventDefault());

  const top = el('div', { className: 'form-row' });
  top.appendChild(inputGroup('规则 ID', `rule-id-${rule.id}`, rule, 'id', onChange));
  top.appendChild(selectGroup('维度', `rule-dim-${rule.id}`, rule, 'dimension', [
    'credential', 'filesystem', 'network', 'side_effect', 'resource',
  ]));
  top.appendChild(numberGroup('层级', `rule-level-${rule.id}`, rule, 'level', onChange));
  form.appendChild(top);

  const meta = el('div', { className: 'form-row' });
  meta.appendChild(selectGroup('表达力', `rule-expr-${rule.id}`, rule, 'expressivity', [
    ['deterministic', '确定性'], ['advisory_only', '仅建议'],
  ]));
  meta.appendChild(selectGroup('分类', `rule-pc-${rule.id}`, rule, 'policy_class', [
    ['security', '安全'], ['engineering', '工程'],
  ]));
  meta.appendChild(selectGroup('执行面', `rule-enf-${rule.id}`, rule, 'enforcement', [
    ['runtime', '运行期'], ['ci', 'CI'], ['server', '服务端'], ['advisory', '建议'],
  ]));
  form.appendChild(meta);

  const hit = el('div', { className: 'form-row' });
  hit.appendChild(selectGroup('命中裁决', `rule-hit-${rule.id}`, rule, 'on_hit', [
    ['deny', '拒绝'], ['confirm', '需确认'], ['log', '记录'],
  ]));
  hit.appendChild(selectGroup('范围', `rule-scope-${rule.id}`, rule, 'scope', [
    ['project', '项目'], ['session', '会话'],
  ]));
  hit.appendChild(selectGroup('属主', `rule-owner-${rule.id}`, rule, 'owner', [
    ['human', '人类'], ['agent', 'Agent'],
  ]));
  hit.appendChild(inputGroup('TTL', `rule-ttl-${rule.id}`, rule, 'ttl', onChange, 'YYYY-MM-DD 或 ISO 时间，留空为无'));
  form.appendChild(hit);

  const narrativeGroup = el('div', { className: 'form-group' });
  narrativeGroup.appendChild(el('label', { text: '说明 narrative', htmlFor: `rule-narrative-${rule.id}` }));
  const narrativeInput = el('textarea', { props: { id: `rule-narrative-${rule.id}`, rows: 3, value: rule.narrative || '' } });
  narrativeInput.addEventListener('input', () => { rule.narrative = narrativeInput.value; onChange(); });
  narrativeGroup.appendChild(narrativeInput);
  form.appendChild(narrativeGroup);

  const predicateCard = el('div', { className: 'card plain-card' });
  predicateCard.appendChild(el('h4', { text: '命中条件' }));
  if (rule.expressivity === 'advisory_only') {
    predicateCard.appendChild(el('p', { className: 'subtitle', text: '建议性规则无 predicate。' }));
  } else {
    const plist = el('div', { className: 'predicate-list' });
    function renderPredicates() {
      empty(plist);
      if (!Array.isArray(rule.predicate)) rule.predicate = [];
      rule.predicate.forEach((p, idx) => {
        plist.appendChild(renderPredicateEditor(p, idx, () => { onChange(); renderPredicates(); }));
      });
      if (rule.predicate.length === 0) {
        plist.appendChild(el('div', { className: 'empty-state', text: '请添加命中条件' }));
      }
    }
    const addPredBtn = el('button', { className: 'button button-small button-success', text: '添加条件' });
    addPredBtn.addEventListener('click', () => {
      rule.predicate.push({ op: 'op_in', args: { operations: [] } });
      onChange();
      renderPredicates();
    });
    predicateCard.appendChild(addPredBtn);
    predicateCard.appendChild(plist);
    renderPredicates();
  }
  form.appendChild(predicateCard);

  const sourceCard = el('div', { className: 'card plain-card' });
  sourceCard.appendChild(el('h4', { text: '来源 source（未修改时保留）' }));
  const source = rule.source || {};
  const srcRow1 = el('div', { className: 'form-row' });
  srcRow1.appendChild(inputGroup('仓库', `src-repo-${rule.id}`, source, 'repo', onChange));
  srcRow1.appendChild(inputGroup('版本', `src-rev-${rule.id}`, source, 'rev', onChange));
  sourceCard.appendChild(srcRow1);
  const srcRow2 = el('div', { className: 'form-row' });
  srcRow2.appendChild(inputGroup('路径', `src-path-${rule.id}`, source, 'path', onChange));
  srcRow2.appendChild(inputGroup('章节', `src-section-${rule.id}`, source, 'section', onChange));
  sourceCard.appendChild(srcRow2);
  const srcRow3 = el('div', { className: 'form-row' });
  srcRow3.appendChild(inputGroup('行号', `src-lines-${rule.id}`, source, 'lines', onChange));
  sourceCard.appendChild(srcRow3);
  const quoteGroup = el('div', { className: 'form-group' });
  quoteGroup.appendChild(el('label', { text: '引用 quote', htmlFor: `src-quote-${rule.id}` }));
  const quoteInput = el('textarea', { props: { id: `src-quote-${rule.id}`, rows: 3, value: source.quote || '' } });
  quoteInput.addEventListener('input', () => { source.quote = quoteInput.value; rule.source = source; onChange(); });
  quoteGroup.appendChild(quoteInput);
  sourceCard.appendChild(quoteGroup);
  form.appendChild(sourceCard);

  const probeGroup = el('div', { className: 'form-group' });
  probeGroup.appendChild(el('label', { text: '攻击探测 probe', htmlFor: `rule-probe-${rule.id}` }));
  const probeInput = el('textarea', { props: { id: `rule-probe-${rule.id}`, rows: 2, value: rule.probe || '' } });
  probeInput.addEventListener('input', () => { rule.probe = probeInput.value; onChange(); });
  probeGroup.appendChild(probeInput);
  form.appendChild(probeGroup);

  return form;
}

function inputGroup(label, id, obj, key, onChange, hint) {
  const group = el('div', { className: 'form-group' });
  group.appendChild(el('label', { text: label, htmlFor: id }));
  const input = el('input', { props: { type: 'text', id, value: obj[key] || '' } });
  input.addEventListener('input', () => { obj[key] = input.value || null; onChange(); });
  group.appendChild(input);
  if (hint) group.appendChild(el('span', { className: 'hint', text: hint }));
  return group;
}

function numberGroup(label, id, obj, key, onChange) {
  const group = el('div', { className: 'form-group' });
  group.appendChild(el('label', { text: label, htmlFor: id }));
  const input = el('input', { props: { type: 'number', id, min: 0, step: 1, value: obj[key] } });
  input.addEventListener('input', () => { obj[key] = Number(input.value) || 0; onChange(); });
  group.appendChild(input);
  return group;
}

function selectGroup(label, id, obj, key, options) {
  const group = el('div', { className: 'form-group' });
  group.appendChild(el('label', { text: label, htmlFor: id }));
  const select = el('select', { props: { id } });
  for (const opt of options) {
    const [value, text] = Array.isArray(opt) ? opt : [opt, opt];
    select.appendChild(el('option', { props: { value, selected: obj[key] === value }, text }));
  }
  select.addEventListener('change', () => { obj[key] = select.value; });
  group.appendChild(select);
  return group;
}

function renderPredicateEditor(predicate, index, onChange) {
  const row = el('div', { className: 'predicate' });
  const header = el('div', { className: 'form-row form-row-compact' });

  const opGroup = el('div', { className: 'form-group form-group-narrow' });
  opGroup.appendChild(el('label', { text: '操作符' }));
  const opSelect = el('select');
  for (const op of Object.keys(PREDICATE_LABELS)) {
    opSelect.appendChild(el('option', { props: { value: op, selected: predicate.op === op }, text: PREDICATE_LABELS[op] }));
  }
  opSelect.addEventListener('change', () => {
    predicate.op = opSelect.value;
    predicate.args = defaultArgsForOp(predicate.op);
    onChange();
  });
  opGroup.appendChild(opSelect);
  header.appendChild(opGroup);

  const removeBtn = el('button', { className: 'button button-small button-danger', text: '删除条件' });
  removeBtn.addEventListener('click', () => {
    const rule = state.candidate.rules.find((r) => r.id === state.selectedRuleId);
    if (rule && Array.isArray(rule.predicate)) {
      rule.predicate.splice(index, 1);
      onChange();
    }
  });
  header.appendChild(removeBtn);
  row.appendChild(header);

  const argsEditor = el('div');
  renderArgsEditor(argsEditor, predicate, onChange);
  row.appendChild(argsEditor);
  return row;
}

function defaultArgsForOp(op) {
  const map = {
    op_in: { operations: [] },
    target_glob: { patterns: [] },
    target_outside_glob: { patterns: [] },
    url_query_key_in: { keys: [] },
    target_scheme_in: { schemes: [] },
    target_host_in: { hosts: [] },
    target_host_not_in: { hosts: [] },
  };
  return map[op] || {};
}

function renderArgsEditor(container, predicate, onChange) {
  empty(container);
  const op = predicate.op;
  const args = predicate.args || {};
  let key = null;
  let label = '';
  if (op === 'op_in') { key = 'operations'; label = '操作列表'; }
  else if (op === 'target_glob' || op === 'target_outside_glob') { key = 'patterns'; label = '模式列表'; }
  else if (op === 'url_query_key_in') { key = 'keys'; label = '查询键'; }
  else if (op === 'target_scheme_in') { key = 'schemes'; label = '协议'; }
  else if (op === 'target_host_in' || op === 'target_host_not_in') { key = 'hosts'; label = '主机'; }
  if (!key) return;
  const arr = Array.isArray(args[key]) ? args[key] : [];
  args[key] = arr;
  container.appendChild(el('label', { text: label }));
  const list = el('div', { className: 'field-array' });
  function renderItems() {
    empty(list);
    arr.forEach((val, i) => {
      const item = el('div', { className: 'array-item' });
      const input = el('input', { props: { type: 'text', value: val } });
      input.addEventListener('input', () => { arr[i] = input.value; onChange(); });
      item.appendChild(input);
      const del = el('button', { className: 'button button-small button-danger', text: '删除' });
      del.addEventListener('click', () => { arr.splice(i, 1); renderItems(); onChange(); });
      item.appendChild(del);
      list.appendChild(item);
    });
  }
  renderItems();
  container.appendChild(list);
  const add = el('button', { className: 'button button-small button-ghost', text: '添加项' });
  add.addEventListener('click', () => { arr.push(''); renderItems(); onChange(); });
  container.appendChild(add);
}

function renderActivationEditor(candidate) {
  ensureCandidateActivation(candidate);
  const card = el('div', { className: 'card' });
  card.appendChild(el('h3', { text: '项目激活策略' }));
  const all = candidate.activation.includedRuleIds === null;
  const allCheck = el('input', { props: { type: 'checkbox', id: 'activation-all', checked: all } });
  allCheck.addEventListener('change', () => {
    candidate.activation.includedRuleIds = allCheck.checked ? null : [];
    render();
  });
  const allLabel = el('label', { text: ' 包含全部规则', htmlFor: 'activation-all' });
  allLabel.prepend(allCheck);
  card.appendChild(allLabel);

  const incList = el('div', { className: 'field-array mt-2' });
  if (!all) {
    incList.appendChild(el('label', { text: '显式包含规则' }));
    for (const r of candidate.rules) {
      const checked = (candidate.activation.includedRuleIds || []).includes(r.id);
      const check = el('input', { props: { type: 'checkbox', checked } });
      check.addEventListener('change', () => {
        const set = new Set(candidate.activation.includedRuleIds || []);
        if (check.checked) set.add(r.id); else set.delete(r.id);
        candidate.activation.includedRuleIds = Array.from(set);
      });
      const lbl = el('label', { text: ` ${r.id || '（无 ID）'}`, htmlFor: `inc-${r.id}` });
      lbl.prepend(check);
      incList.appendChild(lbl);
    }
  }
  card.appendChild(incList);

  const exList = el('div', { className: 'field-array mt-2' });
  exList.appendChild(el('label', { text: '排除规则' }));
  for (const r of candidate.rules) {
    const checked = candidate.activation.excludedRuleIds.includes(r.id);
    const check = el('input', { props: { type: 'checkbox', checked } });
    check.addEventListener('change', () => {
      const set = new Set(candidate.activation.excludedRuleIds);
      if (check.checked) set.add(r.id); else set.delete(r.id);
      candidate.activation.excludedRuleIds = Array.from(set);
    });
    const lbl = el('label', { text: ` ${r.id || '（无 ID）'}`, htmlFor: `ex-${r.id}` });
    lbl.prepend(check);
    exList.appendChild(lbl);
  }
  card.appendChild(exList);
  return card;
}

function renderProposals(parent) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '提案' }));
  header.appendChild(el('button', { className: 'button button-primary', text: '新建提案', events: { click: () => navigate('editor') } }));
  parent.appendChild(header);

  if (state.proposals.length === 0) {
    parent.appendChild(el('div', { className: 'empty-state', children: [
      el('h3', { text: '暂无提案' }),
      el('p', { text: '在候选编辑器中起草并提交第一个提案。' }),
    ] }));
    return;
  }

  const tableWrap = el('div', { className: 'table-wrap' });
  const table = el('table');
  const thead = el('thead');
  thead.appendChild(el('tr', { children: [
    el('th', { text: '标题' }), el('th', { text: '状态' }), el('th', { text: '作者' }),
    el('th', { text: '基准版本' }), el('th', { text: '提交时间' }), el('th', { text: '过期时间' }), el('th', { text: '发布版本' }),
  ] }));
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const p of state.proposals.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
    const stale = isStaleProposal(p);
    const tr = el('tr');
    tr.appendChild(el('td', { children: [el('a', { props: { href: `#proposals/${p.id}` }, text: p.title })] }));
    const statusCell = el('td');
    statusCell.appendChild(statusBadge(p.status));
    if (stale) statusCell.appendChild(el('span', { className: 'badge badge-stage', text: '基准已过期' }));
    tr.appendChild(statusCell);
    tr.appendChild(el('td', { text: fmtActor(p.author) }));
    tr.appendChild(el('td', { text: p.baseVersion === null ? 'null' : String(p.baseVersion) }));
    tr.appendChild(el('td', { text: fmtDate(p.createdAt) }));
    tr.appendChild(el('td', { text: p.expiresAt ? fmtDate(p.expiresAt) : '无' }));
    tr.appendChild(el('td', { text: p.publishedVersion === null ? '—' : String(p.publishedVersion) }));
    tr.addEventListener('click', () => navigate('proposals', p.id));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  parent.appendChild(tableWrap);
}

async function renderProposalDetail(parent, proposalId) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '提案详情' }));
  header.appendChild(el('button', { className: 'button button-ghost', text: '返回列表', events: { click: () => navigate('proposals') } }));
  parent.appendChild(header);

  let proposal = state.proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    parent.appendChild(el('div', { className: 'loading', children: [el('div', { className: 'spinner' }), el('span', { text: '加载提案…' })] }));
    try {
      proposal = await loadProposal(proposalId);
    } catch (e) {
      empty(parent);
      parent.appendChild(el('div', { className: 'message message-error', text: `加载提案失败：${e.code || e.message}` }));
      return;
    }
  }

  empty(parent);
  parent.appendChild(header);

  const metaCard = el('div', { className: 'card' });
  metaCard.appendChild(el('h3', { text: proposal.title }));
  const grid = el('div', { className: 'detail-grid' });
  grid.appendChild(detailItem('ID', proposal.id));
  grid.appendChild(detailItem('状态', ''));
  const statusCell = el('dd');
  statusCell.appendChild(statusBadge(proposal.status));
  if (isStaleProposal(proposal)) statusCell.appendChild(el('span', { className: 'badge badge-stage', text: '基准已过期' }));
  grid.lastChild.appendChild(statusCell);
  grid.appendChild(detailItem('作者', fmtActor(proposal.author)));
  grid.appendChild(detailItem('基准版本', proposal.baseVersion === null ? 'null' : String(proposal.baseVersion)));
  grid.appendChild(detailItem('摘要 digest', shortDigest(proposal.digest)));
  grid.appendChild(detailItem('提交时间', fmtDate(proposal.createdAt)));
  grid.appendChild(detailItem('过期时间', proposal.expiresAt ? fmtDate(proposal.expiresAt) : '无'));
  if (proposal.publishedVersion !== null) grid.appendChild(detailItem('发布版本', String(proposal.publishedVersion)));
  metaCard.appendChild(grid);

  if (proposal.rationale) {
    metaCard.appendChild(el('h4', { text: '理由' }));
    metaCard.appendChild(el('p', { text: proposal.rationale }));
  }

  if (proposal.decision) {
    metaCard.appendChild(el('h4', { text: '审批决定' }));
    metaCard.appendChild(el('p', { text: `${proposal.decision.decision === 'approve' ? '批准' : '拒绝'} · ${fmtActor(proposal.decision.actor)} · ${fmtDate(proposal.decision.decidedAt)}` }));
    if (proposal.decision.note) {
      metaCard.appendChild(el('p', { className: 'subtitle', text: `备注：${proposal.decision.note}` }));
    }
  }
  parent.appendChild(metaCard);

  const baseCandidate = state.policy ? state.policy.candidate : emptyCandidate();
  const diff = diffCandidates(baseCandidate, proposal.candidate);
  parent.appendChild(renderDiffCard(diff, '当前已发布策略', '提案候选'));

  if (proposal.status === 'pending') {
    const actionCard = el('div', { className: 'card' });
    actionCard.appendChild(el('h3', { text: '审批操作' }));
    actionCard.appendChild(el('p', { className: 'subtitle', text: '治理审批：决定该规则候选是否发布为新版本。这不授权任何工具调用执行。' }));
    if (state.session.role === 'agent') {
      actionCard.appendChild(el('div', { className: 'message message-warning', text: 'Agent 身份不能审批提案。' }));
    } else {
      const noteGroup = el('div', { className: 'form-group' });
      noteGroup.appendChild(el('label', { text: '审批备注', htmlFor: 'decision-note' }));
      const noteInput = el('textarea', { props: { id: 'decision-note', rows: 2 } });
      noteGroup.appendChild(noteInput);
      actionCard.appendChild(noteGroup);
      const btnGroup = el('div', { className: 'group' });
      const stale = isStaleProposal(proposal);
      const approveBtn = el('button', { className: 'button button-success', text: '批准并发布', props: { disabled: stale } });
      const rejectBtn = el('button', { className: 'button button-danger', text: '拒绝' });
      const withdrawBtn = el('button', { className: 'button button-ghost', text: '撤回' });
      if (stale) {
        actionCard.appendChild(el('div', { className: 'message message-warning', text: '该提案的基准版本已过期，不能批准。请基于当前策略创建新提案。' }));
      }

      async function decide(decision) {
        clearMessages();
        const note = noteInput.value.trim();
        try {
          await apiCall('POST', `/api/proposals/${encodeURIComponent(proposal.id)}/decision`, {
            decision,
            note,
            expectedDigest: proposal.digest,
          });
          await loadProposals(state.selectedProjectId);
          await loadProjectData(state.selectedProjectId);
          render();
        } catch (e) {
          addMessage('error', '审批操作失败', e.code || e.message);
        }
      }

      approveBtn.addEventListener('click', () => {
        confirmDialog('批准后将以该候选创建新的已发布版本。是否继续？', () => decide('approve'));
      });
      rejectBtn.addEventListener('click', () => decide('reject'));
      withdrawBtn.addEventListener('click', () => {
        confirmDialog('撤回后提案将标记为 withdrawn，不可恢复。是否继续？', async () => {
          try {
            await apiCall('POST', `/api/proposals/${encodeURIComponent(proposal.id)}/withdraw`, {});
            await loadProposals(state.selectedProjectId);
            render();
          } catch (e) {
            addMessage('error', '撤回失败', e.code || e.message);
          }
        });
      });

      btnGroup.appendChild(approveBtn);
      btnGroup.appendChild(rejectBtn);
      btnGroup.appendChild(withdrawBtn);
      actionCard.appendChild(btnGroup);
    }
    parent.appendChild(actionCard);
  }
}

function renderDiffCard(diff, leftLabel, rightLabel) {
  const card = el('div', { className: 'card' });
  card.appendChild(el('h3', { text: '字段差异' }));
  if (diff.rules.length === 0 && !diff.activationChanged) {
    card.appendChild(el('div', { className: 'empty-state', text: '候选与基准完全相同' }));
    return card;
  }

  const diffWrap = el('div', { className: 'diff' });
  if (diff.activationChanged) {
    diffWrap.appendChild(renderActivationDiff(diff.activation, leftLabel, rightLabel));
  }
  for (const item of diff.rules) {
    diffWrap.appendChild(renderRuleDiff(item, leftLabel, rightLabel));
  }
  card.appendChild(diffWrap);
  return card;
}

function renderActivationDiff(activation, leftLabel, rightLabel) {
  const ruleDiv = el('div', { className: 'diff-rule' });
  ruleDiv.appendChild(el('div', { className: 'header', children: [
    el('span', { className: 'action modified', text: '变更' }),
    el('span', { text: '激活策略' }),
  ] }));

  function addField(name, oldText, newText) {
    ruleDiv.appendChild(el('div', { className: 'diff-field', children: [
      el('div', { className: 'name', text: name }),
      el('div', { className: 'value old', text: oldText }),
      el('div', { className: 'value new', text: newText }),
    ] }));
  }

  const beforeInc = activation.before.includedRuleIds;
  const afterInc = activation.after.includedRuleIds;
  if (JSON.stringify(beforeInc) !== JSON.stringify(afterInc)) {
    if (beforeInc === null && Array.isArray(afterInc)) {
      addField('包含规则', `${leftLabel}: 全部`, `${rightLabel}: 显式包含 [${afterInc.join(', ')}]`);
    } else if (Array.isArray(beforeInc) && afterInc === null) {
      addField('包含规则', `${leftLabel}: 显式包含 [${beforeInc.join(', ')}]`, `${rightLabel}: 全部`);
    } else {
      const incDiff = setDiff(beforeInc || [], afterInc || []);
      addField('包含规则新增', '', incDiff.added.join(', ') || '—');
      addField('包含规则移除', '', incDiff.removed.join(', ') || '—');
    }
  }

  const beforeEx = activation.before.excludedRuleIds || [];
  const afterEx = activation.after.excludedRuleIds || [];
  const exDiff = setDiff(beforeEx, afterEx);
  if (exDiff.added.length > 0 || exDiff.removed.length > 0) {
    addField('排除规则新增', '', exDiff.added.join(', ') || '—');
    addField('排除规则移除', '', exDiff.removed.join(', ') || '—');
  }

  return ruleDiv;
}

function renderRuleDiff(item, leftLabel, rightLabel) {
  const ruleDiv = el('div', { className: 'diff-rule' });
  const actionClass = item.type === 'added' ? 'added' : item.type === 'removed' ? 'removed' : 'modified';
  const actionText = item.type === 'added' ? '新增' : item.type === 'removed' ? '删除' : '修改';
  ruleDiv.appendChild(el('div', { className: 'header', children: [
    el('span', { className: `action ${actionClass}`, text: actionText }),
    el('span', { text: item.id }),
  ] }));

  if (item.type === 'added') {
    ruleDiv.appendChild(el('div', { className: 'diff-field', children: [
      el('div', { className: 'name', text: '完整规则' }),
      el('div', { className: 'value old', text: '（无）' }),
      el('div', { className: 'value new', text: JSON.stringify(item.after, null, 2) }),
    ] }));
  } else if (item.type === 'removed') {
    ruleDiv.appendChild(el('div', { className: 'diff-field', children: [
      el('div', { className: 'name', text: '完整规则' }),
      el('div', { className: 'value old', text: JSON.stringify(item.before, null, 2) }),
      el('div', { className: 'value new', text: '（无）' }),
    ] }));
  } else {
    const fields = new Set([...Object.keys(item.before || {}), ...Object.keys(item.after || {})]);
    for (const f of fields) {
      const oldVal = item.before ? item.before[f] : undefined;
      const newVal = item.after ? item.after[f] : undefined;
      if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue;
      ruleDiv.appendChild(el('div', { className: 'diff-field', children: [
        el('div', { className: 'name', text: f }),
        el('div', { className: 'value old', text: formatDiffValue(oldVal) }),
        el('div', { className: 'value new', text: formatDiffValue(newVal) }),
      ] }));
    }
  }
  return ruleDiv;
}

function formatDiffValue(v) {
  if (v === undefined) return '（无）';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

function renderVersions(parent) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '版本历史' }));
  parent.appendChild(header);

  if (state.versions.length === 0) {
    parent.appendChild(el('div', { className: 'empty-state', children: [
      el('h3', { text: '尚无已发布版本' }),
      el('p', { text: '审批通过提案后将生成第一个版本。' }),
    ] }));
    return;
  }

  const tableWrap = el('div', { className: 'table-wrap' });
  const table = el('table');
  const thead = el('thead');
  thead.appendChild(el('tr', { children: [
    el('th', { text: '版本' }), el('th', { text: '提案' }), el('th', { text: '上一版本' }),
    el('th', { text: '发布时间' }), el('th', { text: '审批人' }), el('th', { text: '规则数' }),
  ] }));
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const v of state.versions.slice().sort((a, b) => b.version - a.version)) {
    const tr = el('tr');
    tr.appendChild(el('td', { children: [el('a', { props: { href: `#versions/${v.version}` }, text: String(v.version) })] }));
    tr.appendChild(el('td', { text: v.proposalId }));
    tr.appendChild(el('td', { text: v.previousVersion === null ? '—' : String(v.previousVersion) }));
    tr.appendChild(el('td', { text: fmtDate(v.createdAt) }));
    tr.appendChild(el('td', { text: fmtActor(v.approvedBy) }));
    tr.appendChild(el('td', { text: String((v.candidate && v.candidate.rules) ? v.candidate.rules.length : 0) }));
    tr.addEventListener('click', () => navigate('versions', String(v.version)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  parent.appendChild(tableWrap);
}

async function renderVersionDetail(parent, versionNumber) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: `版本 ${versionNumber}` }));
  header.appendChild(el('button', { className: 'button button-ghost', text: '返回列表', events: { click: () => navigate('versions') } }));
  parent.appendChild(header);

  const version = state.versions.find((v) => String(v.version) === versionNumber);
  if (!version) {
    parent.appendChild(el('div', { className: 'message message-error', text: '未找到该版本' }));
    return;
  }

  const metaCard = el('div', { className: 'card' });
  metaCard.appendChild(el('h3', { text: `版本 ${version.version}` }));
  const grid = el('div', { className: 'detail-grid' });
  grid.appendChild(detailItem('提案', version.proposalId));
  grid.appendChild(detailItem('上一版本', version.previousVersion === null ? '—' : String(version.previousVersion)));
  grid.appendChild(detailItem('发布时间', fmtDate(version.createdAt)));
  grid.appendChild(detailItem('审批人', fmtActor(version.approvedBy)));
  grid.appendChild(detailItem('规则数', String((version.candidate && version.candidate.rules) ? version.candidate.rules.length : 0)));
  grid.appendChild(detailItem('激活策略', activationLabel(version.candidate)));
  if (version.snapshot) {
    grid.appendChild(detailItem('enforcement digest', shortDigest(snapshotDigest(version.snapshot, 'enforcement'))));
    grid.appendChild(detailItem('advisory digest', shortDigest(snapshotDigest(version.snapshot, 'advisory'))));
    grid.appendChild(detailItem('快照 digest', shortDigest(snapshotDigest(version.snapshot, 'combined'))));
  }
  metaCard.appendChild(grid);

  const actions = el('div', { className: 'toolbar mt-3' });
  const yamlBtn = el('button', { className: 'button button-ghost button-small', text: '下载 YAML' });
  const jsonBtn = el('button', { className: 'button button-ghost button-small', text: '下载 JSON' });
  const rollbackBtn = el('button', { className: 'button button-primary button-small', text: '基于此版本回滚' });

  yamlBtn.addEventListener('click', () => downloadExport(versionNumber, 'yaml', `version-${versionNumber}.yaml`));
  jsonBtn.addEventListener('click', () => downloadExport(versionNumber, 'json', `version-${versionNumber}.json`));
  rollbackBtn.addEventListener('click', () => {
    if (state.session.role === 'agent') {
      addMessage('error', 'Agent 不能创建回滚提案');
      return;
    }
    showRollbackForm(version.version);
  });

  actions.appendChild(yamlBtn);
  actions.appendChild(jsonBtn);
  actions.appendChild(rollbackBtn);
  metaCard.appendChild(actions);
  parent.appendChild(metaCard);

  const rulesCard = el('div', { className: 'card' });
  rulesCard.appendChild(el('h3', { text: '包含规则' }));
  const list = el('div', { className: 'rule-list' });
  for (const r of (version.candidate && version.candidate.rules) || []) {
    const item = el('div', { className: 'rule-list-item' });
    item.appendChild(el('div', { className: 'id', text: r.id }));
    item.appendChild(el('div', { className: 'dim', text: `${r.dimension} · ${r.on_hit}` }));
    item.addEventListener('click', () => {
      rulesCard.nextElementSibling?.remove();
      const detail = el('div', { className: 'card' });
      detail.appendChild(renderRuleDetailCard(r));
      parent.appendChild(detail);
    });
    list.appendChild(item);
  }
  rulesCard.appendChild(list);
  parent.appendChild(rulesCard);
}

async function downloadExport(versionNumber, format, filename) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/versions/${encodeURIComponent(versionNumber)}/export?format=${format}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { attrs: { href: url, download: filename } });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    addMessage('error', '下载失败', e.message);
  }
}

function showRollbackForm(version) {
  const existing = $('#rollback-form-card');
  if (existing) existing.remove();

  const card = el('div', { className: 'card', attrs: { id: 'rollback-form-card' } });
  card.appendChild(el('h3', { text: `基于版本 ${version} 创建回滚提案` }));
  card.appendChild(el('p', { className: 'subtitle', text: '回滚会生成新提案，经审批后创建递增新版本，不会把当前指针移回旧版本。' }));
  const form = el('form', { className: 'editor-form' });
  const titleGroup = el('div', { className: 'form-group' });
  titleGroup.appendChild(el('label', { text: '标题', htmlFor: 'rollback-title' }));
  const titleInput = el('input', { props: { type: 'text', id: 'rollback-title', required: true, value: `回滚到版本 ${version}` } });
  titleGroup.appendChild(titleInput);
  form.appendChild(titleGroup);

  const rationaleGroup = el('div', { className: 'form-group' });
  rationaleGroup.appendChild(el('label', { text: '理由', htmlFor: 'rollback-rationale' }));
  const rationaleInput = el('textarea', { props: { id: 'rollback-rationale', rows: 3 } });
  rationaleGroup.appendChild(rationaleInput);
  form.appendChild(rationaleGroup);

  const expiryGroup = el('div', { className: 'form-group' });
  expiryGroup.appendChild(el('label', { text: '提案过期时间', htmlFor: 'rollback-expires' }));
  const expiryInput = el('input', { props: { type: 'datetime-local', id: 'rollback-expires' } });
  expiryGroup.appendChild(expiryInput);
  form.appendChild(expiryGroup);

  const submit = el('button', { className: 'button button-primary', props: { type: 'submit' }, text: '创建回滚提案' });
  form.appendChild(submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      const proposal = await apiCall('POST', `/api/projects/${encodeURIComponent(state.selectedProjectId)}/versions/${encodeURIComponent(version)}/restore`, {
        title: titleInput.value.trim(),
        rationale: rationaleInput.value.trim(),
        baseVersion: currentBaseVersion(),
        expiresAt: expiryInput.value ? new Date(expiryInput.value).toISOString() : null,
      });
      await loadProposals(state.selectedProjectId);
      navigate('proposals', proposal.id);
    } catch (e) {
      addMessage('error', '创建回滚提案失败', e.code || e.message);
      submit.disabled = false;
    }
  });
  card.appendChild(form);
  $('#page-content').appendChild(card);
  titleInput.focus();
}

async function renderAudit(parent) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '治理审计' }));
  header.appendChild(el('button', { className: 'button button-ghost', text: '刷新', events: { click: async () => { state.audit.items = []; state.audit.nextCursor = null; await loadAudit(); render(); } } }));
  parent.appendChild(header);

  if (state.audit.items.length === 0 && !state.audit.loading) {
    await loadAudit();
  }

  if (state.audit.items.length === 0) {
    parent.appendChild(el('div', { className: 'empty-state', children: [
      el('h3', { text: '暂无审计事件' }),
      el('p', { text: '治理操作（创建项目、提交提案、审批、撤回、发布）将记录在此。' }),
    ] }));
    return;
  }

  const list = el('div', { className: 'card' });
  for (const ev of state.audit.items) {
    const item = el('div', { className: 'audit-item' });
    const meta = el('div', { className: 'meta' });
    meta.appendChild(el('span', { text: fmtDate(ev.createdAt) }));
    meta.appendChild(el('span', { className: 'badge badge-muted', text: ev.kind }));
    meta.appendChild(el('span', { text: fmtActor(ev.actor) }));
    if (ev.projectId) meta.appendChild(el('span', { text: `项目 ${ev.projectId}` }));
    if (ev.proposalId) meta.appendChild(el('span', { text: `提案 ${ev.proposalId}` }));
    if (ev.version !== null && ev.version !== undefined) meta.appendChild(el('span', { text: `版本 ${ev.version}` }));
    item.appendChild(meta);
    if (ev.metadata && Object.keys(ev.metadata).length > 0) {
      item.appendChild(el('pre', { text: JSON.stringify(ev.metadata, null, 2) }));
    }
    list.appendChild(item);
  }
  parent.appendChild(list);

  const pag = el('div', { className: 'pagination' });
  pag.appendChild(el('span', { className: 'subtitle', text: `共 ${state.audit.items.length} 条` }));
  if (state.audit.nextCursor) {
    const nextBtn = el('button', { className: 'button button-ghost', text: '下一页' });
    nextBtn.addEventListener('click', async () => {
      await loadAudit(state.audit.nextCursor);
      render();
    });
    pag.appendChild(nextBtn);
  }
  parent.appendChild(pag);
}

async function renderObservations(parent) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '观察日志' }));
  header.appendChild(el('div', { className: 'subtitle', text: '来自启动期审计管道的原始观察记录（Stage A，不构成治理事件）。' }));
  parent.appendChild(header);

  if (!state.observations.loading && !state.observations.error && state.observations.sources.length === 0 && state.observations.queue.length === 0) {
    await loadObservations();
  }

  if (state.observations.loading) {
    parent.appendChild(el('div', { className: 'loading', children: [el('div', { className: 'spinner' }), el('span', { text: '加载观察日志…' })] }));
    return;
  }

  if (state.observations.error || !state.observations.available) {
    parent.appendChild(el('div', { className: 'message message-info', text: '观察日志当前不可用。需要后端在启动时配置并写入日志源；未配置时不伪造记录。' }));
    return;
  }

  const sourcesCard = el('div', { className: 'card' });
  sourcesCard.appendChild(el('h3', { text: '日志源' }));
  if (state.observations.sources.length === 0) {
    sourcesCard.appendChild(el('p', { className: 'subtitle', text: '无已配置源' }));
  } else {
    const ul = el('ul');
    for (const s of state.observations.sources) {
      ul.appendChild(el('li', { text: typeof s === 'string' ? s : JSON.stringify(s) }));
    }
    sourcesCard.appendChild(ul);
  }
  parent.appendChild(sourcesCard);

  const queueCard = el('div', { className: 'card' });
  queueCard.appendChild(el('h3', { text: '待审队列' }));
  if (state.observations.queue.length === 0) {
    queueCard.appendChild(el('div', { className: 'empty-state', text: '队列中没有待审观察记录。' }));
  } else {
    for (const rec of state.observations.queue) {
      const item = el('div', { className: 'audit-item' });
      item.appendChild(el('pre', { text: JSON.stringify(rec, null, 2) }));
      queueCard.appendChild(item);
    }
  }
  parent.appendChild(queueCard);
}

function renderSimulate(parent) {
  const header = el('div', { className: 'page-header' });
  header.appendChild(el('h2', { text: '动作模拟' }));
  header.appendChild(el('div', { className: 'subtitle', text: '观察引擎会如何裁决一个动作。不保存、不执行。' }));
  parent.appendChild(header);

  if (!state.policy) {
    parent.appendChild(el('div', { className: 'message message-warning', text: '当前项目尚无已发布策略，无法模拟。' }));
    return;
  }

  const formCard = el('div', { className: 'card' });
  const form = el('form', { className: 'editor-form' });
  const row = el('div', { className: 'form-row' });
  row.appendChild(inputGroup('工具 tool', 'sim-tool', { tool: 'fs' }, 'tool', () => {}));
  row.appendChild(inputGroup('操作 operation', 'sim-op', { operation: 'file_read' }, 'operation', () => {}));
  row.appendChild(inputGroup('目标 target', 'sim-target', { target: '/home/user/projects/example/file.ts' }, 'target', () => {}));
  form.appendChild(row);

  const versionGroup = el('div', { className: 'form-group' });
  versionGroup.appendChild(el('label', { text: '指定版本（留空使用当前）', htmlFor: 'sim-version' }));
  const versionSelect = el('select', { props: { id: 'sim-version' } });
  versionSelect.appendChild(el('option', { props: { value: '' }, text: '当前已发布版本' }));
  for (const v of state.versions) {
    versionSelect.appendChild(el('option', { props: { value: String(v.version) }, text: `版本 ${v.version}` }));
  }
  versionGroup.appendChild(versionSelect);
  form.appendChild(versionGroup);

  const submit = el('button', { className: 'button button-primary', props: { type: 'submit' }, text: '模拟裁决' });
  form.appendChild(submit);
  formCard.appendChild(form);
  parent.appendChild(formCard);

  const resultCard = el('div', { className: 'card', attrs: { id: 'sim-result' } });
  resultCard.appendChild(el('h3', { text: '模拟结果' }));
  resultCard.appendChild(el('div', { className: 'empty-state', text: '提交后显示假设裁决' }));
  parent.appendChild(resultCard);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearMessages();
    submit.disabled = true;
    const tool = $('#sim-tool').value;
    const operation = $('#sim-op').value;
    const target = $('#sim-target').value;
    const version = versionSelect.value ? Number(versionSelect.value) : undefined;
    try {
      const result = await apiCall('POST', `/api/projects/${encodeURIComponent(state.selectedProjectId)}/simulate`, {
        action: { tool, operation, target },
        version,
      });
      const box = $('#sim-result');
      empty(box);
      box.appendChild(el('h3', { text: '模拟结果' }));
      const grid = el('div', { className: 'detail-grid' });
      grid.appendChild(detailItem('裁决', result.verdict));
      grid.appendChild(detailItem('决策类型', DECISION_KIND_LABELS[result.decision] || result.decision));
      grid.appendChild(detailItem('命中规则', (result.matched_rule_ids || []).join(', ') || '—'));
      if (result.error) grid.appendChild(detailItem('错误', result.error));
      box.appendChild(grid);
      if (result.matched_rules && result.matched_rules.length > 0) {
        const list = el('div', { className: 'predicate-list' });
        for (const mr of result.matched_rules) {
          list.appendChild(el('div', { className: 'predicate', children: [
            el('div', { className: 'op', text: `${mr.id} · ${mr.dimension} · level ${mr.level}` }),
            el('div', { className: 'args', text: `${POLICY_CLASS_LABELS[mr.policy_class]} / ${ENFORCEMENT_LABELS[mr.enforcement]} / 命中 ${VERDICT_LABELS[mr.on_hit]}` }),
          ] }));
        }
        box.appendChild(list);
      }
    } catch (e) {
      addMessage('error', '模拟失败', e.code || e.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function confirmDialog(message, onConfirm) {
  const existing = $('#confirm-dialog');
  if (existing) existing.remove();

  const overlay = el('div', { className: 'dialog-overlay', attrs: { id: 'confirm-dialog', role: 'dialog', 'aria-modal': 'true' } });
  const dialog = el('div', { className: 'dialog' });
  dialog.appendChild(el('header', { children: [el('h3', { text: '请确认' })] }));
  dialog.appendChild(el('div', { className: 'body', text: message }));
  const footer = el('div', { className: 'footer' });
  const cancel = el('button', { className: 'button button-ghost', text: '取消' });
  const ok = el('button', { className: 'button button-danger', text: '确认' });
  cancel.addEventListener('click', close);
  ok.addEventListener('click', () => { close(); onConfirm(); });
  footer.appendChild(cancel);
  footer.appendChild(ok);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  ok.focus();

  function close() {
    overlay.remove();
    if (document.body.contains($('#page-content'))) $('#page-content').focus();
  }
}

async function loadInitialData() {
  await Promise.all([loadStatus(), loadProjects()]);
  if (state.selectedProjectId) {
    await loadProjectData(state.selectedProjectId);
  }
}

async function init() {
  try {
    await loadSession();
    if (state.session && state.session.authenticated) {
      await loadInitialData();
    }
  } catch (e) {
    addMessage('error', '初始化失败', e.code || e.message);
  }
  const r = parseHash();
  state.view = r.view;
  state.viewParam = r.param;
  render();

  window.addEventListener('hashchange', () => {
    const nr = parseHash();
    state.view = nr.view;
    state.viewParam = nr.param;
    render();
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

export { emptyCandidate, fmtDate, shortDigest, parseHash, activationLabel, formatVersion };
