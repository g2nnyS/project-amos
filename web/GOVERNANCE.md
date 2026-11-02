# Amos actual-project UI integration contract

The user clarified that Neuralyn was a **visual reference**, not a second
analytics product. This folder is now the Amos governance frontend. Retain the
monochrome surfaces, Inter typography, compact hierarchy, responsive shell,
light/dark/system preference, accessible controls and restrained transitions.
Remove SaaS analytics, revenue/billing, audience, reports, goals, team,
integrations, fake account/workspace data and all mock API fallbacks.

## Actual behavior and boundaries

`../console/app.js` and `../docs/local-governance.md` describe the existing real
behavior to preserve. The backend contract is `../control-plane/contracts.ts`.
Use the existing `/api/*` endpoints without adding governance/execution APIs.

- Real human-token login, bootstrap CSRF, session renewal/expiry/logout.
- Real projects: list/select/create; absolute immutable workspace.
- Published rule library: filters, complete metadata, seven frozen predicate
  operators; no invented SQL/regex or authorization metadata.
- In-memory candidate editing from current policy, repository seed or import;
  validation; immutable proposal submission. Drafts never cross projects or
  survive logout, and policy content is not persisted in browser storage.
- Proposals: list/detail/rule+activation diff, approve/reject/withdraw. Publish
  binds `expectedDigest`, checks stale base and requires confirmation. Only the
  backend determines success and permissions.
- Versions: list/detail/YAML+JSON download; rollback creates a new proposal.
- Governance audit: actual paginated records, not mock activity.
- Observations: actual sanitized configured-log report; when unavailable show
  exactly that, never insert sample events or ask the webpage for file paths.
- Simulation: actual `/simulate`, published versions only; results are
  hypothetical and never authorize tool execution.
- Appearance: actual local UI preferences only. Do not create model, team,
  workflow or integration settings without a backend API.

UI language is Chinese and branding is Amos / 本地治理控制台. Every page must
distinguish local governance publication from runtime execution authorization.
Stage A is still log-only, enforcement remains NO-GO, same-UID access is not
trusted isolation. No secrets in URLs, logs, storage, errors or screenshots.

## Shared frontend API (foundation owner)

`src/types/index.ts` re-exports type-only domain interfaces from
`../../control-plane/contracts.ts` using the correct relative path. Do not
import backend runtime modules into the browser. Also export the actual
ObservationReport/ReviewRecord types (type-only) and:

```ts
type ThemePreference = 'dark' | 'light' | 'system'
interface BrowserSession {
  authenticated: boolean; role?: 'human' | 'agent'; csrfToken: string;
  expiresAt?: number;
}
interface RuntimeStatus {
  mode: 'log-only'; enforcement: false; trustBoundary: false;
  projectCount?: number;
}
```

`src/lib/api.ts` exports singleton `api` with same-origin fetch and methods:

```text
session(): Promise<BrowserSession>
login(token: string): Promise<BrowserSession>
logout(): Promise<void>
status(): Promise<RuntimeStatus>
projects(): Promise<Project[]>
createProject({name, workspace}): Promise<Project>
policy(projectId): Promise<PublishedVersion | null>
seed(): Promise<Candidate>
schema(): Promise<Record<string, unknown>>
validate(projectId, candidate: Candidate): Promise<ValidationResult>
proposals(projectId): Promise<Proposal[]>
proposal(id): Promise<Proposal>
createProposal(projectId, input: CreateProposalInput): Promise<Proposal>
decide(id, input: DecideProposalInput): Promise<Proposal>
withdraw(id): Promise<Proposal>
versions(projectId): Promise<PublishedVersion[]>
version(projectId, version): Promise<PublishedVersion>
restore(projectId, version, input: CreateRollbackProposalInput): Promise<Proposal>
audit(query?: AuditQuery): Promise<AuditPage>
observations(): Promise<ObservationReport>
simulate(projectId, input: SimulateInput): Promise<PolicyDecision>
exportVersion(projectId, version, format: 'yaml'|'json'): Promise<void>
```

All paths encode IDs. Login always gets fresh session CSRF before POST and
updates the rotated CSRF afterwards. All POSTs send JSON, same-origin cookies
and X-CSRF-Token. No bearer/browser mixing. Network/protocol/API errors reject;
no cached/demo success. Errors expose a stable code and safe Chinese message,
not raw response bodies. Downloads use authenticated same-origin fetch,
validate response and actually save data.

`useAuthStore` (`stores/auth.ts`): `ready`, `loading`, `session`,
`authenticated`, `error`, `bootstrap()`, `login(token)`, `logout()`.
An authenticated 401 clears the governance/session data and returns to login.
Only `lib/api.ts` retains CSRF in memory; it is never persisted.

`useGovernanceStore` (`stores/governance.ts`): `projects`, `activeProjectId`,
`activeProject`, `policy`, `proposals`, `versions`, `status`, `loading`, `error`,
`initialize()`, `refreshProjects()`, `selectProject(id: string|null)`,
`refreshProject()`, `createProject(input)`, `clear()`.
All async methods return promises; createProject returns the backend Project
and selects it. refreshProject loads policy/proposals/versions for the current
project. Project switching and logout must invalidate in-flight results.
Nothing is seeded, approved or published automatically. Persist only an
optional active project ID, not entity records. Pages can use `api` for their
own detail, pagination and mutations, then refresh shared lists as necessary.

`usePreferencesStore`: `theme`, `resolvedTheme`, `sidebarCollapsed`, `compact`,
`setTheme`, `toggleSidebar`, `setSidebarCollapsed`, `setCompact`.
Use `amos:console:*` storage keys; remove analytics/date/customization/
notification fake preferences and demo stores/data/composables.

Retain `useToast()` contract: `{toasts, toast(title, description?, variant?),
dismiss}`; global renderer is owned by the visual lead. `lib/format.ts` and
`lib/utils.ts` remain reusable, no entity mock imports.

## Routes and write ownership

Hash routing; all navigation is client-side. Root serves only exact known
assets, never arbitrary SPA filesystem fallback.

1. **Foundation owner:** web package/config/main/router/types/stores/data/
   composables/lib/tests. Remove demo domain files. Shared types/APIs above are
   fixed. Frontend route map: `/` OverviewView; `/rules` RulesView; `/editor`
   EditorView; `/proposals` ProposalsView; `/proposals/:id` ProposalView;
   `/versions` VersionsView; `/versions/:version` VersionView; `/audit`
   AuditView; `/observations` ObservationsView; `/simulate` SimulateView;
   `/settings` SettingsView; catch-all NotFoundView. App owns login gating.
2. **Visual lead:** App.vue/style.css/components/layout/common/dashboard/
   charts; OverviewView, LoginView, ObservationsView, SimulateView,
   SettingsView, NotFoundView. Delete obsolete analytics components and
   AnalyticsView/AudienceView/EventsView/IntegrationsView. Shared UI generation
   under components/ui is retained; use only CSP-compatible primitives.
3. **Rules/editor owner:** RulesView, EditorView, components/rules only.
4. **Governance pages owner:** ProposalsView, ProposalView, VersionsView,
   VersionView, AuditView, components/governance only. Remove old
   ReportsView/GoalsView/TeamView and components/management/settings after
   checking no retained import relies on them. Project creation lives in shell.
5. **Backend/build owner:** root package/lock/scripts; control-plane static
   delivery, CLI and focused transport tests. Do not change service/store/auth
   or any engine/adapter/security decisions. Coordinate web package/config
   with foundation owner; no concurrent npm installs.

PageHeader(title, description, actions slot), EmptyState(title, description,
default action slot), StatusBadge(status) remain stable. No unnecessary chart
or motion dependency: actual summary counts/tables suffice. Prefer CSS
transitions and native/verified Reka controls under unchanged strict CSP.
No v-html, remote fonts, unsafe-inline/eval, fake notifications, fabricated
connection status, finance metrics, or unavailable configuration switches.

## Build and evidence plan

- One root npm workspace lock; root npm ci installs frontend dependencies.
- Root build compiles server then web into dist/console; only that UI is served
  by npm run console / console:serve. Old console assets are removed only after
  frontend owners have finished consulting them (orchestrator does removal).
- Flatten Vite output; bounded closed build asset manifest; load exact bytes
  before listen, O_NOFOLLOW + ordinary-file/size/name checks, fail startup for
  malformed/missing/symlink/unknown assets. No request-derived disk lookup.
- Keep CSP, Host/Origin/CSRF, human-agent separation, and backend semantics.
- Writers run only focused checks. Orchestrator runs final root npm ci,
  typecheck/test/build and Chromium on the actual same-origin Node server with
  a new temporary database and temporary synthetic tokens, never real user
  state. Test login→project→seed edit→validate→propose→publish→export→rollback,
  logout/relogin/restart persistence, project isolation, stale/error/empty
  states, dark/light/mobile, keyboard and CSP violation events.
- Existing demo smoke must be replaced, not silently kept as governance proof.
  Source content and browser tokens never appear in public evidence/logs.
