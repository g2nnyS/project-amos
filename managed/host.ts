import { randomUUID } from 'node:crypto';
import { boundedCopy, canonicalJson, deepFreeze, digest, record } from '../activation/json.ts';
import { createManagedAuthorizer } from './authorization.ts';
import { ManagedError, MANAGED_MAX_BYTES } from './contracts.ts';
import type { ManagedCapability, ManagedDecision, ManagedEnvelope, ManagedExecution, ManagedFileEffect, ManagedHost, ManagedHostOptions, ManagedResult, PreparedManagedOperation } from './contracts.ts';
import { managedReviewRequestDigest } from './digests.ts';
import { ManagedJournal, managedJournalId, managedReviewFactsDigest } from './journal.ts';
import type { ManagedJournalEvidence, ManagedJournalToken, ManagedJournalReviewFacts } from './journal.ts';
import { createManagedReviewGate } from './review-policy.ts';

const failedCodes = new Set(['cancelled', 'unsupported', 'unsupported_command', 'unsupported_target', 'conflict', 'access_denied', 'invalid_encoding', 'limit_exceeded', 'executor_failed', 'sandbox_unavailable', 'precondition_failed']);
const unknownExecution: ManagedExecution = Object.freeze({ status: 'outcome_unknown', code: 'outcome_unknown' });
function safeExecution(input: unknown, env: ManagedEnvelope, cap: ManagedCapability): ManagedExecution {
  try {
    const value = boundedCopy(input);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownExecution;
    const r = value as Record<string, unknown>;
    if (r.status === 'outcome_unknown') {
      record(r, ['status', 'code']);
      return unknownExecution;
    }
    if (r.status === 'failed') {
      record(r, ['status', 'code']);
      return typeof r.code === 'string' && failedCodes.has(r.code) ? deepFreeze(r) as unknown as ManagedExecution : unknownExecution;
    }
    if (r.status !== 'succeeded') return unknownExecution;
    const tool = env.input.tool;
    const expected = tool === 'edit' ? 'write_complete' : `${tool}_complete`;
    if (r.code !== expected) return unknownExecution;
    if (tool === 'write' || tool === 'edit') {
      record(r, ['status', 'code', 'bytesWritten']);
      if (!Number.isSafeInteger(r.bytesWritten) || (r.bytesWritten as number) < 0 || (r.bytesWritten as number) > cap.maxWriteBytes || (r.bytesWritten as number) > MANAGED_MAX_BYTES) return unknownExecution;
      if (tool === 'write' && r.bytesWritten !== Buffer.byteLength(env.input.content)) return unknownExecution;
    } else if (tool === 'read' || tool === 'list' || tool === 'search') {
      record(r, ['status', 'code', 'output', 'bytesRead']);
      if (typeof r.output !== 'string' || Buffer.byteLength(r.output) > Math.min(cap.maxReadBytes, MANAGED_MAX_BYTES) || !Number.isSafeInteger(r.bytesRead) || (r.bytesRead as number) < 0 || (r.bytesRead as number) > Math.min(cap.maxReadBytes, MANAGED_MAX_BYTES)) return unknownExecution;
      if (tool === 'read' && Buffer.byteLength(r.output) !== r.bytesRead) return unknownExecution;
    } else if (tool === 'shell') {
      record(r, Object.hasOwn(r, 'output') ? ['status', 'code', 'output', 'effects'] : ['status', 'code', 'effects']);
      if (r.output !== undefined && (typeof r.output !== 'string' || Buffer.byteLength(r.output) > Math.min(cap.maxReadBytes, MANAGED_MAX_BYTES))) return unknownExecution;
      if (!Array.isArray(r.effects) || r.effects.length > Math.min(cap.maxShellFiles, 1024)) return unknownExecution;
      let total = 0;
      for (const value of r.effects) {
        const effect = record(value, ['input', 'before']);
        if (!effect.input || typeof effect.input !== 'object' || Array.isArray(effect.input)) return unknownExecution;
        const item = effect.input as Record<string, unknown>;
        if (!['write', 'mkdir', 'remove'].includes(item.tool as string)) return unknownExecution;
        record(item, item.tool === 'write' ? ['tool', 'path', 'content'] : ['tool', 'path']);
        if (typeof item.path !== 'string' || !item.path || item.path.includes('\0')) return unknownExecution;
        if (item.tool === 'write') {
          if (typeof item.content !== 'string' || item.content.includes('\0')) return unknownExecution;
          total += Buffer.byteLength(item.content);
        }
        if (!effect.before || typeof effect.before !== 'object' || Array.isArray(effect.before)) return unknownExecution;
        const before = effect.before as Record<string, unknown>;
        if (before.kind === 'absent') record(before, ['kind']);
        else if (before.kind === 'file' || before.kind === 'directory') {
          record(before, before.kind === 'file' ? ['kind', 'dev', 'ino', 'contentDigest'] : ['kind', 'dev', 'ino']);
          if (!Number.isSafeInteger(before.dev) || (before.dev as number) < 0 || !Number.isSafeInteger(before.ino) || (before.ino as number) < 0 || (before.kind === 'file' && (typeof before.contentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(before.contentDigest)))) return unknownExecution;
        } else return unknownExecution;
      }
      if (total > Math.min(cap.maxWriteBytes, MANAGED_MAX_BYTES)) return unknownExecution;
    } else record(r, ['status', 'code']);
    return deepFreeze(r) as unknown as ManagedExecution;
  } catch { return unknownExecution; }
}
function override(d: ManagedDecision, state: ManagedDecision['state'], reason: string): ManagedDecision {
  return deepFreeze({ ...d, state, reason, notAfter: null });
}
function empty(reason: string): ManagedDecision {
  return deepFreeze({ state: 'DEFER', reason, envelopeDigest: '', capabilityChainDigest: null, capabilityChainIds: [], matchedRuleIds: [], notAfter: null });
}
function stopped(authorization: ManagedDecision, review: ManagedResult['review'] = 'not_required'): ManagedResult {
  return deepFreeze({ authorization, execution: { status: 'not_executed', code: authorization.reason }, review });
}

export function createManagedHost(options: ManagedHostOptions): ManagedHost {
  const core = createManagedAuthorizer({ compiler: options.compiler, snapshot: options.snapshot, expectedSnapshotDigest: options.expectedSnapshotDigest, identity: options.identity, requirement: options.requirement, capabilities: options.capabilities, ...(options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths }) });
  const executor = options.executor;
  if (executor.workspace !== core.workspace) throw new ManagedError();
  const journal = new ManagedJournal({ journalPath: options.journalPath, workspace: core.workspace, snapshotDigest: core.identity.snapshotDigest, identity: core.identity, legacyJournalPaths: options.legacyJournalPaths });
  let gate: ReturnType<typeof createManagedReviewGate> | null = null;
  try {
    if (options.reviewPolicy && options.calibration && options.reviewer) gate = createManagedReviewGate({ policy: options.reviewPolicy, calibration: options.calibration, requirement: options.requirement, workspace: core.workspace });
    if (gate && options.reviewer?.model !== gate.model) gate = null;
  } catch { gate = null; }
  const reviewer = options.reviewer;
  const caps = new Map(core.capabilities.map(c => [c.id, c]));
  const nowFn = options.now ?? Date.now;
  let last = journal.lastTime, closed = false, failed = false;
  let queue: Promise<void> = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const jobs = new Set<PreparedManagedOperation>();
  const clock = () => {
    const n = nowFn();
    if (failed || !Number.isSafeInteger(n) || n < last || n < 0) { failed = true; throw new ManagedError(); }
    last = n; return n;
  };
  const cancelAll = () => {
    for (const controller of controllers) controller.abort();
    for (const job of jobs) { try { job.cancel(); } catch { /* best effort */ } }
  };
  function evaluation(time: number, reviewToken?: ManagedJournalToken, consumed?: readonly string[]) {
    const operationCounts: Record<string, number> = Object.create(null);
    const revokedCapabilityIds: string[] = [];
    for (const cap of core.capabilities) {
      const hash = managedJournalId('capability', cap.id);
      let count = reviewToken ? journal.operationCountExcludingReview(reviewToken, hash) : journal.operationCount(hash);
      if (consumed?.includes(cap.id)) count--;
      operationCounts[cap.id] = count;
      if (journal.isRevoked(hash)) revokedCapabilityIds.push(cap.id);
    }
    return { now: time, revokedCapabilityIds, operationCounts };
  }
  type Lineage = { parentOperationHash: string; effectIndex: number } | null;
  function evidence(env: ManagedEnvelope, d: ManagedDecision, policyDigest: string | null, lineage: Lineage): ManagedJournalEvidence {
    return {
      operationHash: managedJournalId('operation', env.operationId),
      parentOperationHash: lineage?.parentOperationHash ?? null, effectIndex: lineage?.effectIndex ?? null,
      actorHash: managedJournalId('actor', core.identity.actorId), projectHash: managedJournalId('project', core.identity.projectId),
      sessionHash: managedJournalId('session', core.identity.sessionId), taskHash: managedJournalId('task', core.identity.taskId),
      capabilityChainHashes: d.capabilityChainIds.map(id => managedJournalId('capability', id)),
      ruleHashes: d.matchedRuleIds.map(id => managedJournalId('rule', id)), envelopeDigest: d.envelopeDigest,
      capabilityChainDigest: d.capabilityChainDigest, snapshotDigest: core.identity.snapshotDigest,
      requirementDigest: env.requirementDigest, policyDigest, state: d.state, reason: d.reason, notAfter: d.notAfter,
    };
  }
  function limits(d: ManagedDecision): Record<string, number> {
    const result: Record<string, number> = Object.create(null);
    for (const id of d.capabilityChainIds) {
      const cap = caps.get(id); if (!cap) throw new ManagedError();
      result[managedJournalId('capability', id)] = cap.maxOperations;
    }
    return result;
  }
  function persist(env: ManagedEnvelope, d: ManagedDecision, lineage: Lineage): ManagedResult {
    try { journal.recordDecision(evidence(env, d, null, lineage), clock()); return stopped(d); }
    catch { return stopped(override(d, 'DEFER', 'audit_unavailable')); }
  }
  const matches = (a: ManagedDecision, b: ManagedDecision) => canonicalJson(a) === canonicalJson(b);
  async function review(env: ManagedEnvelope, decision: ManagedDecision, lineage: Lineage): Promise<{ token: ManagedJournalToken; deadline: number } | ManagedResult> {
    const cap = caps.get(env.capabilityId);
    if (!gate || !reviewer || !cap) return persist(env, override(decision, 'DEFER', 'review_unavailable'), lineage);
    const req = gate.request(env, decision, cap, randomUUID(), clock());
    if (!req) return persist(env, override(decision, 'DEFER', 'review_unavailable'), lineage);
    let token: ManagedJournalToken;
    try { token = journal.reserveReview(evidence(env, decision, gate.policyDigest, lineage), managedReviewRequestDigest(req), req.deadline, limits(decision), clock()); }
    catch { return stopped(override(decision, 'DEFER', journal.hasOperation(managedJournalId('operation', env.operationId)) ? 'duplicate_operation' : 'audit_unavailable'), 'stopped'); }
    const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let facts: unknown = null;
    try {
      const timeout = Math.max(0, req.deadline - clock());
      const interrupted = new Promise<null>(resolve => {
        abortListener = () => resolve(null);
        controller.signal.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
      });
      const work = Promise.resolve().then(() => reviewer.review(req, controller.signal)).catch(() => null);
      facts = await Promise.race([work, interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      controllers.delete(controller);
    }
    try {
      const time = clock();
      const fresh = core.authorize(env, evaluation(time, token));
      const approved = !closed && !journal.stopped && !controller.signal.aborted && time < req.deadline && matches(fresh, decision) && gate.approve(req, facts as never, time);
      let saved: ManagedJournalReviewFacts | null = null;
      try {
        const f = record(boundedCopy(facts), ['format', 'version', 'requestDigest', 'model', 'requirementMatch', 'withinScope', 'risk', 'confidence']);
        if (f.format === 'amos-managed-review-facts' && f.version === 1 && f.requestDigest === managedReviewRequestDigest(req) && f.model === gate.model && ['match', 'mismatch', 'unclear'].includes(f.requirementMatch as string) && typeof f.withinScope === 'boolean' && typeof f.risk === 'number' && f.risk >= 0 && f.risk <= 1 && typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1) {
          const projection = { requestDigest: managedReviewRequestDigest(req), modelHash: managedJournalId('model', gate.model), requirementMatch: f.requirementMatch as 'match' | 'mismatch' | 'unclear', withinScope: f.withinScope, risk: f.risk, confidence: f.confidence };
          saved = { ...projection, factsDigest: managedReviewFactsDigest(projection) };
        }
      } catch { /* Malformed facts are stopped without raw payload. */ }
      journal.recordReview(token, approved ? 'approved' : 'stopped', saved, time);
      return approved ? { token, deadline: req.deadline } : stopped(override(decision, 'DEFER', 'review_stopped'), 'stopped');
    } catch { return stopped(override(decision, 'DEFER', 'audit_unavailable'), 'stopped'); }
  }
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn);
    queue = result.then(() => {}, () => {});
    return result;
  }
  async function processRequest(raw: unknown, alreadyQueued: boolean, lineage: Lineage = null): Promise<ManagedResult> {
    let env: ManagedEnvelope;
    try { if (closed || journal.stopped) return stopped(empty('stopped')); env = core.createEnvelope(raw, clock()); }
    catch { return stopped(empty('malformed_input')); }
    const opHash = managedJournalId('operation', env.operationId);
    if (journal.hasOperation(opHash)) return stopped(empty('duplicate_operation'));
    let initial: ManagedDecision;
    try { initial = core.authorize(env, evaluation(clock())); } catch { return stopped(empty('audit_unavailable')); }
    if (initial.state === 'DENY' || initial.state === 'DEFER') return persist(env, initial, lineage);
    let reviewToken: ManagedJournalToken | undefined;
    let reviewDeadline: number | undefined;
    if (initial.state === 'AUTO_REVIEW') {
      const outcome = await review(env, initial, lineage);
      if ('authorization' in outcome) return outcome;
      reviewToken = outcome.token; reviewDeadline = outcome.deadline;
    }
    const commit = async (): Promise<ManagedResult> => {
      if (closed || journal.stopped) return stopped(override(initial, 'DEFER', 'stopped'));
      let job: PreparedManagedOperation | undefined;
      let executionToken: ManagedJournalToken | undefined;
      let performed = false;
      try {
        if (!reviewToken && journal.hasOperation(opHash)) return stopped(override(initial, 'DENY', 'duplicate_operation'));
        let ev = evaluation(clock(), reviewToken);
        if (!matches(core.authorize(env, ev), initial) || (reviewDeadline !== undefined && ev.now >= reviewDeadline)) return stopped(override(initial, 'DEFER', 'stale_envelope'));
        job = await executor.prepare(env, core.guards(env, ev)); jobs.add(job);
        ev = evaluation(clock(), reviewToken);
        if (closed || journal.stopped || job.envelopeDigest !== initial.envelopeDigest || !matches(core.authorize(env, ev), initial) || (reviewDeadline !== undefined && ev.now >= reviewDeadline)) { job.cancel(); return stopped(override(initial, 'DEFER', 'stale_envelope')); }
        executionToken = reviewToken ? journal.consumeReviewed(reviewToken, clock()) : journal.consume(evidence(env, initial, null, lineage), limits(initial), clock());
        ev = evaluation(clock(), undefined, initial.capabilityChainIds);
        if (closed || journal.stopped || !matches(core.authorize(env, ev), initial) || (reviewDeadline !== undefined && ev.now >= reviewDeadline)) {
          job.cancel(); journal.recordResult(executionToken, 'not_executed', clock()); return stopped(override(initial, 'DEFER', 'stale_envelope'));
        }
        const controller = new AbortController(); controllers.add(controller);
        let execution: ManagedExecution;
        try { performed = true; execution = safeExecution(await job.perform(controller.signal), env, caps.get(env.capabilityId)!); } catch { execution = unknownExecution; }
        finally { controllers.delete(controller); }
        journal.recordResult(executionToken, execution.status, clock());
        const authorization = reviewToken ? deepFreeze({ ...initial, state: 'ALLOW' as const, reason: 'review_approved' }) : initial;
        if (env.input.tool === 'shell' && execution.status === 'succeeded') {
          const effects = execution.effects;
          const cap = caps.get(env.capabilityId)!;
          if (!effects || effects.length > cap.maxShellFiles) return { authorization, execution: unknownExecution, review: reviewToken ? 'approved' : 'not_required', committedEffects: 0 };
          let committed = 0;
          for (let index = 0; index < effects.length; index++) {
            const effect = effects[index] as ManagedFileEffect;
            try {
              const e = record(boundedCopy(effect), ['input', 'before']);
              if (!e.input || typeof e.input !== 'object' || !['write', 'mkdir', 'remove'].includes((e.input as { tool: string }).tool)) throw new ManagedError();
              const derived = digest('amos-managed-shell-effect-v1', { parent: env.operationId, index, effect: e });
              const result = await processRequest({ format: 'amos-managed-request', version: 1, operationId: derived, capabilityId: env.capabilityId, input: e.input, before: e.before }, true, { parentOperationHash: opHash, effectIndex: index });
              if (result.execution.status !== 'succeeded') return { authorization, execution: { status: result.execution.status === 'outcome_unknown' ? 'outcome_unknown' : 'failed', code: result.execution.status === 'outcome_unknown' ? 'outcome_unknown' : 'executor_failed' }, review: reviewToken ? 'approved' : 'not_required', committedEffects: committed };
              committed++;
            } catch { return { authorization, execution: { status: 'failed', code: 'executor_failed' }, review: reviewToken ? 'approved' : 'not_required', committedEffects: committed }; }
          }
          const { effects: _omitted, ...clean } = execution;
          return { authorization, execution: clean, review: reviewToken ? 'approved' : 'not_required', committedEffects: committed };
        }
        const { effects: _omitted, ...clean } = execution;
        return { authorization, execution: clean, review: reviewToken ? 'approved' : 'not_required' };
      } catch {
        try { job?.cancel(); } catch { /* best effort */ }
        if (performed) return { authorization: initial, execution: unknownExecution, review: reviewToken ? 'approved' : 'not_required' };
        return stopped(override(initial, 'DEFER', 'audit_unavailable'));
      } finally { if (job) jobs.delete(job); }
    };
    return alreadyQueued ? commit() : enqueue(commit);
  }
  return {
    execute(request) {
      const task = processRequest(request, false).catch(() => stopped(empty('audit_unavailable')));
      active.add(task); void task.finally(() => active.delete(task)); return task;
    },
    revoke(id) {
      if (closed || !caps.has(id)) throw new ManagedError();
      try { const hash = managedJournalId('capability', id); if (!journal.isRevoked(hash)) journal.revoke(hash, clock()); }
      finally { cancelAll(); }
    },
    stop() {
      if (closed) throw new ManagedError();
      try { if (!journal.stopped) journal.stop(clock()); } finally { cancelAll(); }
    },
    async close() {
      if (closed) return; closed = true; cancelAll();
      const closing = Promise.resolve().then(() => executor.close());
      try { await Promise.allSettled([...active, closing]); await queue; await closing; }
      finally { journal.close(); }
    },
  };
}
