# AGENTS.md

## Commands

- Requires Node.js 26 and npm; install with `npm ci`.
- Run `npm run typecheck` and `npm test` before review. `npm test` builds first and runs the compiled Node tests.
- Focused test: `npm run build && node --test dist/engine/engine.test.js` (substitute the compiled test path).
- Run tests from the repository root: tests resolve `fixtures/` and `constraints/` through `process.cwd()`.
- OpenCode and Pi load compiled JavaScript from `dist/`; run `npm run build` before launching them and after TypeScript changes.

## Current security boundary

- Amos is Stage A `log-only`: verdicts are hypothetical and tool calls are never blocked. Do not describe it as a hard security boundary or enable real `deny`/`confirm` without the enforcement architecture and adversarial evidence required by `docs/security-model.md`.
- Coverage records make unsupported actions visible; they do not mediate or protect those actions.
- Policy, audit, and snapshot files still share the Agent's writable domain. Append-only JSONL and owner-only modes are not tamper-proof guarantees.
- Security-sensitive changes require human review; follow `CONTRIBUTING.md`. Read `docs/decisions.md` before expanding scope or changing established semantics.

## Architecture invariants

- `engine/` is pure and uses an injected clock. Preserve `deny > confirm > log > allow` and fail-closed evaluation; keep filesystem, network, model, and harness I/O outside it.
- `supervisor/` is an in-memory session/decision/stop core, not a running trust boundary. Its fences rely on process-local object identity, do not survive IPC, and are not approvals or execution authorization; see `docs/supervisor-core.md`.
- `constraints/rules.yaml` is the policy source. The seven predicate operators are frozen; do not add regex routing, custom DSLs, or one-off operators.
- Only `predicate`, `on_hit`, and `ttl` currently affect verdicts. `scope`, `owner`, `level`, `policy_class`, and `enforcement` are validated metadata, not implemented authorization or rule-selection mechanisms.
- Adapters own harness payload normalization. File targets are lexically normalized absolute paths, not symlink-, hard-link-, bind-mount-, or TOCTOU-safe object identities.
- Never log file contents, shell command text, URL secret values, or raw hostile payloads. `decision/` Jev is only an optional semantic sensor: it may tighten but never relax deterministic verdicts; caller-supplied `context` is not automatically redacted.
- Snapshot archives preserve policy inputs but are not externally anchored. Keep digest/provenance compatibility explicit when changing their format.

## Tests and audit

- Tests execute compiled JavaScript under `dist/`; do not add a separate TS test runner.
- Language-neutral engine cases belong in `fixtures/*.json`; fixture names must be globally unique across files.
- `npm run audit:review` requires a new output path and intentionally refuses to overwrite existing worksheets or source logs.
