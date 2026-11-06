import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluatePolicy } from '../engine/engine.ts';
import { createProjectActivationCompiler } from './compiler.ts';
import { createTemporaryTighteningPublisher, tighteningRuleDigest } from './tighten.ts';
import { ActivationError, type ProjectActivationSnapshot } from './types.ts';
import type { ApprovedTighteningTemplate, TighteningQuota } from './tighten.ts';
import { entry, json, options, project } from './test-support.ts';

function catalogOptions() {
  const base = options();
  const hard = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...entry(id, overrides),
    // Temporary tightenings must be hard rules only: no new narrative.
    injection: null,
  });
  return {
    ...base,
    rules: [
      ...base.rules,
      hard('tighten'),
      hard('tighten-confirm', { on_hit: 'confirm' }),
      hard('tighten-second', { on_hit: 'confirm' }),
      hard('tighten-level0', { level: 0 }),
      hard('tighten-log', { on_hit: 'log' }),
      hard('tighten-advisory', {
        expressivity: 'advisory_only',
        enforcement: 'advisory',
        predicate: null,
        on_hit: 'log',
      }),
      // Deterministic rule that carries injection metadata: accepting it would
      // add a narrative to the advisory projection.
      entry('tighten-narrative'),
    ],
  };
}

const compiler = createProjectActivationCompiler(catalogOptions());
const base = compiler.compile(project());

function recordOf(id: string): Readonly<Record<string, unknown>> {
  const snapshot = compiler.compile(project({
    selectedRuleRefs: [{ id: 'typescript', version: 1 }, { id, version: 1 }],
  }));
  const found = snapshot.activeRules.find((item) => item.id === id);
  assert.ok(found !== undefined && found.rule !== null);
  return found.rule;
}

function template(
  id: string,
  ruleId: string,
  overrides: Partial<ApprovedTighteningTemplate> = {},
): ApprovedTighteningTemplate {
  return {
    id,
    ruleRef: { id: ruleId, version: 1 },
    ruleDigest: tighteningRuleDigest(recordOf(ruleId)),
    maxTtlMs: 1_000,
    maxApplications: 5,
    windowMs: 100_000,
    ...overrides,
  };
}

function publisherFor(
  clock: { now: number },
  templates: readonly ApprovedTighteningTemplate[],
  quota: TighteningQuota = { maxActive: 3, maxApplications: 10, windowMs: 100_000 },
) {
  return createTemporaryTighteningPublisher({
    compiler,
    base,
    templates,
    quota,
    now: () => clock.now,
    newProjectConfigVersion: 'policy-tightened',
    newBaseVersion: 'base-tightened',
  });
}

function narrativeIds(snapshot: ProjectActivationSnapshot): string[] {
  return snapshot.advisory.status === 'ready'
    ? snapshot.advisory.snapshot.rules.map(({ id }) => id)
    : [];
}

test('apply adds exactly one approved deterministic rule and leaves narratives unchanged', () => {
  const clock = { now: 1_000 };
  const publisher = publisherFor(clock, [template('allow-tighten', 'tighten')]);
  const baseDigest = base.digest;
  const baseJson = json(base);
  const applied = publisher.apply('allow-tighten', 500);

  assert.equal(applied.templateId, 'allow-tighten');
  assert.deepEqual(applied.ruleRef, { id: 'tighten', version: 1 });
  assert.equal(applied.appliedAt, 1_000);
  assert.equal(applied.expiresAt, 1_500);
  assert.equal(applied.epoch, 2);
  assert.ok(Object.isFrozen(applied));

  const snapshot = applied.snapshot;
  assert.equal(snapshot.epoch, 2);
  assert.equal(snapshot.project.epoch, 2);
  assert.equal(snapshot.project.projectConfigVersion, 'policy-tightened');
  assert.equal(snapshot.project.baseVersion, 'base-tightened');
  assert.deepEqual(snapshot.activeRules.map(({ id }) => id), ['baseline', 'typescript', 'tighten']);
  assert.deepEqual(
    snapshot.enforcement.runtime.ruleRefs.map(({ id }) => id),
    ['baseline', 'typescript', 'tighten'],
  );

  const added = snapshot.activeRules[2]!;
  assert.equal(added.mandatory, false);
  assert.equal(added.rule?.level, 1);
  assert.equal(added.rule?.expressivity, 'deterministic');
  assert.equal(added.rule?.on_hit, 'deny');
  // The base rule answers `confirm`; the tightening may only add `deny`.
  assert.equal(
    evaluatePolicy(
      { tool: 'fs', operation: 'file_write', target: '/work/typescript/src/a.ts' },
      snapshot.enforcement.runtime.rules,
      1_000,
    ).verdict,
    'deny',
  );

  // The advisory projection gains no narrative and rewrites none.
  assert.equal(narrativeIds(snapshot).join(','), narrativeIds(base).join(','));
  if (snapshot.advisory.status === 'ready' && base.advisory.status === 'ready') {
    assert.deepEqual(json(snapshot.advisory.snapshot.rules), json(base.advisory.snapshot.rules));
    assert.deepEqual(snapshot.advisory.ruleRefs, base.advisory.ruleRefs);
  }

  // The base snapshot itself is untouched and still the pre-tightening value.
  assert.deepEqual(json(base), baseJson);
  assert.equal(base.digest, baseDigest);
  assert.equal(base.epoch, 1);
  assert.equal(base.activeRules.length, 2);
  assert.equal(publisher.active().length, 1);
});

test('every base rule, mandatory membership and the advisory narrative set stay append-only', () => {
  const clock = { now: 1_000 };
  const publisher = publisherFor(clock, [
    template('first', 'tighten'),
    template('second', 'tighten-second'),
  ]);
  publisher.apply('first', 1_000);
  const snapshot = publisher.apply('second', 1_000).snapshot;

  assert.deepEqual(json(snapshot.activeRules.slice(0, base.activeRules.length)), json(base.activeRules));
  assert.deepEqual(
    snapshot.activeRules.map(({ id, mandatory }) => [id, mandatory]),
    [['baseline', true], ['typescript', false], ['tighten', false], ['tighten-second', false]],
  );
  assert.deepEqual(narrativeIds(snapshot), narrativeIds(base));
  assert.equal(snapshot.advisory.status, base.advisory.status);
  assert.equal(snapshot.epoch, 3);
  assert.equal(publisher.active().length, 2);

  clock.now = 2_000;
  const expired = publisher.expire();
  assert.deepEqual(expired.expired, ['first', 'second']);
  assert.equal(expired.snapshot.epoch, 4);
  assert.deepEqual(expired.snapshot.activeRules.map(({ id }) => id), ['baseline', 'typescript']);
  assert.deepEqual(json(expired.snapshot.activeRules), json(base.activeRules));
});

test('TTL boundary expires exactly once, never renews, and a later apply gets a fresh TTL', () => {
  const clock = { now: 1_000 };
  const publisher = publisherFor(clock, [template('t', 'tighten')]);
  const applied = publisher.apply('t', 500);

  clock.now = 1_499;
  const beforeExpiry = publisher.expire();
  assert.deepEqual(beforeExpiry.expired, []);
  assert.equal(beforeExpiry.snapshot, applied.snapshot);
  assert.equal(beforeExpiry.snapshot.epoch, 2);

  clock.now = 1_500;
  const atExpiry = publisher.expire();
  assert.deepEqual(atExpiry.expired, ['t']);
  assert.equal(atExpiry.snapshot.epoch, 3);
  assert.deepEqual(atExpiry.snapshot.activeRules.map(({ id }) => id), ['baseline', 'typescript']);

  // Repeated expiry does not recompile or renew anything.
  const again = publisher.expire();
  assert.deepEqual(again.expired, []);
  assert.equal(again.snapshot, atExpiry.snapshot);
  assert.equal(again.snapshot.epoch, 3);
  assert.deepEqual(publisher.active(), []);

  // The same template may be applied again, but with a fresh TTL from now.
  const fresh = publisher.apply('t', 500);
  assert.equal(fresh.appliedAt, 1_500);
  assert.equal(fresh.expiresAt, 2_000);
  assert.equal(fresh.epoch, 4);
});

test('unknown, zero-layer, widening, digest-mismatched and repeated templates are rejected', () => {
  const clock = { now: 1_000 };
  const publisher = publisherFor(clock, [
    template('good', 'tighten'),
    template('confirm', 'tighten-confirm'),
    template('level0', 'tighten-level0'),
    template('log', 'tighten-log'),
    template('advisory', 'tighten-advisory'),
    template('narrative', 'tighten-narrative'),
    template('bad-digest', 'tighten', { ruleDigest: `sha256:${'0'.repeat(64)}` }),
  ]);

  const attempts: [string, number][] = [
    ['missing', 100],
    ['good', 0],
    ['good', -1],
    ['good', 1.5],
    ['good', 1_001],
    ['level0', 100],
    ['log', 100],
    ['advisory', 100],
    ['narrative', 100],
    ['bad-digest', 100],
  ];
  for (const [id, ttl] of attempts) {
    assert.throws(() => publisher.apply(id, ttl), ActivationError, `${id}:${ttl}`);
  }
  assert.equal(publisher.active().length, 0);

  const applied = publisher.apply('good', 100);
  assert.equal(applied.ruleRef.id, 'tighten');
  // An already-active rule is not a tightening and cannot extend its TTL.
  assert.throws(() => publisher.apply('good', 100), ActivationError);
  // `confirm` is allowed: temporary tightening is not limited to `deny`.
  const confirmed = publisher.apply('confirm', 100);
  assert.equal(confirmed.snapshot.activeRules.find(({ id }) => id === 'tighten-confirm')?.rule?.on_hit, 'confirm');
});

test('quota windows survive apply/expire cycles and are enforced per quota and template', () => {
  const clock = { now: 1_000 };
  const templates = [template('t', 'tighten'), template('t2', 'tighten-second')];

  const activeLimited = publisherFor(clock, templates, { maxActive: 1, maxApplications: 10, windowMs: 100_000 });
  activeLimited.apply('t', 100);
  assert.throws(() => activeLimited.apply('t2', 100), ActivationError);

  const applicationLimited = publisherFor(clock, templates, { maxActive: 5, maxApplications: 2, windowMs: 100_000 });
  applicationLimited.apply('t', 100);
  clock.now = 1_100;
  applicationLimited.expire();
  clock.now = 1_200;
  applicationLimited.apply('t', 100);
  clock.now = 1_300;
  applicationLimited.expire();
  clock.now = 1_400;
  assert.throws(() => applicationLimited.apply('t', 100), ActivationError);

  const clock2 = { now: 5_000 };
  const templateLimited = publisherFor(clock2, [
    template('t', 'tighten', { maxApplications: 1 }),
    template('t2', 'tighten-second'),
  ], { maxActive: 5, maxApplications: 10, windowMs: 100_000 });
  templateLimited.apply('t', 100);
  clock2.now = 5_100;
  templateLimited.expire();
  clock2.now = 5_200;
  assert.throws(() => templateLimited.apply('t', 100), ActivationError);
  templateLimited.apply('t2', 100);
});

test('a clock rollback throws before compiling and leaves the applied state intact', () => {
  const clock = { now: 5_000 };
  const publisher = publisherFor(clock, [template('t', 'tighten')]);
  const applied = publisher.apply('t', 1_000);

  clock.now = 4_999;
  assert.throws(() => publisher.apply('t', 100), ActivationError);
  assert.throws(() => publisher.expire(), ActivationError);
  assert.equal(publisher.active().length, 1);
  assert.equal(publisher.active()[0]!.snapshot, applied.snapshot);

  // The rollback did not advance the trusted clock; a later valid time still
  // expires the original TTL without extending it.
  clock.now = 6_000;
  const expired = publisher.expire();
  assert.deepEqual(expired.expired, ['t']);
  assert.equal(expired.snapshot.epoch, applied.epoch + 1);
});

test('a restarted publisher does not inherit process-local TTL state', () => {
  const clock = { now: 1_000 };
  publisherFor(clock, [template('t', 'tighten')]).apply('t', 1_000);

  const restarted = publisherFor(clock, [template('t', 'tighten')]);
  assert.deepEqual(restarted.active(), []);
  const result = restarted.expire();
  assert.equal(result.snapshot, base);
  assert.equal(result.snapshot.epoch, 1);
  // A fresh process may apply the approved template again.
  const applied = restarted.apply('t', 100);
  assert.equal(applied.appliedAt, 1_000);
});

test('invalid publisher options and hostile input fail closed with a fixed error', () => {
  assert.throws(() => createTemporaryTighteningPublisher({
    ...{
      compiler,
      base,
      templates: [template('t', 'tighten')],
      quota: { maxActive: 1, maxApplications: 1, windowMs: 1_000 },
      now: () => 0,
      newProjectConfigVersion: 'policy',
      newBaseVersion: 'base',
    },
    quota: { maxActive: -1, maxApplications: 1, windowMs: 1_000 },
  }), ActivationError);
  assert.throws(() => createTemporaryTighteningPublisher({
    compiler,
    base,
    templates: [template('t', 'tighten'), template('t', 'tighten')],
    quota: { maxActive: 1, maxApplications: 1, windowMs: 1_000 },
    now: () => 0,
    newProjectConfigVersion: 'policy',
    newBaseVersion: 'base',
  }), ActivationError);
  assert.throws(() => createTemporaryTighteningPublisher({
    compiler,
    base: json(base),
    templates: [],
    quota: { maxActive: 1, maxApplications: 1, windowMs: 1_000 },
    now: () => 0,
    newProjectConfigVersion: 'policy',
    newBaseVersion: 'base',
  }), ActivationError);
});
