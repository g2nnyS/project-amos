# Product shape

Target revised **2026-11-02**. The detailed contract is [Product Design](product-design.md),
with evidence and acceptance gates in [Gap Closure](product-gap-plan.md).
This is a design update only; no configuration migration or runtime enforcement is enabled.

The product is three parts. None of them replaces the others.

1. **Approve for me.** A host sandbox stops a boundary crossing. A separate
   reviewer may approve or deny that one stopped escalation. This is the
   security shape below. It is not implemented.
2. **Multi-dimensional intercept rules, with a built-in standard.** The human
   edits rules along the existing dimensions through the GUI. At the GUI stage,
   protected-service-owned SQLite is the sole configuration authority; YAML/Git
   are import/export and archives. The repository currently ships a draft
   standard in `constraints/rules.yaml`. User rules can tighten that set. They do
   not replace the host envelope, and they are not a new expression language.
3. **Dynamic injection of engineering norms.** The injector selects versioned
   narratives from the same project activation snapshot into the model context
   for the current area, path, and task. Hard rules may also have an explanatory
   narrative projection. A prompt cannot introduce a rule. Injection never intercepts, approves,
   or changes a verdict.

Runtime security enforcement remains NO-GO until part 1's sandbox exists and
has stopped a boundary crossing without a model. Parts 2 and 3 already have a
working draft: the standard rule table, and session-pinned advisory injection.
The draft rule table does not yet intercept live tool calls.

## Security shape: sandbox, on-request, auto-review

Status: **target, revised 2026-11-02. Not implemented.** Current security
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
- Network is off by default. Any single-request exception requires a human-approved
  escalation ceiling and a suitably restricted executor. Neither a rule nor the
  reviewer can turn on persistent network access.
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

The target does not require a human to approve individual escalations. Any
system retry must be bounded, revalidated and reviewed again; it is not a standing
grant or a way to override any deterministic deny, including non-level-0 denies.
Repeated refusal ends the attempt. This protocol is not implemented.

## Auto-review is not today's Jev

`decision/` Jev is the engineering and requirement sensor. It may only tighten.
`match` must not turn `deny` or `confirm` into `allow`. Do not reuse
`combineDeterministicWithAssessment` as the security reviewer.

The target security reviewer is a separate Jev role, not the existing sensor:

- It sees the stopped escalation, not a prompt that asks it to invent policy.
- It may approve only a confirm-class escalation that the sandbox already
  stopped.
- It cannot create an executor, enlarge standing path/network permissions, or
  create a protected-path exception. A bounded one-request grant must remain
  within the host's pre-approved escalation ceiling.
- It cannot relax a deny.
- Its instructions are not the enforcement rule table. The approved base and
  any preauthorized temporary epoch remain host-compiled data, not reviewer edits.

Engineering workflow review stays tighten-only. Advisory injection stays
advisory. An injection failure must not change a sandbox decision or a reviewer
decision.

Across security and engineering gates, the target is automatic case-by-case
decisions under human-maintained rules and preauthorized bounds, not routine
human approvals. Deterministic denies, failed checks and host boundaries are not
overridable by Jev; missing evidence, failed review and unsupported entry points
remain stopped. Model approval can be wrong and is not proof of safety. Current
workflow and host integrations do not yet provide this end-to-end automation.

## Built-in standard, then user rules

`constraints/rules.yaml` is the current draft standard across `credential`,
`filesystem`, `network`, `side_effect`, and `resource`. The target compiler inserts
the mandatory baseline explicitly into each project's activation set; it does
not secretly execute an entire global library outside that set. A project may
select other standard/user rules but cannot exclude or weaken standard level-0
denies or disable the sandbox. Rule rollout remains a separate, approved state.

The shell guardrail is part of the built-in standard, not a user expression.
Shell command text is outside the frozen predicate vocabulary, so users do not
write shell patterns. Unknown shell syntax stays confirm or deny in the
existing closed-subset assessor.

## User-edited rules

The human edits the same multi-dimensional rule model as the standard set in
the GUI, through an authenticated configuration service. SQLite becomes the sole
authority at that stage, not a second writable mirror of YAML or Git.
No new expression language. The seven predicate operators stay frozen. A
condition the operators cannot express is `advisory_only`, not a new operator.

Fields the human edits, and the role they compile to:

| Field | What the human is editing |
|---|---|
| `dimension` | Which asset the rule covers. Current values include `credential`, `filesystem`, `network`, `side_effect`, and `resource`. A new dimension is a label, not a new operator or a new table. |
| `policy_class: security` plus `enforcement: runtime` | Runtime rule projection, subject to activation and rollout. Does not define the host sandbox. |
| `policy_class: engineering` | Engineering guardrail or CI. Not the security reviewer. |
| `expressivity: advisory_only` plus `enforcement: advisory` | Dynamic injection only. The injector may render it. It cannot stop, allow, or approve an action. |
| `level: 0` plus `on_hit: deny` | Non-overridable deny. The reviewer cannot approve it. |
| `on_hit: confirm` | Escalation. Eligible for auto-review when no deny matched. |
| `on_hit: log` | Audit only. |
| `on_hit: deny` at level greater than 0 | Still deny. The reviewer cannot approve it. |
| `scope` | `project` or `session` lifetime/applicability metadata; project binding and rule-level activation are compiled separately. No current runtime selection. |
| `ttl` | Expiry. An expired rule does not match. |
| `owner: human` | Authorship metadata, not authentication. Publication requires a trusted channel and a valid publish record. |
| `owner: agent` | Proposal provenance, never publishing authority. A trusted publisher may accept a bounded temporary template activation under prior human authorization; it does not grant the agent write access. |
| `predicate` | Frozen operators only. |
| `narrative` | Human-readable text and advisory wording. Not a verdict. |

Ordinary edits and all relaxation require human publication and a later session.
An approved base stays pinned. A trusted publisher may append a finite-TTL
restriction from an already approved template under explicit human preauthorization;
addition and expiry create immutable epochs shared by both projections. It cannot
replace old rules, touch the mandatory baseline, skip rollout, or auto-publish new
unreviewed narratives. A narrower deny glob can be a relaxation: string edits alone
do not prove tightening. See Product Design sections 4 and 7.

The agent and security reviewer cannot publish either kind. Database files, WAL,
backups, publication credentials, and activation pointers must be isolated from
the agent. Merely wrapping the current agent-writable YAML in SQLite is not that
isolation. The current file loaders remain unchanged until an explicit migration.

## Dynamic injection

Injection is the third product part, not a leftover of the security shape.
Today `guidance/packs.ts` supplies a separate transitional seed. The target imports
that seed into the shared rule library and compiles enforcement and advisory from
one auditable project activation snapshot. Inactive rules are neither evaluated
nor newly injected. Task selection cannot remove hard rules from evaluation.

The injector renders active narratives matching the area, path and task. A prompt
may rank candidates but cannot activate, deactivate or persistently suppress them.
Routing failure considers all active project narratives, never the global library;
bounded rendering records omitted IDs rather than claiming complete delivery.

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

Codex documents this shape: `workspace-write`, `on-request`, and
`approvals_reviewer = "auto_review"`. Reuse its sandbox; do not build a fake
second one. SQLite remains the Amos configuration authority; native user/managed
configuration is a protected generated projection, not a competing source.

Not every Amos rule or injection lifecycle maps to a native command rule or hook.
The earlier `SessionStart` / `PreToolUse` / `PermissionRequest` sketch is a
candidate integration, not a verified adapter contract. Pin a host version,
verify APIs, coverage and failure behavior, and run real probes before claiming
enforcement. A fail-open hook cannot carry a mandatory deny. Hosted tools and
other channels need separate capability evidence. See Product Design section 11
for official references and limits. This does not clear Pi/OpenCode's NO-GO.

## Next slices

First prove project activation and both projections offline (P1 in Gap Closure).
The first execution slice is the host envelope (P2): one session where a boundary crossing has no
executor until it is stopped, and a project-file edit cannot create that
executor. Do not add the reviewer in that slice. A reviewer without a sandbox
is the plugin problem again: the model is asked to approve an action that was
never stopped.

The in-memory strict host is a seed for "no executor the host did not
register." It is not this shape. It has no operating-system sandbox and no
shell. Do not describe it as Approve for me.
