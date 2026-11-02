import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../activation/json.ts';
import { createManagedAuthorizer } from './authorization.ts';
import { managedReviewRequestDigest } from './digests.ts';
import { createManagedReviewGate, evaluateManagedCalibration, managedReviewPolicyDigest } from './review-policy.ts';
import { fixture, NOW, request } from './test-support.ts';
import type { ManagedReviewFacts, ManagedReviewPolicy, ManagedReviewRequest } from './contracts.ts';

function setup() {
  const base = fixture();
  const f = { ...base, requirement: { ...base.requirement, egress: 'allowed' as const } };
  const policy: ManagedReviewPolicy = {
    format: 'amos-managed-review-policy', version: 1, id: 'review-1', model: 'fixture-model',
    questionVersion: 'amos-security-review-v1', tools: ['write'], resourceRoots: ['/work/demo'],
    minConfidence: 0.9, maxRisk: 0.1, timeoutMs: 5000, expiresAt: NOW + 60_000,
    maxAttempts: 1, requirementEgress: 'allowed', targetEgress: 'workspace-relative',
    minimumCases: 30, maximumFalseAllowRate: 0.1, evidenceDigest: 'sha256:' + '0'.repeat(64),
  };
  const r: ManagedReviewRequest = {
    format: 'amos-managed-review-request', version: 1, attemptId: 'case',
    envelopeDigest: 'sha256:' + '1'.repeat(64), capabilityChainDigest: 'sha256:' + '2'.repeat(64),
    snapshotDigest: f.snapshot.digest, requirementDigest: 'sha256:' + '3'.repeat(64),
    policyDigest: managedReviewPolicyDigest(policy), deadline: NOW + 1000, tool: 'write', requestedBytes: 0,
    relativeTarget: 'fixture', requirementText: 'synthetic requirement',
  };
  const facts: ManagedReviewFacts = { format: 'amos-managed-review-facts', version: 1, requestDigest: managedReviewRequestDigest(r), model: policy.model, requirementMatch: 'mismatch', withinScope: false, risk: 1, confidence: 0 };
  const cases = Array.from({ length: 30 }, (_, index) => {
    const request = { ...r, relativeTarget: `fixture-${index}` };
    return { request, facts: { ...facts, requestDigest: managedReviewRequestDigest(request) }, expected: 'stop' as const };
  });
  const calibration = evaluateManagedCalibration(policy, cases, NOW - 1000, NOW + 40_000);
  const pinned = { ...policy, evidenceDigest: digest('amos-managed-calibration-v1', calibration) };
  return { f, policy: pinned, calibration, cases, r, facts };
}
function gate(s: ReturnType<typeof setup>) {
  return createManagedReviewGate({ policy: s.policy, calibration: s.calibration, requirement: s.f.requirement, workspace: '/work/demo' });
}
function eligible(s: ReturnType<typeof setup>) {
  const authorizer = createManagedAuthorizer(s.f);
  const env = authorizer.createEnvelope(request({ tool: 'write', path: 'review-file', content: 'private fixture content' }), NOW);
  const decision = authorizer.authorize(env, { now: NOW, revokedCapabilityIds: [], operationCounts: { root: 0 } });
  assert.equal(decision.state, 'AUTO_REVIEW');
  return { env, decision, cap: s.f.capabilities[0] };
}
test('eligible request and pinned facts pass without leaking content', () => {
  const s = setup(); const g = gate(s); const a = eligible(s);
  const r = g.request(a.env, a.decision, a.cap, 'attempt', NOW);
  assert.ok(r); assert.ok(Object.isFrozen(r));
  assert.equal(r.relativeTarget, 'review-file'); assert.equal(r.requirementText, s.f.requirement.text);
  assert.ok(!JSON.stringify(r).includes('private fixture content'));
  const facts: ManagedReviewFacts = { format: 'amos-managed-review-facts', version: 1, requestDigest: managedReviewRequestDigest(r), model: s.policy.model, requirementMatch: 'match', withinScope: true, risk: 0.1, confidence: 0.9 };
  assert.equal(g.approve(r, facts, NOW), true);
  assert.equal(g.request(a.env, a.decision, a.cap, 'second-attempt', NOW), null);
  assert.equal(g.approve(r, facts, r.deadline), false);
  for (const bad of [{ model: 'wrong' }, { risk: 0.2 }, { confidence: 0.5 }, { risk: NaN }, { requestDigest: 'sha256:' + '9'.repeat(64) }, { requirementMatch: 'unclear' as const }, { withinScope: false }]) assert.equal(g.approve(r, { ...facts, ...bad }, NOW), false);
  assert.equal(g.approve({ ...r, requestedBytes: 0 }, facts, NOW), false);
});
test('calibration uses unsafe denominator and rejects false allows, drift and expiry', () => {
  const s = setup();
  assert.equal(s.calibration.unsafeCases, 30); assert.equal(s.calibration.falseAllows, 0);
  assert.doesNotThrow(() => gate(s));
  const fewer = evaluateManagedCalibration(s.policy, s.cases.map((x, index) => ({ ...x, expected: index === 0 ? 'stop' as const : 'allow' as const })), NOW - 1, NOW + 10);
  assert.equal(fewer.unsafeCases, 1);
  const pin = (calibration: typeof fewer) => ({ ...s.policy, evidenceDigest: digest('amos-managed-calibration-v1', calibration) });
  assert.throws(() => createManagedReviewGate({ policy: pin(fewer), calibration: fewer, requirement: s.f.requirement, workspace: '/work/demo' }));
  const zero = evaluateManagedCalibration(s.policy, [], NOW - 1, NOW + 10);
  assert.throws(() => createManagedReviewGate({ policy: pin(zero), calibration: zero, requirement: s.f.requirement, workspace: '/work/demo' }));
  const passing = { ...s.cases[0].facts, requirementMatch: 'match' as const, withinScope: true, risk: 0, confidence: 1 };
  const failed = evaluateManagedCalibration(s.policy, [{ ...s.cases[0], facts: passing }, ...s.cases.slice(1)], NOW - 1, NOW + 10);
  assert.equal(failed.falseAllows, 1);
  assert.throws(() => createManagedReviewGate({ policy: pin(failed), calibration: failed, requirement: s.f.requirement, workspace: '/work/demo' }));
  assert.throws(() => gate({ ...s, policy: { ...s.policy, model: 'other' } }));
  assert.throws(() => gate({ ...s, policy: { ...s.policy, questionVersion: 'wrong' } }));
  assert.throws(() => gate({ ...s, policy: { ...s.policy, evidenceDigest: 'sha256:' + 'f'.repeat(64) } }));
  const strict = { ...s.policy, maximumFalseAllowRate: 0.01 };
  const strictCases = s.cases.map(item => {
    const request = { ...item.request, policyDigest: managedReviewPolicyDigest(strict) };
    return { request, facts: { ...item.facts, requestDigest: managedReviewRequestDigest(request) }, expected: 'stop' as const };
  });
  const strictEvidence = evaluateManagedCalibration(strict, strictCases, NOW - 1, NOW + 10);
  assert.throws(() => createManagedReviewGate({ policy: { ...strict, evidenceDigest: digest('amos-managed-calibration-v1', strictEvidence) }, calibration: strictEvidence, requirement: s.f.requirement, workspace: '/work/demo' }));
  assert.equal(gate(s).request(eligible(s).env, eligible(s).decision, s.f.capabilities[0], 'a', s.calibration.expiresAt), null);
});

test('requirement and target egress are independently controlled', () => {
  const s = setup();
  const { env, decision, cap } = eligible(s);
  for (const changed of [
    { ...s.policy, requirementEgress: 'denied' as const },
    { ...s.policy, targetEgress: 'denied' as const },
  ]) {
    const calibration = { ...s.calibration, policyDigest: managedReviewPolicyDigest(changed) };
    const policy = { ...changed, evidenceDigest: digest('amos-managed-calibration-v1', calibration) };
    const denied = createManagedReviewGate({ policy, calibration, requirement: s.f.requirement, workspace: '/work/demo' });
    assert.equal(denied.request(env, decision, cap, 'a', NOW), null);
    const cases = s.cases.map(item => {
      const req = { ...item.request, policyDigest: managedReviewPolicyDigest(changed) };
      return { ...item, request: req, facts: { ...item.facts, requestDigest: managedReviewRequestDigest(req) } };
    });
    assert.throws(() => evaluateManagedCalibration(changed, cases, NOW - 1, NOW + 30_000));
  }
  const deniedFrame = { ...s.f.requirement, egress: 'denied' as const };
  const deniedCore = createManagedAuthorizer({ ...s.f, requirement: deniedFrame });
  const deniedEnv = deniedCore.createEnvelope(request({ tool: 'write', path: 'review-file', content: 'secret-data' }), NOW);
  const deniedDecision = deniedCore.authorize(deniedEnv, { now: NOW, revokedCapabilityIds: [], operationCounts: { root: 0 } });
  const deniedGate = createManagedReviewGate({ policy: s.policy, calibration: s.calibration, requirement: deniedFrame, workspace: '/work/demo' });
  assert.equal(deniedGate.request(deniedEnv, deniedDecision, cap, 'a', NOW), null);
});
test('request scope, source, binding and hostile accessors fail closed', () => {
  const s = setup(); const g = gate(s); const { env, decision, cap } = eligible(s);
  assert.equal(g.request(env, { ...decision, state: 'DENY' }, cap, 'attempt', NOW), null);
  assert.equal(g.request(env, decision, { ...cap, reviewPolicyId: 'other' }, 'attempt', NOW), null);
  assert.equal(g.request(env, decision, { ...cap, resourceRoots: ['/work/demo/other'] }, 'attempt', NOW), null);
  assert.equal(g.request(env, decision, { ...cap, tools: ['read'] }, 'attempt', NOW), null);
  const shell = { ...env, input: { tool: 'shell' as const, command: 'echo fixture' } };
  assert.equal(g.request(shell, decision, cap, 'attempt', NOW), null);
  assert.equal(g.request({ ...env, requirementDigest: 'bad' }, decision, cap, 'attempt', NOW), null);
  let invoked = false; const hostile = { ...env, get input() { invoked = true; return env.input; } };
  assert.equal(g.request(hostile, decision, cap, 'attempt', NOW), null); assert.equal(invoked, false);
  const delegated = { ...s.f.requirement, source: 'delegated' as const, actor: 'agent' as const, delegator: 'agent', root_frame_id: 'root' };
  const other = createManagedReviewGate({ policy: s.policy, calibration: s.calibration, requirement: delegated, workspace: '/work/demo' });
  assert.equal(other.request(env, decision, cap, 'attempt', NOW), null);
});

test('calibration rejects nonce-only duplicates and ineligible tools', () => {
  const s = setup();
  const first = s.cases[0];
  const duplicate = { ...first.request, attemptId: 'different', envelopeDigest: 'sha256:' + 'b'.repeat(64) };
  const duplicateFacts = { ...first.facts, requestDigest: managedReviewRequestDigest(duplicate) };
  assert.throws(() => evaluateManagedCalibration(s.policy, [first, { ...first, request: duplicate, facts: duplicateFacts }], NOW - 1, NOW + 10));
  for (const tool of ['shell', 'read'] as const) {
    const ineligible = { ...first.request, tool };
    const facts = { ...first.facts, requestDigest: managedReviewRequestDigest(ineligible) };
    assert.throws(() => evaluateManagedCalibration(s.policy, [{ ...first, request: ineligible, facts }], NOW - 1, NOW + 10));
  }
  for (const field of ['relativeTarget', 'requirementText'] as const) {
    const ineligible = { ...first.request, [field]: null };
    const facts = { ...first.facts, requestDigest: managedReviewRequestDigest(ineligible) };
    assert.throws(() => evaluateManagedCalibration(s.policy, [{ ...first, request: ineligible, facts }], NOW - 1, NOW + 10));
  }
});
