<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong>
</p>

<p align="center">
  Stop treating agent safety boundaries as wishful thinking inside a prompt.<br>
  Amos enforces deterministic rules in the harness—before an action takes effect.
</p>

<p align="center">
  <code>Stage A</code> · log-only · OpenCode V2 + Pi
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

## Why Amos?

Today, most agent safety rules live as plain English inside `AGENTS.md` or system prompts. Natural language is great for expressing intent, but relying on a paragraph of text to stop a destructive tool call is a gamble:

1. **Compliance is a coin toss** — Model obedience is probabilistic, never an engineering guarantee.
2. **Attention dilution** — The more rules you pile on, the easier each one gets ignored (*Lost-in-the-Middle*).
3. **Context truncation** — When the context window fills up, rules get silently dropped with no safety criteria.

**Amos flips the model: the agent proposes, the harness disposes.**

Every action passes through a deterministic policy engine before causing side effects. Hard boundaries are enforced by code; only soft preferences go into the prompt.

---

## How It Works

```text
Model proposes an action
       │
       ▼
Interceptor: normalize into (tool, operation, target)
       │
       ▼
Policy engine: evaluate deterministic match conditions → combine verdicts
       │
       ├─ deny    → block side effects, write to audit log
       ├─ confirm → show structured summary, wait for human sign-off
       ├─ log     → allow through, record "what would have happened"
       └─ allow   → allow through
```

### 4 Core Design Principles

- **Structured interception, immune to prompt injection**: The engine only inspects normalized envelopes (`tool`, `operation`, `target`), never free text. Precedence is strictly `deny > confirm > log > allow` (and fail-closed on errors). No clever reasoning from the model can override a verdict.
- **Hard vs. soft constraints**: Rules with deterministic match conditions (`predicate`) are enforced by the engine. Rules that can't be expressed deterministically are marked `advisory_only` and projected into `AGENTS.md` as guidance.
- **Evidence-backed rules**: Every rule must cite a concrete threat scenario or incident (`source`) and a test `probe`—no gut-feeling rules.
- **Proposals, never direct writes**: Agents can propose rule changes, not write them. Tightening a rule takes effect with a mandatory TTL; relaxing a rule requires human approval; Level-0 core invariants are strictly untouchable.

---

## Current Status (Stage A: Log-only)

A safety system that triggers a "deny storm" on day one just gets turned off by frustrated users. Amos rolls out in four stages:

- [x] **Stage A (Current)**: `log-only` observation—run against real workflows to catch false positives.
- [ ] **Stage B**: Selective Level-0 blocking (`deny`), followed by human confirmation (`confirm`).
- [ ] **Stage C**: Rule proposal queue, human approval workflow, Git audit trail, and TTL expiration.
- [ ] **Stage D**: Rebuildable SQLite read model and local web governance console.

**What's ready today**:
- **Policy Engine**: Pure TypeScript engine, 7 frozen match operators, 15 initial rules, and 142 passing tests.
- **Adapters**: `log-only` adapters for **OpenCode V2** and **Pi** (covering file read/write/search operations without logging file contents or blocking live calls).
- **Review Queue Generator**: Stratified sampling CLI that turns raw JSONL audit logs into human review worksheets.

*(The G0 go/no-go gate is scheduled for human review on 2026-10-30; see [docs/go-no-go.md](docs/go-no-go.md).)*

---

## Quick Start

Requires Node.js 26 and npm:

```bash
npm ci
npm run build
npm test
```

### 1. Run with OpenCode V2 (log-only)

The root `opencode.jsonc` is pre-configured. Run `npm run build`, then launch OpenCode V2 from this directory. It will quietly log hypothetical verdicts to `spike/logs/opencode.jsonl` without interrupting your workflow.

*(The Pi adapter lives in `adapters/pi/`; see the [Pi Adapter Guide](docs/pi-adapter.md).)*

### 2. Generate a Review Worksheet

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

---

## Repository Layout & Docs

```text
constraints/   Rule table (rules.yaml), JSON Schema, and operator vocabulary
engine/        Pure-function policy engine and unit tests
fixtures/      Language-neutral adjudication test fixtures
adapters/      Log-only adapters for OpenCode V2 and Pi
storage/       In-memory snapshots, JSONL logger, and review queue builder
spike/         Harness seam notes, real session logs, and review worksheets
docs/          Architecture decisions and gate criteria
```

For deep dives into our architectural trade-offs (including inspirations from Karpathy's `llm-wiki`, `obelisk`, and `iptables`), check out the docs *(currently in Chinese)*:

- [Product & Engineering Decisions](docs/decisions.md)
- [G0 Go/No-Go Checklist](docs/go-no-go.md)
- [Fixture Coverage](docs/fixture-coverage.md) · [Advisory Translation Gaps](docs/translation-notes.md)
- [OpenCode V2 Seam Notes](spike/README.md) · [Pi Adapter Guide](docs/pi-adapter.md)
- [Full Design Document (Notion)](https://app.notion.com/p/eb784af41d4f834f8cb881cb913f7601)

---

<p align="center">
  <sub>Constraints shouldn't be wishes written in a prompt; they should be a deterministic gate before an action happens.</sub>
</p>
