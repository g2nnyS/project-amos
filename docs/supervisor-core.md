# Supervisor core

Status: **pure foundation only; not connected to adapters or tool execution.** The
`supervisor/` module establishes session-bound decision and stop semantics for a future
trusted supervisor. It does not make the current log-only adapters enforce policy and is
not itself a security boundary.

## Implemented responsibilities

- Register a session identity once: `sessionId`, `agentId`, `sessionWorkspace`, and
  optional `onBehalfOf`. Registration input is copied and frozen; duplicate session IDs
  cannot be registered again, including after a stop.
- Evaluate requests by `sessionId` rather than accepting identity fields from each
  request. Unknown, stopped, malformed, or identity-injecting requests fail closed.
- Evaluate normal actions through the existing deterministic engine with `deny` as the
  no-match default. Policy metadata and the supplied snapshot digest are preserved in an
  immutable decision result.
- Handle explicit coverage gaps as hypothetical `deny + not_evaluated`, without sending
  the action or rule table to the engine. Coverage is never confirmation-eligible;
  requesting `confirmation_eligible: true` is rejected as invalid coverage.
- Omit the raw action and payload from decision results. The result is audit-facing
  decision metadata, not a complete audit event or an approval.
- Stop a session idempotently. The first stop changes its epoch and invalidates all
  previously issued fences; subsequent evaluations deny as stopped.

## Process-local fences

A decision fence is an epoch-state capability issued by one core instance. `isFenceCurrent`
returns true only for the original fence object while its session is active at the same
epoch.

A same-value clone, JSON round-trip, object from another core, or hand-built current-epoch
object is not a valid fence. This object identity cannot be serialized across IPC. A future
trusted transport must establish provenance and have the receiving core issue a new fence.

Fences only answer “is this session epoch still active?” They are not bound to an action,
payload, approval, or policy decision and **must not be treated as execution authorization**.
Stop state is in-memory and process-local; it is not durable or externally anchored.

## Trust assumptions and limits

- The caller that registers sessions is trusted. The core does not authenticate a harness,
  human, Agent, or OBO relationship.
- The caller supplies the policy snapshot. The core checks the current 64-lowercase-hex
  digest shape and propagates it, but does not recompute it or verify it against the table.
- Session workspaces receive lexical POSIX normalization only. No filesystem object
  identity, sandbox, symlink, hard-link, bind-mount, or TOCTOU guarantee is provided.
- No IPC, supervisor process, durable session store, credential broker, human approval,
  execution mediator, audit writer, or real `deny`/`confirm` integration is implemented.
- A decision contains no action digest or execution result and is not sufficient by itself
  for a complete decision/execution audit trail.

## Required next boundaries

Before runtime enforcement can be claimed, a separate trusted process and OS identity must
own registration, policy, and audit state; a trusted transport must rebind session and fence
provenance; and a mediated executor must check an action-bound authorization immediately
before side effects. Unknown or unmediated execution channels must remain disabled or
outside the explicitly stated protection scope.
