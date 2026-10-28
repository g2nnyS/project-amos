<h1 align="center">Project-Amos</h1>

<p align="center">
  <strong>Agent policy matching and audit prototype</strong>
</p>

<p align="center">
  <code>Stage A</code> · log-only · OpenCode V2 + Pi<br>
  <strong>Status: NO-GO for runtime enforcement</strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">中文</a>
</p>

---

## What this is

Amos is an experiment in moving agent constraints out of prompts and into a
deterministic policy engine with an auditable decision record. It is **not yet a hard
security boundary**.

The current adapters observe selected file-tool actions and write hypothetical verdicts
to JSONL. They do not block, confirm, sandbox, or mediate tool execution. Claims about
"physical locking", "default deny everywhere", or an "immutable audit log" require a
trusted supervisor, complete action coverage, and an OS-level execution boundary that
are not implemented here.

## Implemented today

- A pure TypeScript policy engine with a strict rule schema and content-addressed
  policy snapshots.
- Explicit decisions for matched rules, no match, engine error, and not evaluated.
- `log-only` adapters for OpenCode V2 and Pi covering the file channel.
- Coverage records for known-but-unsupported tools and opaque shell actions instead of
  silent skips.
- Audit records carrying a rule snapshot digest, matched rule metadata, decision kind,
  schema version, and coverage status.
- Content-addressed snapshot archives under the log directory, containing the exact
  rules, schema, schema digest, and effective session workspace for each policy digest.
- URL value/userinfo/fragment/path redaction before persistence; shell text and file
  contents are not logged.
- Review worksheets that use the rule metadata captured at decision time and encode
  untrusted fields so they cannot inject Markdown or HTML.
- A provider-neutral Jev integration for typed semantic assessments. Jev is advisory;
  deterministic policy remains authoritative and model output may only tighten a
  verdict.

## Not implemented yet

- Complete mediation across shell, patches, network, unknown tools, disabled
  extensions, and other harness entry points.
- A trusted supervisor separated from the agent's writable domain.
- Policy and audit storage the agent cannot modify.
- Runtime semantics for `scope`, `owner`, `level`, and `policy_class`; they are
  validated audit metadata, not yet permissions or rule-selection mechanisms.
- Symlink-, hard-link-, bind-mount-, and TOCTOU-safe filesystem execution.
- Authenticated one-time approval bound to the action and policy snapshot.
- Tamper-evident remote audit retention.
- Real `deny`/`confirm` enforcement in either adapter.

See [Security model and current guarantees](docs/security-model.md) for the threat model
and the enforcement architecture required before those claims can be made.

## How it works today

```text
Tool event
   │
   ▼
Adapter normalization ── unsupported/opaque ──► coverage record (not evaluated)
   │
   ▼
Strict policy snapshot
   │
   ▼
Deterministic evaluation
   │
   ├─ matched rule      → hypothetical verdict + matched rule metadata
   ├─ no match          → explicit no_match (recorder uses hypothetical deny)
   ├─ validation error  → deny + engine_error
   └─ snapshot failure  → deny + snapshot_error
   │
   ▼
Sanitized JSONL audit record ──► human review worksheet
```

The only side effects are writing the audit record and its content-addressed snapshot
archive. The tool call is never modified.

## Quick start

Requires Node.js 26 and npm:

```bash
npm ci
npm run typecheck
npm test
```

OpenCode and Pi usage remains log-only. See [the Pi adapter guide](docs/pi-adapter.md)
and the root `opencode.jsonc`.

Generate a review worksheet:

```bash
npm run audit:review -- \
  --rules constraints/rules.yaml \
  --log spike/logs/opencode.jsonl \
  --output spike/review/new-review.md
```

## Delivery conventions

- New work uses a `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, or `ci/`
  branch.
- Protected branches, force-push prevention, secret scanning, and release authority
  must be enforced by the Git host. Local hooks and branch names are not authorization.
- Security-sensitive changes require human review. Agents do not self-approve, merge,
  force-push, tag, or release.
- See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Security model](docs/security-model.md)
- [Jev integration](docs/jev-integration.md)
- [Product and engineering decisions](docs/decisions.md)
- [G0 gate criteria](docs/go-no-go.md)
- [Fixture coverage](docs/fixture-coverage.md)
- [OpenCode V2 seam notes](spike/README.md)
- [Pi adapter guide](docs/pi-adapter.md)

---

<p align="center">
  <sub>A policy engine is useful only when its trust boundary, coverage, and audit trail are as explicit as its verdicts.</sub>
</p>
