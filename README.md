<h1 align="center">Project Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Deterministic policy governance, pre-execution harness gating, and verifiable audit for AI agents
</p>

<p align="center">
  Move agent constraints out of wishful prompts and into a deterministic policy engine with a verifiable audit trail.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

## What Is Amos?

Writing safety rules in `AGENTS.md` or system prompts relies on model goodwill. **Amos takes a different path: the agent proposes an action, a deterministic policy engine evaluates it against explicit rules, and every decision leaves a clean audit trail.**

> **Security boundary**: Security adapters are log-only by default. Pi `.pi/amos.json` `managed.enabled` is an explicit opt-in Harness-layer gate that can block normalized tool calls and review confirms; it is **not an OS sandbox**, does not cover every entry/side effect, and its audit is not tamper-proof. The separate engineering workflow gate remains an opt-in guard. See [Security Model](docs/security-model.md), [Harness Gate ADR](docs/adr-harness-gate.md), and [Workflow Gate](docs/workflow-gate.md).

---

## What Stage Is It At?

`Harness-Layer MVP` · Vue Governance Console · Pi Managed Gate (opt-in) · Stage A Default Adapters

**End-to-end closed loop: Vue console publishes P1 catalog-v2 snapshots, Pi `managed.enabled` enforces pre-tool `deny`/`confirm`/`allow` with a Jev semantic reviewer + one-shot HMAC grant and dynamic advisory injection; default adapters remain log-only and OS isolation is out of scope.**

---

## Current Product Scope

Amos now provides a limited Harness-layer MVP: a real Vue governance console publishes
P1 project snapshots, a real Pi session loads the same snapshot for enforcement and
advisory injection, and `deny`/`confirm`/`allow` are decided before the harness tool
runs. `confirm` is held for the Jev semantic reviewer and a single-use grant. The default
adapter remains log-only; managed mode is explicit opt-in and is not an OS sandbox.
See [MVP delivery](docs/mvp-delivery.md), [Product Scope](docs/product-design.md), and
[Implementation Status](docs/product-gap-plan.md).

---

## How It Works Today

```text
[1] Managed Governance & Harness Gate (Pi opt-in: .pi/amos.json managed.enabled = true)
Vue Console / SQLite ── publish P1 catalog-v2 ──► .pi/activation.json
   │
   ▼
Pi session loads snapshot (writes .pi/runtime.json) + injects <amos-guidance> into system prompt
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

---

## Where Things Stand

### What's Built (Harness-Layer MVP & Stage A Foundation)

- **Pure Policy Engine & Snapshot Archives**: A strict, schema-validated TypeScript engine that cleanly separates *matched*, *no match*, *engine error*, and *not evaluated*. Every policy digest archives its exact rules, schema, and workspace context under the log directory.
- **In-Memory Supervisor Core**: Manages registered session context, hypothetical decisions, and process-local stop fencing for in-memory supervisor workflows; live Pi tool interception is handled by the Harness-Layer Blocking MVP (`managed/`).
- **Log-Only Security Adapters (OpenCode V2 & Default Pi)**: Covers file-channel operations and explicitly logs coverage gaps for unsupported tools or opaque shell commands instead of silently dropping them.
- **Opt-In Engineering Workflow Gate**: Versioned guidance packs, a closed-subset dangerous-command assessor, pre-execution blocking where the harness supports it, and post-change local/Jev feedback. OpenCode does not expose a true settle-block hook, so its completion review is explicitly advisory.
- **Session-Pinned Advisory Injection**: Compiles versioned guidance seeds into an immutable advisory snapshot, selects only active rules through deterministic area, path, task-tag, and prompt-token scoring, and renders bounded `<amos-guidance>` blocks with policy and digest provenance. A prompt can rank active rules but cannot introduce one, and injection failures never change a gate decision.
- **P1 Project Rule Catalog + Publication**: Imports the repository YAML rules and guidance seeds, compiles project execution/advisory projections, and publishes a catalog-v2 artifact from the console. The Pi managed path consumes the same artifact for enforcement and injection.
- **Harness-Layer Blocking MVP (Pi, explicit opt-in)**: The real Pi `tool_call` hook evaluates an activation execution projection; `deny` blocks before the tool runs, `confirm` is held for the Jev semantic reviewer and a one-shot HMAC grant, and `tool_result` records the outcome. Activation advisory is injected into the real system prompt and path/task guidance is appended to tool results. Verified by `managed/pi-harness.test.ts` (real Pi session, real extension, real write tool, loopback Jev protocol responses, real file effects) and `managed/harness-requirement.test.ts`; the 2026-11-05 live probe used the retired local reviewer service. Not an OS sandbox; default remains log-only.
- **Offline Managed Host & One-Shot Review**: A closed-set file host with real path/symlink/hard-link checks, capability roots, audit-before-effect, and crash-recovery replay refusal; a Jev semantic reviewer (`review/jev-reviewer.ts`) with a bounded projection, calibration gate, and HMAC one-shot grants; `managed/` wires the deterministic confirm stop, review, grant consumption, and single effect end to end. Pi and OpenCode managed modes wire this review/grant path; ordinary adapters remain log-only. OS isolation is out of scope.
- **Vue Governance Console & SQLite API**: Reuses the existing Vue console for login, projects, rule editing/import, validation, proposals, human approval/publish, versions, rollback, audit, and observations. SQLite remains the single primary; publication compiles catalog-v2 and writes the harness artifact. A real browser test covers login→publish→YAML export/import→runtime status→rollback. Host receipt is a same-UID runtime report, not remote attestation.
- **Bound Checkpoint, Rollout Gate & Temporary Tightening**: A deterministic TypeScript checkpoint bound to an exact tree (`CheckBinding`/`FindingBatch`), a version-bound probe-evidence promotion gate, and append-only approved-template tightening with TTL/quota/epoch. These are local libraries; no remote CI enforcement, real probe, or persisted TTL recovery.
- **Requirement Conformance & Literal Grants**: Captures the current human requirement as a harness-owned `RequirementFrame` and asks Jev whether an action serves it. `mismatch` denies, `partial`/`unclear` require confirmation, and `match` never relaxes a baseline. A command the human typed literally can lift a non-`deny` shell verdict; deterministic denies always remain. Audit records carry frame and command digests, never requirement text.
- **Redacted Logs & Injection-Safe Review Worksheets**: Redacts sensitive URL components before persistence and never logs file contents or shell command text. Review worksheets encode untrusted fields so audited targets cannot inject Markdown or HTML.
- **Advisory Jev Integration**: Provider-neutral System One assessment with TypeSafe and OpenRouter configuration. Jev can use a protected local credential file; deterministic policy remains authoritative and Jev may only tighten a verdict, never relax it.

### Current Limitations

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
