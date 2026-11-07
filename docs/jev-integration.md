# Jev integration: semantic sensor, not policy authority

The `decision/` module integrates TypeSafe Jev (`POST /v1/systemone`) as an
**optional probabilistic semantic sensor**. It never replaces the deterministic
rule engine, and on this assessment path it cannot grant permissions.

The `decision/` assessment path is not an authorization or security-enforcement
mechanism. Do not treat `combineDeterministicWithAssessment` as permission to
execute an action. The managed `confirm` reviewer is a separate Jev caller,
described in [Managed confirm reviewer](#managed-confirm-reviewer-2026-11-07);
it issues at most one one-shot grant for one stopped request.

## Boundary

```
harness-captured RequirementFrame ──┐
                                    ▼
deterministic engine ──> verdict ──┐
                                   ├─> maxVerdict() ──> final verdict
Jev facts ──> trusted mapping ─────┘
```

- `engine/` remains the authority. Its `Verdict` is the baseline.
- Jev returns bounded facts (`intent`, `requirementMatch`, `sensitiveArea`,
  `irreversible`, `riskScore`, `confidence`), not a verdict.
- Trusted code maps those facts through explicit thresholds and policy.
- `combineDeterministicWithAssessment` is a strict maximum: the model may
  tighten `allow -> log/confirm/deny`, but can never relax `deny` or `confirm`.
- When an assessment is required and the provider fails, the async helper
  fails closed to `deny`. Optional assessments preserve the deterministic
  result.
- Every fact set is bound to the digest of the requirement frame it was
  produced from. A mismatch is treated as an assessment failure.

## Requirement conformance

`requirementMatch` answers "does this action serve what the human asked for".
It is a separate question from `intent` (`feature`/`fix`/...), which is
telemetry only.

| Deterministic baseline | `requirementMatch` | Model verdict |
| --- | --- | --- |
| any | `match` | normal thresholds |
| `allow` | `partial` / `unclear` | `confirm` |
| `allow` | `mismatch` | `deny` |
| `deny` / `confirm` | any | unchanged by `match` |

A requirement frame is only valid when the harness captured it from a user
input channel. `source: "delegated"` records an agent-authored instruction and
must never be used to relax a deterministic verdict. Requirement text, file
contents, tool results, MCP responses, and model summaries are not substitutes
for a frame.

Requirement text is user content. The frame must carry `egress: "allowed"`
before the provider will send it; otherwise the provider throws
`egress_denied`. Audit only the frame digest and provenance, never the text or
declared scope.

## Managed confirm reviewer (2026-11-07)

The managed `confirm` branch no longer calls an independent HTTP reviewer
service. `review/jev-reviewer.ts` (`createJevManagedReviewer`) is the only
semantic reviewer on that path. It is a second Jev caller, separate from the
`decision/` sensor above: it reuses the same provider and configuration loader
and adds the bindings the harness needs before it issues a one-shot grant.

Reused building blocks:

- `decision/jev.ts`: provider, request filtering, response validation, secret
  handling, and `JEV_QUESTION_SET_VERSION` (`jev-questions/v2`);
- `decision/config.ts` (`loadJevConfig`): `{ "env": ... }` references and the
  ignored `decision/jev.local.json` literal-key rule (current user, mode `0600`);
- `decision/requirement.ts`: the requirement frame digest;
- `review/projection.ts`: the bounded projection;
- `review/calibration.ts`: calibration evidence validation.

Every pass condition is checked by trusted code, not by the model:

- the requirement exists with `source: "user_message"` and `actor: "user"`;
- the frame digest and the projection digest agree;
- egress is `allowed` on both the frame and the review policy;
- the target is inside the workspace and under a `declared_scope` prefix;
- `requirementMatch` is `match`;
- `riskScore <= policy.maxRisk` and `confidence >= policy.minConfidence`;
- model, question version (`jev-questions/v2`) and `policyDigest` match the
  bound policy;
- calibration is valid and bound to the same model, question version and
  `policyDigest`;
- the deadline has not passed.

`mismatch` rejects. `partial`, `unclear`, `requiresReview`, an over-threshold
risk, low confidence, a timeout, an abort, rate limiting, a refusal, an invalid
response, a network error, missing or mismatched calibration, and a projection
binding error all stop the action. None of them falls back to per-request human
approval.

One approval yields a single one-use grant and no standing allow rule. The grant
additionally binds `requirementVersion` and `requirementDigest`. Before the
effect the harness re-reads the requirement state; a changed version or digest
stops with `requirement_changed`. The audit authorization record is written
before the effect, and a failed audit write stops the action.

The audit authorization record gains a structured `review` block: `model`,
`questionVersion`, `policyDigest`, `requirementDigest`, `actionDigest`,
`snapshotDigest`, `risk`, `confidence`, `resultCode`, `calibrationVersion`,
`calibrationDigest`, `grantId`, `grantNonce`, plus `requirementVersion` and
`requirementDigest` on the record itself. It never contains the requirement
text, the model reply, or a secret.

### Requirement lifecycle

`decision/requirement-registry.ts` keeps the captured requirement in a
versioned, persisted registry at
`$XDG_STATE_HOME/amos-governance/requirement-registry/<projectId>.json` (directory `0700`, file
`0600`, atomic replace, `lstat` owner and mode check).

- Only a direct user-channel capture with `actor: "user"` and
  `capturedBy: "harness"` creates or revises a requirement. Agent and delegated
  frames never authorize anything.
- Each capture increments the version and recomputes the digest; a new version
  invalidates earlier review results and any unconsumed grant.
- Non-ready states stop managed execution: `requirement_conflict` (another
  instance revised it), `requirement_revoked`, `requirement_expired` (TTL),
  `requirement_corrupt` (damaged file or digest mismatch),
  `requirement_owner_mismatch` (uid or project id), `requirement_unavailable`
  (epoch change), and `requirement_missing`.
- The requirement text lives only in that protected state file. It is not
  written into the workspace, the JSONL journal, errors, or ordinary logs. A
  same-UID file or SQLite database is not a tamper-proof isolation boundary.

### Configuration migration

The managed reviewer configuration shape is
`{"reviewer":"jev","jevConfigPath":"<absolute path>","policy":{...},"calibration":{...},"ceilingDigest":"sha256:..."}`,
identical in `.pi/amos.json` `managed.review` and in the control-plane
projection `.pi/amos.managed.json` `managed.review`.

- The retired shape (`endpoint` / `model` / `apiKeyEnv`) is a stop signal, never
  an implicit fallback. The control plane rejects that publication with
  `reviewer_migration_required` (409). An adapter that reads a legacy projection
  or a legacy hand-written config sets the managed state to error and blocks
  tool calls with `amos_managed_reviewer_migration_required`.
- An unreadable or invalid Jev config file blocks with
  `amos_managed_reviewer_unavailable`.
- `managed.enabled` stays an explicit opt-in. Ordinary Pi/OpenCode remain Stage A
  log-only; a managed confirm without a configured recognizer stops with
  `review_unavailable`.
- A stored legacy control-plane configuration can still be read and published,
  but its projection carries `review: null`, so the host stops. A human migrates
  it in place with a single PATCH.

### Role separation

The Jev security reviewer (managed `confirm`, question set `jev-questions/v2`)
and the Jev engineering reviewer (`workflow/engineering-review.ts`, question set
`amos-engineering-review/v1`) use different question sets, policies, and audit
records. An engineering conclusion never serves as a security approval, and a
security conclusion never overrides a deterministic check.

## Configuration and data egress

Provider, model, threshold, and egress configuration can be edited per project in
**Settings → Jev 应用内设置**. The console saves through the human-only control-plane
API, writes literal keys atomically to the private state directory as
`jev/<projectId>/jev.local.json` (`0600`), and updates enabled workflow or existing
Jev managed-reviewer paths. The saved-connection test sends only a fixed synthetic
request. Environment references and the ignored local config file remain supported;
the `decision/` assessment integration cannot authorize tool execution.

Direct construction remains available:

```ts
import { createJevAssessmentProvider } from './decision/jev.ts';
import { combineWithAssessment } from './decision/combine.ts';

const provider = createJevAssessmentProvider({
  apiKey: process.env.TYPESAFE_API_KEY ?? '',
  model: 'jev-latest',
  timeoutMs: 8_000,
});

const result = await combineWithAssessment({
  deterministic,
  provider,
  action,
  context,
  requirement: frame,
  policy: { reviewRisk: 0.6, denyRisk: 0.9 },
  assessmentRequired: true,
});
```

For file configuration, TypeSafe direct and OpenRouter System One are supported. Both
use `state + questions`; OpenRouter is **not** the chat-completions endpoint.

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

Path resolution:

- OpenRouter: `baseUrl` + `/v1/systemone` (an API root ending in `/v1` appends only
  `/systemone`).
- TypeSafe direct: `baseUrl` default `https://api.typesafe.ai` plus `/v1/systemone`.
- `defaultModel` must be in the explicit model allowlist. There is no automatic fallback;
  changing models requires recalibrating thresholds.
- A shared/example file may only use `{ "env": "OPENROUTER_API_KEY" }` or
  `{ "env": "TYPESAFE_API_KEY" }`. A literal credential is accepted only from an explicit
  local file such as `decision/jev.local.json`; on POSIX it must be owned by the current
  user with mode `0600`.
- Remote plaintext HTTP, URL userinfo, queries, and fragments are rejected. A non-official
  HTTPS host requires `allowCredentialEgress: true` in the protected local configuration.
  This is deliberate credential egress, not a trust boundary.

`loadJevConfig()` and `parseJevConfig()` return an `assessmentProvider`, a generic
`systemOneClient` for typed engineering reviews, and a public config that never contains
the credential. `createJevManagedReviewer` loads the same file, so one protected
configuration serves the sensor, the engineering review, and the managed reviewer.

**Data egress warning:** `state` is `{ action, context, requirement }`. The
adapter applies the same safe action projection as the audit sink before
egress: URL userinfo, paths, query values, fragments, shell text, and hostile
tool identifiers are removed. `requirement` is sent only when its frame
carries `egress: "allowed"`; it contains the bounded requirement text,
declared scope, source, and frame digest. `context` is caller-supplied and is
not automatically redacted, so callers must remove secrets, tokens, personal
data, and anything that must not leave the process. Never place the API key in
`context`. The key is sent only in the `Authorization` header and is never
included in errors.

Pin a concrete model version when thresholds are calibrated. `jev-latest` can
move underneath the thresholds.

## Thresholds and review

Defaults live in `decision/jev.ts`:

| Threshold | Meaning |
| --- | --- |
| `sensitiveArea` | noul probability at/above which the action is sensitive |
| `irreversible` | noul probability at/above which the action is irreversible |
| `minConfidence` | weakest intent/requirementMatch confidence below which review is required |
| `nearThresholdMargin` | probability distance treated as ambiguous |

`requiresReview` is set when the weakest of the intent and requirementMatch
confidences is below `minConfidence`, or a noul probability is within
`nearThresholdMargin` of its threshold. Sensitive, irreversible, ambiguous, or
low-confidence facts map to `confirm`. Risk at or above `denyRisk` maps to
`deny` when that policy is configured.

## Audit requirements

Audit the model identifier and the probabilistic inputs alongside the final
verdict. Keep at minimum:

- returned `model` and the fixed question-set version
  (`JEV_QUESTION_SET_VERSION`, currently `jev-questions/v2`);
- `intent`, `requirementMatch`, `requirementFrameDigest`, `sensitiveArea`,
  `irreversible`, `riskScore`, `confidence`, `requiresReview`;
- the requirement frame's `source`, `actor`, and `root_frame_id`, but never its
  text or declared scope;
- whether assessment was required, and whether it failed (`assessment_failed`);
- the deterministic verdict before combination and the final verdict.

Do not log the API key, authorization headers, raw request/response bodies, or
unredacted context. `JevAssessmentError` intentionally exposes only a safe
`code` and HTTP `status`.

## Failure behavior

The adapter throws `JevAssessmentError` for configuration errors,
non-2xx responses, timeouts, aborts, invalid JSON, refusals, malformed answer
shapes, denied requirement egress, and out-of-range probabilities/confidence.
It validates strictly:

- choice answers must use a known intent or requirementMatch value and a
  confidence in `[0, 1]`;
- noul answers must be in `[0, 1]`;
- score answers are raw rubric values in `[0, levels - 1]` (3 levels for
  risk, so `[0, 2]`), normalized by the adapter to `[0, 1]`;
- probabilities, when present, must all be in `[0, 1]`.

Timeouts use `AbortController` and are always cleared. An external abort signal
is combined with the timeout.

## Non-goals

- Jev does not decide policy, grant access, or override deny/confirm rules. The
  managed reviewer approves at most one stopped `confirm` inside the preapproved
  policy ceiling; it cannot lift a deterministic `deny`, widen scope, or leave a
  standing allow rule behind.
- Jev does not discover the human requirement from model text. Only a
  harness-captured frame is accepted, and a `delegated` frame never relaxes a
  verdict.
- Jev is not a substitute for exact checks of paths, URLs, credentials, or
  authorization.
- The adapter does not add the TypeSafe SDK; it uses injectable `fetch`.
