# Security model and current guarantees

Status: **implementation in progress; runtime enforcement is not yet available.** The
current adapters remain log-only. This document separates guarantees implemented in
the repository from the deployment architecture required before `deny` or `confirm`
can be described as a security boundary.

## Threat model

Protected assets include credentials, files outside an approved workspace, network
destinations, release credentials, policy files, and audit records.

The relevant adversary controls an agent's prompts, tool inputs, and any code it can
execute inside its assigned sandbox. It may use symlinks, path races, unknown tools,
shell, patches, or alternate harness entry points. It may attempt to inject text into
review surfaces or make a probabilistic classifier return an unsafe answer.

Out of scope: a compromised kernel, a compromised supervisor, host root, a malicious
human approver, and hardware compromise.

## Current guarantees

The implementation is being hardened to provide these properties:

- Policy evaluation fails closed on malformed actions, malformed or empty rule tables,
  unknown fields, invalid predicates, and internal errors.
- A policy result distinguishes a matched rule, no match, an evaluation error, and a
  not-evaluated action. The log-only recorder uses `deny` as its hypothetical no-match
  default.
- Every known but unsupported tool produces a coverage record instead of disappearing.
  Opaque shell actions are marked not evaluated and not confirmation-eligible.
- Audit records include the rule snapshot digest, matched rule metadata, decision
  kind, coverage status, and schema version.
- New audit directories and files are created owner-only where the platform
  supports POSIX modes. The writer rejects a final-component symlink. Parent
  directory symlinks, existing file ownership, and tamper resistance still require
  the trusted supervisor described below.
- URL query values, userinfo, fragments, and path contents are redacted before being
  persisted. Shell command text and free-form payloads are not persisted.
- Audit worksheets encode untrusted fields so they cannot break code spans or inject
  raw HTML/Markdown.
- Audit review prefers the rule metadata captured at decision time. Missing historical
  metadata is a coverage gap, not a reason to reinterpret the record using the current
  rule table.
- Session-scoped filesystem whitelists use the single restricted
  `${SESSION_WORKSPACE}` substitution in `target_glob` / `target_outside_glob`
  patterns. The adapter must supply an explicit normalized absolute session
  workspace; a missing or invalid value fails closed. This is not a general
  variable system, and the snapshot digest binds both the raw rule bytes and the
  effective workspace so different sessions cannot share a misleading digest.
- Tests use system temporary directories and portable logical workspace paths.

These properties cover the observer pipeline only. They do not stop a tool call in the
real harness.

## Snapshot provenance archives

Each successful snapshot load can persist the exact policy inputs that produced its
digest. The log-only recorder enables this by default, so an audit log's
`snapshot_digest` remains resolvable after the working tree changes:

- Location is deterministic: `<snapshotArchiveDir>/<digest>.json`, where the adapter
  default is `<dirname(logPath)>/snapshots`. The digest is the existing
  `SHA-256(rawRules + '\0SESSION_WORKSPACE=' + workspace + '\0')` value recorded in
  the audit entry.
- Each archive contains `schema_version: 1`, `digest`, `session_workspace`
  (`null` when no workspace was supplied), the raw YAML `rules` string, the raw
  JSON `schema` string, and a separate `schema_digest` of the schema bytes.
- New archive directories are created with mode `0700` and archive files with mode
  `0600`, best effort as with the audit writer. Existing paths keep their mode.
- On a later load with the same digest, the existing archive is read and verified
  against the freshly loaded digest, session workspace, raw rules, and raw schema,
  including the recomputed rules-plus-workspace hash and the stored schema digest.
  A mismatch, unreadable archive, or write failure makes the load return
  `snapshot_error` and keeps the previous snapshot, rather than silently accepting
  altered provenance.
- This is integrity checking against accidental or partial modification by the same
  kind of access that can alter the policy files, not tamper-proof storage. A
  same-user attacker can rewrite both an archive and its digests, or a whole audit
  log. Authentic provenance still requires the trusted supervisor and separate OS
  identity described below.

## Not yet guaranteed

The following remain open until a separate enforcement milestone:

- Complete mediation. Harness flags, extensions, shell, and unregistered tools can
  bypass a plugin hook.
- Separation between the agent and the policy/audit trust root. Files in the project
  workspace are writable by the same execution domain.
- Execution-time filesystem identity. Lexical normalization does not resolve symlinks,
  bind mounts, hard links, or check/use races.
- Tamper-resistant audit. Appending JSONL is not an immutability or remote-retention
  guarantee.
- Authenticated, one-time human approval bound to the exact action and snapshot.
- A real OS sandbox or trusted mediator that performs side effects on the agent's
  behalf.

Until those are implemented and adversarially tested, the product must be described
as a policy-matching and observation prototype, not a hard security boundary.

## Required enforcement architecture

1. A trusted supervisor outside the agent's writable domain loads policy from a
   protected location, owns credentials, and writes audit records.
2. A complete action envelope is produced at the execution boundary. Unsupported or
   incomplete actions are denied, not guessed.
3. Filesystem and network operations are executed through an OS sandbox or protected
   mediator using real object identity. A preflight `realpath()` check is insufficient.
4. Approvals bind the action digest, policy snapshot digest, session, expiry, and
   one-time use. Non-interactive environments fail closed when confirmation is needed.
5. Policy and audit storage use a separate OS identity or remote trust anchor. A local
   hash chain without an external anchor only detects accidental edits.
6. Adversarial integration tests cover symlinks, TOCTOU, hard links, shell escapes,
   unknown tools, disabled extensions, policy modification, approval substitution, and
   audit tampering.

## Policy dimensions

`policy_class` separates security policy from engineering policy. `dimension` identifies
the concrete asset or discipline. `enforcement` records the intended mechanism:

- `runtime` for execution-time policy;
- `ci` for repository checks such as branch naming, tests, and secure coding rules;
- `server` for Git-host or infrastructure controls such as protected branches;
- `advisory` for guidance that is not mechanically enforced.

Branch naming and commit style belong to `engineering`/`delivery` and are enforced in
CI. Protected branches, force-push prevention, secret scanning, and signed releases
belong to security and must be enforced by the Git host or another authority outside
the agent. A branch name is metadata, never an authorization decision.

## Decision-model integration

A probabilistic decision model such as Jev may supply typed semantic facts (intent,
sensitivity, reversibility, risk). It must not own policy or execute actions. The
deterministic engine remains authoritative, the model may only tighten a verdict, and
model failure or low confidence must fail closed when the policy requires an
assessment. See `docs/jev-integration.md`.
