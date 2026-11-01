# Product shape

The product is three parts. None of them replaces the others.

1. **Approve for me.** A host sandbox stops a boundary crossing. A separate
   reviewer may approve or deny that one stopped escalation. This is the
   security shape below. It is not implemented.
2. **Multi-dimensional intercept rules, with a built-in standard.** The human
   edits rules along the existing dimensions. The repository ships a standard
   set in `constraints/rules.yaml`. User rules can tighten that set. They do
   not replace the host envelope, and they are not a new expression language.
3. **Dynamic injection of engineering norms.** The injector selects versioned
   engineering guidance into the model context for the current area, path, and
   task. A prompt cannot introduce a rule. Injection never intercepts, approves,
   or changes a verdict.

Runtime security enforcement remains NO-GO until part 1's sandbox exists and
has stopped a boundary crossing without a model. Parts 2 and 3 already have a
working draft: the standard rule table, and session-pinned advisory injection.
The draft rule table does not yet intercept live tool calls.

## Security shape: sandbox, on-request, auto-review

Status: **target, recorded 2026-11-01. Not implemented.** Current security
adapters remain Stage A `log-only`.

This shape matches ChatGPT / Codex **Approve for me**, not a harder claim than
that product makes. Official names:

| Control | Codex | Amos target |
|---|---|---|
| Sandbox | `workspace-write` | Host executor. Session workspace is writable. Network is off. Policy, audit, host configuration, and credential paths are protected. |
| Approval policy | `on-request` | Inside the sandbox, a non-matching action proceeds. Crossing the sandbox, or hitting a user rule with `on_hit: confirm`, stops and creates one escalation. |
| Reviewer | `auto_review` | A separate reviewer may approve or deny that stopped escalation. It is not the engineering Jev path. |

Approve for me is a reviewer swap. It does not expand writable roots, enable
network, or weaken protected paths. Amos copies that limit. The reviewer is not
a deterministic guarantee; it can be wrong. A wrong approval is still confined
to the single stopped request. It cannot enlarge the sandbox.

## What holds before any model runs

The sandbox is not a rule and not a plugin. It is the host that actually
performs the side effect. Ordinary `pi` and OpenCode plugins do not become this
host by setting a mode flag. A project file the agent can write cannot turn the
sandbox off.

Default envelope, fixed by the host, not by a project rule:

- Writes stay inside the session workspace.
- No network destination is reachable until a human publishes a wider host
  setting. A rule cannot express "enable network."
- Policy files, audit logs, host configuration, and credential paths are
  protected. A project rule cannot remove them.
- Unknown tools and unmediated entry points have no executor. They are not
  guessed into an allow, and they are not sent to the reviewer as a way around
  the missing executor.

User rules sit on top of this envelope. They can make it stricter. They cannot
define it into existence, and they cannot switch it off.

## On-request

The deterministic engine decides which stopped actions are eligible for review.
Only `predicate`, `on_hit`, and `ttl` select the verdict. The other fields
assign the rule to a role before evaluation; they are not a second verdict
language.

| Stop reason | Eligible for auto-review? | If the reviewer approves |
|---|---|---|
| Level 0 `on_hit: deny` | No. Stays deny. | Impossible. Approval is not accepted. |
| Any other deterministic `deny` | No. | Impossible. |
| Sandbox crossing or `on_hit: confirm`, and no deny matched | Yes. One request, bound to the action digest and the pinned snapshot digest. | That one action may run. The sandbox is unchanged. |
| `on_hit: log`, or no match inside the sandbox | No review. The action is already allowed by the envelope. | Not applicable. |
| Unknown or unmediated action | No. No executor. | Impossible. |

Reviewer failure, refusal, timeout, or low confidence does not approve. The
action stays stopped. Timeout is not evidence that the action is safe.

A human may still approve one exact denied escalation for one retry, as Codex
`/approve` does. That approval is not a standing grant, and a level 0 deny
remains ineligible. This protocol is not implemented.

## Auto-review is not today's Jev

`decision/` Jev is the engineering and requirement sensor. It may only tighten.
`match` must not turn `deny` or `confirm` into `allow`. Do not reuse
`combineDeterministicWithAssessment` as the security reviewer.

The security reviewer is a separate role:

- It sees the stopped escalation, not a prompt that asks it to invent policy.
- It may approve only a confirm-class escalation that the sandbox already
  stopped.
- It cannot grant a tool, a path, a network destination, or a protected-path
  exception.
- It cannot relax a deny.
- Its instructions are not the enforcement rule table. User rules remain data
  the host compiled before the session started.

Engineering workflow review stays tighten-only. Advisory injection stays
advisory. An injection failure must not change a sandbox decision or a reviewer
decision.

## Built-in standard, then user rules

`constraints/rules.yaml` is the built-in intercept standard: fifteen rules
across `credential`, `filesystem`, `network`, `side_effect`, and `resource`.
The host always loads this standard. A user table may add rules and may
tighten a standard rule. It may not delete or weaken a level 0 standard deny,
and it may not turn the sandbox off.

The shell guardrail is part of the built-in standard, not a user expression.
Shell command text is outside the frozen predicate vocabulary, so users do not
write shell patterns. Unknown shell syntax stays confirm or deny in the
existing closed-subset assessor.

## User-edited rules

The human edits the same multi-dimensional rule format as the standard set.
No new expression language. The seven predicate operators stay frozen. A
condition the operators cannot express is `advisory_only`, not a new operator.

Fields the human edits, and the role they compile to:

| Field | What the human is editing |
|---|---|
| `dimension` | Which asset the rule covers. Current values include `credential`, `filesystem`, `network`, `side_effect`, and `resource`. A new dimension is a label, not a new operator or a new table. |
| `policy_class: security` plus `enforcement: runtime` | Security envelope. Compiles into the host snapshot. |
| `policy_class: engineering` | Engineering guardrail or CI. Not the security reviewer. |
| `expressivity: advisory_only` plus `enforcement: advisory` | Dynamic injection only. The injector may render it. It cannot stop, allow, or approve an action. |
| `level: 0` plus `on_hit: deny` | Non-overridable deny. The reviewer cannot approve it. |
| `on_hit: confirm` | Escalation. Eligible for auto-review when no deny matched. |
| `on_hit: log` | Audit only. |
| `on_hit: deny` at level greater than 0 | Still deny. The reviewer cannot approve it. |
| `scope` | `project` or `session` activation. Not a runtime selector until a compiler uses it. |
| `ttl` | Expiry. An expired rule does not match. |
| `owner: human` | May be published into the enforcement snapshot. |
| `owner: agent` | Proposal only. Never enforcement, never injection that reduces protection. |
| `predicate` | Frozen operators only. |
| `narrative` | Human-readable text and advisory wording. Not a verdict. |

Tightening edits — adding a deny, narrowing a glob, adding a confirm
escalation, adding advisory text — may be published by the human into the next
session snapshot.

Relaxing edits — deleting a rule, excluding a path, widening the workspace,
changing `deny` to `confirm` or `log`, suppressing a rule — are also human
publishes, and only for a later session. The running session keeps the snapshot
it started with. The reviewer cannot perform a relaxing edit. The agent cannot
publish either kind.

`constraints/rules.yaml` in this repository is the human edit format and a
draft. It lives in the agent-writable tree, so a running host must pin a copy
the agent cannot swap. Editing the file during a session does not change that
session. Wrapping the same file in a database does not create the sandbox.

## Dynamic injection

Injection is the third product part, not a leftover of the security shape.
`guidance/packs.ts` holds the built-in engineering norms. The injector compiles
a session-pinned advisory snapshot and renders only the norms that match the
current area, path, and task. The prompt may rank active norms. It cannot add
or remove one.

Injected text is context for the model. It is not an intercept rule and not
the reviewer policy. A missing or failed injection leaves the sandbox decision
and the reviewer decision unchanged. Engineering norms stay `advisory`; they
do not become security denies by being injected.

## What is unchanged

- Engineering workflow gate: closed-subset shell guardrail, part of the
  built-in intercept standard, not a user-authored shell language and not by
  itself the Approve for me sandbox.
- Session-pinned advisory injection: prompt may rank active advisory rules and
  cannot introduce one. Injection failure does not change a verdict.
- Stage A adapters: hypothetical verdicts, no security `deny` / `confirm`
  blocking.
- `deny > confirm > log > allow`, same-tier deny, and fail-closed evaluation.
- No new predicate operator, regex router, or custom expression language.

## Not this shape

- A plugin flag named `strict` or `approve-for-me` on ordinary `pi` or OpenCode.
- Letting today's Jev approve a `confirm`.
- Treating dynamic injection as the reviewer policy.
- A governance console that edits rules while the agent still executes through
  an unmediated harness.
- Claiming Approve for me alignment because a model looked at an action.

## Codex

Codex already has this shape: `workspace-write`, `on-request`, and `auto_review`.
Do not build a second sandbox inside it. Compile the built-in standard and
human rule edits into the user layer (`~/.codex/`) or managed
`requirements.toml`, not into a repository `.codex/` the agent can write.
Untrusted projects skip project-local rules and hooks. Managed requirements
outrank project files.

Engineering norms go through a user-layer `SessionStart` hook as
`additionalContext`. A `PermissionRequest` hook may answer only an escalation
Codex has already stopped: a deterministic `deny` must be denied, and a
confirm-class request may be approved once. If the hook does not decide,
Codex's own reviewer continues. `PreToolUse` may deny a level 0 match and must
not approve. Hook failure, timeout, or a malformed response may not block the
tool, so the hook is tightening, not the sandbox. Hosted tools such as web
search are outside this path. This integration does not clear the NO-GO for Pi
or OpenCode.

## Next slice

Build the host envelope first: one session where a boundary crossing has no
executor until it is stopped, and a project-file edit cannot create that
executor. Do not add the reviewer in that slice. A reviewer without a sandbox
is the plugin problem again: the model is asked to approve an action that was
never stopped.

The in-memory strict host is a seed for "no executor the host did not
register." It is not this shape. It has no operating-system sandbox and no
shell. Do not describe it as Approve for me.
