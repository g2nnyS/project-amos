# AGENTS.md

## Commands

- Requires Node.js 26 and npm; install with `npm ci`.
- Run `npm run typecheck` and `npm test` before review. `npm test` builds first and runs the compiled Node tests.
- Focused test: `npm run build && node --test dist/engine/engine.test.js` (substitute the compiled test path).
- Run tests from the repository root: tests resolve `fixtures/` and `constraints/` through `process.cwd()`.
- OpenCode and Pi load compiled JavaScript from `dist/`; run `npm run build` before launching them and after TypeScript changes.

## Current security boundary

- The security policy layer is Stage A `log-only`: its verdicts are hypothetical and the security engine does not block tools. Do not describe it as a hard security boundary or enable security `deny`/`confirm` without the architecture and adversarial evidence required by `docs/security-model.md`.
- A separate opt-in engineering workflow gate may block dangerous shell commands and hold work. It is a workflow guardrail, not complete mediation, a security boundary, or merge authority; see `docs/workflow-gate.md`.
- Coverage records make unsupported actions visible; they do not mediate or protect those actions.
- Policy, audit, and snapshot files still share the Agent's writable domain. Append-only JSONL and owner-only modes are not tamper-proof guarantees.
- Security-sensitive changes require human review; follow `CONTRIBUTING.md`. Read `docs/decisions.md` before expanding scope or changing established semantics.

## Architecture invariants

- `engine/` is pure and uses an injected clock. Preserve `deny > confirm > log > allow` and fail-closed evaluation; keep filesystem, network, model, and harness I/O outside it.
- `supervisor/` is an in-memory session/decision/stop core, not a running trust boundary. Its fences rely on process-local object identity, do not survive IPC, and are not approvals or execution authorization; see `docs/supervisor-core.md`.
- `guidance/` contains static versioned engineering guidance; `workflow/` contains the opt-in workflow gate: closed-subset shell assessment, fixed local checks, filtered diff egress, and advisory Jev engineering review. Never treat these modules as security enforcement.
- `constraints/rules.yaml` is the policy source. The seven predicate operators are frozen; do not add regex routing, custom DSLs, or one-off operators.
- Only `predicate`, `on_hit`, and `ttl` currently affect verdicts. `scope`, `owner`, `level`, `policy_class`, and `enforcement` are validated metadata, not implemented authorization or rule-selection mechanisms.
- Adapters own harness payload normalization. File targets are lexically normalized absolute paths, not symlink-, hard-link-, bind-mount-, or TOCTOU-safe object identities.
- Never log file contents, shell command text, URL secret values, or raw hostile payloads. `decision/` Jev is only an optional semantic sensor: it may tighten but never relax deterministic verdicts; caller-supplied `context` is not automatically redacted.
- Jev supports TypeSafe direct and OpenRouter System One. Shared/example config uses `{env:...}`; a literal credential belongs only in a Git-ignored `decision/jev.local.json` with POSIX owner and mode `0600`. Do not expose credentials in errors or public config.
- Workflow shell decisions are a deliberately closed subset. Unknown syntax, custom shells/prefixes, PowerShell, or analysis errors must remain confirm/deny, never silent allow. OpenCode completion feedback is advisory because V2 has no true settle/merge block.
- Snapshot archives preserve policy inputs but are not externally anchored. Keep digest/provenance compatibility explicit when changing their format.

## Tests and audit

- Tests execute compiled JavaScript under `dist/`; do not add a separate TS test runner.
- Language-neutral engine cases belong in `fixtures/*.json`; fixture names must be globally unique across files.
- `npm run audit:review` requires a new output path and intentionally refuses to overwrite existing worksheets or source logs.
