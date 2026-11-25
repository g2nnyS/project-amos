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
    const evidence = record(boundedCopy(input), keys);
    if (evidence.format !== 'amos-authorization-evidence' || evidence.formatVersion !== 1 || evidence.checkpoint !== 'runtime' || evidence.tool !== 'fs' || evidence.operation !== 'file_write' || evidence.effect !== 'file_create') throw 0;
    for (const k of ['operationIdHash','actorIdHash','projectIdHash','sessionIdHash','taskIdHash','capabilityIdHash']) if (typeof evidence[k] !== 'string' || !hashPattern.test(evidence[k] as string)) throw 0;
    for (const k of ['snapshotDigest','parameterDigest','envelopeDigest']) if (typeof evidence[k] !== 'string' || !digestPattern.test(evidence[k] as string)) throw 0;
    if (!hashes(evidence.capabilityChainIdHashes) || !hashes(evidence.matchedRuleIdHashes) || (evidence.capabilityChainIdHashes.length > 0 && evidence.capabilityChainIdHashes[0] !== evidence.capabilityIdHash)) throw 0;
    if (typeof evidence.state !== 'string' || !Object.hasOwn(reasons, evidence.state) || typeof evidence.reason !== 'string' || !(AUTHORIZATION_REASONS as readonly string[]).includes(evidence.reason) || !reasons[evidence.state as AuthorizationState].includes(evidence.reason)) throw 0;
    if (!integer(evidence.requestedBytes) || evidence.requestedBytes > MAX_FILE_CONTENT_BYTES) throw 0;
    const bound = evidence.state === 'ALLOW' || evidence.state === 'AUTO_REVIEW';
    if (bound ? (typeof evidence.capabilityChainDigest !== 'string' || !digestPattern.test(evidence.capabilityChainDigest) || !integer(evidence.authorityExpiresAt) || evidence.capabilityChainIdHashes.length === 0) : (evidence.capabilityChainDigest !== null || evidence.authorityExpiresAt !== null)) throw 0;
    return deepFreeze(evidence) as unknown as AuthorizationAuditEvidence;
  } catch { throw new AutonomyError(); }
}

export function buildAuditEvidence(envelope: ActionEnvelope, decision: AuthorizationDecision): AuthorizationAuditEvidence {
  try {
    const envelopeCopy = boundedCopy(envelope) as unknown as ActionEnvelope;
    const decisionCopy = boundedCopy(decision) as unknown as AuthorizationDecision;
    if (decisionCopy.operationId !== envelopeCopy.operationId || !Array.isArray(decisionCopy.capabilityChainIds) || !Array.isArray(decisionCopy.matchedRuleIds) || decisionCopy.capabilityChainIds.some(x => typeof x !== 'string' || !x) || decisionCopy.matchedRuleIds.some(x => typeof x !== 'string' || !x)) throw 0;
    const envelopeDigest = digest(ENVELOPE_DIGEST_DOMAIN, envelopeCopy);
    const bytes = Buffer.byteLength(envelopeCopy.parameters.content, 'utf8');
    if (decisionCopy.binding && (decisionCopy.binding.envelopeDigest !== envelopeDigest || decisionCopy.binding.snapshotDigest !== envelopeCopy.context.snapshotDigest || decisionCopy.binding.authorizedBytes !== bytes)) throw 0;
    if ((decisionCopy.state === 'ALLOW' || decisionCopy.state === 'AUTO_REVIEW') !== (decisionCopy.binding !== null)) throw 0;
    return validateAuditEvidence({
      format: 'amos-authorization-evidence', formatVersion: 1,
      operationIdHash: auditId('operation', envelopeCopy.operationId), actorIdHash: auditId('actor', envelopeCopy.context.actorId), projectIdHash: auditId('project', envelopeCopy.context.projectId), sessionIdHash: auditId('session', envelopeCopy.context.sessionId), taskIdHash: auditId('task', envelopeCopy.context.taskId), capabilityIdHash: auditId('capability', envelopeCopy.capabilityId),
      capabilityChainIdHashes: decisionCopy.capabilityChainIds.map(x => auditId('capability', x)), capabilityChainDigest: decisionCopy.binding?.capabilityChainDigest ?? null,
      snapshotDigest: envelopeCopy.context.snapshotDigest, checkpoint: envelopeCopy.checkpoint, tool: envelopeCopy.action.tool, operation: envelopeCopy.action.operation, effect: envelopeCopy.parameters.effect,
      state: decisionCopy.state, reason: decisionCopy.reason, matchedRuleIdHashes: decisionCopy.matchedRuleIds.map(x => auditId('rule', x)), parameterDigest: digest('amos-action-parameters-v1', envelopeCopy.parameters), envelopeDigest,
      requestedBytes: bytes, authorityExpiresAt: decisionCopy.binding?.notAfter ?? null,
    });
  } catch { throw new AutonomyError(); }
}
