# Security model and current guarantees

Status: **limited Harness-layer MVP implemented; general runtime enforcement and OS
isolation remain unavailable.** The default adapters remain log-only; the Pi
`managed.enabled` path is an explicit opt-in Harness-layer gate. The managed
`confirm` reviewer is Jev (`review/jev-reviewer.ts`). This document separates
guarantees implemented in the repository from the deployment architecture
required before `deny` or `confirm` can be described as a general security boundary.

## 2026-11-05 limited Harness MVP

- Pi `tool_call` is intercepted before the real tool runs; deterministic `deny`
  blocks, `confirm` stops for an independent HTTP reviewer and a single-use HMAC
  grant, and `tool_result` records execution. *(Superseded 2026-11-07: the managed
  `confirm` reviewer is Jev; see the next section.)*
- Execution and advisory injection consume the same verified activation snapshot.
  The console publishes a catalog-v2 artifact; the harness writes a same-UID
  `.pi/runtime.json` load report.
- This covers only the normalized tools `read/write/edit/ls/find/grep`. Shell,
  PowerShell, custom tools, MCP, subprocesses, bypass paths, alternate harness
  entries, and effects inside an allowed shell are outside this guarantee.
- No independent OS identity, mount domain, bwrap/cgroup, kernel sandbox, or
  tamper-proof audit. The runtime report is a same-UID observation, not remote
  attestation. OS isolation is explicitly out of scope for this MVP.
- The reviewer is a local model plus a fixed deny surface; the synthetic
  calibration set is not a security certification. *(Historical, 2026-11-05: the
  independent local-model reviewer service was replaced by the Jev reviewer on
  2026-11-07; the calibration set is still not a security certification.)*

## 2026-11-07 Jev reviewer and requirement lifecycle

- The managed `confirm` branch calls `review/jev-reviewer.ts`
  (`createJevManagedReviewer`). That adapter reuses the `decision/` Jev provider
  and `loadJevConfig` rules and adds digest, scope, policy, calibration and
  deadline bindings before a grant is issued.
- A pass requires: a user-captured requirement (`source: "user_message"`,
  `actor: "user"`); matching frame and projection digests; egress allowed on both
  the frame and the policy; a target inside the workspace and under
  `declared_scope`; `requirementMatch: "match"`; `riskScore <= policy.maxRisk`;
  `confidence >= policy.minConfidence`; model, `jev-questions/v2` question
  version and `policyDigest` bound to the same policy; valid calibration bound to
  that model, question version and policy digest; and an unexpired deadline.
- One approval yields one one-use grant, bound to the action digest, snapshot,
  session, epoch, capability, `requirementVersion` and `requirementDigest`. It
  creates no allow rule. The harness re-reads the requirement before the effect
  and stops with `requirement_changed` on any version or digest change. The audit
  authorization record is written before the effect; a failed audit write stops
  the action.
- `mismatch` rejects. `partial`, `unclear`, `requiresReview`, over-threshold
  risk, low confidence, timeout, abort, rate limit, refusal, invalid response,
  network error, missing or mismatched calibration, and a projection binding
  error all stop. None of them converts into per-request human approval.
- `decision/requirement-registry.ts` persists the captured requirement per
  project under `$XDG_STATE_HOME/amos-governance/requirement-registry/<projectId>.json` with
  directory `0700`, file `0600`, atomic replace, and an `lstat` owner and mode
  check. Only a direct user-channel capture (`actor: "user"`,
  `capturedBy: "harness"`) creates or revises it; each capture increments the
  version and invalidates earlier review results and unconsumed grants.
  `conflict`, `revoked`, `expired`, `corrupt`, `owner_mismatch` and
  `unavailable` all stop managed execution.

### Boundary of the Jev reviewer

- Jev cannot override a deterministic `deny`, including non-level-0 denies. A
  stopped `confirm` is the only class it can approve, and only inside the
  preapproved policy ceiling.
- Jev cannot widen scope: not the writable roots, not `declared_scope`, not the
  network policy, not the target, not the grant TTL, and not the rule set. A
  target outside the workspace or outside `declared_scope` stops regardless of
  model output.
- Jev has no filesystem or network side-effect authority. It returns bounded
  facts; trusted code issues and consumes the grant and the host performs the
  single effect. Jev never executes, never writes a file, and never publishes
  configuration.
- Jev does not retain the requirement text or the model reply. The audit `review`
  block carries only `model`, `questionVersion`, `policyDigest`,
  `requirementDigest`, `actionDigest`, `snapshotDigest`, `risk`, `confidence`,
  `resultCode`, `calibrationVersion`, `calibrationDigest`, `grantId` and
  `grantNonce`; the authorization record also carries `requirementVersion` and
  `requirementDigest`. Requirement text stays in the protected requirement
  registry file; the model reply is not stored.
- The audit record is an entry in a same-UID writable domain. It records what the
  code wrote at that moment; it is not tamper-resistant, because a same-UID
  process can still rewrite the journal, the registry file, or both.

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
combination table exist in `decision/`. The opt-in engineering workflow gate captures
frames and uses them for its shell-assessment path; the separate security observer
does not become an enforcement boundary through that integration. The managed
`confirm` branch calls the Jev reviewer (`review/jev-reviewer.ts`), which may issue
one one-use grant for one stopped request inside the preapproved policy ceiling.
Runtime security enforcement for ordinary adapters remains Stage A `log-only`.

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
- One-time HMAC authorization bound to the exact action, session, snapshot/epoch,
  requirement version and expiry. The managed path implements this for the
  normalized tools it mediates; it is a same-UID Harness-layer gate without OS
  isolation or complete mediation. Human per-request approval is not the latest
  target; see decision 32.
- A real OS sandbox or trusted mediator that performs side effects on the agent's
  behalf.

Until those are implemented and adversarially tested, the product must be described
as a policy-matching and observation prototype, not a hard security boundary.

The standalone [local governance console](local-governance.md) adds persistent rule
proposals, capability-authenticated human governance review, and atomic version
publication. These are not runtime action approvals: publishing does not change
harness configuration, enable adapter enforcement, or establish a separate OS
trust domain. Same-UID processes can still access its credentials and database.

## Target shape: Approve for me

The target security shape is the Codex Approve for me trio, not a plugin mode
and not a stronger claim than that product makes. A host sandbox stops a
boundary crossing first. `on-request` means in-sandbox work proceeds and a
crossing waits. A separate reviewer (Jev on the current managed path) may approve
or deny only that stopped confirm-class escalation. The reviewer cannot expand the
writable root, enable network, weaken a protected path, or lift a `deny`. Level 0
denies are not eligible. Humans edit rules through the existing multi-dimensional table; the
agent cannot publish them. Engineering guardrails and advisory injection stay
outside this trio.

The 2026-11-02 [Product Design](product-design.md) makes protected-service-owned
SQLite the sole Amos configuration authority at the GUI stage. A shared project
activation snapshot feeds enforcement and narrative injection; temporary tightening
requires a trusted publisher, human preauthorization, finite TTL and immutable epochs.
Neither the GUI nor SQLite alone supplies isolation. The current YAML/JSON loaders,
shared advisory seed and same-domain JSONL remain unchanged. The eleven implementation
gaps and falsifiable acceptance gates are in [Gap Closure](product-gap-plan.md).

This shape is not implemented. Ordinary adapters remain log-only; the managed
path adds a Jev reviewer and a one-use grant without OS isolation, and the
`decision/` sensor path may only tighten. See `docs/security-shape.md` and
decisions 21–23 in `docs/decisions.md`. Aligning the target does not pass the
enforcement gate.

## Required enforcement architecture

### Restricted staging profile

The experimental controlled Pi host described in [strict-harness.md](strict-harness.md)
uses a smaller execution domain: its only model tools operate on private in-memory
string files, not native paths. Shell, MCP, extensions, native filesystem executors,
and automatic change application are absent. Mandatory audit, pinned policy, and a
closed dispatcher protect that virtual domain. Its guarantees must not be generalized
to the ordinary plugins or to native filesystem/OS enforcement. The requirements below
still apply before expanding to that broader execution domain.

1. A trusted supervisor outside the agent's writable domain loads policy from a
   protected location, owns credentials, and writes audit records.
2. A complete action envelope is produced at the execution boundary. Unsupported or
   incomplete actions are denied, not guessed.
3. Filesystem and network operations are executed through an OS sandbox or protected
   mediator using real object identity. A preflight `realpath()` check is insufficient.
4. Approvals bind the action digest, policy snapshot/epoch, session, expiry, and
   one-time use, with revalidation immediately before execution. The target reviewer
   may resolve an eligible stopped request; without a valid reviewer/human protocol,
   confirm stays stopped. Today's engineering gate still requires its supported UI.
5. Policy and audit storage use a separate OS identity or remote trust anchor. A local
   hash chain without an external anchor only detects accidental edits.
6. Adversarial integration tests cover symlinks, TOCTOU, hard links, shell escapes,
   unknown tools, disabled extensions, policy modification, approval substitution, and
   audit tampering.
7. The protected publisher authenticates SQLite configuration versions and shared
   activation projections; the agent cannot modify the DB, WAL, backups or generated
   native configuration. TTL, rollout and language-check evidence cannot be forged by
   changing project files or by naming a rule in a prompt. Durable audit acknowledgement
   precedes effects; outcome receipts remain distinct from authorization records.

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
- Pi allows at most one repair continuation per session at `agent_before_settle`. OpenCode
  V2 implements the same single-repair continuation through the `experimental.idle` hook;
  both are advisory (soft-block) and do not hard-prevent completion. `experimental.idle`
  is an experimental API that may change in a future release.
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
assessment. The `decision/` sensor path cannot approve a `confirm`; the managed
`confirm` reviewer is `review/jev-reviewer.ts`, which approves at most one stopped
request inside the preapproved policy ceiling. *(Historical, 2026-11-05: the
`decision/` path was the only Jev integration, and extending it to approve a
`confirm` was excluded.)* See `docs/jev-integration.md`.
