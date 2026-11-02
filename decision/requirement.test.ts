import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_DECLARED_SCOPE_CHARACTERS,
  MAX_DECLARED_SCOPE_ITEMS,
  MAX_REQUIREMENT_TEXT_CHARACTERS,
  createRequirementFrame,
  isRequirementFrame,
  requirementAuditProjection,
  requirementEgressProjection,
  requirementFrameDigest,
  type RequirementFrameInput,
} from './requirement.ts';

const BASE: RequirementFrameInput = {
  frame_id: 'rf_001',
  session_id: 'ses_001',
  source: 'user_message',
  user_turn_digest: `sha256:${'a'.repeat(64)}`,
  egress: 'denied',
  text: 'Fix the failing engine test.',
  captured_at: '2026-10-29T00:00:00.000Z',
};

test('a user_message frame is its own root and carries no delegator', () => {
  const frame = createRequirementFrame(BASE);

  assert.equal(frame.source, 'user_message');
  assert.equal(frame.actor, 'user');
  assert.equal(frame.delegator, null);
  assert.equal(frame.root_frame_id, 'rf_001');
  assert.equal(frame.captured_by, 'harness');
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(Object.isFrozen(frame.declared_scope), true);
});

test('a user_message frame cannot claim another root or a delegator', () => {
  assert.throws(() =>
    createRequirementFrame({ ...BASE, root_frame_id: 'rf_other' }),
  );
  assert.throws(() =>
    createRequirementFrame({ ...BASE, delegator: 'agent_1' }),
  );
});

test('a delegated frame must name the agent and a different root', () => {
  const frame = createRequirementFrame({
    ...BASE,
    frame_id: 'rf_002',
    source: 'delegated',
    root_frame_id: 'rf_001',
    delegator: 'agent_7',
    text: 'Run the engine tests.',
  });

  assert.equal(frame.source, 'delegated');
  assert.equal(frame.actor, 'agent');
  assert.equal(frame.delegator, 'agent_7');
  assert.equal(frame.root_frame_id, 'rf_001');

  assert.throws(() =>
    createRequirementFrame({
      ...BASE,
      source: 'delegated',
      root_frame_id: 'rf_001',
    }),
  );
  assert.throws(() =>
    createRequirementFrame({
      ...BASE,
      frame_id: 'rf_002',
      source: 'delegated',
      root_frame_id: 'rf_001',
      delegator: '',
    }),
  );
  assert.throws(() =>
    createRequirementFrame({
      ...BASE,
      frame_id: 'rf_002',
      source: 'delegated',
      delegator: 'agent_7',
    }),
  );
});

test('egress consent is explicit and part of the digest', () => {
  assert.throws(() =>
    createRequirementFrame({ ...BASE, egress: undefined as never }),
  );

  const allowed = createRequirementFrame({ ...BASE, egress: 'allowed' });
  const denied = createRequirementFrame(BASE);

  assert.notEqual(
    requirementFrameDigest(allowed),
    requirementFrameDigest(denied),
  );
});

test('the frame digest is stable and changes with the requirement text', () => {
  const first = createRequirementFrame(BASE);
  const same = createRequirementFrame({ ...BASE });
  const changed = createRequirementFrame({
    ...BASE,
    text: 'Refactor the engine loader.',
  });

  assert.equal(requirementFrameDigest(first), requirementFrameDigest(same));
  assert.notEqual(requirementFrameDigest(first), requirementFrameDigest(changed));
  assert.match(requirementFrameDigest(first), /^sha256:[a-f0-9]{64}$/);
});

test('audit projection never includes requirement text or scope', () => {
  const frame = createRequirementFrame({
    ...BASE,
    text: 'SECRET_REQUIREMENT_TEXT',
    declared_scope: ['engine', 'tests'],
  });

  const projection = requirementAuditProjection(frame);
  const serialized = JSON.stringify(projection);

  assert.equal(serialized.includes('SECRET_REQUIREMENT_TEXT'), false);
  assert.equal(serialized.includes('engine'), false);
  assert.equal(projection.root_frame_id, 'rf_001');
  assert.equal(projection.source, 'user_message');
  assert.equal(projection.frame_digest, requirementFrameDigest(frame));
});

test('the egress projection carries the text and its binding digest', () => {
  const frame = createRequirementFrame({
    ...BASE,
    egress: 'allowed',
    declared_scope: ['tests'],
  });

  const projection = requirementEgressProjection(frame);

  assert.equal(projection.text, BASE.text);
  assert.deepEqual(projection.declared_scope, ['tests']);
  assert.equal(projection.frame_digest, requirementFrameDigest(frame));
});

test('rejects malformed frames', () => {
  const cases: unknown[] = [
    { ...BASE, frame_id: '' },
    { ...BASE, frame_id: 'has space' },
    { ...BASE, session_id: 'x'.repeat(200) },
    { ...BASE, user_turn_digest: 'not-a-digest' },
    { ...BASE, text: '' },
    { ...BASE, text: '   ' },
    { ...BASE, text: 'x'.repeat(MAX_REQUIREMENT_TEXT_CHARACTERS + 1) },
    { ...BASE, text: 'nul\0byte' },
    { ...BASE, captured_at: 'yesterday' },
    { ...BASE, source: 'tool_result' },
    { ...BASE, declared_scope: ['ok', 7] },
  ];

  for (const value of cases) {
    assert.throws(() => createRequirementFrame(value as RequirementFrameInput));
    assert.equal(isRequirementFrame(value), false);
  }
});

test('isRequirementFrame accepts a valid frame and rejects actor mismatches', () => {
  const frame = createRequirementFrame(BASE);
  assert.equal(isRequirementFrame(frame), true);

  assert.equal(
    isRequirementFrame({ ...frame, actor: 'agent' }),
    false,
  );
  assert.equal(
    isRequirementFrame({ ...frame, delegator: 'agent_1' }),
    false,
  );
  assert.equal(
    isRequirementFrame({ ...frame, root_frame_id: 'rf_other' }),
    false,
  );
  assert.equal(
    isRequirementFrame({ ...frame, captured_by: 'model' }),
    false,
  );
});

test('isRequirementFrame enforces creation-time text and scope bounds', () => {
  const frame = createRequirementFrame(BASE);
  assert.equal(isRequirementFrame(frame), true);

  const malformed: unknown[] = [
    // Oversized requirement text.
    { ...frame, text: 'x'.repeat(MAX_REQUIREMENT_TEXT_CHARACTERS + 1) },
    // NUL in requirement text.
    { ...frame, text: 'nul\0byte' },
    // Too many scope items.
    {
      ...frame,
      declared_scope: Array.from(
        { length: MAX_DECLARED_SCOPE_ITEMS + 1 },
        (_, index) => `scope-${index}`,
      ),
    },
    // Oversized scope item.
    {
      ...frame,
      declared_scope: ['x'.repeat(MAX_DECLARED_SCOPE_CHARACTERS + 1)],
    },
    // Scope item empty after trimming.
    { ...frame, declared_scope: ['   '] },
    // NUL in a scope item.
    { ...frame, declared_scope: ['engine\0tests'] },
    // Not a real timestamp.
    { ...frame, captured_at: 'not-a-real-timestamp' },
    { ...frame, captured_at: '2026-13-45T99:99:99.000Z' },
  ];

  for (const value of malformed) {
    assert.equal(isRequirementFrame(value), false);
  }
});

test('declared scope is bounded, trimmed, and deduplicated', () => {
  const frame = createRequirementFrame({
    ...BASE,
    declared_scope: ['  engine  ', 'engine', 'tests'],
  });

  assert.deepEqual(frame.declared_scope, ['engine', 'tests']);
});
