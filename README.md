<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong>
</p>

<p align="center">
  Turn agent behavioral constraints from wishes written in a prompt into engineering assets that are evidence-backed, approved, expirable, evaluable, and enforced by the harness.
</p>

<p align="center">
  <code>Stage A</code> · log-only · OpenCode V2
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

> Constraints should not live only in prompts. They should be enforced before an action happens.

The name Project-Amos (AMOS) comes from **A**gent **M**andate & **O**versight **S**ystem: it is about mandate and oversight, not intelligence. It does not try to make models smarter; it tries to make their actions more constrainable.

## Vision

Today, many agent behavior rules are still expressed primarily as natural language in `AGENTS.md` files, system prompts, and project documentation. Natural language is effective at communicating intent, but it cannot, by itself, guarantee enforcement when an agent acts. This approach has three structural flaws:

1. **Compliance depends on the model** — probability, not a guarantee;
2. **Attention dilution** — the more constraints there are, the less likely each one is followed (Lost-in-the-Middle);
3. **Compression loss** — when context does not fit, something must be cut, and there is no criterion for what to cut.

Amos turns constraints from “reminders” into “mechanisms”: the model only proposes actions; the harness makes a deterministic decision before an action has side effects. Hard boundaries are enforced by the engine; only soft preferences enter the context.

### Core positions

- **The model is the proposer; the harness is the disposer.** Every action passes through the deterministic policy engine before execution; the model cannot override a verdict with its own explanation.
- **Enforceable rules need a deterministic match condition** (machine field: `predicate`). The natural-language `narrative` is an advisory view for humans and prompts. Rules that cannot be expressed deterministically are marked `advisory_only` rather than forced into a fake condition.
- **The constraint table is the single core data structure.** The engine is its execution semantics, git is its history, and the governance process is its write permission.
- **Activation and injection are separate.** Global rule library → project activation set → current task injection set. Activation decides whether a rule applies to the project; injection decides which reminders the model sees right now. Whether a hard rule is enforced does not depend on whether it was injected.
- **Rules are compiled from evidence.** Every rule must reference a threat model, incident, or probe result. When the evidence disappears, the rule should be flagged for review instead of quietly outliving its justification.
- **Agents may propose table changes, but cannot write directly.** Changing the table is itself a governed action; attempts to touch level-0 hard invariants are rejected outright.
- **Hard constraints do not rely on attention.** No fine-tuning, no attention surgery, and no delegating safety to a more prominent prompt.

### Hard vs. soft constraints

| | Hard constraints | Soft constraints |
| --- | --- | --- |
| Carrier | `predicate` + `on_hit` | `narrative` |
| Executor | policy engine | prompt context |
| When it takes effect | before an action has side effects | when the model reads context |
| Failure mode | fail-closed: deny by default | the model may ignore it |
| Governance | level 0 is untouchable; changes go through proposals | routable by project and task |

### Relationship to AGENTS.md

Not a replacement — a projection. Project knowledge (how to build and test) still belongs in `AGENTS.md`; the `narrative` column renders by dimension and generates or updates the constraint section of `AGENTS.md`. Hard constraints written only in `AGENTS.md` can rely only on model compliance or external checks; that is a category error.

## How it works

The following is the target design. Stage A implements only the observation part: the engine still evaluates, but every result is logged and no real tool call is blocked.

### Lifecycle of an action

```text
Model proposes an action
      │
      ▼
Interceptor: normalize to (tool, operation, target)
      │
      ▼
Policy engine: load project activation snapshot → match conditions → combine verdicts
      │
      ├─ deny    → block side effects, log
      ├─ confirm → show structured summary, wait for a human
      ├─ log     → allow, record “what would have happened”
      └─ allow   → allow
      │
      ▼
harness / sandbox executes → append JSONL audit log
```

The interceptor consumes only the structured envelope, never free text. That is why routing and adjudication are not directly exposed to prompt injection: to manipulate routing, an attacker would have to change the tool name itself, and tool names are controlled by the harness parser.

### How rules are expressed

Every rule has at least three parts:

- `predicate`: the deterministic match condition for the engine;
- `on_hit`: `deny` / `confirm` / `log`;
- `narrative`: the explanation for humans and models.

The machine field remains `predicate`; in prose we call it a match condition.

G0 froze 7 match-condition operators: `op_in`, `target_glob`, `target_outside_glob`, `url_query_key_in`, `target_scheme_in`, `target_host_in`, and `target_host_not_in`. There are no variables, scripts, nested boolean expressions, regex, or free-text conditions. States that cannot be expressed are marked `advisory_only`; we do not guess them from the target.

### Three sets, do not mix them

| Set | Decides | Consumed by |
| --- | --- | --- |
| Global rule library | which candidate rules exist | governance and activation |
| Project activation set | which rules matter in this project | the engine and narrative routing |
| Current task injection set | which soft constraints to remind the model about now | prompt context |

The engine enforces every hard rule in the project activation set, whether or not it was injected; injection only reduces noise, it does not change the enforcement surface. Activation is per rule via tags / `exclude_rules`; it cannot be an all-or-nothing dimension switch. Activating a rule counts as tightening; disabling or excluding an active rule counts as relaxing and requires human approval. If detection fails, keep the last valid activation snapshot; do not auto-disable.

### How verdicts combine

- Multiple hits: `deny > confirm > log > allow`;
- Same-level conflict: `deny` wins;
- Invalid input, unknown match-condition operator, parse failure, and internal engine errors: `deny` (fail-closed).

### Governance: proposals, not writes

Changing the table goes through the same harness as any other action:

- Add / tighten → effective automatically, mandatory TTL, git trace;
- Relax / delete / downgrade → structured diff summary → human approval;
- Touch level 0 → rejected outright + privilege log; one attempt revokes the session’s table-write permission;
- TTL expires → automatic revert, no reminder, no renewal.

The proposal’s “reason” field is not used for automatic approval — it may be an injection artifact. Confirm and approval views show only structured summaries (tool, parameters, target, matched rules), never persuasive prose written by the model.

### Sources of truth, snapshots, and logs

- **YAML is the source of truth for rules.** JSON Schema and the closed vocabulary are validated in the loader; rules are readable, diffable, and reviewable.
- **JSONL is the source of truth for raw audit.** Append-only, never rewritten; derived samples and review worksheets can be rebuilt, but never written back to the raw log.
- **SQLite is only a deletable, rebuildable derived read model in Stage D.** It never enters the hot path; the engine loads a deeply frozen in-memory snapshot.
- **Snapshot failure keeps the last good version.** An invalid reload cannot leave the system half-broken; a first-load failure is logged as fail-closed.

### Cold start

1. **log-only**: record “what would have happened” and collect false positives from real task flows;
2. **Selective enforcement**: deny only level 0;
3. **confirm**: irreversible side effects require human confirmation;
4. **Governance**: proposal queue, TTL, git governance.

Skipping steps usually ends in a deny storm, then users turn the system off. **A safety system that gets turned off is worse than none.**

## What exists today

Currently in **Stage A: log-only validation**. Real deny, confirm, proposal governance, the SQLite read model, and the local web governance console are not enabled.

| Part | Status | Evidence |
| --- | --- | --- |
| Rule table | 15 rules, 5 dimensions | `constraints/rules.yaml` |
| Match-condition vocabulary | 7 operators, frozen | `constraints/vocabulary.md` |
| Rule validation | JSON Schema + loader semantic checks | `constraints/schema.json` |
| Engine | TypeScript pure function, injected clock, fail-closed | `engine/engine.ts` |
| Language-neutral fixtures | match conditions, multi-hit, TTL, invalid input | `fixtures/` |
| Snapshot | deeply frozen; invalid reload keeps the last good version | `storage/snapshot.ts` |
| Audit log | append-only JSONL + error classification | `storage/jsonl.ts` |
| OpenCode V2 | compiled log-only plugin; real session sample | `adapters/opencode-v2/`, `spike/` |
| Review worksheet | stratified sampling; refuses to overwrite existing conclusions | `storage/audit-review.ts` |
| Tests | 109 passing | `npm test` |

Of the first 15 rules, 10 are deterministic and 5 are `advisory_only`; by declared `on_hit`, 11 are marked `deny`, 3 are marked `confirm`, and 1 is marked `log` (`advisory_only` rules never enter hard adjudication). Every rule has a concrete `source` reference and a tempting-violation `probe`; the first constraints started as threat scenarios and were then turned into executable match conditions.

The live seam currently covers only the file channel: `read` → `file_read`, `write` / `edit` → `file_write`, `glob` / `grep` → `file_search`, and `list` → `file_list`. Targets are normalized to absolute paths; file contents are neither read nor logged; unknown payloads and parse failures are recorded explicitly, never silently ignored. The hook does not mutate input, return a verdict, or block tool calls. `http_request` and other network rules are present in the engine and fixtures but not wired into the live hook; shell, patch, and other write paths remain uncovered.

The review worksheet is derived from raw JSONL: all level-0 hits, all non-level-0 denies, confirm sampled with tool/rule coverage first, and all errors and coverage gaps. The current worksheet (at generation time) covers 158 records: 1 level-0 hit, 0 non-level-0 denies, 35 errors/gaps, and 20 of 65 confirm records sampled. It only builds a queue; it does not decide false positives or approvals. Output refuses to overwrite a file that already contains human conclusions.

**Not yet enabled**: real deny / confirm, shell and patch write paths, project activation snapshot and narrative routing, proposal queue, TTL cleanup, SQLite, local web governance console, second harness, and probe execution with violation/false-positive dashboards.

The G0 (go/no-go) gate is scheduled for **2026-10-30**; humans check each item. Current status: **not decided**. Agents do not self-approve. See [docs/go-no-go.md](docs/go-no-go.md).

## Inspiration

The first constraints were inspired by designing the Termcp threat model: write down “what behavior would cause unacceptable consequences” as threat scenarios, then distill executable match conditions from them.

### llm-wiki: constraints as compiled artifacts

Karpathy’s llm-wiki philosophy is the most direct philosophical reference for this design. Its core principles map almost one-to-one:

| llm-wiki | Project-Amos |
| --- | --- |
| Atomic | one rule is the smallest unit |
| Data-driven | rules are compiled from threat models, incidents, and probes, not written from intuition |
| Grounding | `source` is a mandatory reference, not decoration |
| Non-destructive evolution | proposals are ADD/FIX, git keeps the full trace, TTL is an ADD with an explicit expiry |
| Promotion pipeline | idea → experimental rule (TTL + log-only) → probe evidence → enforcement layer |

Two amendments: the enforcement point does not chase a living wiki — the engine loads a pinned project activation snapshot (lockfile semantics); and whether a rule is promoted is decided by probes, not editorial consensus. In one line: **llm-wiki stores facts; Amos stores norms.**

### obelisk: the read side and the write side

[tommy0103/obelisk](https://github.com/tommy0103/obelisk) is an agent history retrieval layer: it normalizes session JSONL from multiple coding agents into one database and gives agents a CLI and humans a browsing UI. It governs what agents remember; Amos governs what agents must not do. They are the read and write sides of the same architecture.

Borrowed patterns:

- Single-database normalization + dual audience: agents query through a CLI, humans review through a UI;
- Project N provider formats into a shared schema: this maps to how a second harness could normalize heterogeneous actions in the future; we do not reserve an empty interface or implement a second adapter today;
- The memory layer’s “agent proposes → human approves → register → recall later” is a ready prototype for the proposal pipeline;
- A layered read API: typed helpers first, raw queries as an escape hatch.

Boundaries we do not borrow:

- **Hot-path database reads**: the read side can be slow and can fail; on the enforcement side, a corrupt database under fail-closed equals a fleet-wide DoS;
- **An arbitrary JS query surface**: only on the audit/read side, never on the enforcement side;
- **Electron**: the human console is a local web service, not a desktop app; and not on day one — the UI renders state, and state must exist before the UI;
- **AGPL contamination**: read only its README/docs/ADR, clean-room rewrite the code, and use a permissive license for the spec and conformance suite from day one.

### Jev: an advisory seat only

Jev (TypeSafe AI’s System One decision model) appears only in four advisory positions: semantic routing, proposal pre-classification, probe evaluation (Jev-as-a-Judge), and intent-to-match-condition-template routing. It never enters the engine, never approves, and never touches level 0. `confidence` is not `permission`; a model with weak explainability never gets a seat at the adjudication table.

### Other references

- **iptables / firewall semantics**: narrative routing inspects only the structured envelope, uses exact + glob matching, and prefers specificity; on no match it fails open to all active soft constraints for the project. Think of it as “iptables for narratives”.
- **Lost-in-the-Middle (Liu et al., 2023)**: the more constraints there are, and the more central their position, the more likely they are to be ignored. This is the reason for dynamic injection and activation/injection separation, not a reason to delegate enforcement to prompts.
- **AGENTS.md**: convention and enforcement mechanism are separate. `AGENTS.md` remains the entry point for project knowledge; its constraint section becomes an advisory projection of the rule table.

## Quick start

Requirements: Node.js 26, npm; OpenCode V2 is needed only to run the adapter.

```bash
npm ci
npm run build
npm test
npm run typecheck
```

`npm test` builds first, then runs the compiled JavaScript tests.

### Integrate with OpenCode V2 in log-only mode

```bash
npm run build
```

The root `opencode.jsonc` loads the plugin from `dist/adapters/opencode-v2/`, passing the rules, schema, log path, and `log-only` mode explicitly. Start OpenCode V2 from this directory afterward. The plugin only records hypothetical verdicts and does not block real tool calls; the live log is written to `spike/logs/opencode.jsonl` (git-ignored).

### Generate a review worksheet

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

Output must be a new file that does not exist, so human conclusions are never overwritten. Historical archives can be passed with repeated `--log` flags.

## Repository layout

```text
constraints/       rules, JSON Schema, closed vocabulary
engine/            pure-function engine and tests
fixtures/          language-neutral verdict fixtures
adapters/          OpenCode V2 normalization and hook
storage/           snapshot, JSONL, review queue
spike/             seam notes, real log samples, human review material
docs/              decisions, gates, and coverage notes
```

## Documentation

The documents below are currently in Chinese.

- [Product and engineering decisions](docs/decisions.md)
- [G0 go/no-go](docs/go-no-go.md)
- [Fixture coverage](docs/fixture-coverage.md)
- [Advisory-only translation gaps](docs/translation-notes.md)
- [OpenCode V2 log-only seam](spike/README.md)
- [Design document (Notion)](https://app.notion.com/p/eb784af41d4f834f8cb881cb913f7601)
- [中文 README](README.zh-CN.md)

## Boundaries

The goal is a single-machine, single-trust-root governance loop for individuals and closed fleets: no multi-user, SaaS, or cloud control plane.

Stage gates:

- **Stage A** (current): log-only, real logs, and false-positive review.
- **Stage B**: selective level-0 enforcement, then confirm.
- **Stage C**: proposals, human approval, git governance, and TTL.
- **Stage D**: SQLite derived read model and a local web governance console.

Currently only the OpenCode V2 adapter is delivered. No prompt-engineering soft constraints, second harness, multi-user support, SaaS, cloud control plane, LLM adjudication, custom match-condition DSL, regex routing, or rule marketplace. Do not change `deny > confirm > log > allow`, same-level deny, or fail-closed semantics for architectural aesthetics.

---

<p align="center">
  <sub>Constraints should not be wishes written in a prompt; they should be a deterministic check before an action happens.</sub>
</p>
