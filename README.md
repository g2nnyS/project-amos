<h1 align="center">Project Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Human-governed rules, deterministic pre-execution verdicts, dynamic engineering guidance, and a verifiable audit trail for AI agents
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

## What Is Amos?

Amos is a locally run governance and oversight system for AI coding agents.

Hard boundaries written into a monolithic `AGENTS.md` or system prompt rely on model goodwill and flood the context with every rule at once; approving each action by hand turns the human into the throughput bottleneck. Amos turns both kinds of limits into versioned, auditable data and separates governance from execution:

- **Humans govern**: in a local console they curate security rules, engineering conventions, and design preferences, submit proposals, and approve an atomic publication.
- **The system decides before execution**: the managed harness gate evaluates normalized tool calls against the published project snapshot — `deny` blocks before the tool runs, `confirm` is held for a bounded Jev semantic review and a one-shot grant, `allow` executes.
- **Agents get guidance, not just gates**: the same snapshot compiles an advisory projection that injects task-relevant conventions (`<amos-guidance>`) by area, path, task tag, and prompt tokens.
- **Everything leaves a trail**: sanitized JSONL verdicts, runtime receipts, and governance events; unsupported tools and opaque shells surface as coverage records, never silent drops.

Current stage: **Harness-Layer MVP** — Vue governance console · Tauri desktop app · Pi managed gate (explicit opt-in) · default adapters log-only.

> **Security boundary**: Default adapters are log-only. `managed.enabled` is an explicit opt-in Harness-layer gate; it is **not an OS sandbox**, does not cover every entry or side effect, and its audit is not tamper-proof. OS isolation is out of scope for this round. See [Security Model](docs/security-model.md), [Harness Gate ADR](docs/adr-harness-gate.md), and [Runtime Status](docs/go-no-go.md).

---

## Product Tour

### Governance console (browser + Tauri desktop, localized UI)

- First run sets and confirms a login password (12–1024 chars): a browser session pastes the human token from the state directory once, while a Tauri self-started service receives a 10-minute one-time setup authorization through private IPC. Afterwards, log in with the password; the desktop offers password login.
- Projects, rule-matrix editing, YAML import/export, validation, immutable proposals, human approval and atomic publish, version history, rollback proposals, governance audit, policy simulation, and opt-in observation logs (`--audit-log` at startup).
- Settings are organized in tabs with an about panel; the Harness discovery page probes local installations of Pi, OpenCode, Oh My Pi, Codex, Claude Code, and DSH and reports whether each is under Amos management.

### Managed harness gate (Pi / OpenCode V2, explicit opt-in)

- The real `tool_call` hook evaluates the activation execution projection before the tool runs: `deny` blocks with an audit record, `confirm` stops for the Jev semantic reviewer (`review/jev-reviewer.ts`) and a one-shot HMAC grant, `allow` executes and `tool_result` records the outcome.
- The session loads the published snapshot, writes a runtime receipt the console reads back (`loaded` / `stale` / `never` / …), and injects the advisory projection into the real system prompt.

### Dynamic engineering guidance

- Engineering conventions, architecture invariants, and design preferences are first-class versioned rules compiled from the same activation snapshot. Two-stage deterministic selection (applicability filter, then weighted area/path/task/token signals) renders bounded `<amos-guidance>` blocks under strict character budgets.
- Prompts, task tags, and budgets only rank or truncate advisory text; hard enforcement rules, permissions, and gate/audit outcomes stay untouched.

### Default observers and the engineering workflow gate

- Default Pi/OpenCode adapters stay Stage A log-only: normalized tool events produce hypothetical verdicts, sanitized JSONL audit logs, and snapshot archives; coverage gaps are recorded, never silently dropped.
- The separate opt-in workflow gate assesses a closed subset of bash commands before execution, runs fixed local checks, and holds work for Jev engineering review; OpenCode completion feedback is advisory.

### Desktop application (Tauri)

- The console also ships as a native desktop app: ~10 MB Linux AppImage, ~5 MB Windows NSIS, ~3 MB macOS DMG. It reuses a healthy console service from the same state directory and leaves a pre-existing service running when the window closes; each state directory accepts exactly one service instance.

---

## Installation & Quick Start

Requires Node.js 26 and npm (desktop development additionally needs the Rust toolchain):

```bash
npm ci
npm run typecheck
npm test
```

### 1. Launch the governance console

```bash
npm run console        # build + serve
npm run console:serve  # serve without rebuilding
npm run service        # backend-only build, API-only mode (no console assets)
```

Open the emitted `http://127.0.0.1:4310` (keep `127.0.0.1` to preserve Host/Origin checks). The default state directory is `${XDG_STATE_HOME:-$HOME/.local/state}/amos-governance`, holding `governance.sqlite`, `human.token`, and `agent.token` (plus `human-password.json` after setup). Token files are owner-only `0600` — never paste tokens into chat, URLs, or logs. One `serve` instance per state directory; a second start is rejected with `service_already_running`.

### 2. Publish a project snapshot

Create a project with a normalized absolute workspace path, import the repository rules or edit your own, validate, submit a proposal, and approve the publication: the console atomically writes the P1 snapshot to `<workspace>/.pi/activation.json`. Rollback creates a new proposal; versions export as YAML or JSON. Full operational details: [Local Governance](docs/local-governance.md) and [Console README](web/README.md).

### 3. Wire up Pi or OpenCode V2

- **Pi managed gate (explicit opt-in)**: configure `.pi/amos.json` with `managed.enabled: true` pointing at `.pi/activation.json` as documented in [Configuration & Managed Startup](docs/configuration-one-shot.md). The session loads the snapshot, writes a runtime receipt (`.pi/runtime.pi.json` for the v2 projection), injects `<amos-guidance>`, and gates normalized tool calls before execution.
- **Default log-only adapters**: the root `opencode.jsonc` is pre-configured without a plugin `mode` option. Run `npm run build` and launch OpenCode V2 from the repo root to record security verdicts to `spike/logs/opencode.jsonl`. Console project configuration controls OpenCode through `.pi/amos.managed.json`; without that projection, the observer fallback remains active. Default Pi setup: [Pi Adapter Guide](docs/pi-adapter.md); engineering gating and Jev configuration: [Workflow Gate](docs/workflow-gate.md).

### 4. Desktop application (Tauri)

```bash
npm run tauri:dev    # development, requires Rust toolchain
npm run tauri:build  # production bundles
```

Architecture and bundle details: [src-tauri/README.md](src-tauri/README.md).

### 5. Generate a human review worksheet

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

*(Note: `--output` must point to a new file so existing human review notes are never overwritten.)*

---

## Technical Overview

### How it works today

```text
[1] Managed Governance & Harness Gate (Pi opt-in: .pi/amos.json managed.enabled = true)
Vue Console / SQLite ── publish P1 catalog-v2 ──► .pi/activation.json
   │
   ▼
Pi session loads snapshot (writes .pi/runtime.pi.json) + injects <amos-guidance> into system prompt
   │
   ▼
Tool call (read/write/edit/ls/find/grep)
   ├─ deny     → blocked before tool runs + audit record
   ├─ confirm  → bounded Jev semantic reviewer ──► one-shot HMAC grant ──► execute once
   └─ allow    → execute + tool_result audit & path/task advisory

[2] Default Log-Only Adapters (OpenCode V2 & default Pi)
Tool event ──► Adapter normalization (unsupported tool / opaque shell → coverage record)
   │
   ▼
Content-addressed policy snapshot ──► Deterministic evaluation (matched / no_match / error)
   │
   ▼
Sanitized JSONL audit log & snapshot archive ──► injection-safe human review worksheet
```

In default `log-only` mode, the only side effects are writing the audit record and its content-addressed policy snapshot. When Pi `managed.enabled` is turned on, normalized file/search tool calls are gated before execution against the published P1 snapshot. The separate engineering workflow gate can also block dangerous shell commands or hold work for review.

### Dual projections from one activation set

Amos splits one project-activated catalog into two synchronized projections: a deterministic policy engine evaluates structured actions against hard rules (`deny`/`confirm`/`allow`), while a session-pinned advisory injector dynamically delivers relevant engineering conventions, architecture invariants, and design preferences (`<amos-guidance>`) by area, path, task tag, and prompt tokens.

- **Curated engineering packs & custom conventions**: seeded with 7 domain packs in `guidance/packs.ts` (`typescript-base`, `engine-invariants`, `adapters`, `supervisor-core`, `decision-jev`, `dependencies-and-manifests`, `workflow-security`). Teams author project-specific `advisory_only` design preferences or attach `narrative` guidance to deterministic rules in the console or YAML (`injection.baselineRuleIds` + `injection.routes`).
- **Two-stage deterministic selection (`injector/select.ts`)**: filters active rules by `languages` / `frameworks` applicability, then ranks candidates by level ascending and weighted signals (`areas`, `pathHints` globs, `taskTags`, bounded prompt keyword tokens), plus explicit route `add`/`suppress`. With no matching signal or on routing failure it falls back to the project's active narratives (`baselineRuleIds` prioritized).
- **Session-pinned delivery & budgets (`injector/session.ts`, `injector/render.ts`)**: renders XML-escaped `<amos-guidance policy="..." digest="..." mode="advisory">` blocks under strict character budgets (`1,800` prompt / `1,200` fallback / `900` area / `6,000` session total, max `6` rules per block). Budget-dropped rules are reported via `omittedRefs` / `incomplete: true`.
- **Non-interference invariant**: prompts, task tags, and character budgets only rank or truncate advisory text; they never filter hard enforcement rules, grant permissions, or alter gate/audit outcomes.

### Module map

| Module | Role |
| --- | --- |
| `engine/` | Pure, fail-closed policy evaluation: `deny > confirm > log > allow`, seven predicate operators, injected clock, no I/O |
| `catalog/` + `activation/` | Offline catalog-v2 compilation; the console publishes project activation snapshots with paired enforcement/advisory projections |
| `adapters/` | OpenCode V2 and Pi event normalization; log-only observers with explicit coverage records; managed paths consume the activation projection |
| `injector/` | Two-stage deterministic selection, session pinning, character budgets, `<amos-guidance>` rendering |
| `control-plane/` | SQLite governance service (single primary) with the typed HTTP API for projects, proposals, versions, and audit |
| `managed/` + `host/` + `review/` | Managed gate wiring; closed-set file host with real path/symlink/hard-link checks and audit-before-effect; Jev semantic reviewer with one-shot HMAC grants |
| `decision/` | Harness-captured `RequirementFrame`, versioned requirement registry, provider-neutral Jev access |
| `supervisor/` | In-memory session context, hypothetical decisions, and process-local stop fencing |
| `workflow/` | Opt-in engineering shell gate: closed-subset command assessor, fixed local checks, advisory completion review |
| `rollout/` + `check/` | Version-bound probe-evidence promotion gate, `CheckBinding`, approved temporary-tightening templates (local libraries) |
| `strict/` + `autonomy/` | Experimental in-memory harness and bounded file-create host (dev line, separate from the managed path) |
| `storage/` | Content-addressed snapshot archives, sanitized JSONL, injection-safe review worksheets |

### What's built

- **Pure Policy Engine & Snapshot Archives**: A strict, schema-validated TypeScript engine that cleanly separates *matched*, *no match*, *engine error*, and *not evaluated*. Every policy digest archives its exact rules, schema, and workspace context under the log directory.
- **In-Memory Supervisor Core**: Manages registered session context, hypothetical decisions, and process-local stop fencing for in-memory supervisor workflows; live Pi tool interception is handled by the Harness-Layer Blocking MVP (`managed/`).
- **Log-Only Security Adapters (OpenCode V2 & Default Pi)**: Covers file-channel operations and explicitly logs coverage gaps for unsupported tools or opaque shell commands instead of silently dropping them.
- **Opt-In Engineering Workflow Gate**: Versioned guidance packs, a closed-subset dangerous-command assessor, pre-execution blocking where the harness supports it, and post-change local/Jev feedback. OpenCode uses the `experimental.idle` hook for a single-repair continuation, mirroring Pi's `agent_before_settle`; like Pi it is advisory (soft-block), and the hook is an experimental API that may change in a future release.
- **Session-Pinned Advisory Injection**: Compiles versioned guidance seeds into an immutable advisory snapshot, selects only active rules through deterministic area, path, task-tag, and prompt-token scoring, and renders bounded `<amos-guidance>` blocks with policy and digest provenance. A prompt can rank active rules but cannot introduce one, and injection failures never change a gate decision.
- **P1 Project Rule Catalog + Publication**: Imports the repository YAML rules and guidance seeds, compiles project execution/advisory projections, and publishes a catalog-v2 artifact from the console. The Pi managed path consumes the same artifact for enforcement and injection.
- **Harness-Layer Blocking MVP (Pi, explicit opt-in)**: The real Pi `tool_call` hook evaluates an activation execution projection; `deny` blocks before the tool runs, `confirm` is held for the Jev semantic reviewer and a one-shot HMAC grant, and `tool_result` records the outcome. Activation advisory is injected into the real system prompt and path/task guidance is appended to tool results. Verified by `managed/pi-harness.test.ts` (real Pi session, real extension, real write tool, loopback Jev protocol responses, real file effects) and `managed/harness-requirement.test.ts`. Not an OS sandbox; default remains log-only.
- **Offline Managed Host & One-Shot Review**: A closed-set file host with real path/symlink/hard-link checks, capability roots, audit-before-effect, and crash-recovery replay refusal; a Jev semantic reviewer (`review/jev-reviewer.ts`) with a bounded projection, calibration gate, and HMAC one-shot grants; `managed/` wires the deterministic confirm stop, review, grant consumption, and single effect end to end.
- **Vue Governance Console, Tauri Desktop & SQLite API**: Login, projects, rule editing/import, validation, proposals, human approval/publish, versions, rollback, audit, and observations, with a localized UI, first-run password enrollment (browser token paste; Tauri private-IPC setup grant), settings tabs with an about panel, harness discovery, and a single-instance service lifecycle that the Tauri desktop reuses. SQLite remains the single primary; publication compiles catalog-v2 and writes the harness artifact. A real browser test covers login→publish→YAML export/import→runtime status→rollback. Host receipt is a same-UID runtime report, not remote attestation.
- **Bound Checkpoint, Rollout Gate & Temporary Tightening**: A deterministic TypeScript checkpoint bound to an exact tree (`CheckBinding`/`FindingBatch`), a version-bound probe-evidence promotion gate, and append-only approved-template tightening with TTL/quota/epoch. These are local libraries; no remote CI enforcement, real probe, or persisted TTL recovery.
- **Requirement Conformance & Literal Grants**: Captures the current human requirement as a harness-owned `RequirementFrame` and asks Jev whether an action serves it. `mismatch` denies, `partial`/`unclear` require confirmation, and `match` never relaxes a baseline. A command the human typed literally can lift a non-`deny` shell verdict; deterministic denies always remain. Audit records carry frame and command digests, never requirement text.
- **Redacted Logs & Injection-Safe Review Worksheets**: Redacts sensitive URL components before persistence and never logs file contents or shell command text. Review worksheets encode untrusted fields so audited targets cannot inject Markdown or HTML.
- **Advisory Jev Integration**: Provider-neutral System One assessment with TypeSafe and OpenRouter configuration. Jev can use a protected local credential file; deterministic policy remains authoritative and Jev may only tighten a verdict, never relax it.

### Current limitations

- The default Pi/OpenCode adapters still use Stage A log-only behavior. Pi `managed.enabled` is the explicit opt-in Harness gate; OpenCode's explicit managed path reads the same projection and ordinary adapters stay log-only.
- `managed` covers normalized `read/write/edit/ls/find/grep`; shell, PowerShell, custom tools, MCP, subprocesses, bypass paths and side effects inside an allowed shell are outside the guarantee.
- OS isolation (independent UID, mount domains, bwrap/cgroup, kernel sandboxing, full side-effect mediation, tamper-proof audit) is **out of scope for this MVP**, not a blocker; do not claim it.
- No publisher authentication. Snapshot verification is structural/identity consistency, not a signature; control-plane tokens and runtime reports are same-UID local observations.
- The reviewer is Jev, configured through a local Jev config file; the calibration set is not a security certification. A hosted Jev or local llama live probe was not run this round; it needs operator credentials and a local endpoint. *(Historical, 2026-11-05: the reviewer was a local model behind an independent service; it was replaced on 2026-11-07.)*
- No complete rollout, temporary-tightening persistence, remote CI acceptance gate, or host effective-receipt across machines.
- SQLite owner-only files, in-process HMAC, JSONL, and digests are not tamper-proof or authenticated trust boundaries.
- `strict/` and `autonomy/` remain local experimental libraries from the dev line; they are not the MVP managed path.

---

## Quick Start

Requires Node.js 26 and npm:

```bash
npm ci
npm run typecheck
npm test
```

### 1. Launch the Governance Console (Publish a Project Snapshot)

```bash
npm run console
# Or skip rebuilding if dist/ is already up to date: npm run console:serve
# Headless: build only the backend and serve the governance API without console assets
npm run service
```

### Desktop Application (Tauri)

Run the governance console as a native desktop app with 90%+ smaller bundle size:

```bash
# Development (requires Rust toolchain)
npm run tauri:dev

# Production build
npm run tauri:build
```

The desktop reuses a healthy console service from the same state directory and leaves that existing service running when the window closes. A second `serve` on the same state directory is rejected; see [Local Governance](docs/local-governance.md) and [src-tauri/README.md](src-tauri/README.md).

**Bundle sizes:**
- Linux AppImage: ~10 MB
- Windows NSIS: ~5 MB
- macOS DMG: ~3 MB


The root `opencode.jsonc` is pre-configured. Run `npm run build` and launch OpenCode V2 from the repo root to record security verdicts to `spike/logs/opencode.jsonl`. For Pi setup, see the [Pi Adapter Guide](docs/pi-adapter.md). Engineering gating, Jev configuration, and its honest harness limits are documented in [Workflow Gate](docs/workflow-gate.md).

Open the emitted `http://127.0.0.1:4310` URL (use `127.0.0.1` to preserve Host/Origin checks). Open `${XDG_STATE_HOME:-$HOME/.local/state}/amos-governance/human.token` in a local editor and paste it into the login form—never paste tokens into chat, URLs, or logs. Create a project, import or edit rules, submit a proposal, and approve/publish it to write `<workspace>/.pi/activation.json`. See [Local Governance](docs/local-governance.md) and [Console README](web/README.md).

### 2. Run with Pi or OpenCode V2

- **Pi Managed Gate (explicit opt-in)**: Configure `.pi/amos.json` with `managed.enabled: true` pointing at `.pi/activation.json` as documented in [Configuration & Managed Startup](docs/configuration-one-shot.md). Pi loads the snapshot, writes `.pi/runtime.pi.json` for a v2 projection (or the legacy `.pi/runtime.json`), injects `<amos-guidance>`, and gates normalized tool calls before execution.
- **Default Log-Only Adapters**: The root `opencode.jsonc` is pre-configured. Run `npm run build` and launch OpenCode V2 from the repo root to record security verdicts to `spike/logs/opencode.jsonl`. For default Pi setup, see the [Pi Adapter Guide](docs/pi-adapter.md); for the engineering workflow gate and Jev setup, see [Workflow Gate](docs/workflow-gate.md).

### 3. Generate a Human Review Worksheet

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

*(Note: `--output` must point to a new file so existing human review notes are never overwritten.)*

---

## Workflow & Documentation

- **Delivery Conventions**: Use `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, or `ci/` branches. Branch protection, force-push prevention, and release authority belong on the Git host. Security-sensitive changes require human review—**agents never self-approve, merge, or release** (see [CONTRIBUTING.md](CONTRIBUTING.md)).

**Documentation Index**:
- [Product Scope](docs/product-design.md) · [Project Activation & Dual Projections](docs/project-activation.md) · [Implementation Status](docs/product-gap-plan.md) · [MVP Delivery](docs/mvp-delivery.md)
- [Local Governance](docs/local-governance.md) · [Console README](web/README.md) · [Desktop App](src-tauri/README.md) · [Harness Discovery](docs/harness-discovery-usage.md)
- [Security Model & Current Status](docs/security-model.md) · [Runtime Status](docs/go-no-go.md)
- [Supervisor Core](docs/supervisor-core.md) · [Workflow Gate & Advisory Injection](docs/workflow-gate.md) · [Jev Integration](docs/jev-integration.md)
- [Product & Engineering Decisions](docs/decisions.md) · [Fixture Coverage](docs/fixture-coverage.md)
- [Delivery Status](docs/delivery-status.md) · [AC-01–22 Acceptance Matrix](docs/acceptance-one-shot.md) · [One-Shot Verification](docs/verification-one-shot.md) · [Configuration & Managed Startup](docs/configuration-one-shot.md)
- Safety & Architecture ADRs: [unified rule catalog](docs/adr-unified-rule-catalog.md) · [harness gate](docs/adr-harness-gate.md) · [source authentication](docs/adr-source-authentication.md) · [managed host](docs/adr-managed-file-host.md) · [review protocol](docs/adr-review-protocol.md) · [governance store](docs/adr-governance-store.md) · [check binding](docs/adr-check-binding.md) · [temporary tightening](docs/adr-temporary-tightening.md)
- [OpenCode V2 Seam Notes](spike/README.md) · [Pi Adapter Guide](docs/pi-adapter.md)

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

---

<p align="center">
  <sub>A policy engine is useful only when its trust boundary, coverage gaps, and audit trail are as explicit as its verdicts.</sub>
</p>
