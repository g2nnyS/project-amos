# Jev integration: semantic sensor, not policy authority

The `decision/` module integrates TypeSafe Jev (`POST /v1/systemone`) as an
**optional probabilistic semantic sensor**. It never replaces the deterministic
rule engine and it cannot grant permissions.

## Boundary

```
deterministic engine ──> verdict ──┐
                                   ├─> maxVerdict() ──> final verdict
Jev facts ──> trusted mapping ─────┘
```

- `engine/` remains the authority. Its `Verdict` is the baseline.
- Jev returns bounded facts (`intent`, `sensitiveArea`, `irreversible`,
  `riskScore`, `confidence`), not a verdict.
- Trusted code maps those facts through explicit thresholds and policy.
- `combineDeterministicWithAssessment` is a strict maximum: the model may
  tighten `allow -> log/confirm/deny`, but can never relax `deny` or `confirm`.
- When an assessment is required and the provider fails, the async helper
  fails closed to `deny`. Optional assessments preserve the deterministic
  result.

## Configuration and data egress

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
  policy: { reviewRisk: 0.6, denyRisk: 0.9 },
  assessmentRequired: true,
});
```

**Data egress warning:** `state` is `{ action, context }`. The adapter applies the
same safe action projection as the audit sink before egress: URL userinfo, paths,
query values, fragments, shell text, and hostile tool identifiers are removed.
`context` is caller-supplied and is not automatically redacted, so callers must
remove secrets, tokens, personal data, and anything that must not leave the
process. Never place the API key in `context`. The key is sent only in the
`Authorization` header and is never included in errors.

Pin a concrete model version when thresholds are calibrated. `jev-latest` can
move underneath the thresholds.

## Thresholds and review

Defaults live in `decision/jev.ts`:

| Threshold | Meaning |
| --- | --- |
| `sensitiveArea` | noul probability at/above which the action is sensitive |
| `irreversible` | noul probability at/above which the action is irreversible |
| `minConfidence` | intent confidence below which review is required |
| `nearThresholdMargin` | probability distance treated as ambiguous |

`requiresReview` is set when intent confidence is below `minConfidence` or a
noul probability is within `nearThresholdMargin` of its threshold. Sensitive,
irreversible, ambiguous, or low-confidence facts map to `confirm`. Risk at or
above `denyRisk` maps to `deny` when that policy is configured.

## Audit requirements

Audit the model identifier and the probabilistic inputs alongside the final
verdict. Keep at minimum:

- returned `model` and the fixed question-set version
  (`JEV_QUESTION_SET_VERSION`);
- `intent`, `sensitiveArea`, `irreversible`, `riskScore`, `confidence`,
  `requiresReview`;
- whether assessment was required, and whether it failed (`assessment_failed`);
- the deterministic verdict before combination and the final verdict.

Do not log the API key, authorization headers, raw request/response bodies, or
unredacted context. `JevAssessmentError` intentionally exposes only a safe
`code` and HTTP `status`.

## Failure behavior

The adapter throws `JevAssessmentError` for configuration errors, non-2xx
responses, timeouts, aborts, invalid JSON, refusals, malformed answer shapes,
and out-of-range probabilities/confidence. It validates strictly:

- choice answers must use a known intent and a confidence in `[0, 1]`;
- noul answers must be in `[0, 1]`;
- score answers are raw rubric values in `[0, levels - 1]` (3 levels for
  risk, so `[0, 2]`), normalized by the adapter to `[0, 1]`;
- probabilities, when present, must all be in `[0, 1]`.

Timeouts use `AbortController` and are always cleared. An external abort signal
is combined with the timeout.

## Non-goals

- Jev does not decide policy, grant access, or override deny/confirm rules.
- Jev is not a substitute for exact checks of paths, URLs, credentials, or
  authorization.
- The adapter does not add the TypeSafe SDK; it uses injectable `fetch`.
