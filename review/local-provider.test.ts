import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCAL_REVIEWER_MODEL, createLocalReviewProvider, localReviewFacts } from './local-provider.ts';
import { buildReviewProjection } from './projection.ts';
import { makeProjectionInput } from './test-support.ts';
import type { LocalReviewPolicy } from './local-provider.ts';

const POLICY: LocalReviewPolicy = {
  allowedTools: ['write'],
  allowedOperations: ['file_write'],
  allowedTargets: ['src/approved'],
  deniedTargets: ['src/approved/secret'],
  risk: 0.1,
  confidence: 0.9,
};

function projection(target = '/ws/src/approved/a.ts') {
  return buildReviewProjection(
    makeProjectionInput({
      action: { tool: 'write', operation: 'file_write', target },
      targetEgress: 'workspace-relative',
    }),
  );
}

describe('local deterministic reviewer', () => {
  it('approves only an in-scope tool/operation/target', () => {
    const facts = localReviewFacts(POLICY, projection());
    assert.deepEqual(facts, {
      requirementMatch: 'match',
      withinScope: true,
      risk: 0.1,
      confidence: 0.9,
    });
  });

  it('denies a target outside the approved prefix or explicitly denied', () => {
    for (const target of ['/ws/src/other/a.ts', '/ws/src/approved/secret/a.ts']) {
      const facts = localReviewFacts(POLICY, projection(target));
      assert.equal(facts.withinScope, false);
      assert.equal(facts.requirementMatch, 'mismatch');
    }
  });

  it('denies an outside-workspace or suppressed target', () => {
    const outside = buildReviewProjection(
      makeProjectionInput({
        action: { tool: 'write', operation: 'file_write', target: '/outside/a.ts' },
        targetEgress: 'workspace-relative',
      }),
    );
    assert.equal(outside.target, '[outside-workspace]');
    assert.equal(localReviewFacts(POLICY, outside).withinScope, false);

    const suppressed = buildReviewProjection(
      makeProjectionInput({
        action: { tool: 'write', operation: 'file_write', target: '/ws/src/approved/a.ts' },
        targetEgress: 'denied',
      }),
    );
    assert.equal(suppressed.target, null);
    assert.equal(localReviewFacts(POLICY, suppressed).withinScope, false);
  });

  it('denies a disallowed tool or operation', () => {
    const otherTool = buildReviewProjection(
      makeProjectionInput({
        action: { tool: 'remove', operation: 'file_write', target: '/ws/src/approved/a.ts' },
        targetEgress: 'workspace-relative',
      }),
    );
    assert.equal(localReviewFacts(POLICY, otherTool).withinScope, false);

    const otherOperation = buildReviewProjection(
      makeProjectionInput({
        action: { tool: 'write', operation: 'file_delete', target: '/ws/src/approved/a.ts' },
        targetEgress: 'workspace-relative',
      }),
    );
    assert.equal(localReviewFacts(POLICY, otherOperation).withinScope, false);
  });

  it('exposes a real provider and rejects malformed policies', async () => {
    const provider = createLocalReviewProvider(POLICY);
    assert.equal(provider.model, LOCAL_REVIEWER_MODEL);
    const facts = await provider.review(
      {
        model: LOCAL_REVIEWER_MODEL,
        questionVersion: 'q',
        projection: projection(),
        timeoutMs: 1_000,
      },
      new AbortController().signal,
    );
    assert.equal((facts as { withinScope: boolean }).withinScope, true);
    assert.throws(() =>
      createLocalReviewProvider({
        ...POLICY,
        risk: 2,
      }),
    );
  });
});
