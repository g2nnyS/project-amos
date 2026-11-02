import path from 'node:path';
import { boundedCopy, deepFreeze, record } from '../activation/json.ts';
import { AutonomyError } from './contracts.ts';
import type { ActionEnvelope, AuthorizationDecision, AuthorizationReason, AuthorizationState, FileExecutionResult, HostExecutionResult, PolicyBoundHost, PolicyBoundHostOptions, PreparedFileExecution, TrustedSessionContext } from './contracts.ts';
import { Journal } from './journal.ts';
import { buildAuditEvidence } from './audit.ts';
import { assertProtectedAssets } from './protected-assets.ts';

const decision = (state: AuthorizationState, reason: AuthorizationReason, operationId: string | null = null, source?: AuthorizationDecision): AuthorizationDecision => ({ state, reason, operationId, matchedRuleIds: source?.matchedRuleIds ?? [], capabilityChainIds: source?.capabilityChainIds ?? [], binding: null });
const unexecuted = (authorization: AuthorizationDecision): HostExecutionResult => ({ authorization, execution: { status: 'not_executed', code: authorization.reason } });
const unknown: FileExecutionResult = Object.freeze({ status: 'outcome_unknown', code: 'outcome_unknown' });
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function safeResult(value: unknown): FileExecutionResult {
  try {
    const copy = boundedCopy(value);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) return unknown;
    const obj = copy as Record<string, unknown>;
    const keys = Object.keys(obj).sort().join(',');
    if (keys !== 'code,status' && keys !== 'bytesWritten,code,status') return unknown;
    if (obj.status === 'outcome_unknown' && obj.code === 'outcome_unknown' && keys === 'code,status') return unknown;
    if (obj.status === 'succeeded' && obj.code === 'write_complete' && (obj.bytesWritten === undefined || (Number.isSafeInteger(obj.bytesWritten) && (obj.bytesWritten as number) >= 0))) {
      return obj.bytesWritten === undefined ? { status: 'succeeded', code: 'write_complete' } : { status: 'succeeded', code: 'write_complete', bytesWritten: obj.bytesWritten as number };
    }
    if (obj.status === 'failed' && keys === 'code,status' && ['target_exists', 'unsupported_target', 'sandbox_unavailable', 'executor_failed', 'cancelled'].includes(obj.code as string)) return { status: 'failed', code: obj.code as 'target_exists' | 'unsupported_target' | 'sandbox_unavailable' | 'executor_failed' | 'cancelled' };
  } catch { /* Do not expose executor-owned data. */ }
  return unknown;
}

/** In-process trusted-parent coordination; not an IPC identity or OS boundary. */
export function createPolicyBoundHost(options: PolicyBoundHostOptions): PolicyBoundHost {
  const { core, executor, now = Date.now } = options;
  if (!path.isAbsolute(core.workspace) || path.resolve(core.workspace) !== core.workspace || executor.workspace !== core.workspace) throw new AutonomyError();
  assertProtectedAssets(core.workspace, options.journalPath, options.protectedPaths);
  const journal = new Journal(options.journalPath, core.workspace, core.snapshotDigest);
  const sessions = new WeakMap<object, TrustedSessionContext>();
  const jobs = new Set<PreparedFileExecution>();
  const inflight = new Set<Promise<unknown>>();
  let closed = false;
  let clockFailed = false;
  let lastTime = journal.lastTime;
  const clock = (): number => {
    let n: number;
    try { n = now(); } catch { clockFailed = true; journal.poison(); throw new AutonomyError(); }
    if (clockFailed || !Number.isSafeInteger(n) || n < lastTime || n < 0) { clockFailed = true; journal.poison(); throw new AutonomyError(); }
    lastTime = n; return n;
  };
  const revoked = () => core.capabilityIds.filter((id) => journal.revoked.has(Journal.capabilityId(id)));
  const cancel = (job: PreparedFileExecution) => { try { job.cancel(); } catch { /* best effort */ } };
  const persistDecision = (d: AuthorizationDecision, envelope: ActionEnvelope): HostExecutionResult => {
    const operationId = envelope.operationId;
    try {
      const id = Journal.id(operationId);
      if (journal.consumed.has(id)) return unexecuted(decision('DENY', 'duplicate_operation', operationId));
      const evidence = buildAuditEvidence(envelope, d);
      journal.append('decision', id, d.state, clock(), evidence);
      return unexecuted(d);
    } catch { return unexecuted(decision('DEFER', 'audit_unavailable', operationId)); }
  };
  return {
    openSession(input) {
      if (closed || journal.stopped) throw new AutonomyError();
      try {
        const copy = record(boundedCopy(input), ['actorId', 'projectId', 'sessionId', 'snapshotDigest', 'taskId']);
        if (Object.values(copy).some((v) => typeof v !== 'string' || !v) || copy.projectId !== core.projectId || copy.snapshotDigest !== core.snapshotDigest) throw new AutonomyError();
        const session = Object.freeze({});
        sessions.set(session, Object.freeze(copy) as unknown as TrustedSessionContext);
        return session;
      } catch { throw new AutonomyError(); }
    },
    async execute(session, request) {
       const context = session && typeof session === 'object' ? sessions.get(session) : undefined;
       if (!context) return unexecuted(decision('DENY', 'identity_mismatch'));
       if (closed) return unexecuted(decision('DEFER', 'stopped'));
      let issuedAt: number;
      try { issuedAt = clock(); } catch { return unexecuted(decision('DEFER', 'audit_unavailable')); }
      let envelope;
      try { envelope = deepFreeze(boundedCopy(core.createEnvelope(context, request, issuedAt))) as unknown as ActionEnvelope; }
      catch { return unexecuted(decision('DENY', 'malformed_input')); }
      const operationId = envelope.operationId;
      const id = Journal.id(operationId);
      if (journal.consumed.has(id)) return unexecuted(decision('DENY', 'duplicate_operation', operationId));
      if (closed || journal.stopped) return persistDecision(decision('DEFER', 'stopped', operationId), envelope);
      let initial: AuthorizationDecision;
      try { initial = core.authorize(envelope, { now: clock(), revokedCapabilityIds: revoked() }); }
      catch { return persistDecision(decision('DEFER', 'policy_error', operationId), envelope); }
      if (initial.state !== 'ALLOW') return persistDecision(initial, envelope);
      if (!initial.binding || initial.operationId !== operationId) return persistDecision(decision('DEFER', 'policy_error', operationId), envelope);
      let job: PreparedFileExecution;
      try { job = executor.prepare(envelope); jobs.add(job); }
      catch { return persistDecision(decision('DEFER', 'executor_unavailable', operationId, initial), envelope); }
      let final: AuthorizationDecision;
      try { final = core.authorize(envelope, { now: clock(), revokedCapabilityIds: revoked() }); }
      catch { cancel(job); jobs.delete(job); return persistDecision(decision('DEFER', 'policy_error', operationId, initial), envelope); }
      const binding = final.binding;
      if (closed || journal.stopped || final.state !== 'ALLOW' || !binding || JSON.stringify(binding) !== JSON.stringify(initial.binding) || final.operationId !== operationId || !digestPattern.test(binding.envelopeDigest) || job.envelopeDigest !== binding.envelopeDigest || binding.snapshotDigest !== context.snapshotDigest || lastTime >= binding.notAfter || core.snapshotDigest !== context.snapshotDigest) {
        cancel(job); jobs.delete(job);
        return persistDecision(final.state !== 'ALLOW' ? final : decision('DEFER', closed || journal.stopped ? 'stopped' : 'stale_envelope', operationId, final), envelope);
      }
      if (journal.consumed.has(id)) { cancel(job); jobs.delete(job); return unexecuted(decision('DENY', 'duplicate_operation', operationId)); }
      // Synchronous final check and durable reservation are one parent-process critical section.
      try { journal.append('consume', id, binding.envelopeDigest, lastTime, buildAuditEvidence(envelope, final)); }
      catch { cancel(job); jobs.delete(job); return unexecuted(decision('DEFER', 'audit_unavailable', operationId)); }
      try {
        const after = core.authorize(envelope, { now: clock(), revokedCapabilityIds: revoked() });
        if (closed || journal.stopped || after.state !== 'ALLOW' || !after.binding || lastTime >= binding.notAfter || JSON.stringify(after.binding) !== JSON.stringify(binding)) {
          cancel(job); jobs.delete(job);
          journal.append('result', id, 'not_executed', lastTime);
          return unexecuted(after.state === 'ALLOW' ? decision('DEFER', closed || journal.stopped ? 'stopped' : 'stale_envelope', operationId) : after);
        }
      } catch { cancel(job); jobs.delete(job); return unexecuted(decision('DEFER', 'audit_unavailable', operationId)); }
      let result: FileExecutionResult;
      try {
        const performing = job.perform(); inflight.add(performing);
        try { result = safeResult(await performing); } finally { inflight.delete(performing); }
      } catch { result = unknown; }
      if (result.status === 'succeeded' && result.bytesWritten !== binding.authorizedBytes) result = unknown;
      jobs.delete(job);
      try { journal.append('result', id, result.status, clock()); }
      catch { return { authorization: final, execution: unknown }; }
      return { authorization: final, execution: result };
    },
    revoke(capabilityId) {
      if (closed || typeof capabilityId !== 'string' || !core.capabilityIds.includes(capabilityId)) throw new AutonomyError();
      const id = Journal.capabilityId(capabilityId);
      try { if (!journal.revoked.has(id)) journal.append('revoke', id, '', clock()); }
      catch { journal.poison(); throw new AutonomyError(); }
      finally { for (const job of jobs) cancel(job); }
    },
    stop() {
      if (closed) throw new AutonomyError();
      try { if (!journal.stopped) journal.append('stop', '', '', clock()); }
      catch { journal.poison(); throw new AutonomyError(); }
      finally { for (const job of jobs) cancel(job); }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const job of jobs) cancel(job);
      await Promise.allSettled([...inflight]);
      try { await executor.close(); } finally { journal.close(); }
    },
  };
}
