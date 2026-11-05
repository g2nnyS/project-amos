<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Agent policy matching and audit prototype
</p>

<p align="center">
  Move agent constraints out of wishful prompts and into a deterministic policy engine with a verifiable audit trail.
</p>

<p align="center">
  <code>Stage A</code> · log-only security layer · opt-in engineering gate<br>
  <strong>Pi harness-layer blocking (explicit opt-in), independent review + one-shot grant, activation injection and audit are implemented; default adapters remain log-only. OS isolation is out of scope for this MVP.</strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

## What Is Amos?

Writing safety rules in `AGENTS.md` or system prompts relies on model goodwill. **Amos takes a different path: the agent proposes an action, a deterministic policy engine evaluates it against explicit rules, and every decision leaves a clean audit trail.**

> **Security boundary**: Security adapters are log-only by default. Pi `.pi/amos.json` `managed.enabled` is an explicit opt-in Harness-layer gate that can block normalized tool calls and review confirms; it is **not an OS sandbox**, does not cover every entry/side effect, and its audit is not tamper-proof. The separate engineering workflow gate remains an opt-in guard. See [Security Model](docs/security-model.md), [Harness Gate ADR](docs/adr-harness-gate.md), and [Workflow Gate](docs/workflow-gate.md).

---

## Current Product Scope

Amos now provides a limited Harness-layer MVP: a real Vue governance console publishes
P1 project snapshots, a real Pi session loads the same snapshot for enforcement and
advisory injection, and `deny`/`confirm`/`allow` are decided before the harness tool
runs. `confirm` is held for an independent reviewer and a single-use grant. The default
adapter remains log-only; managed mode is explicit opt-in and is not an OS sandbox.
See [MVP delivery](docs/mvp-delivery.md), [Product Scope](docs/product-design.md), and
[Implementation Status](docs/product-gap-plan.md).

---

## How It Works Today

```text
Tool event
   │
   ▼
Adapter normalization ── unsupported tool / opaque shell ──► coverage record (never silently skipped)
   │
   ▼
Strict policy snapshot (content-addressed by digest)
   │
   ▼
Deterministic evaluation
   │
   ├─ matched rule      → hypothetical verdict + pinned rule metadata
   ├─ no match          → explicit no_match (recorder logs hypothetical deny)
   ├─ validation error  → deny + engine_error
   └─ snapshot failure  → deny + snapshot_error
   │
   ▼
Sanitized JSONL audit log & snapshot archive ──► injection-safe human review worksheet
```

In security `log-only` mode, the only side effects are writing the audit record and its content-addressed policy snapshot. The opt-in engineering workflow gate can separately block dangerous shell commands or hold work for review; it does not turn the security layer into a hard boundary.

---

## Where Things Stand

### What's Built (Stage A Foundation)

- **Pure Policy Engine & Snapshot Archives**: A strict, schema-validated TypeScript engine that cleanly separates *matched*, *no match*, *engine error*, and *not evaluated*. Every policy digest archives its exact rules, schema, and workspace context under the log directory.
- **In-Memory Supervisor Core**: Manages registered session context, hypothetical decisions, and process-local stop fencing (not yet wired to block live tool execution).
- **Log-Only Security Adapters (OpenCode V2 & Pi)**: Covers file-channel operations and explicitly logs coverage gaps for unsupported tools or opaque shell commands instead of silently dropping them.
- **Opt-In Engineering Workflow Gate**: Versioned guidance packs, a closed-subset dangerous-command assessor, pre-execution blocking where the harness supports it, and post-change local/Jev feedback. OpenCode does not expose a true settle-block hook, so its completion review is explicitly advisory.
- **Session-Pinned Advisory Injection**: Compiles versioned guidance seeds into an immutable advisory snapshot, selects only active rules through deterministic area, path, task-tag, and prompt-token scoring, and renders bounded `<amos-guidance>` blocks with policy and digest provenance. A prompt can rank active rules but cannot introduce one, and injection failures never change a gate decision.
- **P1 Project Rule Catalog + Publication**: Imports the repository YAML rules and guidance seeds, compiles project execution/advisory projections, and publishes a catalog-v2 artifact from the console. The Pi managed path consumes the same artifact for enforcement and injection.
- **Harness-Layer Blocking MVP (Pi, explicit opt-in)**: The real Pi `tool_call` hook evaluates an activation execution projection; `deny` blocks before the tool runs, `confirm` is held for a bounded independent model review and a one-shot HMAC grant, and `tool_result` records the outcome. Activation advisory is injected into the real system prompt and path/task guidance is appended to tool results. A live probe uses a real local model, real Pi session, real reviewer, and real file effects. Not an OS sandbox; default remains log-only.
- **Offline Managed Host & One-Shot Review**: A closed-set file host with real path/symlink/hard-link checks, capability roots, audit-before-effect, and crash-recovery replay refusal; an independent reviewer with a bounded projection, calibration gate, and HMAC one-shot grants; `managed/` wires the deterministic confirm stop, review, grant consumption, and single effect end to end in local tests. Pi managed mode now wires the review/grant path; OpenCode remains log-only. OS isolation is out of scope and there is no live model calibration.
- **Vue Governance Console & SQLite API**: Reuses the existing Vue console for login, projects, rule editing/import, validation, proposals, human approval/publish, versions, rollback, audit, and observations. SQLite remains the single primary; publication compiles catalog-v2 and writes the harness artifact. A real browser test covers login→publish→YAML export/import→runtime status→rollback. Host receipt is a same-UID runtime report, not remote attestation.
- **Bound Checkpoint, Rollout Gate & Temporary Tightening**: A deterministic TypeScript checkpoint bound to an exact tree (`CheckBinding`/`FindingBatch`), a version-bound probe-evidence promotion gate, and append-only approved-template tightening with TTL/quota/epoch. These are local libraries; no remote CI enforcement, real probe, or persisted TTL recovery.
- **Requirement Conformance & Literal Grants**: Captures the current human requirement as a harness-owned `RequirementFrame` and asks Jev whether an action serves it. `mismatch` denies, `partial`/`unclear` require confirmation, and `match` never relaxes a baseline. A command the human typed literally can lift a non-`deny` shell verdict; deterministic denies always remain. Audit records carry frame and command digests, never requirement text.
- **Redacted Logs & Injection-Safe Review Worksheets**: Redacts sensitive URL components before persistence and never logs file contents or shell command text. Review worksheets encode untrusted fields so audited targets cannot inject Markdown or HTML.
- **Advisory Jev Integration**: Provider-neutral System One assessment with TypeSafe and OpenRouter configuration. Jev can use a protected local credential file; deterministic policy remains authoritative and Jev may only tighten a verdict, never relax it.

### Current Limitations

- P1 remains an offline compiler; existing adapters still use the legacy policy snapshot and guidance seed. The managed host/reviewer flow is a library, not a default harness entry.
- Security adapters do not block tool execution; the opt-in workflow gate remains an engineering guard only. The security runtime is still **NO-GO**.
- OS isolation (independent UID, mount domains, bwrap/cgroup, kernel sandboxing, full side-effect mediation) is **out of scope for this MVP**, not a blocker; do not claim it.
- No source authentication, live model reviewer calibration, real probe/rollout, host receipt/effective acknowledgement, Vue console, or remote CI acceptance gate.
- SQLite owner-only files, in-process HMAC, JSONL, and digests are not tamper-proof or authenticated trust boundaries.

---

## Quick Start

Requires Node.js 26 and npm:

```bash
npm ci
npm run typecheck
npm test
```

### 1. Run with OpenCode V2 or Pi

The root `opencode.jsonc` is pre-configured. Run `npm run build` and launch OpenCode V2 from the repo root to record security verdicts to `spike/logs/opencode.jsonl`. For Pi setup, see the [Pi Adapter Guide](docs/pi-adapter.md). Engineering gating, Jev configuration, and its honest harness limits are documented in [Workflow Gate](docs/workflow-gate.md).

### 2. Generate a Human Review Worksheet

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
- [Product Scope](docs/product-design.md) · [Implementation Status](docs/product-gap-plan.md)
- [Security Model & Current Status](docs/security-model.md) · [Runtime Status](docs/go-no-go.md)
- [Supervisor Core](docs/supervisor-core.md) · [Workflow Gate](docs/workflow-gate.md) · [Jev Integration](docs/jev-integration.md)
- [Product & Engineering Decisions](docs/decisions.md) · [Fixture Coverage](docs/fixture-coverage.md)
- [Delivery Status](docs/delivery-status.md) · [AC-01–22 Acceptance Matrix](docs/acceptance-one-shot.md) · [One-Shot Verification](docs/verification-one-shot.md) · [Configuration & Managed Startup](docs/configuration-one-shot.md)
- Safety ADRs: [source authentication](docs/adr-source-authentication.md) · [managed host](docs/adr-managed-file-host.md) · [review protocol](docs/adr-review-protocol.md) · [governance store](docs/adr-governance-store.md) · [check binding](docs/adr-check-binding.md) · [temporary tightening](docs/adr-temporary-tightening.md)
- [OpenCode V2 Seam Notes](spike/README.md) · [Pi Adapter Guide](docs/pi-adapter.md)

---

<p align="center">
  <sub>A policy engine is useful only when its trust boundary, coverage gaps, and audit trail are as explicit as its verdicts.</sub>
</p>
