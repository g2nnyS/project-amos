import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../autonomy/journal.ts';
import { auditId } from '../autonomy/audit.ts';
import { ManagedJournal, managedJournalId, managedReviewFactsDigest } from './journal.ts';
import type { ManagedJournalEvidence, ManagedJournalOptions, ManagedJournalReviewFacts } from './journal.ts';

const D = `sha256:${'a'.repeat(64)}`;
const identity = { actorId: 'private-actor', projectId: 'private-project', sessionId: 'private-session', taskId: 'private-task', snapshotDigest: D };
const cap = managedJournalId('capability', 'private-capability');
const limits = { [cap]: 3 };
function ev(id: string, state: 'ALLOW' | 'AUTO_REVIEW' | 'DENY' = 'ALLOW'): ManagedJournalEvidence {
  return {
    operationHash: managedJournalId('operation', id), parentOperationHash: null, effectIndex: null, actorHash: managedJournalId('actor', identity.actorId), projectHash: managedJournalId('project', identity.projectId), sessionHash: managedJournalId('session', identity.sessionId), taskHash: managedJournalId('task', identity.taskId),
    capabilityChainHashes: [cap], ruleHashes: [managedJournalId('rule', 'private-rule')], envelopeDigest: D, capabilityChainDigest: D, snapshotDigest: D, requirementDigest: D, policyDigest: state === 'AUTO_REVIEW' ? D : null, state, reason: state === 'ALLOW' ? 'allowed' : state === 'DENY' ? 'policy_denied' : 'review_required', notAfter: state === 'DENY' ? null : 100,
  };
}
const reviewBase = { requestDigest: D, modelHash: managedJournalId('model', 'private-model'), requirementMatch: 'match' as const, withinScope: true, risk: 0.1, confidence: 0.99 };
const review: ManagedJournalReviewFacts = { ...reviewBase, factsDigest: managedReviewFactsDigest(reviewBase) };
function fixture(): { dir: string; options: ManagedJournalOptions } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-ledger-')); const workspace = path.join(dir, 'work'); fs.mkdirSync(workspace);
  return { dir, options: { workspace, snapshotDigest: D, identity, journalPath: path.join(dir, 'journal') } };
}

test('durable unique reservation, token-only ordered review and single budget count', () => {
  const { dir, options } = fixture();
  try {
    const j = new ManagedJournal(options);
    const token = j.reserveReview(ev('review', 'AUTO_REVIEW'), D, 90, limits, 1);
    assert.equal(j.operationCount(cap), 1);
    assert.equal(j.operationCountExcludingReview(token, cap), 0);
    assert.throws(() => j.reserveReview(ev('review', 'AUTO_REVIEW'), D, 90, limits, 2));
    assert.throws(() => j.consumeReviewed({}, 2));
    assert.throws(() => j.consumeReviewed(token, 2));
    assert.throws(() => j.recordReview(token, 'approved', { ...review, requestDigest: `sha256:${'b'.repeat(64)}` }, 2));
    j.recordReview(token, 'approved', review, 2);
    assert.throws(() => j.recordReview(token, 'approved', review, 2));
    const execution = j.consumeReviewed(token, 3);
    assert.equal(j.operationCount(cap), 1);
    assert.throws(() => j.consumeReviewed(token, 3));
    j.recordResult(execution, 'outcome_unknown', 4);
    assert.throws(() => j.recordResult(execution, 'failed', 4));
    j.recordDecision(ev('private-operation-denied', 'DENY'), 5);
    assert.throws(() => j.consume(ev('private-operation-denied'), limits, 6));
    j.close();
    const text = fs.readFileSync(options.journalPath, 'utf8');
    for (const raw of ['private-actor','private-project','private-session','private-task','private-capability','private-rule','private-model','private-operation-denied',options.workspace]) {
      assert.equal(text.includes(raw), false);
    }
    const reopened = new ManagedJournal(options);
    assert.equal(reopened.operationCount(cap), 1);
    assert.throws(() => reopened.consumeReviewed(token, 6));
    assert.throws(() => reopened.reserveReview(ev('review', 'AUTO_REVIEW'), D, 90, limits, 6));
    reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending review cannot be retried after restart; revoke and stop survive', () => {
  const { dir, options } = fixture();
  try {
    const j = new ManagedJournal(options); const token = j.reserveReview(ev('pending', 'AUTO_REVIEW'), D, 90, limits, 1); j.revoke(cap, 2); j.close();
    const next = new ManagedJournal(options);
    assert.equal(next.isRevoked(cap), true); assert.equal(next.operationCount(cap), 1);
    assert.throws(() => next.recordReview(token, 'approved', review, 3));
    assert.throws(() => next.reserveReview(ev('pending', 'AUTO_REVIEW'), D, 90, limits, 3));
    next.stop(3); next.close();
    const stopped = new ManagedJournal(options); assert.equal(stopped.stopped, true);
    assert.throws(() => stopped.consume(ev('after-stop'), limits, 4)); stopped.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fsync failure poisons ledger and leaves its exclusive lock', (t) => {
  const { dir, options } = fixture(); const j = new ManagedJournal(options);
  t.mock.method(fs, 'fsyncSync', () => { throw Error('fixture'); });
  try {
    assert.throws(() => j.consume(ev('fsync'), limits, 1));
    assert.throws(() => j.consume(ev('another'), limits, 2));
  } finally { t.mock.restoreAll(); j.close(); }
  try { assert.throws(() => new ManagedJournal(options)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy v2 is read only, pinned, imports history and refuses lock, corruption and drift', () => {
  const { dir, options } = fixture(); const old = path.join(dir, 'old');
  const legacyEvidence = {
    format: 'amos-authorization-evidence' as const, formatVersion: 1 as const,
    operationIdHash: auditId('operation', 'old-operation'), actorIdHash: auditId('actor', identity.actorId), projectIdHash: auditId('project', identity.projectId), sessionIdHash: auditId('session', identity.sessionId), taskIdHash: auditId('task', identity.taskId), capabilityIdHash: cap, capabilityChainIdHashes: [cap], capabilityChainDigest: D, snapshotDigest: D, checkpoint: 'runtime' as const, tool: 'fs' as const, operation: 'file_write' as const, effect: 'file_create' as const, state: 'ALLOW' as const, reason: 'allowed' as const, matchedRuleIdHashes: [], parameterDigest: D, envelopeDigest: D, requestedBytes: 1, authorityExpiresAt: 100,
  };
  try {
    const source = new Journal(old, options.workspace, D);
    source.append('consume', legacyEvidence.operationIdHash, D, 1, legacyEvidence);
    source.append('revoke', cap, '', 2); source.close();
    const oldText = fs.readFileSync(old, 'utf8');
    const withLegacy = { ...options, legacyJournalPaths: [old] };
    const j = new ManagedJournal(withLegacy);
    assert.equal(j.hasOperation(legacyEvidence.operationIdHash), true); assert.equal(j.operationCount(cap), 1); assert.equal(j.isRevoked(cap), true); j.close();
    assert.equal(fs.readFileSync(old, 'utf8'), oldText);
    fs.writeFileSync(`${old}.lock`, 'stale'); assert.throws(() => new ManagedJournal(withLegacy)); fs.unlinkSync(`${old}.lock`);
    fs.appendFileSync(old, '{'); assert.throws(() => new ManagedJournal(withLegacy));
    fs.writeFileSync(old, oldText + oldText.split('\n')[0] + '\n'); assert.throws(() => new ManagedJournal(withLegacy));
    fs.writeFileSync(old, oldText);
    const changedSource = new Journal(old, options.workspace, D);
    changedSource.append('result', legacyEvidence.operationIdHash, 'outcome_unknown', 3); changedSource.close();
    assert.throws(() => new ManagedJournal(withLegacy)); // valid source, different pinned whole-file digest
    fs.writeFileSync(old, oldText);
    const recovered = new ManagedJournal(withLegacy); recovered.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy v2 requires an exact first pin before any otherwise valid entry', () => {
  const { dir, options } = fixture(); const old = path.join(dir, 'old');
  const legacyEvidence = {
    format: 'amos-authorization-evidence' as const, formatVersion: 1 as const,
    operationIdHash: auditId('operation', 'historical'), actorIdHash: auditId('actor', identity.actorId), projectIdHash: auditId('project', identity.projectId), sessionIdHash: auditId('session', identity.sessionId), taskIdHash: auditId('task', identity.taskId), capabilityIdHash: cap, capabilityChainIdHashes: [cap], capabilityChainDigest: D, snapshotDigest: D, checkpoint: 'runtime' as const, tool: 'fs' as const, operation: 'file_write' as const, effect: 'file_create' as const, state: 'ALLOW' as const, reason: 'allowed' as const, matchedRuleIdHashes: [], parameterDigest: D, envelopeDigest: D, requestedBytes: 1, authorityExpiresAt: 100,
  };
  try {
    const source = new Journal(old, options.workspace, D);
    source.append('consume', legacyEvidence.operationIdHash, D, 1, legacyEvidence);
    source.append('revoke', cap, '', 2); source.close();
    const lines = fs.readFileSync(old, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const valid = new ManagedJournal({ ...options, legacyJournalPaths: [old] });
    assert.equal(valid.hasOperation(legacyEvidence.operationIdHash), true); valid.close();
    const cases: Array<[string, unknown[]]> = [
      ['missing-pin', []],
      ['first-consume', [{ ...lines[1], seq: 1 }]],
      ['first-revoke', [{ ...lines[2], seq: 1 }]],
      ['foreign-pin', [{ ...lines[0], id: 'b'.repeat(64) }, lines[1], lines[2]]],
    ];
    for (const [name, entries] of cases) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), { mode: 0o600 });
      assert.throws(() => new ManagedJournal({ ...options, journalPath: path.join(dir, `new-${name}`), legacyJournalPaths: [file] }), name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recovery rejects tampered facts, request binding, receipt and result ordering', () => {
  const { dir, options } = fixture();
  try {
    const j = new ManagedJournal(options);
    const reviewToken = j.reserveReview(ev('binding', 'AUTO_REVIEW'), D, 90, limits, 1);
    j.recordReview(reviewToken, 'approved', review, 2);
    const executionToken = j.consumeReviewed(reviewToken, 3);
    j.recordResult(executionToken, 'succeeded', 4); j.close();
    const original = fs.readFileSync(options.journalPath, 'utf8');
    const lines = original.trimEnd().split('\n').map(line => JSON.parse(line));
    const cases: Array<(entries: any[]) => void> = [
      x => { x[2].data.facts.risk = 0.2; },
      x => { x[2].data.facts.requestDigest = `sha256:${'b'.repeat(64)}`; x[2].data.facts.factsDigest = managedReviewFactsDigest(x[2].data.facts); },
      x => { x[2].receipt = `sha256:${'b'.repeat(64)}`; },
      x => { x[4].id = 'b'.repeat(64); },
      x => { x.splice(3, 1); x[3].seq = 4; },
    ];
    for (const mutate of cases) {
      const changed = structuredClone(lines); mutate(changed);
      fs.writeFileSync(options.journalPath, changed.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      assert.throws(() => new ManagedJournal(options));
    }
    fs.writeFileSync(options.journalPath, original);
    const recovered = new ManagedJournal(options);
    assert.throws(() => recovered.recordResult(executionToken, 'failed', 5));
    recovered.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clock rollback poisons lock; stopped and expired reviews cannot be consumed', () => {
  const { dir, options } = fixture();
  try {
    const j = new ManagedJournal(options);
    const stopped = j.reserveReview(ev('stopped-review', 'AUTO_REVIEW'), D, 90, limits, 1);
    j.recordReview(stopped, 'stopped', null, 2);
    assert.throws(() => j.consumeReviewed(stopped, 3));
    const expired = j.reserveReview(ev('expired-review', 'AUTO_REVIEW'), D, 5, limits, 3);
    assert.throws(() => j.recordReview(expired, 'approved', review, 5));
    j.recordReview(expired, 'stopped', null, 5);
    assert.throws(() => j.consume(ev('rollback'), limits, 4));
    assert.throws(() => j.consume(ev('later'), limits, 6));
    j.close();
    assert.throws(() => new ManagedJournal(options));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('effect lineage is bound, unique, and restored without granting authority', () => {
  const { dir, options } = fixture();
  try {
    const journal = new ManagedJournal(options);
    const parent = ev('parent-shell');
    const child = { ...ev('child'), parentOperationHash: parent.operationHash, effectIndex: 0 };
    const draft = { ...ev('old-draft') } as Record<string, unknown>;
    delete draft.parentOperationHash; delete draft.effectIndex;
    assert.throws(() => journal.consume(draft as unknown as ManagedJournalEvidence, limits, 1));
    assert.throws(() => journal.consume(child, limits, 1));
    const parentToken = journal.consume(parent, limits, 1);
    journal.recordResult(parentToken, 'succeeded', 2);
    for (const bad of [
      { ...ev('missing-index'), parentOperationHash: parent.operationHash },
      { ...ev('missing-parent'), effectIndex: 0 },
      { ...ev('bad-index'), parentOperationHash: parent.operationHash, effectIndex: -1 },
      { ...ev('bad-hash'), parentOperationHash: 'not-a-hash', effectIndex: 1 },
    ]) assert.throws(() => journal.consume(bad, limits, 3));
    const childToken = journal.consume(child, limits, 3);
    journal.recordResult(childToken, 'succeeded', 4);
    assert.throws(() => journal.consume({ ...ev('other-child'), parentOperationHash: parent.operationHash, effectIndex: 0 }, limits, 5));
    journal.close();
    const original = fs.readFileSync(options.journalPath, 'utf8');
    const entries = original.trimEnd().split('\n').map(line => JSON.parse(line));
    const childRecord = entries.find(entry => entry.kind === 'consume' && entry.id === child.operationHash);
    childRecord.data.evidence.effectIndex = 1;
    fs.writeFileSync(options.journalPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    assert.throws(() => new ManagedJournal(options));
    fs.writeFileSync(options.journalPath, original);
    const reopened = new ManagedJournal(options);
    assert.equal(reopened.hasOperation(child.operationHash), true);
    assert.throws(() => reopened.recordResult(childToken, 'failed', 5));
    assert.throws(() => reopened.consume({ ...ev('other-child'), parentOperationHash: parent.operationHash, effectIndex: 0 }, limits, 5));
    reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
