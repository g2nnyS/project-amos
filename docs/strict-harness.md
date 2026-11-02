# Restricted strict Harness

Status: **experimental, controlled Pi SDK entrypoint; staged memory workspace only.**
The ordinary Pi/OpenCode plugins remain Stage A observers with optional engineering
guardrails. Installing a plugin or setting `mode: "strict"` does not turn them into a
trusted execution boundary.

## Protection scope

The adversary controls model output, tool names and arguments, and imported file text.
It does not control the host program, model transport implementation, policy supplied by
the host, or the mandatory audit sink. A session exposes only an explicit subset of
`read`, `list`, `write`, `edit`, and `delete` over a private in-memory string-file map.
The model cannot execute JavaScript, Shell, MCP, plugins, extensions, skills, or another
Harness. Unknown tools and malformed inputs have no executor.

All model-visible file paths are canonical relative paths in a virtual `/workspace`
namespace. They are never passed to the operating system. Symlinks, hard links, mounts,
and path races cannot redirect these operations because there are no native filesystem
operations in this executor. This is **not** a claim that native filesystem mediation
or an OS sandbox has been implemented.

Host code, credentials, policy, and audit storage are not model-visible tools or virtual
files. The host must deliberately choose which files to import: an ordinary source file
containing a secret is not made safe by its filename. Reserved names and host-supplied
protected paths are independently blocked even
if a policy or semantic assessment would otherwise permit an action. An imported file
named after a configuration file cannot reconfigure the running host.

## Execution flow

1. Validate and copy a closed tool request; reject unknown fields, unsupported tools,
   noncanonical paths, protected paths, and resource-limit violations.
2. Evaluate a session-pinned copy of the policy through the existing pure engine.
   Explicitly granted virtual tools supply the allow baseline; rules can tighten it.
3. If configured, assess against the host-captured human `RequirementFrame`. Jev can
   only tighten the deterministic verdict; it never grants new tools or paths. Explicit
   requirement egress consent is checked before a semantic provider is called.
4. Await mandatory write-ahead authorization audit acknowledgement before disclosing
   read data or committing a staged mutation. An authorization record is not an execution
   receipt: stop, requirement replacement, or a crash may still prevent the operation.
   Audit failure poisons the runtime and terminates the controlled host run.
5. Recheck session/requirement state after asynchronous work and before committing.
   A stopped session or a superseded requirement cannot reuse an earlier decision.

`deny` never executes. `confirm` does not execute either: this restricted runtime has
no authenticated approval protocol and does not accept a model-supplied approval flag.
Existing `deny > confirm > log > allow` engine semantics remain unchanged.

## Controlled Pi host

`adapters/pi/strict.ts` owns the Pi SDK session and registers only custom tools backed
by the strict dispatcher. It supplies an empty resource loader and in-memory settings
and conversation storage. Project/global resource discovery, prompt-template expansion,
native tools, extension replacement, and RPC shell entrypoints are not exposed.

The public host facade exposes only user prompting, stop, policy identity, and staged
change export. It does not return the raw Pi session, Agent, registry, or `executeBash`.
Only the trusted host supplies the model transport and policy; there is no project
configuration switch that grants the model additional authority.

This is a programmatic entrypoint, not a flag added to ordinary `pi` or `opencode`:

```ts
import { createStrictPiSession } from './adapters/pi/strict.ts';

// All values below are supplied by the trusted host, not a tool call or project config.
const host = await createStrictPiSession({
  sessionId: 'review-1',
  model: trustedModel,
  modelRuntime: trustedModelRuntime,
  files: { 'src/example.ts': 'export const value = 1;\n' },
  tools: ['read', 'list', 'write', 'edit'],
  policy: approvedPolicy,
  audit: trustedAuditSink,
  // Optional: advisorySnapshot, semantic, protectedPaths.
});

try {
  await host.prompt('Update the imported example.');
  const stagedChanges = host.changes(); // Inspect/export; do not auto-apply or execute.
} finally {
  await host.stop();
}
```

The audit callback is mandatory and awaited; the host is responsible for its actual
persistence. Passing a no-op callback is not durable audit. Host budgets default to
32 tool attempts, 16 assistant turns, and 120 seconds per prompt. Budget exhaustion
stops the host permanently; unknown and rejected tool attempts also consume the budget.

Strict audit events describe dispatcher authorization decisions, not a durable
decision/execution transaction log. Tool names unregistered in Pi are rejected before
the dispatcher and consume the host budget, but do not generate a strict dispatcher
event. Immediate queue-limit or already-terminal rejections also avoid enqueueing new
audit work; an unavailable audit sink cannot be relied on to record its own failure.

An optional pinned advisory snapshot uses the shared Injector. Prompt and accepted
write/edit actions may produce independent advisory blocks. Injector errors cannot
alter the execution decision, mandatory audit, or staged file result. Advisory text
does not authorize anything.

## Applying changes

`changes()` returns a host-only change plan. No tool applies that plan to disk, runs
tests, installs packages, loads generated code, or restarts a Harness. Exporting or
applying the plan is an explicit human/host operation outside this restricted session.
Do not automatically execute or trust generated code because it passed this gate.

This restriction is intentional: adding arbitrary Shell or native filesystem writes
would require a new boundary design and adversarial evidence, not another allowlist
entry. Human operations outside the Harness are outside the declared protection scope.

## Unsupported entrypoints

- The ordinary Pi extension rejects explicit strict requests by blocking its tool and
  user-shell paths with `amos_strict_requires_controlled_host`.
- The OpenCode Promise plugin rejects strict setup. A rejected plugin load is not proof
  that the whole OpenCode service stopped; use no strict-safety claim for that host.
- Disabling an ordinary plugin does not disable this controlled host: it is a separate
  programmatic entrypoint, not a plugin discovered from the project.

## Verification and limits

Focused tests must establish that denied requests produce no staged changes or read
disclosure, and that the controlled Pi session cannot reach native tools or discover
hostile project resources. Unit tests alone do not establish host/OS isolation.

The repository's wider runtime-enforcement NO-GO remains in force. Native disk mutation,
Shell/network mediation, durable authenticated approvals, tamper-resistant audit, trusted
control-plane deployment, and strict OpenCode integration are not provided by this pass.
Security-sensitive changes still require human review before merge or deployment.
