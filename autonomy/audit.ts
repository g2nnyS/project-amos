import { createHash } from 'node:crypto';
import { boundedCopy, deepFreeze, digest, record } from '../activation/json.ts';
import { AUTHORIZATION_REASONS, AutonomyError, ENVELOPE_DIGEST_DOMAIN, MAX_FILE_CONTENT_BYTES } from './contracts.ts';
import type { ActionEnvelope, AuthorizationAuditEvidence, AuthorizationDecision, AuthorizationState } from './contracts.ts';

const hashPattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const keys = ['format','formatVersion','operationIdHash','actorIdHash','projectIdHash','sessionIdHash','taskIdHash','capabilityIdHash','capabilityChainIdHashes','capabilityChainDigest','snapshotDigest','checkpoint','tool','operation','effect','state','reason','matchedRuleIdHashes','parameterDigest','envelopeDigest','requestedBytes','authorityExpiresAt'];
const reasons: Record<AuthorizationState, readonly string[]> = {
  ALLOW: ['allowed'], AUTO_REVIEW: ['review_required'],
  DENY: ['malformed_input','identity_mismatch','snapshot_mismatch','capability_missing','capability_invalid','capability_revoked','capability_expired','capability_not_yet_valid','scope_denied','budget_exceeded','policy_denied','policy_error','unsupported_action','duplicate_operation'],
  DEFER: ['unsupported_precondition','checkpoint_unavailable','policy_error','review_not_preauthorized','unsupported_action','stale_envelope','audit_unavailable','executor_unavailable','stopped'],
};
export function auditId(domain: string, value: string): string {
  return createHash('sha256').update(`amos-audit-id-v1\0${domain}\0${value}`).digest('hex');
}
const hashes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 1024 && v.every((x) => typeof x === 'string' && hashPattern.test(x)) && new Set(v).size === v.length;
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/** Validate copied inert evidence, never interpret it as a permit. */
export function validateAuditEvidence(input: unknown): AuthorizationAuditEvidence {
  try {
    const e = record(boundedCopy(input), keys);
    if (e.format !== 'amos-authorization-evidence' || e.formatVersion !== 1 || e.checkpoint !== 'runtime' || e.tool !== 'fs' || e.operation !== 'file_write' || e.effect !== 'file_create') throw 0;
    for (const k of ['operationIdHash','actorIdHash','projectIdHash','sessionIdHash','taskIdHash','capabilityIdHash']) if (typeof e[k] !== 'string' || !hashPattern.test(e[k] as string)) throw 0;
    for (const k of ['snapshotDigest','parameterDigest','envelopeDigest']) if (typeof e[k] !== 'string' || !digestPattern.test(e[k] as string)) throw 0;
    if (!hashes(e.capabilityChainIdHashes) || !hashes(e.matchedRuleIdHashes) || (e.capabilityChainIdHashes.length > 0 && e.capabilityChainIdHashes[0] !== e.capabilityIdHash)) throw 0;
    if (typeof e.state !== 'string' || !Object.hasOwn(reasons, e.state) || typeof e.reason !== 'string' || !(AUTHORIZATION_REASONS as readonly string[]).includes(e.reason) || !reasons[e.state as AuthorizationState].includes(e.reason)) throw 0;
    if (!integer(e.requestedBytes) || e.requestedBytes > MAX_FILE_CONTENT_BYTES) throw 0;
    const bound = e.state === 'ALLOW' || e.state === 'AUTO_REVIEW';
    if (bound ? (typeof e.capabilityChainDigest !== 'string' || !digestPattern.test(e.capabilityChainDigest) || !integer(e.authorityExpiresAt) || e.capabilityChainIdHashes.length === 0) : (e.capabilityChainDigest !== null || e.authorityExpiresAt !== null)) throw 0;
    return deepFreeze(e) as unknown as AuthorizationAuditEvidence;
  } catch { throw new AutonomyError(); }
}

export function buildAuditEvidence(envelope: ActionEnvelope, decision: AuthorizationDecision): AuthorizationAuditEvidence {
  try {
    const e = boundedCopy(envelope) as unknown as ActionEnvelope;
    const d = boundedCopy(decision) as unknown as AuthorizationDecision;
    if (d.operationId !== e.operationId || !Array.isArray(d.capabilityChainIds) || !Array.isArray(d.matchedRuleIds) || d.capabilityChainIds.some(x => typeof x !== 'string' || !x) || d.matchedRuleIds.some(x => typeof x !== 'string' || !x)) throw 0;
    const envelopeDigest = digest(ENVELOPE_DIGEST_DOMAIN, e);
    const bytes = Buffer.byteLength(e.parameters.content, 'utf8');
    if (d.binding && (d.binding.envelopeDigest !== envelopeDigest || d.binding.snapshotDigest !== e.context.snapshotDigest || d.binding.authorizedBytes !== bytes)) throw 0;
    if ((d.state === 'ALLOW' || d.state === 'AUTO_REVIEW') !== (d.binding !== null)) throw 0;
    return validateAuditEvidence({
      format: 'amos-authorization-evidence', formatVersion: 1,
      operationIdHash: auditId('operation', e.operationId), actorIdHash: auditId('actor', e.context.actorId), projectIdHash: auditId('project', e.context.projectId), sessionIdHash: auditId('session', e.context.sessionId), taskIdHash: auditId('task', e.context.taskId), capabilityIdHash: auditId('capability', e.capabilityId),
      capabilityChainIdHashes: d.capabilityChainIds.map(x => auditId('capability', x)), capabilityChainDigest: d.binding?.capabilityChainDigest ?? null,
      snapshotDigest: e.context.snapshotDigest, checkpoint: e.checkpoint, tool: e.action.tool, operation: e.action.operation, effect: e.parameters.effect,
      state: d.state, reason: d.reason, matchedRuleIdHashes: d.matchedRuleIds.map(x => auditId('rule', x)), parameterDigest: digest('amos-action-parameters-v1', e.parameters), envelopeDigest,
      requestedBytes: bytes, authorityExpiresAt: d.binding?.notAfter ?? null,
    });
  } catch { throw new AutonomyError(); }
}
