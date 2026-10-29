# Engineering workflow gate

Status: **opt-in workflow guardrail, not a security boundary.** It is separate from the
security adapters' Stage A `log-only` mode. Enabling it may block a dangerous shell
command or hold work for engineering review; that does not turn Amos into complete
mediation or a trusted execution boundary.

## What it does

- Selects advisory engineering rules from a session-pinned snapshot before and during a coding run. The current DB-free adapter uses a transitional seed compiled from `guidance/`; it is not a trusted control-plane snapshot.
- Assesses bash commands through a strict, closed-subset lexer before execution.
  Known destructive, privilege, interpreter, meta-executor, network, and forced-VCS
  operations are denied or require confirmation. Unknown syntax and executables are
  never silently allowed.
- Runs fixed local change checks (`npm run typecheck`, `npm test`) after changes when
  completion review is enabled.
- Optionally sends a filtered diff and applicable guidance to Jev through TypeSafe or
  OpenRouter. A model concern or uncertainty holds the work for review; it never
  approves a merge or weakens a deterministic check.
- Optionally assesses a model-authored shell action against the harness-captured human
  requirement. The semantic result can only tighten the deterministic shell verdict:
  mismatch may deny, partial/unclear may require confirmation, and a match never turns
  deny or confirm into allow.
- Never logs shell command text, file contents, credentials, or the raw diff.

## Configuration

Pi reads the gate from the local, untracked `.pi/amos.json`; OpenCode reads the equivalent
object from plugin options. The security audit configuration remains required and
independent. `.pi/` must not be committed; create it locally.

```json
{
  "workflowGate": {
    "enabled": true,
    "guidance": true,
    "shellGate": true,
    "completionReview": true,
    "jevConfigPath": "./decision/jev.local.json",
    "actionAssessment": false,
    "requirementEgress": "denied"
  }
}
```

`enabled` is required. When enabled, `guidance`, `shellGate`, and `completionReview`
default to `true`; `actionAssessment` defaults to `false` and `requirementEgress` defaults
to `denied`. `completionReview` or `actionAssessment` requires `jevConfigPath`.
`actionAssessment` also requires `shellGate`, and `requirementEgress: "allowed"` is valid
only when action assessment is enabled. Paths resolve against the harness session/project
directory, not the process cwd. Missing gate configuration means disabled; an explicitly
malformed gate configuration is handled fail-closed for gated actions.

## Human requirement and action assessment

When `actionAssessment` is enabled, each harness captures the current user prompt into a
session-bound `RequirementFrame`. Only the direct user-input channel creates a frame; a
tool result, file, model message, MCP response, or subagent prompt cannot. A new user turn
replaces the previous frame, and an invalid or oversized turn clears it rather than
leaving a stale requirement behind.

`requirementEgress` is a separate consent switch because the requirement text is user
content. `denied` keeps it local; the provider rejects the assessment, and policy decides
whether that is a fail-closed denial or just loses the optional semantic signal. With
`assessmentRequired: true`, a missing frame, denied egress, provider failure, or timeout
denies the otherwise eligible shell action. With `false`, the deterministic verdict is
preserved.

The provider sees only a bounded structural action: shell input with the assessment kind,
reason, and safe operation descriptors (`program`, `effect`, `reason`). It never sees the
raw command, arguments, redirect targets, file contents, environment, credentials, or the
requirement text unless egress is explicitly allowed. Successful and failed assessments
are written as separate audit entries containing the requirement-frame digest, provenance,
fixed fact fields, deterministic/final verdicts, and fixed error codes; the requirement
text and declared scope are not logged.

A direct command typed through Pi's `user_bash` channel is a separate literal-grant path.
The harness captures the exact command text, binds a `UserLiteralGrant` to its digest, and
resolves every non-deny verdict without a UI prompt. Every deterministic `deny` remains a
hard stop. The grant is not available to model-authored tool calls and never invokes Jev.

OpenCode V2 can only perform action assessment in `shell.create.before`. If the host omits
`sessionID` there, no requirement frame can be associated: required assessment denies and
optional assessment preserves the deterministic verdict without calling the provider. A
semantic `confirm` created from a deterministic `allow` fails closed rather than relying on
a later permission event that may not ask.

## Advisory injection pipeline

The shared `injector/` module compiles the transitional guidance packs into an immutable advisory snapshot, selects only rules present in that active snapshot, and renders independent `<amos-guidance>` blocks with `policy`, `digest`, and `mode="advisory"` provenance. Selection is deterministic: normalized action areas, fixed glob path hints, structured task tags, and bounded prompt token matching can rank rules, but a prompt cannot introduce a rule that is absent from the snapshot. The seed baseline is snapshot data; the selector has no global base-pack fallback.

Injection state is scoped to a harness session. Rules and action areas are deduplicated, prompt/area/session character budgets apply, and a block is committed only after the host accepts its emission. Current state is process-local; reconstruction after a process restart and durable per-decision advisory-digest audit records are not implemented yet.

- Pi replaces only the `amos-workflow-guidance` system-prompt section on user turns. After a normalized write/edit action, it can append one independent text block through `tool_result` without changing existing result text or dropping `structuredContent`.
- OpenCode V2 stores prompt guidance through the keyed instruction API when available, otherwise appends it at the next `session.context`. Because V2 has no after-tool hook here, area guidance is queued by `tool.execute.before` and emitted at the next context as an independent system part.
- Selection, rendering, and channel failures are advisory-only: they do not allow, deny, or confirm an action and do not change the deterministic gate result. The current static seed remains inside the agent-writable repository and provides no authenticity or tamper-resistance guarantee.

## Jev credential boundary

Shared examples use an environment reference:

```json
{
  "schema_version": 1,
  "provider": "openrouter",
  "baseUrl": "https://openrouter.ai/api",
  "apiKey": { "env": "OPENROUTER_API_KEY" },
  "defaultModel": "typesafe/jev-1.14",
  "models": ["typesafe/jev-1.14", "typesafe/jev-1.13"],
  "timeoutMs": 8000,
  "assessmentRequired": true,
  "policy": { "reviewRisk": 0.6, "denyRisk": 0.9, "minConfidence": 0.6 }
}
```

A literal credential is accepted only from an explicit local file such as
`decision/jev.local.json`, which is Git-ignored; on POSIX the file must be owned by the
current user and have mode `0600`. A shared or example file must use `{ "env": ... }`.
Custom non-official HTTPS endpoints require `allowCredentialEgress: true` in the protected
local configuration. Remote plaintext HTTP, URL userinfo, query strings, and fragments are
rejected. This protects against accidental egress; it is not a defense against a malicious
process running as the same OS user.

OpenRouter and TypeSafe both use the System One `state + questions` protocol. The
OpenRouter endpoint is `https://openrouter.ai/api/v1/systemone`; this is not the chat
completions API. TypeSafe direct uses `https://api.typesafe.ai/v1/systemone`. There is no
automatic model fallback.

## Harness behavior and limits

### Pi

Pi supports pre-execution `{ block: true, reason }` for `tool_call`, including bash and
PowerShell, and has a separate `user_bash` path that is blocked by throwing. Interactive
confirmation uses the Pi UI; without a dialog-capable UI, a confirm-class decision is
blocked. At `agent_before_settle`, the gate runs a review and may request one repair
continuation for a given diff digest; it does not loop indefinitely.

### OpenCode V2

OpenCode `execute.before` cannot block by its documented contract. The gate uses
`shell.create.before` plus native permission evaluation to deny or ask before shell
execution, and blocks unanalyzable code-execution tools while enabled.

The native approval path covers only the agent shell tool's plan-class `confirm` decisions.
After `tool.execute.before` and `shell.create.before`, OpenCode runs its own shell
`permission.assert`, then `permission.evaluate`, and finally the user's `once` / `always` /
`reject` choice. The gate's `shell.create.before` hook returns without throwing only when
the assessment is a parsed plan-class confirm and the `permission.evaluate` hook registered
successfully; otherwise a confirm-class decision fails with
`amos_workflow_gate_shell_confirm_unavailable`, because this path cannot approve it. That
code means "this path cannot approve", not "waiting for approval". Opaque, unsupported, and
reduced-host assessments remain fail-closed.

The `permission.evaluate` hook can only tighten: it raises an `allow` to `ask` for a parsed
confirm and forces `deny` for denied or unanalyzable resources; it never relaxes an existing
`deny` or `ask`.

This approval path is only for the agent shell tool. The `/api/shell` endpoints and
`POST /api/session/{id}/shell` are not in this channel and must not be described as
gate-managed. Several host behaviors also remain outside the gate's control:

- `--auto` (or an equivalent non-interactive mode) may accept `once` automatically rather
  than obtaining a human approval.
- A saved `always` decision may still be followed by another `ask` when the gate tightens
  the effect; treating `always` as a permanent allow is unsound.
- Without a registered permission hook, confirm-class actions are unavailable
  (`amos_workflow_gate_shell_confirm_unavailable`), not queued.

The gate therefore remains an engineering guardrail, not a security boundary. Direct shell
APIs cannot be claimed as mediated by this plugin.

### OpenCode approval verification (2026-10-30)

A real OpenCode 2.1.4 standalone TUI session used the plan-class command
`npm install --dry-run --ignore-scripts left-pad`. The native prompt presented
`Allow once`, `Always allow`, and `Reject`:

- `Allow once` completed the dry run successfully; no package was installed.
- `Reject` stopped the call with `The user declined this tool call`; no package was installed.
- The full compiled suite was 465/465 passing, with TypeScript and dependency audits clean.

This verifies the native agent-tool approval path, not the excluded direct shell APIs or
non-interactive/auto modes.

OpenCode's context hooks can provide review feedback before a later model request, but the
documented API does not provide a true "prevent settle/merge" hook; the local feedback must
not be described as such. Branch protection and CI remain the merge authority.

## Explicit non-guarantees

- The shell classifier is deliberately a closed subset. Expansions, substitutions,
  globs, braces, heredocs, compound syntax, `cd`, assignments, PowerShell, custom shells,
  and non-empty shell command prefixes are opaque and fail toward confirmation/denial.
- Redirect containment is lexical; there is no symlink, hard-link, bind-mount, or TOCTOU
  protection.
- Safe git/npm entries still trust repository configuration and package scripts. Running
  repository scripts can execute project-defined code by design.
- Disabled extensions, alternate harness entry points, `pi.exec`, extension code, MCP
  tools, and a compromised harness remain outside this gate.
- Jev is a probabilistic semantic sensor. A "pass" is not proof of correctness or safety
  and does not authorize merge or release.
