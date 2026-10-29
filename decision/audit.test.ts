import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildJevAssessmentAudit,
  buildUserLiteralGrantAudit,
} from './audit.ts';
import type { CombinedAssessmentResult } from './combine.ts';
import { JEV_QUESTION_SET_VERSION } from './jev.ts';
import { createUserLiteralGrant, userTurnDigest } from './grant.ts';
import {
  createRequirementFrame,
  requirementFrameDigest,
  type RequirementFrame,
} from './requirement.ts';
import type { AssessmentFacts } from './types.ts';
import type { ShellAssessment } from '../workflow/shell-policy.ts';

const FRAME = createRequirementFrame({
  frame_id: 'rf_001',
  session_id: 'ses_001',
  source: 'user_message',
  user_turn_digest: `sha256:${'a'.repeat(64)}`,
  egress: 'allowed',
  text: 'SECRET_REQUIREMENT_TEXT',
  declared_scope: ['SECRET_SCOPE'],
  captured_at: '2026-10-29T00:00:00.000Z',
});

const FRAME_DIGEST = requirementFrameDigest(FRAME);

const FACTS: AssessmentFacts = {
  intent: 'feature',
  requirementMatch: 'match',
  requirementFrameDigest: FRAME_DIGEST,
  sensitiveArea: false,
  irreversible: false,
  riskScore: 0.2,
  confidence: 0.9,
  requiresReview: false,
  model: 'jev-latest',
};

function shell(verdict: ShellAssessment['verdict']): ShellAssessment {
  return {
    kind: verdict === 'deny' ? 'opaque' : 'plan',
    verdict,
    reason: verdict === 'deny' ? 'destructive_filesystem' : 'safe_workflow_command',
    operations: [],
  };
}

function result(
  overrides: Partial<CombinedAssessmentResult> = {},
): CombinedAssessmentResult {
  return {
    verdict: 'allow',
    facts: FACTS,
    requirementFrameDigest: FRAME_DIGEST,
    ...overrides,
  };
}

test('Jev audit metadata keeps digests and facts but never text or scope', () => {
  const audit = buildJevAssessmentAudit({
    requirement: FRAME,
    shellAssessment: shell('confirm'),
    result: result({ verdict: 'confirm' }),
    assessmentRequired: true,
  });

  assert.equal(audit.kind, 'jev_assessment');
  assert.equal(audit.deterministic_verdict, 'confirm');
  assert.equal(audit.final_verdict, 'confirm');
  assert.deepEqual(audit.requirement, {
    frame_digest: FRAME_DIGEST,
    source: 'user_message',
    actor: 'user',
    root_frame_id: 'rf_001',
  });
  assert.equal(audit.question_set_version, JEV_QUESTION_SET_VERSION);
  assert.equal(audit.model, 'jev-latest');
  assert.equal(audit.intent, 'feature');
  assert.equal(audit.requirementMatch, 'match');
  assert.equal(audit.sensitiveArea, false);
  assert.equal(audit.irreversible, false);
  assert.equal(audit.riskScore, 0.2);
  assert.equal(audit.confidence, 0.9);
  assert.equal(audit.requiresReview, false);
  assert.equal(audit.assessmentRequired, true);
  assert.equal(audit.error, undefined);

  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes('SECRET_REQUIREMENT_TEXT'), false);
  assert.equal(serialized.includes('SECRET_SCOPE'), false);
  assert.equal(Object.isFrozen(audit), true);
});

test('a missing requirement is representable without raw details', () => {
  const audit = buildJevAssessmentAudit({
    requirement: null,
    shellAssessment: shell('allow'),
    result: { verdict: 'deny', error: 'assessment_failed' },
    assessmentRequired: true,
  });

  assert.equal(audit.requirement, null);
  assert.equal(audit.assessmentRequired, true);
  assert.equal(audit.error, 'assessment_failed');
  assert.equal('model' in audit, false);
});

test('provider failure without a requirement records requirement_unavailable', () => {
  const audit = buildJevAssessmentAudit({
    requirement: undefined,
    shellAssessment: shell('allow'),
    result: { verdict: 'allow' },
    assessmentRequired: false,
  });

  assert.equal(audit.requirement, null);
  assert.equal(audit.assessmentRequired, false);
  assert.equal(audit.error, 'requirement_unavailable');
});

test('facts bound to a different frame fail closed in the audit projection', () => {
  const audit = buildJevAssessmentAudit({
    requirement: FRAME,
    shellAssessment: shell('allow'),
    result: result({
      facts: { ...FACTS, requirementFrameDigest: `sha256:${'b'.repeat(64)}` },
      requirementFrameDigest: `sha256:${'b'.repeat(64)}`,
    }),
    assessmentRequired: true,
  });

  assert.equal(audit.error, 'assessment_failed');
  assert.equal('model' in audit, false);
  assert.ok(audit.requirement);
  assert.equal(audit.requirement.frame_digest, FRAME_DIGEST);
});

test('malformed optional facts are omitted conservatively', () => {
  const malformed = {
    ...FACTS,
    intent: 'bogus',
    requirementMatch: 'approved',
    model: 'x'.repeat(200),
    riskScore: 2,
    confidence: Number.NaN,
    sensitiveArea: 'yes',
    irreversible: 1,
    requiresReview: 'no',
    requirementFrameDigest: FRAME_DIGEST,
  } as unknown as AssessmentFacts;

  const audit = buildJevAssessmentAudit({
    requirement: FRAME,
    shellAssessment: shell('allow'),
    result: result({ facts: malformed }),
    assessmentRequired: true,
  });

  for (const key of [
    'intent',
    'requirementMatch',
    'model',
    'riskScore',
    'confidence',
    'sensitiveArea',
    'irreversible',
    'requiresReview',
  ]) {
    assert.equal(key in audit, false, `${key} should be omitted`);
  }
  assert.equal(audit.question_set_version, JEV_QUESTION_SET_VERSION);
});

test('log verdicts in the combined result are recorded as non-blocking allow', () => {
  const audit = buildJevAssessmentAudit({
    requirement: FRAME,
    shellAssessment: shell('allow'),
    result: result({ verdict: 'log' }),
    assessmentRequired: false,
  });
  assert.equal(audit.deterministic_verdict, 'allow');
  assert.equal(audit.final_verdict, 'allow');
});

test('user literal grant audit contains digests but never command text', () => {
  const frame = createRequirementFrame({
    frame_id: 'rf_002',
    session_id: 'ses_001',
    source: 'user_message',
    user_turn_digest: userTurnDigest('SECRET_LITERAL_COMMAND'),
    egress: 'denied',
    text: 'SECRET_LITERAL_COMMAND',
    captured_at: '2026-10-29T00:00:00.000Z',
  });
  const grant = createUserLiteralGrant(frame, 'SECRET_LITERAL_COMMAND');

  const audit = buildUserLiteralGrantAudit({
    grant,
    shellAssessment: shell('confirm'),
    requirement: frame,
  });

  assert.equal(audit.kind, 'user_literal_grant');
  assert.equal(audit.deterministic_verdict, 'confirm');
  assert.equal(audit.final_verdict, 'allow');
  assert.equal(audit.assessmentRequired, null);
  assert.deepEqual(audit.requirement, {
    frame_digest: requirementFrameDigest(frame),
    source: 'user_message',
    actor: 'user',
    root_frame_id: 'rf_002',
  });
  assert.equal(JSON.stringify(audit).includes('SECRET_LITERAL_COMMAND'), false);
});

test('user literal grant audit keeps only the digest when the frame is absent', () => {
  const frame = createRequirementFrame({
    frame_id: 'rf_003',
    session_id: 'ses_001',
    source: 'user_message',
    user_turn_digest: userTurnDigest('npm test'),
    egress: 'denied',
    text: 'npm test',
    captured_at: '2026-10-29T00:00:00.000Z',
  });
  const grant = createUserLiteralGrant(frame, 'npm test');

  const audit = buildUserLiteralGrantAudit({
    grant,
    shellAssessment: shell('confirm'),
  });

  assert.deepEqual(audit.requirement, {
    frame_digest: requirementFrameDigest(frame),
    source: 'user_message',
    actor: 'user',
    root_frame_id: null,
  });
  assert.equal(audit.final_verdict, 'allow');
});

test('a frame that does not match the grant digest is not trusted', () => {
  const frame = createRequirementFrame({
    frame_id: 'rf_004',
    session_id: 'ses_001',
    source: 'user_message',
    user_turn_digest: userTurnDigest('npm test'),
    egress: 'denied',
    text: 'npm test',
    captured_at: '2026-10-29T00:00:00.000Z',
  });
  const other = createRequirementFrame({
    frame_id: 'rf_005',
    session_id: 'ses_001',
    source: 'user_message',
    user_turn_digest: userTurnDigest('npm run build'),
    egress: 'denied',
    text: 'npm run build',
    captured_at: '2026-10-29T00:00:00.000Z',
  });
  const grant = createUserLiteralGrant(frame, 'npm test');

  const audit = buildUserLiteralGrantAudit({
    grant,
    shellAssessment: shell('confirm'),
    requirement: other,
  });

  assert.equal(audit.requirement, null);
  assert.equal(audit.error, 'requirement_unavailable');
  assert.equal(audit.final_verdict, 'allow');
});
