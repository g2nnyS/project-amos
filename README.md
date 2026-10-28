<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong><br>
  Agent policy matching and audit prototype
</p>

<p align="center">
  Move agent constraints out of wishful prompts and into a deterministic policy engine with a verifiable audit trail.
</p>

<p align="center">
  <code>Stage A</code> · log-only · OpenCode V2 + Pi<br>
  <strong>Status: Observation &amp; Audit Prototype (NO-GO for runtime enforcement)</strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

## What Is Amos?

Writing safety rules in `AGENTS.md` or system prompts relies on model goodwill. **Amos takes a different path: the agent proposes an action, a deterministic policy engine evaluates it against explicit rules, and every decision leaves a clean audit trail.**

> **Security Boundary Notice**: The security policy layer is in **Stage A (`log-only` observation)** and is **not yet a hard security boundary**.
> Security adapters observe selected file-tool actions and log hypothetical verdicts to JSONL. A separate opt-in **engineering workflow gate** can block dangerous shell commands, inject engineering guidance, and hold changes for local/Jev review. That gate is a workflow guardrail, not complete mediation or an OS security boundary. True "physical locking," "default deny everywhere," or "tamper-proof auditing" still require an isolated supervisor process, complete action mediation, and OS-level execution boundaries (see [Security Model & Current Guarantees](docs/security-model.md) and [Workflow Gate](docs/workflow-gate.md)).

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
- **Redacted Logs & Injection-Safe Review Worksheets**: Redacts sensitive URL components before persistence and never logs file contents or shell command text. Review worksheets encode untrusted fields so audited targets cannot inject Markdown or HTML.
- **Advisory Jev Integration**: Provider-neutral System One assessment with TypeSafe and OpenRouter configuration. Jev can use a protected local credential file; deterministic policy remains authoritative and Jev may only tighten a verdict, never relax it.

### What's Not Built Yet (Required Before Enforcement)

- Complete mediation across shell commands, patches, network calls, unknown tools, and other harness entry points.
- A trusted supervisor process and policy/audit storage isolated from the agent's writable domain.
- Symlink-, hard-link-, bind-mount-, and TOCTOU-safe filesystem execution.
- Authenticated one-time human approval bound to specific actions and policy snapshots, plus runtime enforcement semantics for `scope`, `owner`, `level`, and `policy_class`.
- Live security-layer `deny` or `confirm` blocking in either adapter. The separate engineering workflow gate does not satisfy this requirement.

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
- [Security Model & Guarantees](docs/security-model.md) · [G0 Gate Criteria](docs/go-no-go.md)
- [Supervisor Core](docs/supervisor-core.md) · [Workflow Gate](docs/workflow-gate.md) · [Jev Integration](docs/jev-integration.md)
- [Product & Engineering Decisions](docs/decisions.md) · [Fixture Coverage](docs/fixture-coverage.md)
- [OpenCode V2 Seam Notes](spike/README.md) · [Pi Adapter Guide](docs/pi-adapter.md)

---

<p align="center">
  <sub>A policy engine is useful only when its trust boundary, coverage gaps, and audit trail are as explicit as its verdicts.</sub>
</p>
