# P1: offline project activation and shared projections

Status: implemented as an **offline-shadow compiler**, not connected to either
Harness. This slice does not publish policy, authorize execution, open a database,
call Jev, or change the existing file configuration. Runtime security remains
Stage A `log-only` / NO-GO.

The product direction is human-maintained rules and bounds, with system decisions
and an independent reviewer where needed rather than routine human action
approvals. This prerequisite slice gives that future host one explicit project
activation set. It does not implement the reviewer before an execution boundary.

## Inputs and ownership

`activation/index.ts` exports `createProjectActivationCompiler`,
`createProjectActivationStore`, the input/output types, format constants, and
`ActivationError`.

The compiler takes an inert JSON-compatible `ActivationCompilerOptions`:

- `rawSchema`: the existing complete rule-table JSON Schema as a string;
- `libraryVersion`: the source catalog version;
- `rules`: immutable-source candidates `{version, rule, injection}`;
- `mandatoryRuleRefs`: exact `{id, version}` baseline members fixed at compiler
  construction, not chosen by each project.

Rule revisions are positive safe integers. `rule` retains the existing strict
schema, including all metadata and the seven predicate operators. `injection` is
either null or the closed selection-metadata structure in `activation/types.ts`.
It cannot override the rule's ID, narrative, source, owner, TTL or pairing.
Even inactive catalog entries must pass validation.

The compiler input is not a trusted publication record. Authentication of the
catalog, selection, standard baseline and schema is the future publisher/host's
responsibility. The compiler protects its captured copies from subsequent caller
mutation; it does not protect the process from its owner.

## Project selection

`compiler.compile(input)` accepts a `ProjectActivationInput`:

| Field | Meaning |
| --- | --- |
| `projectId` | Explicit project identity, never inferred from process cwd |
| `workspace` | Normalized absolute POSIX path; lexical identity only |
| `policyVersion` | Caller-supplied version of this project configuration |
| `selectedRuleRefs` | Ordered exact ID/revision selections, not a global-library toggle |
| `excludedRuleIds` | Known nonmandatory IDs subtracted from the selected set |
| `advisoryBaselineRuleIds` | Fallback narrative IDs from the active injection projection only |
| `routes` | Existing Injector routing structures, restricted to active narrative IDs |

The effective activation is the mandatory members followed by selected members,
minus legal exclusions. A selected mandatory member at the same revision is
deduplicated; selecting another revision is rejected. Unknown references,
duplicate selections/exclusions, conflicting revisions, mandatory exclusions and
an empty effective activation fail compilation. Excluding a known but unselected
nonmandatory ID does not activate it or any other library member.

Mandatory members appear explicitly in `activeRules` with `mandatory: true`.
No hidden global baseline is evaluated separately. The `mandatory` flag itself
does not authorize execution; its source must still be authenticated by a host.

## One source, distinct payloads

Each `ProjectActivationSnapshot` contains:

- `project`, fixed source-library/schema/compiler identities and `activeRules`;
- one `activationDigest` shared by every projection;
- `enforcement.runtime`, `.ci` and `.server`, each containing every active
  deterministic rule for that actual checkpoint;
- `advisory`, compiled with the existing `compileAdvisorySnapshot`;
- content digests for the individual projections and the complete snapshot;
- `mode: "offline-shadow"`, which is not rollout eligibility or an executor.

An active hard rule may both be evaluated and have a narrative in the advisory
projection. The compiler derives its `pairedRuleId` and narrative revision rather
than accepting a caller's assertion of pairing. A pure advisory rule cannot enter
an execution projection. Source records are serialized canonically for the
existing Injector's string `source` field; the full source object is also retained
on the active rule.

Prompt scoring, route suppression and rendering budgets only select advisory
text. They cannot filter or mutate the execution projections. Unselected rules
cannot be evaluated through these projections or introduced into injection by
naming them in a prompt. Native Injector validation rejects routing/baseline
references outside the active narrative set.

Empty checkpoint projections are explicitly `status: "empty"`. Empty advisory
is `{status: "empty", snapshot: null, ...}` and cannot carry baseline/routes.
These are valid compilation states, not missing data or an engine allow verdict.
A downstream host must not call the engine with an empty array, reinterpret an
unknown executor as an empty checkpoint, or infer permission from that status.
The engine's existing empty-table fail-closed result remains unchanged.

## Verification, hashing and last-good state

All outputs are deeply frozen, and caller-owned inputs are neither mutated nor
frozen. Input copying rejects non-JSON values, accessors, sparse arrays and
excessive size/depth. Errors expose only `ActivationError` with
`code/message: "activation_error"`, not schema diagnostics or hostile content.

The format is `amos-project-activation`, version 1, with a separately versioned
compiler and domain-separated SHA-256 digests. Identity binds the project,
workspace, policy version, source-library version, schema bytes, resolved rule
versions/content, routing/selection data and all projections. Array order is
preserved because it affects advisory tie-breaking; object key order does not
affect identity.

`compiler.verify(snapshot, {projectId, workspace})` recompiles against the same
fixed catalog and compares the complete canonical result. It rejects wrong
identity, mixed projections, unknown fields, missing content and drift, returning
a freshly verified immutable snapshot rather than trusting the submitted object.
This is **not authentication**. It does not prove human approval, current rollout,
monotonic policy versions or the current release. A future host must separately
authenticate its publisher and pin/compare the expected published digest.

`${SESSION_WORKSPACE}` expansion is limited to existing `target_glob` and
`target_outside_glob` pattern values. The reserved token in other predicates is
rejected; documentation may mention it unchanged. No general variable expansion,
realpath, symlink or TOCTOU guarantee is added.

`createProjectActivationStore(compiler, identity)` binds an in-memory store to
one project and workspace. `load(input)` returns `{snapshot, error}`. It replaces
current state only after compilation and identity verification succeed; failure
returns only this store's last-good snapshot and `activation_error`. On initial
failure the snapshot is null. A request for another identity is an error, not a
switch; stores never borrow each other's snapshots. A new store starts empty.

No file persistence, TTL renewal, runtime epoch switch or activation-pointer
ownership is implemented. Rule TTL strings are preserved exactly, and the engine
continues to evaluate expiry using its injected clock. Native advisory TTL is an
expiry hint; the current selector does not itself retire expired narratives.
Therefore these offline outputs are not a live expiry/injection protocol. The
future host/publisher must enforce validity and epoch changes before using them
as runtime policy; last-good never authorizes extending expired/revoked grants.

## Try the offline compiler

Run from this worktree's root, with Node 26:

```sh
npm ci
npm run build
node --test dist/activation/*.test.js
```

A read-only import example after building:

```js
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createProjectActivationCompiler } from './dist/activation/index.js';

const rules = parse(readFileSync('constraints/rules.yaml', 'utf8'));
const refs = rules.map((rule) => ({ id: rule.id, version: 1 }));
const compiler = createProjectActivationCompiler({
  rawSchema: readFileSync('constraints/schema.json', 'utf8'),
  libraryVersion: 'offline-import-1',
  rules: rules.map((rule) => ({
    version: 1,
    rule,
    injection: {
      areas: [], pathHints: [], taskTags: [], keywords: [], tags: [],
      specificity: 1, priority: 0,
    },
  })),
  mandatoryRuleRefs: refs.filter((ref) =>
    rules.some((rule) => rule.id === ref.id && rule.level === 0)),
});
const snapshot = compiler.compile({
  projectId: 'offline-demo', workspace: '/work/demo', policyVersion: 'demo-1',
  selectedRuleRefs: refs, excludedRuleIds: [], advisoryBaselineRuleIds: [], routes: [],
});
console.log(snapshot.mode, snapshot.activationDigest);
```

This example neither publishes the catalog nor connects the result to Pi or
OpenCode. Existing adapters keep their original loader and guidance seed until an
explicit migration. Neither Jev path changes, and no automatic approval occurs.

## Evidence and next slice

`activation/*.test.ts` covers two-project separation, explicit baseline protection,
closed routing, same-version hard/advisory pairing, prompt/budget independence of
hard rules, schema and workspace failures, immutable/deterministic content,
explicit empty projections, foreign/mixed snapshot rejection and process-local
last-good behavior. It compares the real YAML source with the existing loader and
runs existing language-neutral fixture cases through the new compilation path.

Legacy snapshot archives, their digest formula and JSONL formats are not changed.
No new fields are added to the strict rule/action schemas. Required integration
checks remain `npm run typecheck` and `npm test` from the worktree root.

The next execution slice is a real host boundary: first demonstrate that a
stopped request has no side effects without any reviewer. Only then can a
separate security reviewer consume a bound, stopped confirm request. This module
and its passing tests are not evidence that that boundary already exists.
