import assert from 'node:assert/strict';
import test from 'node:test';

import { ReviewError } from './errors.ts';
import {
  MAX_REVIEW_REQUEST_BYTES,
  OUTSIDE_WORKSPACE,
  buildReviewProjection,
} from './projection.ts';
import {
  makeFrame,
  makeProjectionInput,
} from './test-support.ts';

function isErrorCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof ReviewError && error.code === code;
}

test('projection emits a workspace-relative path and excludes sensitive payloads', () => {
  const projection = buildReviewProjection(makeProjectionInput());
  const serialized = JSON.stringify(projection);

  assert.equal(projection.target, 'src/a.ts');
  assert.ok(!serialized.includes('/ws'));
  assert.ok(!serialized.includes('/ws/src/a.ts'));
  assert.ok(!serialized.includes('deployment token'));
  assert.ok(!serialized.includes('Authorization'));
  assert.ok(!serialized.includes('Bearer'));
  assert.equal(projection.requirementText, undefined);
  assert.match(projection.requirementDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_REVIEW_REQUEST_BYTES);
});

test('projection rejects unknown content, command, and secret fields without echoing them', () => {
  for (const extra of [
    { content: 'file body' },
    { oldText: 'before', newText: 'after' },
    { query: 'search secret' },
    { command: 'rm -rf /' },
    { environment: { TOKEN: 'secret-value' } },
  ]) {
    const input = { ...makeProjectionInput(), ...extra };
    assert.throws(
      () => buildReviewProjection(input),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, 'invalid_input');
        assert.ok(!error.message.includes('secret-value'));
        assert.ok(!error.message.includes('rm -rf'));
        assert.ok(!error.message.includes('file body'));
        return true;
      },
    );
  }
});

test('projection rejects missing fields, bad digests, and non-absolute workspaces', () => {
  const { attemptId: _omitted, ...missing } = makeProjectionInput();
  assert.throws(() => buildReviewProjection(missing), isErrorCode('invalid_input'));

  assert.throws(
    () => buildReviewProjection(makeProjectionInput({ requestDigest: 'sha256:xyz' })),
    isErrorCode('invalid_input'),
  );
  assert.throws(
    () => buildReviewProjection(makeProjectionInput({ workspace: 'relative/ws' })),
    isErrorCode('invalid_input'),
  );
  assert.throws(
    () => buildReviewProjection(makeProjectionInput({ epoch: Number.NaN })),
    isErrorCode('invalid_input'),
  );
  assert.throws(
    () =>
      buildReviewProjection(
        makeProjectionInput({
          action: { tool: '/etc/passwd', operation: 'read', target: 'a.ts' },
        }),
      ),
    isErrorCode('invalid_input'),
  );
  assert.throws(
    () =>
      buildReviewProjection(
        makeProjectionInput({
          action: { tool: 'read', operation: 'cat /etc/passwd', target: 'a.ts' },
        }),
      ),
    isErrorCode('invalid_input'),
  );
  assert.throws(
    () =>
      buildReviewProjection(
        makeProjectionInput({ questionVersion: '/etc/passwd' }),
      ),
    isErrorCode('invalid_input'),
  );
  assert.throws(
    () =>
      buildReviewProjection(
        makeProjectionInput({
          action: { tool: 'edit', operation: 'write', target: 'a.ts', content: 'x' },
        } as unknown as Parameters<typeof makeProjectionInput>[0]),
      ),
    isErrorCode('invalid_input'),
  );
});

test('outside targets become a fixed placeholder and never an absolute path', () => {
  const absolute = buildReviewProjection(
    makeProjectionInput({
      action: { tool: 'read', operation: 'read', target: '/etc/passwd' },
    }),
  );
  assert.equal(absolute.target, OUTSIDE_WORKSPACE);
  assert.ok(!JSON.stringify(absolute).includes('/etc/passwd'));

  const escaping = buildReviewProjection(
    makeProjectionInput({
      action: { tool: 'read', operation: 'read', target: '../secrets.txt' },
    }),
  );
  assert.equal(escaping.target, OUTSIDE_WORKSPACE);
  assert.ok(!JSON.stringify(escaping).includes('../secrets.txt'));

  const windows = buildReviewProjection(
    makeProjectionInput({
      action: { tool: 'read', operation: 'read', target: 'C:\\Users\\secret.txt' },
    }),
  );
  assert.equal(windows.target, OUTSIDE_WORKSPACE);
  assert.ok(!JSON.stringify(windows).includes('C:\\Users'));
});

test('target egress denied nulls the target regardless of its value', () => {
  const projection = buildReviewProjection(
    makeProjectionInput({ targetEgress: 'denied' }),
  );
  assert.equal(projection.target, null);
  assert.ok(!JSON.stringify(projection).includes('src/a.ts'));
});

test('requirement text requires source, frame egress, and policy egress to all allow', () => {
  const deniedByPolicy = buildReviewProjection(
    makeProjectionInput({
      requirement: makeFrame({ egress: 'allowed' }),
      requirementEgress: 'denied',
    }),
  );
  assert.equal(deniedByPolicy.requirementText, undefined);
  assert.ok(!JSON.stringify(deniedByPolicy).includes('deployment token'));

  const deniedByFrame = buildReviewProjection(
    makeProjectionInput({
      requirement: makeFrame({ egress: 'denied' }),
      requirementEgress: 'allowed',
    }),
  );
  assert.equal(deniedByFrame.requirementText, undefined);

  const delegated = buildReviewProjection(
    makeProjectionInput({
      requirement: makeFrame({
        frame_id: 'rf_delegated',
        source: 'delegated',
        delegator: 'agent_a',
        root_frame_id: 'rf_root',
        egress: 'allowed',
      }),
      requirementEgress: 'allowed',
    }),
  );
  assert.equal(delegated.requirementText, undefined);
  assert.ok(!JSON.stringify(delegated).includes('deployment token'));

  const allowed = buildReviewProjection(
    makeProjectionInput({
      requirement: makeFrame({ egress: 'allowed' }),
      requirementEgress: 'allowed',
    }),
  );
  assert.equal(allowed.requirementText, 'Please update /ws/src/a.ts using the deployment token');
});

test('oversized projections are rejected instead of truncated', () => {
  const ruleIds = Array.from(
    { length: 120 },
    (_value, index) => `rule_${index}_${'x'.repeat(100)}`,
  );
  assert.throws(
    () => buildReviewProjection(makeProjectionInput({ matchedRuleIds: ruleIds })),
    isErrorCode('oversized'),
  );
});

test('projection and its rule list are frozen', () => {
  const projection = buildReviewProjection(makeProjectionInput());
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.matchedRuleIds), true);
  assert.equal(Reflect.set(projection, 'target', 'other.ts'), false);
  assert.equal(Reflect.set(projection.matchedRuleIds, '0', 'other'), false);
});
