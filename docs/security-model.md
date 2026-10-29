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

## Requirement conformance (semantic layer)

The deterministic engine answers "what does the policy say"; it cannot answer "did the
human ask for this". Jev supplies that as a typed semantic sensor, never as an
authority:

| Layer | Question | Authority |
|---|---|---|
| Structural | Is the tool mediated, is the target in scope, is it a zero-level action? | Trusted code |
| Deterministic | What is the policy baseline? | `engine/` |
| Semantic | Does the action serve the captured requirement? | Jev facts |

A `RequirementFrame` is the only accepted representation of a human requirement. It is
captured by the harness from a user-input channel. Its `source` is either
`user_message` or `delegated`; a delegated frame records that the immediate
instruction came from an agent, and can never justify relaxing a verdict. Requirement
text from tool results, file contents, MCP responses, or model summaries is not a
frame.

Jev returns `requirementMatch` plus `sensitiveArea`, `irreversible`, `risk`, and
`confidence`. The fixed combination table is trusted code:

| Deterministic baseline | `requirementMatch` | Result |
|---|---|---|
| `deny` | any | `deny` |
| `confirm` | any | `confirm` |
| `allow` | `match` | `allow` |
| `allow` | `partial` / `unclear` | `confirm` |
| `allow` | `mismatch` | `deny` |

`match` never loosens a stricter baseline. Provider failure, refusal, timeout, low
confidence, or facts bound to a different frame digest fail closed when an assessment
is required and otherwise preserve the deterministic verdict.

Requirement text is user content. Sending it to a hosted assessor requires
`egress: "allowed"` on the frame; the provider rejects a denied frame with
`egress_denied`. Audit records carry the frame digest and provenance only, never the
text or declared scope.

Implementation status: the frame type, Jev question set v2, digest binding, and
combination table exist in `decision/` and are covered by tests. No adapter captures a
frame yet, and no harness is blocked by this layer; runtime enforcement remains Stage A
`log-only`.

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

## Engineering workflow gate

The opt-in `workflowGate` is a separate engineering guardrail, not part of the guarantees
above. It can select advisory guidance, block a closed subset of dangerous shell
commands before execution where the harness exposes a blocking seam, run fixed local
change checks, and send an eligible filtered diff to Jev for advisory engineering review.
Its optional `actionAssessment` mode compares a model-authored shell action with a
harness-captured human requirement and may only tighten the deterministic shell verdict.
A Pi `user_bash` command typed directly by the human is a separate structural literal
grant: every deterministic deny remains, while a non-deny can proceed without a second
approval. These are engineering controls, not authenticated approvals, complete mediation,
or a security boundary.

- Unknown shell syntax, custom shells/prefixes, PowerShell, and analysis failures remain
  confirmation-required or denied. Confirm-class decisions fail closed without a safe
  approval path.
- Pi can block `tool_call` and stop `user_bash` by throwing. OpenCode `execute.before`
  cannot block by contract; it uses `shell.create.before` plus native permission
  tightening. Only a parsed plan-class confirm is admitted from the shell hook into
  OpenCode's own `permission.assert` → `permission.evaluate` → user once/always/reject
  path; opaque, unsupported, or reduced-host decisions fail closed with
  `amos_workflow_gate_shell_confirm_unavailable` (this path cannot approve, rather than
  waiting for approval). The gate's permission hook can only tighten: `allow` becomes
  `ask` for a parsed confirm, and `deny` stays `deny`. This covers only the agent shell
  tool's plan confirm; `/api/shell` and `POST /api/session/{id}/shell` are outside the
  channel, `--auto` may accept `once` without a human, a saved `always` may still be
  asked again after tightening, and direct shell APIs cannot be claimed as mediated. The
  gate remains an engineering guardrail, not a security boundary.
- Pi allows at most one repair continuation per session. OpenCode V2 exposes no true
  settle/merge block, so its completion feedback is advisory only.
- The gate does not provide complete mediation. Disabled extensions, alternate entry
  points, `pi.exec`, MCP/extension code, repository scripts, and safe-command trust in git
  or npm configuration remain outside it.
- A passing Jev engineering review is not proof of correctness, safety, or merge
  authorization.

See `docs/workflow-gate.md` for configuration and exact limits.

## Decision-model integration

A probabilistic decision model such as Jev may supply typed semantic facts (intent,
sensitivity, reversibility, risk). It must not own policy or execute actions. The
deterministic engine remains authoritative, the model may only tighten a verdict, and
model failure or low confidence must fail closed when the policy requires an
assessment. See `docs/jev-integration.md`.
