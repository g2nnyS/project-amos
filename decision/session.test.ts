import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createRequirementSessionStore,
  DEFAULT_MAX_REQUIREMENT_SESSIONS,
} from './session.ts';
import { requirementFrameDigest } from './requirement.ts';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function store(maxSessions?: number) {
  return createRequirementSessionStore({
    ...(maxSessions === undefined ? {} : { maxSessions }),
    now: () => NOW,
  });
}

test('captures only the explicit caller text and hashes the trimmed turn', () => {
  const sessions = store();
  const frame = sessions.captureUserMessage(
    'ses_001',
    '  Fix the failing engine test.  ',
    'allowed',
  );

  assert.equal(frame.source, 'user_message');
  assert.equal(frame.actor, 'user');
  assert.equal(frame.captured_by, 'harness');
  assert.equal(frame.session_id, 'ses_001');
  assert.equal(frame.text, 'Fix the failing engine test.');
  assert.equal(frame.user_turn_digest, digest('Fix the failing engine test.'));
  assert.equal(frame.egress, 'allowed');
  assert.equal(frame.captured_at, new Date(NOW).toISOString());
  assert.equal(frame.root_frame_id, frame.frame_id);
  assert.equal(Object.isFrozen(frame), true);

  // The digest is of the trimmed text, not the raw caller padding.
  assert.notEqual(frame.user_turn_digest, digest('  Fix the failing engine test.  '));
});

test('egress defaults to denied', () => {
  const sessions = store();
  const frame = sessions.captureUserMessage('ses_001', 'Run the tests.');
  assert.equal(frame.egress, 'denied');
});

test('each new user turn replaces the current frame for that session', () => {
  const sessions = store();
  const first = sessions.captureUserMessage('ses_001', 'First requirement.');
  const second = sessions.captureUserMessage('ses_001', 'Second requirement.');

  assert.notEqual(first.frame_id, second.frame_id);
  assert.notEqual(
    requirementFrameDigest(first),
    requirementFrameDigest(second),
  );
  assert.equal(sessions.current('ses_001')?.frame_id, second.frame_id);
  assert.equal(sessions.size, 1);
});

test('sessions are isolated and never expose another session text', () => {
  const sessions = store();
  const alpha = sessions.captureUserMessage('ses_alpha', 'ALPHA_SECRET_TEXT');
  const beta = sessions.captureUserMessage('ses_beta', 'BETA_SECRET_TEXT');

  assert.notEqual(alpha.session_id, beta.session_id);
  assert.equal(sessions.current('ses_alpha')?.text, 'ALPHA_SECRET_TEXT');
  assert.equal(sessions.current('ses_beta')?.text, 'BETA_SECRET_TEXT');
  assert.equal(sessions.current('ses_missing'), null);
  assert.equal(sessions.size, 2);
});

test('clear removes only the named session', () => {
  const sessions = store();
  sessions.captureUserMessage('ses_alpha', 'Alpha.');
  sessions.captureUserMessage('ses_beta', 'Beta.');

  sessions.clear('ses_alpha');

  assert.equal(sessions.current('ses_alpha'), null);
  assert.equal(sessions.current('ses_beta')?.text, 'Beta.');
  assert.equal(sessions.size, 1);
});

test('the default LRU bound is 64 sessions', () => {
  assert.equal(DEFAULT_MAX_REQUIREMENT_SESSIONS, 64);
  const sessions = store();

  for (let index = 0; index < 65; index += 1) {
    sessions.captureUserMessage(`ses_${index}`, `Requirement ${index}.`);
  }

  assert.equal(sessions.size, 64);
  assert.equal(sessions.current('ses_0'), null);
  assert.equal(sessions.current('ses_1')?.text, 'Requirement 1.');
});

test('reads refresh LRU order and a custom bound is honored', () => {
  const sessions = store(2);
  sessions.captureUserMessage('ses_a', 'A.');
  sessions.captureUserMessage('ses_b', 'B.');

  // Touch A so B becomes the oldest entry.
  assert.equal(sessions.current('ses_a')?.text, 'A.');
  sessions.captureUserMessage('ses_c', 'C.');

  assert.equal(sessions.current('ses_a')?.text, 'A.');
  assert.equal(sessions.current('ses_b'), null);
  assert.equal(sessions.current('ses_c')?.text, 'C.');
});

test('invalid input throws instead of capturing a partial frame', () => {
  const sessions = store();
  assert.throws(() => sessions.captureUserMessage('bad session', 'x'));
  assert.throws(() => sessions.captureUserMessage('ses_001', '   '));
  assert.throws(() =>
    sessions.captureUserMessage('ses_001', 'nul\0byte'),
  );
  assert.throws(() =>
    sessions.captureUserMessage('ses_001', 'x', 'maybe' as never),
  );
  assert.throws(() => createRequirementSessionStore({ maxSessions: 0 }));
});

test('literal capture returns a denied frame and a bound grant without text', () => {
  const sessions = store();
  const { frame, grant } = sessions.captureUserLiteral(
    'ses_001',
    'npm test',
  );

  assert.equal(frame.text, 'npm test');
  assert.equal(frame.egress, 'denied');
  assert.equal(frame.user_turn_digest, digest('npm test'));
  assert.equal(grant.kind, 'user_literal');
  assert.equal(grant.session_id, 'ses_001');
  assert.equal(grant.command_digest, digest('npm test'));
  assert.equal(grant.requirement_frame_digest, requirementFrameDigest(frame));
  assert.equal(JSON.stringify(grant).includes('npm test'), false);
  assert.equal(sessions.current('ses_001')?.frame_id, frame.frame_id);
});
