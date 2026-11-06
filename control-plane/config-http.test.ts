import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tighteningRuleDigest } from '../activation/tighten.ts';
import { createPromotionThresholds, createProbeRun } from '../rollout/contracts.ts';
import {
  TEST_AGENT_TOKEN,
  createHarness,
  fetchJson,
  humanHeaders,
  loginHuman,
} from './http-test-support.ts';
import {
  human,
  makeCandidate,
  makeRule,
} from './test-helpers.ts';

test('HTTP exposes config, tightening, probe, and rollout lifecycle routes', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const workspace = join(harness.dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const auth = await loginHuman(harness);

  const active = makeRule('active-read', {
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
  });
  const templateRule = makeRule('tighten-write', {
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
  });
  const project = harness.service.createProject({ name: 'HTTP config', workspace }, human());
  const proposal = harness.service.createProposal(
    project.id,
    {
      title: 'Publish',
      rationale: 'HTTP fixture',
      baseVersion: 0,
      expiresAt: new Date(harness.clock.now() + 60_000).toISOString(),
      candidate: makeCandidate([active, templateRule], { includedRuleIds: [active.id] }),
    },
    human(),
  );
  harness.service.decideProposal(
    proposal.id,
    { decision: 'approve', note: 'approved', expectedDigest: proposal.digest },
    human(),
  );
  const published = harness.service.getVersion(project.id, 1);

  const configPath = `/api/projects/${project.id}/config`;
  const initial = await fetchJson(harness, configPath, {
    headers: humanHeaders(auth, harness.url),
  });
  assert.equal(initial.status, 200);
  assert.equal((initial.body as { managed: { enabled: boolean } }).managed.enabled, false);

  const template = {
    id: 'template-write',
    ruleRef: { id: templateRule.id, version: 1 },
    ruleDigest: tighteningRuleDigest(templateRule as unknown as Record<string, unknown>),
    maxTtlMs: 60_000,
    maxApplications: 3,
    windowMs: 3_600_000,
  };
  const updated = await fetchJson(harness, configPath, {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: JSON.stringify({
      managed: { ...(initial.body as { managed: object }).managed, enabled: true },
      tightening: {
        enabled: true,
        quota: { maxActive: 2, maxApplications: 5, windowMs: 3_600_000 },
        templates: [template],
      },
      rollout: {
        thresholds: createPromotionThresholds({
          format: 'amos-rollout-thresholds',
          version: 1,
          id: 'threshold-draft-log',
          ruleRef: { id: active.id, version: 1 },
          fromStage: 'draft',
          toStage: 'log_only',
          minViolationCases: 1,
          minControlCases: 1,
          minCoverage: 1,
          maxFalseAllowRate: 0,
          maxFalseDenyRate: 0,
          requiredHosts: [],
          requiredEnvironments: [],
          reviewer: null,
          registeredAt: harness.clock.now() - 1_000,
          expiresAt: harness.clock.now() + 3_600_000,
        }),
      },
    }),
  });
  assert.equal(updated.status, 200);
  assert.equal((updated.body as { managed: { enabled: boolean } }).managed.enabled, true);

  const agentHeaders = {
    Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const tightenPath = `/api/projects/${project.id}/tighten`;
  const applied = await fetchJson(harness, tightenPath, {
    method: 'POST',
    headers: agentHeaders,
    body: JSON.stringify({ templateId: 'template-write', ttlMs: 30_000 }),
  });
  assert.equal(applied.status, 200);
  assert.equal((applied.body as { active: unknown[] }).active.length, 1);
  assert.equal(
    (applied.body as { active: Array<{ ruleRef: { id: string } }> }).active[0]?.ruleRef.id,
    'tighten-write',
  );
  const listed = await fetchJson(harness, tightenPath, {
    headers: humanHeaders(auth, harness.url),
  });
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { active: unknown[] }).active.length, 1);
  harness.clock.advance(31_000);
  const expired = await fetchJson(harness, `${tightenPath}/expire`, {
    method: 'POST',
    headers: agentHeaders,
    body: '{}',
  });
  assert.equal(expired.status, 200);
  assert.equal((expired.body as { active: unknown[] }).active.length, 0);

  const effectiveDigest =
    harness.service.listTemporaryTightenings(project.id).activationDigest ??
    published.snapshot.activationDigest;
  const run = createProbeRun({
    format: 'amos-probe-run',
    version: 1,
    runId: 'http-run-1',
    ruleRef: { id: active.id, version: 1 },
    activationDigest: effectiveDigest,
    host: { id: 'host-a', version: '1.0.0' },
    check: { id: 'typescript', version: '1.0.0' },
    environment: { id: 'env-a', version: '1.0.0' },
    driver: 'trusted-os',
    outcome: 'observed',
    cases: { total: 10, observed: 10, violations: 4, controls: 6 },
    coverage: { required: 10, observed: 10 },
    sideEffects: { expected: 0, observed: 0, unauthorized: 0 },
    falseAllowRate: 0,
    falseDenyRate: 0,
    artifactsDigest: `sha256:${'a'.repeat(64)}`,
    recordedAt: harness.clock.now(),
    expiresAt: harness.clock.now() + 3_600_000,
  });
  const recorded = await fetchJson(harness, `/api/projects/${project.id}/probes`, {
    method: 'POST',
    headers: agentHeaders,
    body: JSON.stringify({ probe: run }),
  });
  assert.equal(recorded.status, 201);
  assert.equal((recorded.body as { digest: string }).digest, run.digest);
  const probes = await fetchJson(harness, `/api/projects/${project.id}/probes`, {
    headers: humanHeaders(auth, harness.url),
  });
  assert.equal(probes.status, 200);
  assert.equal(Array.isArray(probes.body), true);

  const promoted = await fetchJson(harness, `/api/projects/${project.id}/rollout/promote`, {
    method: 'POST',
    headers: agentHeaders,
    body: JSON.stringify({
      ruleId: active.id,
      evidence: [run],
      current: {
        activationDigest: effectiveDigest,
        host: run.host,
        check: run.check,
        environment: run.environment,
      },
    }),
  });
  assert.equal(promoted.status, 200);
  assert.equal((promoted.body as { decision: string }).decision, 'promote');
  const rollout = await fetchJson(harness, `/api/projects/${project.id}/rollout`, {
    headers: humanHeaders(auth, harness.url),
  });
  assert.equal(rollout.status, 200);
  assert.equal((rollout.body as Array<{ state: string }>)[0]?.state, 'log_only');
});
