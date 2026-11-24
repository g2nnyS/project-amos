<h1 align="center">Project Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Human-governed rules, deterministic pre-execution verdicts, dynamic engineering guidance, and a verifiable audit trail for AI agents
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

## What Amos gives you

Amos is a locally run governance and oversight system for AI coding agents.

- **Humans govern**: a local console manages the global baseline and workspace projects, security rules, engineering conventions, proposals, approvals, atomic publications, versions, rollback, audit, and draft simulation.
- **The system decides before execution**: the explicit managed harness gate evaluates normalized tool calls against the published project snapshot — `deny` blocks before the tool runs, `confirm` stops for a bounded Jev review and a one-shot grant, `allow` executes.
- **Agents receive guidance**: the same snapshot compiles an advisory projection that injects task-relevant `<amos-guidance>` conventions without changing hard-rule verdicts.
- **Every decision leaves a trail**: sanitized audit records and per-harness runtime receipts make coverage and gaps visible; unsupported tools and opaque shells are recorded, never silently dropped.

Current stage: **Harness-Layer MVP** — Vue governance console · optional Tauri desktop app · Pi & OpenCode managed gate (explicit opt-in) · default adapters log-only.

> **Security boundary**: Default adapters are log-only. `managed` mode is an explicit opt-in Harness-layer gate; it has no OS sandbox, does not cover every entry or side effect, and its audit is not tamper-proof. See [Security Model](docs/security-model.md) and [Runtime Status](docs/go-no-go.md).

---

## Install and verify

Requires Node.js 26 and npm. Desktop development additionally needs the Rust toolchain.

```bash
npm ci
npm run typecheck
npm test
```

Optional browser acceptance test:

```bash
npm run e2e:smoke   # requires a local Chromium executable
```

---

## Start the governance console

```bash
npm run console        # build and serve the full console
npm run console:serve  # serve an existing build
npm run service        # build and serve the API only
```

Open the emitted `http://127.0.0.1:4310` URL. Keep the `127.0.0.1` host so Host/Origin checks remain active. On first run, set and confirm the login password; a browser session pastes `human.token` once, while the Tauri-started service receives its setup authorization through private IPC. Afterwards, sign in with the password.

The default state directory is:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/amos-governance
```

It contains `governance.sqlite`, `human.token`, and `agent.token` (plus `human-password.json` after setup). Token files are owner-only `0600`; never paste tokens into chat, URLs, or logs. One `serve` instance is allowed per state directory, and a second start is rejected with `service_already_running`.

For a custom port, state directory, or remote SSH tunnel, see [Local Governance](docs/local-governance.md).

---

## Use the console and author rules

1. **Choose the governance scope.** The built-in Global Project (`global`) holds shared baseline rules inherited by every workspace project. Create a workspace project when a repository needs supplementary rules; enter its normalized absolute workspace path.
2. **Curate rules in the UI or via YAML.** Edit rules with the console's WAF-style condition builder or import a versioned `format: amos-project-policy` YAML document. Security and engineering rules are grouped, validated against the closed 7-operator schema, and can be activated or excluded per project.
3. **Simulate before proposing.** Use the simulation page or the editor draft panel. Quick presets fill a tool call and calculate the verdict against either the published version or an unpublished draft without executing the tool.
4. **Publish through governance.** Submit a proposal, review the diff, approve, and publish. Publication atomically writes `<workspace>/.pi/activation.json` (P1 execution + advisory snapshot) and `<workspace>/.pi/amos.managed.json` (host projection).
5. **Operate versions and inspect the trail.** Export YAML or JSON, inspect version history, create rollback proposals (publishing a new version without rewinding history), and review governance events and read-only observation logs (`--audit-log` at service startup) directly in the console.

### Agent-assisted rule authoring with `amos-skill`

Instead of hand-writing rule tables from scratch, give your coding agent [`amos-skill`](https://github.com/g2nnyS/amos-skill) (for example, install it under `~/.claude/skills/amos-skill/` or point the agent at its `SKILL.md`):

- **What it produces**: a complete, importable `format: amos-project-policy` YAML draft for `global` or a specific workspace project (`activation`, `injection`, and 14-field `rules` covering both deterministic `deny`/`confirm`/`log` rules and `advisory_only` engineering conventions).
- **How the draft enters Amos**:
  1. Inspect the active schema (`GET /api/schema`) or export the current published baseline (`GET /api/projects/:id/versions/:n/export?format=yaml`) when editing an existing policy.
  2. Import and validate the full YAML via `POST /api/projects/:id/import` (`{"yaml": "..."}`), which preserves `injection` and returns `{valid, issues, candidate}`.
  3. Pass the returned `candidate` to `POST /api/projects/:id/validate` and `POST /api/projects/:id/simulate` (`{"candidate": ..., "action": ...}`) to verify at least one matching and one non-matching action.
  4. When explicitly authorized, the agent can submit a proposal via `POST /api/projects/:id/proposals` using the Agent Bearer token (`agent.token`). **Approval and publication (`POST /api/proposals/:id/decision`) are always performed by a human in the console.**

Console details and API contracts: [Local Governance](docs/local-governance.md) · [Console README](web/README.md) · [`amos-skill`](https://github.com/g2nnyS/amos-skill).

---

## Connect an agent harness

### 1. One-click plugin installation from the console

Open **Harness Detection** (`#/harnesses`) in the console. For any detected **Pi** or **OpenCode** installation, click **Install Amos Plugin**:

- **Pi** (`~/.pi/agent/extensions/amos.js`): writes a user-level extension entry that forwards to this repository's compiled `dist/adapters/pi/index.js` and loads automatically with Pi (Oh My Pi reuses the Pi adapter).
- **OpenCode** (`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`): appends the Amos plugin entry pointing at `dist/adapters/opencode-v2` with absolute `rulesPath`, `schemaPath`, and `logPath`, preserving existing plugins and comments.

Before writing, the console previews the target path and exact content; existing conflicting files are never silently overwritten. Details: [Harness Discovery](docs/harness-discovery-usage.md).

### 2. Project mode and host projection (`.pi/amos.managed.json`)

Once a project is published, the console writes `<workspace>/.pi/activation.json` and `<workspace>/.pi/amos.managed.json`:

- Both **Pi** and **OpenCode** prioritize `.pi/amos.managed.json`, which carries the resolved project mode (`log-only` or `managed`), `advisoryInjection` toggle, `configDigest`, and Jev review/workflow-gate settings configured in the console.
- When `mode: "managed"` is active for the project, normalized file and search tool calls are evaluated before execution (`deny` blocks, `confirm` stops for Jev semantic review and a one-shot HMAC grant, `allow` executes) and `<amos-guidance>` is injected from the same snapshot.
- On startup and tool evaluation, the adapter writes `<workspace>/.pi/runtime.pi.json` or `<workspace>/.pi/runtime.opencode.json` so the console shows whether the latest policy and configuration digest are `loaded`, `stale`, or `never` loaded.
- Without a published project projection, adapters stay in default Stage A `log-only` observer mode (recording sanitized verdicts and coverage gaps without blocking tools).

Adapter and configuration guides: [Configuration & Managed Startup](docs/configuration-one-shot.md) · [Pi Adapter Guide](docs/pi-adapter.md) · [OpenCode V2 Seam Notes](spike/README.md) · [Workflow Gate](docs/workflow-gate.md).

---

## Optional desktop app

The console can also run as a Tauri desktop app:

```bash
npm run tauri:dev    # development; requires Rust toolchain
npm run tauri:build  # production bundles
```

The browser console is the primary supported path. Current desktop bundles are development-stage artifacts: without Developer ID signing and Apple notarization secrets, macOS Gatekeeper may block a downloaded DMG. Do not distribute desktop bundles until the signing and notarization workflow is completed.

Architecture and packaging details: [src-tauri/README.md](src-tauri/README.md).

---

## Command reference

| Command | Purpose |
| --- | --- |
| `npm run console` | Build backend and console, then serve |
| `npm run console:serve` | Serve an existing build |
| `npm run service` | Build backend and serve API only |
| `npm run build` | Compile backend (`dist/`) and console (`dist/console/`) |
| `npm run typecheck` | Typecheck backend and console |
| `npm test` | Build and run backend plus console tests |
| `npm run e2e:smoke` | Optional real-browser acceptance run |
| `npm run tauri:dev` | Start the desktop app in development |
| `npm run tauri:build` | Build desktop bundles |

---

## Integrate Amos directly into your own harness

If you are building or maintaining an agent harness and want to integrate Amos's governance, pre-execution gating, and dynamic guidance directly, follow the same five-step contract used by the built-in Pi (`adapters/pi/`) and OpenCode V2 (`adapters/opencode-v2/`) adapters:

### 1. Load the console-published workspace artifacts

In the target project's workspace root, read the two files written by the governance console:

- **Host projection (`<workspace>/.pi/amos.managed.json`)**: call `readHostProjection(workspace)` (`adapters/shared/host-projection.ts`). It validates the `amos-managed-host-projection` v2 contract via descriptor checks (`O_NOFOLLOW`) and returns `{ status: 'ready', projection }` with `harness: { enabled, mode: 'log-only' | 'managed', advisoryInjection }`, `activation: { snapshotPath, projectId }`, `managed` review settings, `workflowGate`, and `configDigest`. If `status === 'error'`, **fail closed** rather than silently falling back to unverified config.
- **Activation snapshot (`<workspace>/.pi/activation.json`)**: call `loadActivationRuntime({ snapshotPath, projectId, workspace })` (`adapters/shared/activation-guidance.ts`) or `createActivationRuntime(snapshot, { projectId, workspace })` (`activation/runtime.ts`). It verifies the `amos-unified-rule-catalog` v2 digests and project/workspace identity, returning an immutable `ActivationRuntime` that exposes both `runtime.execution('runtime')` and `runtime.injectorSession(now)`.

### 2. Normalize tool events into closed Action Envelopes

Before a tool runs, translate your harness's native tool payload into the closed 3-field action `{ tool, operation, target }` (see `adapters/pi/normalize.ts` and `adapters/opencode-v2/normalize.ts`):

- Map operations to the canonical vocabulary: `file_read`, `file_write`, `file_search`, `file_list` (plus `file_mkdir` / `file_delete` if your host mediates directory/delete operations).
- Normalize file targets to lexical absolute paths within the session workspace; never include file contents, shell command text, URL secret values, or raw prompts in the action envelope or audit log.
- For unsupported tools, opaque shell commands (`shell_input`), or unparseable payloads, emit an explicit coverage record (`not_evaluated`, `unknown_payload`, or `parse_error`) in `log-only` mode, and block them in `managed` mode—never treat an unevaluated tool as an implicit `allow`.

### 3. Wire pre-execution evaluation and the managed gate

- **In `log-only` mode**: evaluate `runtime.execution('runtime').rules` with `evaluatePolicy(action, rules, { now })` (`engine/engine.ts`) or the shared observer recorder (`adapters/shared/log-only.ts`), and append the sanitized decision record to your JSONL log without interrupting the tool call.
- **In `managed` mode**: create a gate with `createHarnessGate` (`managed/harness.ts`), passing the verified `ActivationRuntime`, an `auditPath` outside the workspace, the session's harness-captured user requirement (`decision/requirement-registry.ts`), and the Jev semantic reviewer (`createJevSemanticReviewer` in `review/jev-reviewer.ts`):
  - **Pre-tool hook**: call `const decision = await gate.preCall({ callId, action })`.
    - `deny` (or any engine, snapshot, or requirement state error) returns `{ action: 'block' }` before the tool executes.
    - `confirm` holds execution, builds a minimal bounded projection (`tool`, `operation`, workspace-relative `target`, matched rule IDs, requirement digest), invokes the Jev reviewer, verifies the response against the active `ReviewerPolicy` and requirement version, and consumes a single-use HMAC grant before returning `{ action: 'allow' }`.
    - `allow` writes the authorization journal entry first (`host/journal.ts`) and returns `{ action: 'allow' }`.
  - **Post-tool hook**: call `gate.recordResult(callId, 'executed' | 'failed' | 'cancelled')` so the audit journal pairs every authorized call with its outcome.
  - **User prompt hook**: capture the human prompt into the versioned `RequirementRegistry` (`decision/requirement-registry.ts`) from the trusted user-input channel only (never from tool outputs or model text); a requirement update bumps the version and automatically invalidates in-flight reviews and unconsumed grants.

### 4. Inject session-pinned `<amos-guidance>` blocks

When `harness.advisoryInjection` is enabled, create one injector session per harness session via `const injector = runtime.injectorSession(now)` (`activation/injector.ts`, `injector/session.ts`):

- **On user turns**: select active conventions using prompt tokens, task tags, and active path hints, render the bounded XML block (`<amos-guidance policy="..." digest="..." mode="advisory">`), append it to the system or turn context, and call `commit` once emitted so rules are deduplicated across the session.
- **On write/edit tool calls**: derive the target path's area and attach path-matched conventions to the tool result or next turn context.
- **Preserve non-interference**: advisory selection, prompt tokens, and character budgets must never filter `runtime.execution('runtime')` or alter a gate verdict; if injection fails, log or drop the advisory block and keep enforcement unchanged.

### 5. Write the runtime receipt and register harness discovery

- **Runtime receipt (`<workspace>/.pi/runtime.<harness>.json`)**: when the snapshot loads and when tool calls are evaluated, atomically write a v2 receipt (`format: "amos-harness-runtime"`, `version: 2`, `projectId`, `activationDigest`, `epoch`, `policyVersion`, `configDigest`, `harness`, `mode: "enforcing" | "log-only" | "disabled"`, `loadedAt`, `lastToolAt`; see `control-plane/runtime-status.ts`). The console reads this receipt to report whether the harness has loaded the current policy and configuration.
- **Console detection & one-click install**: to list your harness in `#/harnesses`, add its binary probe and plugin marker check to `control-plane/harness-discovery.ts`, and add its idempotent user-level config installer to `control-plane/harness-plugin-install.ts`.

---

## Documentation

- **Using Amos & authoring rules**: [Local Governance](docs/local-governance.md) · [Console README](web/README.md) · [Harness Discovery](docs/harness-discovery-usage.md) · [`amos-skill` (Rule Authoring Skill)](https://github.com/g2nnyS/amos-skill)
- **Agent & harness integration**: [Configuration & Managed Startup](docs/configuration-one-shot.md) · [Pi Adapter Guide](docs/pi-adapter.md) · [OpenCode V2 Seam Notes](spike/README.md) · [Workflow Gate](docs/workflow-gate.md) · [Jev Integration](docs/jev-integration.md)
- **Status and safety**: [Security Model](docs/security-model.md) · [Runtime Status](docs/go-no-go.md) · [Product Closure](docs/product-closure.md) · [Implementation Status](docs/product-gap-plan.md)
- **Architecture and decisions**: [Product Scope](docs/product-design.md) · [Project Activation](docs/project-activation.md) · [Harness Gate ADR](docs/adr-harness-gate.md) · [Decisions](docs/decisions.md)
- **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
