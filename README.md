<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent Mandate &amp; Oversight System</strong>
</p>

<p align="center">
  Stop treating agent safety boundaries as wishful thinking tucked inside a prompt.<br>
  Amos turns behavioral constraints into evidence-backed, auditable, expirable, and testable engineering assets—enforced directly by the harness.
</p>

<p align="center">
  <code>Stage A</code> · log-only · OpenCode V2 + Pi
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

> Constraints shouldn't just live in prompts. They need to be enforced before an action takes effect.

The name Project-Amos (AMOS) stands for **A**gent **M**andate & **O**versight **S**ystem. As the name implies, it is about mandate and oversight, not intelligence. We are not trying to make models smarter; we are making sure their actions stay within bounds.

## Why Amos?

Today, most agent behavioral rules are still written in plain English inside `AGENTS.md` files, system prompts, and project docs. Natural language is great for expressing intent, but relying on a paragraph of text to stop a destructive tool call is wishful thinking. That approach has three structural flaws:

1. **Compliance is a coin toss** — Whether the model listens is a matter of probability, never an engineering guarantee.
2. **Attention dilution** — The more rules you pile on, the less weight each individual rule carries (the classic *Lost-in-the-Middle* problem).
3. **Context compression loss** — When the context window fills up, something gets truncated—and there is no principled way to know which safety rule just got dropped on the cutting-room floor.

Amos shifts constraints from polite reminders to deterministic mechanisms. The model proposes an action; the harness disposes of it—making a hard, deterministic call before any side effect hits the system. Hard boundaries are enforced by the policy engine; only soft preferences go into the prompt context.

### Core Principles

- **The model proposes; the harness disposes.** Every action runs through a deterministic policy engine before execution. If the engine says no, no amount of clever reasoning from the model can talk its way past the verdict.
- **Hard rules require deterministic match conditions (`predicate`).** Natural-language descriptions (`narrative`) exist as an advisory view for humans and prompts. If a rule cannot be expressed as a deterministic check, it is marked `advisory_only` rather than shoehorned into a brittle heuristic.
- **The constraint table is the single source of truth.** The policy engine defines its execution semantics, Git tracks its history, and the governance workflow controls who gets to write to it.
- **Activation and injection are decoupled.** Rules flow from the *global rule library* → *project activation set* → *current task injection set*. Activation determines which rules apply to a repo; injection merely decides which reminders the model sees right now. **A hard rule is enforced whether or not it was injected into the current prompt.**
- **Rules are compiled from evidence.** Every rule must cite a concrete threat model, incident report, or probe result. When that underlying evidence goes away, the rule is flagged for review instead of quietly lingering as dead weight.
- **Agents may propose changes, never write them directly.** Modifying the constraint table is itself a governed action. Any attempt to touch Level-0 hard invariants is rejected outright.
- **Safety never leans on attention.** No fine-tuning, no attention surgery, and no hoping that ALL-CAPS prompts will save the day.

### Hard vs. Soft Constraints

| | Hard Constraints | Soft Constraints |
| --- | --- | --- |
| **Carrier** | `predicate` + `on_hit` | `narrative` |
| **Enforced by** | Policy engine | Prompt context |
| **When it runs** | **Before** an action causes side effects | When the model reads context |
| **Failure mode** | Fail-closed (deny by default) | The model may ignore it |
| **Governance** | Level 0 is immutable; changes require proposals | Routed dynamically by project and task |

### How does this relate to AGENTS.md?

Amos is a projection, not a replacement. Project know-how—how to build, test, and navigate the repo—still belongs in `AGENTS.md`. Meanwhile, the `narrative` column of the constraint table renders by dimension to generate or update the constraints section of `AGENTS.md`. Putting hard safety boundaries *only* in `AGENTS.md` leaves enforcement up to model goodwill—a category error in system design.

## How It Works

Below is the full target architecture. Right now, **Stage A** implements the observation pipeline: the engine evaluates every action for real, but verdicts are only logged—no live tool calls are blocked yet.

### Lifecycle of an Action

```text
Model proposes an action
       │
       ▼
Interceptor: normalize into envelope (tool, operation, target)
       │
       ▼
Policy engine: load project activation snapshot → match conditions → combine verdicts
       │
       ├─ deny    → block side effects, write to audit log
       ├─ confirm → surface structured summary, wait for human sign-off
       ├─ log     → allow through, record "what would have happened"
       └─ allow   → allow through
       │
       ▼
Harness / sandbox executes → append to raw JSONL audit log
```

One crucial detail: **the interceptor only inspects the structured action envelope, never free-form text.** That keeps routing and adjudication insulated from prompt injection. To hijack routing, an attacker would have to forge the tool name itself—and tool names are controlled by the harness parser, not the prompt.

### Anatomy of a Rule

Every rule has three core fields:

- `predicate`: the deterministic match condition evaluated by the engine;
- `on_hit`: what happens on a match (`deny` / `confirm` / `log`);
- `narrative`: the human- and model-readable explanation.

In code, the field is named `predicate`; in prose, we call it a **match condition**.

Milestone G0 freezes a closed vocabulary of 7 match-condition operators: `op_in`, `target_glob`, `target_outside_glob`, `url_query_key_in`, `target_scheme_in`, `target_host_in`, and `target_host_not_in`. There are no variables, scripts, nested boolean trees, regular expressions, or free-text matchers. If a condition cannot be expressed cleanly with those 7 operators, the rule is marked `advisory_only`—we never guess intent by scraping the target string.

### Three Distinct Sets—Don't Mix Them

| Set | What It Decides | Consumed By |
| --- | --- | --- |
| **Global rule library** | Which candidate rules exist in the system | Governance and activation |
| **Project activation set** | Which rules apply to this specific repository | Policy engine and `narrative` routing |
| **Current task injection set** | Which soft reminders the model needs right now | Prompt context |

The engine enforces every hard rule in the **project activation set**, regardless of whether its narrative was injected into the current prompt. Dynamic injection is there to cut prompt noise, never to shrink the enforcement boundary.

Activation works at the individual rule level via tags and `exclude_rules`, rather than flipping entire dimensions on or off. Turning a rule on tightens policy and takes effect automatically; turning an active rule off relaxes policy and requires human approval. If environment detection fails, Amos falls back to the last valid activation snapshot rather than failing open.

### Combining Multiple Verdicts

- **Precedence**: `deny > confirm > log > allow`;
- **Ties at the same level**: `deny` always wins;
- **Malformed input, unknown operators, parse errors, or internal engine faults**: `deny` (strictly fail-closed).

### Governance: Proposals, Never Direct Writes

Updating the rule table goes through the exact same harness oversight as any other action:

- **Add / tighten a rule** → takes effect automatically, requires a mandatory TTL, and leaves a Git trace;
- **Relax / delete / downgrade a rule** → generates a structured diff summary and waits for human approval;
- **Touch Level 0** → rejected outright, logged as a privilege violation, and immediately revokes the session's proposal privileges;
- **TTL expires** → reverts automatically, with no nagging prompts and no auto-renewal.

Crucially, the free-text "reason" field in a proposal is **never** trusted for automated approval—it could easily be carrying a prompt injection payload. Both `confirm` prompts and approval views show strictly structured summaries (tool, parameters, target, matched rules), never persuasive essays written by the model.

### Sources of Truth, Snapshots, and Logs

- **YAML is the source of truth for rules.** Validated on load against a JSON Schema and a closed operator vocabulary, keeping rules human-readable, diff-friendly, and easy to review in PRs.
- **JSONL is the source of truth for raw audit logs.** Strictly append-only. Review queues and sample sets can be rebuilt from it at any time, and nothing ever writes back to mutate the raw log.
- **SQLite (Stage D) is purely a disposable read model.** It can be deleted and rebuilt from scratch, and it **never** sits on the enforcement hot path. During evaluation, the engine reads from a deeply frozen in-memory snapshot.
- **Bad reloads keep the last known-good snapshot.** A botched config change won't leave a running session half-protected; if the very first load fails at startup, the system logs the failure and stays fail-closed.

### Cold-Start Rollout: Why Not Block on Day One?

1. **Log-only**: Record "what would have happened" against real workflows to surface false positives early;
2. **Selective enforcement**: Turn on real `deny` verdicts strictly for Level-0 invariants;
3. **Human confirmation (`confirm`)**: Gate irreversible side effects behind human sign-off;
4. **Full governance**: Enable the proposal queue, TTL expiration, and Git-backed lifecycle.

Skipping straight to full enforcement almost always triggers a "deny storm"—until frustrated developers simply disable the tool. **A safety system that gets turned off is worse than having no safety system at all.**

## Where Things Stand Today

Amos is currently in **Stage A: log-only validation**. Live blocking (`deny`), interactive confirmation (`confirm`), proposal governance, the SQLite read model, and the local web console are not enabled yet.

| Component | Current Status | Where to Look |
| --- | --- | --- |
| **Rule table** | 15 initial rules across 5 dimensions | `constraints/rules.yaml` |
| **Match-condition vocabulary** | 7 operators, frozen for G0 | `constraints/vocabulary.md` |
| **Rule validation** | JSON Schema + loader semantic checks | `constraints/schema.json` |
| **Policy engine** | Pure TypeScript function, injected clock, fail-closed | `engine/engine.ts` |
| **Language-neutral fixtures** | Covers match conditions, multi-hit, TTL, and malformed input | `fixtures/` |
| **In-memory snapshot** | Deeply frozen; bad reloads fall back to last good state | `storage/snapshot.ts` |
| **Audit log** | Append-only JSONL + structured error taxonomy | `storage/jsonl.ts` |
| **OpenCode V2 adapter** | Compiled log-only plugin with real session traces | `adapters/opencode-v2/`, `spike/` |
| **Pi adapter** | Compiled log-only extension (real CLI trace pending provider setup) | `adapters/pi/`, `docs/pi-adapter.md` |
| **Review worksheet builder** | Stratified sampling; refuses to clobber existing human reviews | `storage/audit-review.ts` |
| **Test suite** | 142 tests passing | `npm test` |

Out of the initial 15 rules, 10 use deterministic match conditions and 5 are `advisory_only`. By declared `on_hit` action, 11 are `deny`, 3 are `confirm`, and 1 is `log` (`advisory_only` rules never enter hard adjudication). Every rule carries a concrete `source` reference and a tempting-violation `probe`—each started life as a real threat scenario before being distilled into an executable check.

On the integration side, the OpenCode adapter currently covers file operations: `read` → `file_read`, `write` / `edit` → `file_write`, `glob` / `grep` → `file_search`, and `list` → `file_list`. The Pi adapter maps the equivalent file tools under its own naming conventions and logs `bash` / `user_bash` calls as `shell_input` (omitting command text for privacy and safety). Target paths are normalized to absolute paths (including `~` expansion); any path still containing uncollapsed `.`, `..`, or `//` segments is rejected by the engine rather than treated as a non-match. File contents are never read or logged, and unknown payloads or parse failures are recorded explicitly. Both hooks remain strictly observational: neither mutates tool inputs, returns verdicts upstream, or blocks execution. Network rules like `http_request` are implemented in the engine and fixtures but not yet wired into live hooks. OpenCode currently skips shell commands, and patch operations remain unstructured in both adapters.

The human review worksheet is generated directly from raw JSONL logs using stratified sampling: 100% of Level-0 hits, 100% of non-Level-0 denies, 100% of errors and coverage gaps, and a coverage-weighted sample of `confirm` verdicts across tools and rules. The current baseline worksheet covers 158 raw records: 1 Level-0 hit, 0 non-Level-0 denies, 35 errors/gaps, and 20 sampled `confirm` records (out of 65). The generator only builds the review queue—it never auto-judges false positives, and it refuses to overwrite any file that already contains human sign-offs.

**Not yet enabled**: live `deny` / `confirm` enforcement, OpenCode shell hooks, structured patch parsing in either adapter, project activation snapshots and `narrative` routing, the proposal queue, TTL cleanup, SQLite, the local web governance console, and automated probe dashboards. Pi is also awaiting a live CLI session sample.

The G0 (go/no-go) gate is scheduled for human review on **2026-10-30**. Current status: **undecided**—agents do not get to grade their own homework. See [docs/go-no-go.md](docs/go-no-go.md) for the checklist.

## Design Inspirations

The earliest rules grew out of threat-modeling sessions for Termcp: we wrote down concrete scenarios where an agent action would cause unacceptable damage, then worked backward to extract deterministic match conditions.

### 1. llm-wiki: Constraints as Compiled Artifacts

Karpathy's `llm-wiki` concept is the most direct philosophical influence on Amos. Its core tenets map almost one-to-one:

| llm-wiki | Project-Amos |
| --- | --- |
| **Atomic** | A single rule is the smallest self-contained unit |
| **Data-driven** | Rules are compiled from threat models, incidents, and probes—never gut feelings |
| **Grounded** | `source` is a required citation, not optional commentary |
| **Non-destructive evolution** | Changes happen via ADD/FIX proposals with full Git history; TTL is simply an ADD with an expiration date |
| **Promotion pipeline** | Idea → experimental rule (TTL + log-only) → probe evidence → hard enforcement |

We make two deliberate departures for security: first, the enforcement engine never chases a moving target—it loads a pinned project activation snapshot (think lockfile semantics). Second, rule promotion is decided by empirical probe results, not editorial consensus. Put simply: **llm-wiki stores facts; Amos stores norms.**

### 2. obelisk: Read Side vs. Write Side

[tommy0103/obelisk](https://github.com/tommy0103/obelisk) is a session-history retrieval layer for coding agents: it normalizes session JSONL logs from multiple agents into a single database, offering a CLI for agents and a web UI for humans. **If obelisk governs what agents remember, Amos governs what agents are forbidden to do.** They sit on opposite sides—read vs. write—of the same architectural coin.

Patterns we borrowed:

- **Single-schema normalization + dual audience**: Agents query via CLI; humans audit via UI.
- **Projecting N harnesses into one envelope**: OpenCode and Pi each normalize events into the same action envelope, without pretending to be a universal agent framework.
- **Proposal workflow**: Obelisk's memory loop (*agent proposes → human approves → register → recall*) maps naturally onto rule governance.
- **Layered read API**: Typed helpers for everyday queries, with raw queries kept as an escape hatch.

Lines we deliberately refuse to cross:

- **No database reads on the hot path**: A slow or corrupted read-side database is an annoyance; on a fail-closed enforcement path, a corrupted database means an instant fleet-wide DoS.
- **No arbitrary JS query surface on the enforcement side**: Expressive queries belong exclusively on the audit/read side.
- **No Electron**: The human console will be a lightweight local web server—and not on day one. UI renders state, so state must be solid before any UI exists.
- **Zero AGPL contamination**: We studied only public READMEs, docs, and ADRs, building the codebase via clean-room implementation so the spec and conformance suite remain permissively licensed from day one.

### 3. Jev: Strictly Advisory

Jev (TypeSafe AI's System One decision model) is restricted to four purely **advisory** roles: semantic routing, proposal pre-classification, probe evaluation (*Jev-as-a-Judge*), and mapping natural-language intent to match-condition templates. It never enters the policy engine, never approves proposals, and never touches Level 0. Model `confidence` is not system `permission`—an opaque model never gets a vote on the adjudication path.

### 4. Other Touchstones

- **iptables / firewall semantics**: `narrative` routing inspects only the structured envelope, matching via exact + glob rules with specificity precedence, and failing open to all active project soft constraints when nothing matches. Think of it as **"iptables for prompt narratives."**
- **Lost-in-the-Middle (Liu et al., 2023)**: Empirical proof that the more constraints you stuff into the middle of a prompt, the more likely the model is to ignore them. That finding justifies both dynamic narrative injection and decoupling activation from injection—while reminding us why hard safety can never live in a prompt.
- **AGENTS.md**: Separating conventions from enforcement. `AGENTS.md` remains the front door for project context, while its constraints section becomes an automated, advisory projection of the Amos rule table.

## Quick Start

Requirements: Node.js 26 and npm. (You only need OpenCode V2 or Pi installed if you want to run their live adapters.)

```bash
npm ci
npm run build
npm test
npm run typecheck
```

Note: `npm test` compiles the TypeScript project first, then runs the test suite against the compiled JS output.

### Try the OpenCode V2 Adapter (log-only)

```bash
npm run build
```

The root `opencode.jsonc` is pre-configured to load the compiled plugin from `dist/adapters/opencode-v2/`, passing the rules file, schema, log path, and `log-only` mode explicitly. Once built, simply launch OpenCode V2 from this repository root. The plugin quietly records hypothetical verdicts without interrupting any tool calls, writing live audit entries to `spike/logs/opencode.jsonl` (git-ignored).

The Pi adapter lives under `adapters/pi/` and likewise runs strictly in `log-only` mode.

### Generate a Human Review Worksheet

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

The `--output` path must point to a new, non-existent file so the CLI never overwrites existing human review notes. You can pass `--log` multiple times to aggregate historical log archives into a single review queue.

## Repository Layout

```text
constraints/       Rule table, JSON Schema, and closed operator vocabulary
engine/            Pure-function policy engine and unit tests
fixtures/          Language-neutral adjudication test fixtures
adapters/          Normalization layers and log-only hooks for OpenCode V2 and Pi
storage/           In-memory snapshots, JSONL logger, and review queue generator
spike/             Harness seam notes, real session logs, and human review worksheets
docs/              Architecture decisions, G0 gate criteria, and coverage notes
```

## Documentation

*(Note: Internal engineering docs below are currently written in Chinese.)*

- [Product and Engineering Decisions](docs/decisions.md)
- [G0 Go/No-Go Checklist](docs/go-no-go.md)
- [Fixture Coverage Notes](docs/fixture-coverage.md)
- [Advisory-Only Translation Gaps](docs/translation-notes.md)
- [OpenCode V2 Log-Only Seam Notes](spike/README.md)
- [Pi Log-Only Adapter Guide](docs/pi-adapter.md)
- [Architecture Design Doc (Notion)](https://app.notion.com/p/eb784af41d4f834f8cb881cb913f7601)
- [中文 README](README.zh-CN.md)

## Scope & Boundaries

Our current focus is a rock-solid, **single-machine, single-trust-root** governance loop built for individual developers and tightly controlled agent fleets. Multi-device sync and team workflows (including hosted or cloud-assisted setups) belong to future milestones, not the current deliverable.

Milestone gates:

- **Stage A (Current)**: `log-only` observation, real session traces, and false-positive human review.
- **Stage B**: Selective Level-0 hard blocking (`deny`), followed by interactive human confirmation (`confirm`).
- **Stage C**: Rule proposal queue, human sign-off workflow, Git-backed audit trails, and automatic TTL expiration.
- **Stage D**: Rebuildable SQLite read model and a lightweight local web governance console.

Right now, we ship `log-only` adapters exclusively for OpenCode V2 and Pi. We explicitly **do not** build prompt-engineering tricks for soft constraints, third-party harness adapters beyond those two, LLM-based judges on the hot path, custom match-condition DSLs, regex routers, or a "rule marketplace." Above all, we never compromise `deny > confirm > log > allow` precedence, same-level deny tie-breaking, or fail-closed semantics for the sake of architectural aesthetics.

---

<p align="center">
  <sub>Constraints shouldn't be wishes written in a prompt; they should be a deterministic gate before an action happens.</sub>
</p>
