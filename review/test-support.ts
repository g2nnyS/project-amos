/**
 * Shared builders for reviewer lane tests. Test-only; not re-exported.
 */

import { createRequirementFrame } from '../decision/requirement.ts';
import type {
  CalibrationEvidence,
  ReviewerPolicy,
} from './calibration.ts';
import type { OneShotRequest } from './authority.ts';
import type { ReviewProjectionInput } from './projection.ts';
import type { ReviewProviderFacts } from './provider.ts';

export const NOW = 1_000_000;
export const DEADLINE = 5_000_000;
export const POLICY_DIGEST = `sha256:${'d'.repeat(64)}`;
export const REQUEST_DIGEST = `sha256:${'b'.repeat(64)}`;
export const SNAPSHOT_DIGEST = `sha256:${'c'.repeat(64)}`;
export const ACTION_DIGEST = `sha256:${'a'.repeat(64)}`;
export const CEILING_DIGEST = `sha256:${'e'.repeat(64)}`;
export const CASE_SET_DIGEST = `sha256:${'f'.repeat(64)}`;
export const MODEL = 'reviewer-test';
export const QUESTION_VERSION = 'review-questions/v1';

export function makeFrame(
  overrides: Partial<Parameters<typeof createRequirementFrame>[0]> = {},
) {
  return createRequirementFrame({
    frame_id: 'rf_test',
    session_id: 'ses_test',
    source: 'user_message',
    user_turn_digest: `sha256:${'1'.repeat(64)}`,
    egress: 'denied',
    text: 'Please update /ws/src/a.ts using the deployment token',
    captured_at: '2026-10-29T00:00:00.000Z',
    ...overrides,
  });
}

export function makeProjectionInput(
  overrides: Partial<ReviewProjectionInput> = {},
): ReviewProjectionInput {
  return {
    attemptId: 'attempt_1',
    action: {
      tool: 'edit',
      operation: 'write',
      target: '/ws/src/a.ts',
    },
    workspace: '/ws',
    requestDigest: REQUEST_DIGEST,
    matchedRuleIds: ['rule_a', 'rule_b'],
    projectId: 'project_1',
    sessionId: 'ses_1',
    epoch: 3,
    snapshotDigest: SNAPSHOT_DIGEST,
    capabilityId: 'cap_1',
    requestedBytes: 42,
    deadline: DEADLINE,
    requirement: makeFrame(),
    requirementEgress: 'denied',
    targetEgress: 'workspace-relative',
    questionVersion: QUESTION_VERSION,
    policyDigest: POLICY_DIGEST,
    ...overrides,
  };
}

export function makePolicy(
  overrides: Partial<ReviewerPolicy> = {},
): ReviewerPolicy {
  return {
    id: 'policy_1',
    model: MODEL,
    questionVersion: QUESTION_VERSION,
    minConfidence: 0.7,
    maxRisk: 0.5,
    timeoutMs: 50,
    maxAttempts: 1,
    requirementEgress: 'denied',
    targetEgress: 'workspace-relative',
    minimumCases: 2,
    maximumFalseAllowRate: 0,
    expiresAt: NOW + 10_000,
    policyDigest: POLICY_DIGEST,
    ...overrides,
  };
}

export function makeEvidence(
  overrides: Partial<CalibrationEvidence> = {},
): CalibrationEvidence {
  return {
    format: 'amos-review-calibration',
    version: 1,
    model: MODEL,
    questionVersion: QUESTION_VERSION,
    policyDigest: POLICY_DIGEST,
    caseSetDigest: CASE_SET_DIGEST,
    cases: 10,
    unsafeCases: 4,
    falseAllows: 0,
    evaluatedAt: 1_000,
    expiresAt: NOW + 10_000,
    ...overrides,
  };
}

export function makeRequest(
  overrides: Partial<OneShotRequest> = {},
): OneShotRequest {
  return {
    requestId: 'req_1',
    nonce: 'nonce_1',
    actionDigest: ACTION_DIGEST,
    sessionId: 'ses_1',
    projectId: 'project_1',
    epoch: 3,
    snapshotDigest: SNAPSHOT_DIGEST,
    capabilityId: 'cap_1',
    expiresAt: NOW + 2_000,
    ceilingDigest: CEILING_DIGEST,
    ...overrides,
  };
}

export function makeFacts(
  overrides: Partial<ReviewProviderFacts> = {},
): ReviewProviderFacts {
  return {
    requirementMatch: 'match',
    withinScope: true,
    risk: 0.1,
    confidence: 0.9,
    ...overrides,
  };
}
