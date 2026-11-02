# Policy-Bounded Autonomy

Target: **Human-governed. Machine-enforced. Agent-autonomous.**

This document adopts the proposal to remove routine human operation approvals,
without giving a probabilistic reviewer policy or execution authority. It is a
target and bounded implementation contract, not a claim that the complete product
is enforced. Existing Pi/OpenCode security adapters remain Stage A `log-only`.

The current pass implements a **standalone, explicitly bootstrapped prototype**:
capability/delegation checks, four-state deterministic decisions, a persistent
single-parent journal, and one Linux descriptor-bound file-create executor. This
is a narrow part of Phase 1, not completion of all authorization infrastructure,
host integration or long-running unattended autonomy.

## Required next-delivery completion gate

The requested next delivery is **working Jev-assisted automatic authorization
and enforcing adapter execution**, not another declaration that the standalone
file-create prototype is the complete product. It must establish all of:

- A real stopped, preauthorized confirm-class request can receive bounded Jev
  signals and execute once after deterministic revalidation. A deny cannot be
  overridden; unavailable, stale or insufficient review stays stopped without
  opening a routine human approval dialog.
- Supported adapter tools perform useful real work through the managed host;
  neither a log-only recorder nor rejecting every tool satisfies this gate.
  Native tools, direct shell, plugins/MCP, delegation and alternative execution
  routes must be mediated or made unavailable by the actual host boundary.
- Reviewer attempts, outcomes and execution consumption have durable, bound
  evidence; concurrency, expiry, revocation and crash recovery cannot manufacture
  an extra approval, retry or execution.
- Live adapter and real side-effect/bypass probes demonstrate the claimed
  coverage. Missing host capabilities cannot be hidden behind an enforcement
  configuration flag or described as implemented.

This section is the next delivery's acceptance criterion, not a claim that the
current implementation already passes it. The separate engineering sensor and
advisory injection retain their existing roles.

## Current entry points and verification

The compiled internal API is `dist/autonomy/index.js`:

```js
const core = createAuthorizationCore({
  snapshot, expectedSnapshotDigest, capabilities,
});
const executor = createLinuxFileExecutor({ workspace: core.workspace });
let host;
try {
  host = createPolicyBoundHost({ core, executor, journalPath, protectedPaths });
  const session = host.openSession(trustedSessionContext);
  const result = await host.execute(session, fileCreateRequest);
  // Check authorization and execution separately; do not infer task success.
} finally {
  if (host) await host.close();
  else await executor.close(); // Bootstrap may fail before host ownership.
}
```

The values above come from explicit trusted bootstrap, not an Agent request.
`openSession`, `revoke` and `stop` are trusted-side library methods, not
unauthenticated RPC routes. The journal parent directory must already exist
outside the workspace. Optional `protectedPaths` declares additional file-backed
policy/credential assets at trusted bootstrap; it is not automatic credential
discovery. Protection claims require complete declaration of the relevant
file-backed assets. Journal and lock placement are always checked. There is no
installation command or automatic integration with a running Harness in this pass.

Supported protected placements are canonical existing regular files or
directories outside the workspace, excluding exposed runtime objects and their
inode aliases. Only the journal and lock may have missing final components;
their parent must already exist. Declared protected directories are scanned for
runtime inode aliases, with a shared limit of 100,000 entries; symlinks, special
files or an exceeded limit fail bootstrap. The workspace is not recursively
scanned: existing workspace files and symlinks are not mounted, and the executor
cannot overwrite them. These startup checks do not mediate later host changes.

Run from the worktree root with Node 26:

```sh
npm run typecheck
npm test
# Focused checks after building:
node --test dist/autonomy/*.test.js
```

The package build includes `worker.ts` explicitly through the source-directory
glob. A custom focused TypeScript file-list build must include it too: its
runtime `new URL('./worker.js', import.meta.url)` is not a static import dependency.
Tests for unsupported Linux/loader/bubblewrap configurations report a skip, not
evidence of confinement. The real execution, isolation and physical crash probes
ran without skips on the development host; this is not a portability guarantee.
The isolation probe uses the production mount builder with a temporary runtime
tree containing both allowlisted libraries and an unlisted private file/Unix
socket. A host-side socket connection is the positive control; the sandbox must
neither see the private host file nor reach that socket. Writable sandbox scratch
directories are not mistaken for writable host directories.

## 1. Three responsibilities

| Plane | Authority | Not its job |
| --- | --- | --- |
| Governance | Humans maintain rules, architecture/engineering standards, capability bounds, risk budgets and preauthorization | A synchronous queue of routine tool approvals |
| Authorization | Trusted code intersects valid capabilities, delegation, active rules, evidence, budgets and host capabilities | Treating a model score or a rule no-match as a permission grant |
| Decision assistance | An independently scoped, replaceable reviewer supplies structured signals about an already eligible stopped request | Expanding scope, publishing rules, bypassing deny, executing tools or changing thresholds |

The Harness constructs identity-bound actions, enforces the authorization result,
and records the actual execution outcome. Authentication comes from its trusted
integration; natural-language identity claims are not credentials.

Rules describe restrictions and requirements. A capability describes authority.
An action needs both valid authority and compliance with all applicable rules.
The absence of a matching deny does not create a capability.

## 2. Runtime states outside the old engine

| State | Meaning and next step |
| --- | --- |
| `ALLOW` | All required deterministic authorization conditions hold; the host may consume this one bound operation |
| `DENY` | A hard rule or authority boundary forbids the operation; the reviewer cannot override it |
| `AUTO_REVIEW` | Preauthorized for independent machine review, but not yet executable or finally authorized |
| `DEFER` | Evidence, support or conditions are insufficient; do not execute or automatically open a human approval dialog |

These are new **outer orchestration states**, not additions to the frozen rule
`on_hit` enum or the old engine action schema. The legacy engine still evaluates
only `{tool, operation, target}` and preserves `deny > confirm > log > allow`.

A rule `confirm` means a stopped request. In a future reviewed path, signals must
satisfy fixed policy before authorization can complete. In this first slice,
`AUTO_REVIEW` is always non-executable: there is no reviewer implementation or
automatic approval route.

An orchestration layer may respond to `DEFER` by choosing an allowed alternative,
gathering permitted evidence, reducing scope or continuing independent tasks.
Permission expansion becomes a governance proposal. None of those options allows
retrying a denied action through another unmediated entry point. This host does
not implement a planner, retry loop or fallback-to-human mechanism.

## 3. Explicit capabilities and envelopes

The new versioned outer contracts live in `autonomy/contracts.ts`.

`CapabilityLease` pins an actor, project/task, optional session, exact policy
snapshot, tools, operations, resource roots, effects, per-operation byte ceiling,
validity interval, delegation depth, auto-review eligibility and required checks.
It is trusted bootstrap/control-plane input, not a grant accepted from the Agent.

Delegation must attenuate every relevant dimension:

- parent ID and delegator must bind the actual chain;
- project/task/snapshot stay fixed; a specific parent session cannot become any
  session in a child;
- tool/operation/effect sets, resource roots, time interval and byte ceiling cannot
  widen;
- remaining delegation depth decreases, reviewer eligibility cannot be enabled
  below a disabled parent, and inherited prerequisites cannot disappear;
- a revoked or expired ancestor invalidates its descendants.

Resource-root inclusion uses normalized path components, not glob containment
inference. This is a scope check, not filesystem object identity. The executor
must separately bind actual objects.

`FileCreateRequest` contains only a closed operation ID, capability ID, three-field
file action and complete UTF-8 create parameters. The host adds its trusted
session context, checkpoint and timestamp to make an `ActionEnvelope`. Complete
parameters are included in its digest, but not copied into audit records.

The pure core cannot authenticate an arbitrary caller's context. The host binds
context to its own opaque session objects; cloning/serializing an object does not
preserve this process-local authority. This is not an IPC authentication protocol.

The first format supports one explicit effect: creating a new file. It does not
accept unknown cumulative-budget fields or silently ignore unsupported checks.
`maxWriteBytes` is a per-operation limit, **not** a shared project budget. Nonempty
required checks remain unsupported/DEFER until a trusted check-binding path exists.

## 4. Bounded first host slice

The first execution slice is deliberately narrow:

1. A trusted parent explicitly pins an already compiled policy digest and a fixed
   capability catalog. P1's `offline-shadow` snapshot is test/bootstrap content,
   not proof of publication or production rollout.
2. The authorizer checks the complete envelope and capability ancestry, then the
   active runtime rules. An empty/missing checkpoint is not an implicit allow.
3. Only `ALLOW` may reach a prepared executor. Preparation has no target-write
   side effects.
4. The parent revalidates time, revocation, parameters and policy, atomically
   consumes the operation ID, and obtains a durable authorization audit receipt.
   There must be no asynchronous gap in the consumption critical section.
5. It checks validity again before execution; expiry during an audit write does
   not create a free execution window. Revocation and consumption have an explicit
   parent-process ordering; an already committed side effect cannot be undone by
   a later revocation.
6. The executor binds one actual new file object and starts a fixed isolated
   worker. The worker does not receive a writable workspace, policy store,
   journal, credential directory or host process view.
7. Execution and result auditing are separate. Authorization is not execution
   success, and execution success is not proof of task completion.

The intended Linux executor uses bubblewrap namespaces and descriptor-based
mounts. The permitted effect is a new direct child of a pre-opened directory,
created without following symlinks or overwriting any existing inode. The target
file descriptor, not a re-resolved path, is the worker's writable host object.
Existing files, symlinks, hardlinks, subdirectories and unsupported targets are
not an invitation to fall back to ordinary path-based writes.

The factory pins Node, the fixed worker, and the eight library/loader objects in
`autonomy/runtime-manifest.ts`. Each dependency is resolved to a regular file and
mounted read-only by descriptor; no host runtime directory is mounted. This is a
closed Node/x86-64 runtime layout, not dynamic discovery of arbitrary libraries.
Files or Unix sockets beside those libraries are not included by the mount list;
read-only directory mounts would not have provided that isolation.

The factory runs a real read-only startup preflight before accepting requests.
The parent verifies the final target bytes
and fsyncs the file and containing directory before returning success. An error
after exclusive creation can still leave an empty/partial file and is not silently
cleaned up. Cancellation is conservative and does not undo a committed effect.

Node's `--permission` is not an adversarial sandbox. Missing namespace, mount or
descriptor-binding support blocks managed execution; it does not enable a weaker
fallback. Only the explicit runtime objects may be mounted read-only; parent
state and secrets must not be exposed. Resource and process
limits or defense-in-depth flags do not replace the mount/identity boundary.

This is not a generic Shell/MCP executor, complete filesystem mediator, production
Agent sandbox, or automatic policy publisher. Probe results apply only to the
tested Linux/runtime configuration and operation class. A compromised parent or
independent host writer is outside this boundary.

## 5. Persistence and failure semantics

The trusted parent journal is a new protocol, separate from legacy JSONL audit
formats. Its current record version is **2**, with closed version-1 authorization
evidence on every recorded decision and consumption. Evidence retains separately
hashed actor, project, session, task, operation, capability ancestry and matched
rule IDs; snapshot/checkpoint/action category; state and reason; parameter and
envelope digests; byte count; and the bound authority expiry where applicable.
An execution result references the digest of its consumption evidence. Recovery
validates the closed shapes, legal ordering, identity/digest associations and
receipt before accepting history.

These are pseudonymous, domain-separated, unkeyed ID hashes (`auditId` in
`autonomy/audit.ts`), not anonymization or authentication. An auditor with known
IDs can correlate them without retaining the raw envelope or file contents;
guessable IDs and parameters may remain guessable. Raw contents, paths and
command/context text are not stored. The journal and declared protected assets
must not overlap the writable workspace or exposed runtime objects.

Version-1 prototype journals are refused rather than silently upgraded or
discarded. This pass supplies no migration that preserves their consumption
history; replacing an old ledger with an empty one is not replay-safe recovery.

- Authorization persistence fails: no side effect.
- Preparation fails: no target write and no invented permission.
- Failure after a file may have been created/written: conservatively report
  `outcome_unknown` where the actual effect cannot be proven.
- Result persistence fails: consumed state remains; do not automatically retry,
  refund or infer that nothing happened.
- Restart: a consumed operation without a result is not available to replay.
- Corrupt/incomplete journal, wrong policy pin or uncertain clock: refuse unsafe
  recovery rather than truncate history or extend a lease.
- A single parent owns the journal. A stale exclusive lock after a crash must
  block automatic takeover; trusted recovery is not a PID-guessing cleanup loop.
- Emergency stop and revocation are independent of Jev and stop new authority;
  in-flight cancellation can still leave an unknown result.

Hashing and owner-only file modes do not prove resistance to a compromised host.
Worker isolation, source/identity verification and persistent storage each need
their own evidence. Cross-process shared accounting and autonomous crash repair
are not claimed by this single-parent implementation contract.

## 6. Reviewer and workflow work comes later

Jev should be replaceable behind a versioned `DecisionReviewer` contract once the
host boundary and stopped escalation protocol are established. The existing
engineering Jev sensor remains tighten-only and is not repurposed as this reviewer.

Review eligibility, limits, model/version allowlists, evidence freshness and
thresholds come from governance. Reviewer probabilities are not calibrated safety
probabilities by definition. A model/version change requires revalidating the
relevant calibration evidence. Failure, injection-tainted evidence, stale inputs,
conflicting outputs or low confidence cannot become approval.

Deterministically authorized routine operations must not depend on reviewer
availability. A required review failure stays stopped without a routine human
fallback or unlimited retry. The reviewer receives minimal permitted structured
context, not automatically the complete conversation or workspace. Requirement
text egress still needs an explicitly allowed trusted frame.

Workflow authority later needs atomic cross-session/Agent budget reservation,
settlement and revocation. Independent legal operations may still violate an
aggregate bound; the current per-operation limit does not solve that. Temporary
tightening remains a trusted publisher action under prior human authorization,
with finite TTL and no automatic permanent conversion. Agents and reviewers do
not publish rules or remove baseline infrastructure protections.

Existing dynamic norms and engineering guardrails remain in place throughout.
Architecture/engineering taste remains advisory and evidence-driven unless a
reliable, non-bypassable check exists. No new predicate or speculative language
analysis fields are inserted into the old strict schemas.

## 7. Evidence and staged delivery

This pass must establish, rather than assume:

- capability intersection, complete delegation attenuation, ancestor revocation,
  expiry, binding and the no-capability/no-match rejection;
- `confirm`/`AUTO_REVIEW` cannot reach execution;
- actual permitted bytes reach a real target while denied targets do not change;
- an isolated worker cannot access the parent journal, policy, credentials,
  process state or network, using the actual executor layout;
- duplicate concurrent consumption, audit failure, stale parameters, clock/expiry
  races and crash/unknown results do not produce a second execution;
- existing engine, injector, adapters and legacy audit/digest regressions remain
  green without claiming that this proves complete mediation.

Subsequent slices add deterministic alternative planning and bounded retries,
then reviewer shadow evaluation, narrowly eligible calibrated auto-review,
workflow-wide atomic budgets, and richer governance/feedback. The governance UI
is a policy workbench, not a daily operation-approval inbox. It needs rule design,
boundary-change proposals, runtime evaluation, lifecycle management and independent
emergency controls; this pass does not implement those pages.

Compare human review, deterministic-plus-human, deterministic-plus-Jev, and
layered-review variants using identical tasks, authority, risk budgets and
environments. Pre-register risk-specific thresholds before experiments. Measure
human interruptions/time, task throughput and unattended completion **alongside**
false allows and their severity, false denies, actual unauthorized effects,
delegation/budget abuse, failure behavior, latency and total model/maintenance
cost. Auto-approval rate alone is not a success metric.

Pure tests, a model's explanation and one sandbox startup are not substitutes for
real side-effect and adversarial probes. Current implementation coverage and exact
verification commands must be reported separately from this target contract.
