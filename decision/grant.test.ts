import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  applyUserLiteralGrant,
  createUserLiteralGrant,
  isUserLiteralGrant,
  normalizeUserTurnText,
  userTurnDigest,
  type UserLiteralGrant,
} from './grant.ts';
import {
  createRequirementFrame,
  requirementFrameDigest,
  type RequirementFrame,
} from './requirement.ts';
import type { ShellAssessment } from '../workflow/shell-policy.ts';

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function frameFor(text = 'npm test'): RequirementFrame {
  return createRequirementFrame({
    frame_id: 'rf_001',
    session_id: 'ses_001',
    source: 'user_message',
    user_turn_digest: digest(text),
    egress: 'denied',
    text,
    captured_at: '2026-10-29T00:00:00.000Z',
  });
}

function assessment(verdict: ShellAssessment['verdict']): ShellAssessment {
  return {
    kind: verdict === 'deny' ? 'opaque' : 'plan',
    verdict,
    reason: verdict === 'deny' ? 'destructive_filesystem' : 'safe_workflow_command',
    operations: [],
  };
}

test('normalizes a user turn and digests the exact trimmed text', () => {
  assert.deepEqual(normalizeUserTurnText('  npm test  '), {
    text: 'npm test',
    digest: digest('npm test'),
  });
  assert.equal(userTurnDigest('npm test'), digest('npm test'));
  assert.throws(() => normalizeUserTurnText('   '));
  assert.throws(() => normalizeUserTurnText('nul\0'));
});

test('a grant requires a harness user_message frame', () => {
  const frame = frameFor('npm test');
  const grant = createUserLiteralGrant(frame, 'npm test');
  assert.deepEqual(grant, {
    kind: 'user_literal',
    session_id: 'ses_001',
    requirement_frame_digest: requirementFrameDigest(frame),
    command_digest: digest('npm test'),
  });
  assert.equal(Object.isFrozen(grant), true);

  const delegated = createRequirementFrame({
    frame_id: 'rf_002',
    session_id: 'ses_001',
    root_frame_id: 'rf_001',
    source: 'delegated',
    delegator: 'agent_1',
    user_turn_digest: digest('npm test'),
    egress: 'denied',
    text: 'npm test',
    captured_at: '2026-10-29T00:00:00.000Z',
  });
  assert.throws(() => createUserLiteralGrant(delegated, 'npm test'));
  assert.throws(() =>
    createUserLiteralGrant({ ...frame, captured_by: 'model' } as never, 'npm test'),
  );
});

test('the command must be exactly the captured user turn', () => {
  const frame = frameFor('npm test');
  assert.throws(() => createUserLiteralGrant(frame, 'rm -rf /'));
  assert.throws(() => createUserLiteralGrant(frame, 'npm test -- --watch'));
  // Surrounding whitespace is ordinary formatting and is normalized away.
  assert.doesNotThrow(() => createUserLiteralGrant(frame, '  npm test  '));
});

test('a grant never carries command text', () => {
  const frame = frameFor('TOPSECRET_COMMAND --flag');
  const grant = createUserLiteralGrant(frame, 'TOPSECRET_COMMAND --flag');
  assert.equal(JSON.stringify(grant).includes('TOPSECRET'), false);
  assert.equal(isUserLiteralGrant(grant), true);
});

test('a grant upgrades confirm and allow to allow', () => {
  const frame = frameFor();
  const grant = createUserLiteralGrant(frame, 'npm test');

  assert.equal(applyUserLiteralGrant(grant, assessment('confirm'), 'ses_001'), 'allow');
  assert.equal(applyUserLiteralGrant(grant, assessment('allow'), 'ses_001'), 'allow');
});

test('every deterministic deny is preserved, including structural hard stops', () => {
  const frame = frameFor();
  const grant = createUserLiteralGrant(frame, 'npm test');

  for (const kind of ['plan', 'opaque', 'unsupported'] as const) {
    const deny: ShellAssessment = {
      kind,
      verdict: 'deny',
      reason: 'destructive_filesystem',
      operations: [],
    };
    assert.equal(applyUserLiteralGrant(grant, deny, 'ses_001'), 'deny');
  }
});

test('wrong session or malformed grant is rejected without granting', () => {
  const frame = frameFor();
  const grant = createUserLiteralGrant(frame, 'npm test');

  assert.equal(
    applyUserLiteralGrant(grant, assessment('confirm'), 'ses_other'),
    'confirm',
  );

  const badDigest = { ...grant, command_digest: 'not-a-digest' } as UserLiteralGrant;
  assert.equal(
    applyUserLiteralGrant(badDigest, assessment('confirm'), 'ses_001'),
    'confirm',
  );

  const wrongKind = { ...grant, kind: 'model_grant' } as unknown as UserLiteralGrant;
  assert.equal(
    applyUserLiteralGrant(wrongKind, assessment('confirm'), 'ses_001'),
    'confirm',
  );

  // A forged grant can never turn a deny into anything else.
  assert.equal(
    applyUserLiteralGrant(badDigest, assessment('deny'), 'ses_001'),
    'deny',
  );
});

test('a malformed assessment fails closed to deny', () => {
  const grant = createUserLiteralGrant(frameFor(), 'npm test');
  assert.equal(
    applyUserLiteralGrant(grant, { verdict: 'maybe' } as never, 'ses_001'),
    'deny',
  );
});
