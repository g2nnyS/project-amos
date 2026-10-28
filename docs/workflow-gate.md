# Engineering workflow gate

Status: **opt-in workflow guardrail, not a security boundary.** It is separate from the
security adapters' Stage A `log-only` mode. Enabling it may block a dangerous shell
command or hold work for engineering review; that does not turn Amos into complete
mediation or a trusted execution boundary.

## What it does

- Selects versioned engineering guidance from `guidance/` before a coding run.
- Assesses bash commands through a strict, closed-subset lexer before execution.
  Known destructive, privilege, interpreter, meta-executor, network, and forced-VCS
  operations are denied or require confirmation. Unknown syntax and executables are
  never silently allowed.
- Runs fixed local change checks (`npm run typecheck`, `npm test`) after changes when
  completion review is enabled.
- Optionally sends a filtered diff and applicable guidance to Jev through TypeSafe or
  OpenRouter. A model concern or uncertainty holds the work for review; it never
  approves a merge or weakens a deterministic check.
- Never logs shell command text, file contents, credentials, or the raw diff.

## Configuration

Pi reads the gate from `.pi/atmos.json`; OpenCode reads the equivalent object from the
plugin options. The security audit configuration remains required and independent.

```json
{
  "workflowGate": {
    "enabled": true,
    "guidance": true,
    "shellGate": true,
    "completionReview": true,
    "jevConfigPath": "./decision/jev.local.json"
  }
}
```

`enabled` is required. When enabled, `guidance`, `shellGate`, and `completionReview`
default to `true`. `completionReview` requires `jevConfigPath`. Paths resolve against the
harness session/project directory, not the process cwd. Missing gate configuration means
disabled; an explicitly malformed gate configuration is handled fail-closed for gated
actions.

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
`shell.create.before` and permission evaluation to deny/ask before shell execution, and
blocks unanalyzable code-execution tools while enabled. A confirm-class shell command
must not silently execute when no safe approval path exists. OpenCode's context hooks can
provide review feedback before a later model request, but the documented API does not
provide a true "prevent settle/merge" hook; the local feedback must not be described as
such. Branch protection and CI remain the merge authority.

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
