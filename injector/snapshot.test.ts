import assert from 'node:assert/strict';
import test from 'node:test';

import { compileAdvisorySnapshot } from './snapshot.ts';
import { rule, snapshotInput } from './test-support.ts';

test('compiles a closed snapshot, computes a digest, and deep-freezes it', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      baselineRuleIds: ['base'],
      rules: [
        rule({
          id: 'base',
          narrative: 'Base rule.',
          areas: ['typescript'],
          keywords: ['typescript'],
        }),
        rule({
          id: 'engine',
          narrative: 'Engine rule.',
          areas: ['engine'],
          pathHints: ['engine'],
        }),
      ],
    }),
  );

  assert.equal(snapshot.projectId, 'project-amos');
  assert.equal(snapshot.policyVersion, '1.0.0');
  assert.match(snapshot.advisoryDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(snapshot.baselineRuleIds, ['base']);
  assert.deepEqual(
    snapshot.rules.map((entry) => entry.id),
    ['base', 'engine'],
  );
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.rules));
  assert.ok(Object.isFrozen(snapshot.rules[0]));
  assert.ok(Object.isFrozen(snapshot.rules[0]!.areas));
  assert.ok(Object.isFrozen(snapshot.routes));
});

test('mutating the source object cannot change the frozen injection', () => {
  const source = snapshotInput({
    baselineRuleIds: ['base'],
    rules: [rule({ id: 'base', narrative: 'Original narrative.', keywords: ['base'] })],
  });
  const snapshot = compileAdvisorySnapshot(source);

  const mutableRules = source.rules as Array<Record<string, unknown>>;
  mutableRules[0]!.narrative = 'Mutated narrative.';
  (mutableRules[0]!.keywords as string[]).push('mutated');

  assert.equal(snapshot.rules[0]?.narrative, 'Original narrative.');
  assert.deepEqual(snapshot.rules[0]?.keywords, ['base']);
  assert.throws(() => {
    (snapshot.rules[0] as { narrative: string }).narrative = 'Again.';
  }, TypeError);
});

test('verifies a supplied digest and rejects content drift', () => {
  const input = snapshotInput({
    baselineRuleIds: ['base'],
    rules: [rule({ id: 'base', narrative: 'Stable narrative.' })],
  });
  const first = compileAdvisorySnapshot(input);

  const verified = compileAdvisorySnapshot({
    ...input,
    advisoryDigest: first.advisoryDigest,
  });
  assert.equal(verified.advisoryDigest, first.advisoryDigest);

  assert.throws(
    () =>
      compileAdvisorySnapshot({
        ...input,
        rules: [rule({ id: 'base', narrative: 'Changed narrative.' })],
        advisoryDigest: first.advisoryDigest,
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      compileAdvisorySnapshot({
        ...input,
        advisoryDigest: 'sha256:not-a-digest',
      }),
    /advisoryDigest/,
  );
});

test('rejects enforcement-only fields on advisory rules', () => {
  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' }), { ...rule({ id: 'b' }), on_hit: [] }],
        }),
      ),
    /on_hit/,
  );
  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' }), { ...rule({ id: 'b' }), kind: 'security' }],
        }),
      ),
    /kind/,
  );
  const advisory = compileAdvisorySnapshot(
    snapshotInput({
      rules: [rule({ id: 'a' }), { ...rule({ id: 'b' }), kind: 'advisory' }],
    }),
  );
  assert.equal(advisory.rules.length, 2);
});

test('requires explicit active enforcement for a paired rule', () => {
  const paired = snapshotInput({
    rules: [rule({ id: 'a', pairedRuleId: 'security-rule' })],
  });

  assert.throws(
    () => compileAdvisorySnapshot(paired),
    /active enforcement/,
  );
  assert.throws(
    () =>
      compileAdvisorySnapshot(paired, {
        activeEnforcementRuleIds: ['other-rule'],
      }),
    /active enforcement/,
  );
  const compiled = compileAdvisorySnapshot(paired, {
    activeEnforcementRuleIds: ['security-rule'],
  });
  assert.equal(compiled.rules[0]?.pairedRuleId, 'security-rule');
});

test('rejects duplicate ids, unknown references, missing ttl, and unknown fields', () => {
  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({ rules: [rule({ id: 'same' }), rule({ id: 'same' })] }),
      ),
    /unique/,
  );

  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' })],
          baselineRuleIds: ['missing'],
        }),
      ),
    /baselineRuleIds/,
  );

  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' })],
          routes: [{ match: { keyword: 'a' }, add: ['missing'] }],
        }),
      ),
    /route.add/,
  );

  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' })],
          routes: [{ match: { keyword: 'a' }, suppress: ['missing'] }],
        }),
      ),
    /route.suppress/,
  );

  const withoutTtl = { ...rule({ id: 'a' }) } as Record<string, unknown>;
  delete withoutTtl.ttl;
  assert.throws(
    () => compileAdvisorySnapshot(snapshotInput({ rules: [withoutTtl] })),
    /ttl/,
  );

  assert.throws(
    () =>
      compileAdvisorySnapshot({
        ...snapshotInput({ rules: [rule({ id: 'a' })] }),
        extra: true,
      }),
    /unknown field/,
  );
});

test('rejects private path hints and invalid glob hints', () => {
  for (const hint of [
    'constraints/rules.yaml',
    'workflow/shell-policy.ts',
    'storage/audit',
    'audit/log.jsonl',
    'policies/gate',
  ]) {
    assert.throws(
      () =>
        compileAdvisorySnapshot(
          snapshotInput({
            rules: [rule({ id: 'a' }), rule({ id: 'b', pathHints: [hint] })],
          }),
        ),
      /private policy, gate, or audit path/,
      hint,
    );
  }

  // A bare orientation hint is preserved by the transition seed.
  const allowed = compileAdvisorySnapshot(
    snapshotInput({
      rules: [rule({ id: 'a' }), rule({ id: 'b', pathHints: ['constraints'] })],
    }),
  );
  assert.deepEqual(allowed.rules[1]?.pathHints, ['constraints']);

  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' }), rule({ id: 'b', pathHints: ['../secret'] })],
        }),
      ),
    /traverse upward/,
  );
  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' }), rule({ id: 'b', pathHints: ['/absolute'] })],
        }),
      ),
    /relative glob/,
  );
});

test('rejects a route with no match condition', () => {
  assert.throws(
    () =>
      compileAdvisorySnapshot(
        snapshotInput({
          rules: [rule({ id: 'a' })],
          routes: [{ match: {}, add: ['a'] }],
        }),
      ),
    /at least one condition/,
  );
});
