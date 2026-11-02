import path from 'node:path';
import { boundedCopy, canonicalJson, deepFreeze, digest, list, record, text, uniqueStrings, workspace } from '../activation/json.ts';
import { isRequirementFrame, requirementFrameDigest } from '../decision/requirement.ts';
import { MANAGED_MAX_AGE_MS, MANAGED_MAX_BYTES, MANAGED_REVIEW_QUESTION_VERSION, ManagedError } from './contracts.ts';
import type { ManagedCalibrationEvidence, ManagedCapability, ManagedDecision, ManagedEnvelope, ManagedReviewFacts, ManagedReviewPolicy, ManagedReviewRequest, ManagedTool } from './contracts.ts';
import { managedEnvelopeDigest, managedReviewRequestDigest } from './digests.ts';

const tools = ['read', 'write', 'edit', 'list', 'search', 'mkdir', 'remove', 'shell'];
const policyKeys = ['format', 'version', 'id', 'model', 'questionVersion', 'tools', 'resourceRoots', 'minConfidence', 'maxRisk', 'timeoutMs', 'expiresAt', 'maxAttempts', 'requirementEgress', 'targetEgress', 'minimumCases', 'maximumFalseAllowRate', 'evidenceDigest'];
const evidenceKeys = ['format', 'version', 'model', 'questionVersion', 'policyDigest', 'caseSetDigest', 'cases', 'unsafeCases', 'falseAllows', 'evaluatedAt', 'expiresAt'];
const requestKeys = ['format', 'version', 'attemptId', 'envelopeDigest', 'capabilityChainDigest', 'snapshotDigest', 'requirementDigest', 'policyDigest', 'deadline', 'tool', 'requestedBytes', 'relativeTarget', 'requirementText'];
const factsKeys = ['format', 'version', 'requestDigest', 'model', 'requirementMatch', 'withinScope', 'risk', 'confidence'];
const frameKeys = ['frame_id', 'session_id', 'root_frame_id', 'source', 'actor', 'delegator', 'user_turn_digest', 'egress', 'text', 'declared_scope', 'captured_by', 'captured_at'];
const capabilityKeys = ['id', 'parentId', 'delegatorActorId', 'identity', 'tools', 'resourceRoots', 'validFrom', 'expiresAt', 'delegationDepthRemaining', 'reviewPolicyId', 'maxReadBytes', 'maxWriteBytes', 'maxOperations', 'maxShellFiles'];
const identityKeys = ['actorId', 'projectId', 'sessionId', 'taskId', 'snapshotDigest'];
const decisionKeys = ['state', 'reason', 'envelopeDigest', 'capabilityChainDigest', 'capabilityChainIds', 'matchedRuleIds', 'notAfter'];
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const probability = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const inside = (value: string, root: string) => root === '/' ? value.startsWith('/') : value === root || value.startsWith(root + '/');
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw new Error('invalid_digest');
}
function parsePolicy(value: unknown): ManagedReviewPolicy {
  const p = record(value, policyKeys);
  if (p.format !== 'amos-managed-review-policy' || p.version !== 1 || p.questionVersion !== MANAGED_REVIEW_QUESTION_VERSION || p.maxAttempts !== 1) throw new Error('invalid_policy');
  text(p.id); text(p.model); hash(p.evidenceDigest);
  const selected = uniqueStrings(p.tools); const roots = uniqueStrings(p.resourceRoots);
  if (!selected.length || selected.some(x => !tools.includes(x)) || !roots.length) throw new Error('invalid_policy');
  roots.forEach(workspace);
  if (!probability(p.minConfidence) || !probability(p.maxRisk) || !probability(p.maximumFalseAllowRate) || !integer(p.timeoutMs) || p.timeoutMs < 1 || !integer(p.expiresAt) || !integer(p.minimumCases) || p.minimumCases < 1) throw new Error('invalid_policy');
  if (!['allowed', 'denied'].includes(p.requirementEgress as string) || !['workspace-relative', 'denied'].includes(p.targetEgress as string)) throw new Error('invalid_policy');
  return p as unknown as ManagedReviewPolicy;
}
function policyDigest(policy: ManagedReviewPolicy): string {
  const { evidenceDigest: _ignored, ...content } = policy;
  return digest('amos-managed-review-policy-v1', content);
}
export function managedReviewPolicyDigest(policy: ManagedReviewPolicy): string {
  try { return policyDigest(parsePolicy(boundedCopy(policy))); } catch { throw new ManagedError(); }
}
function parseRequest(value: unknown): ManagedReviewRequest {
  const r = record(value, requestKeys);
  if (r.format !== 'amos-managed-review-request' || r.version !== 1) throw new Error('invalid_request');
  text(r.attemptId);
  for (const key of ['envelopeDigest', 'capabilityChainDigest', 'snapshotDigest', 'requirementDigest', 'policyDigest']) hash(r[key]);
  if (!integer(r.deadline) || !integer(r.requestedBytes) || r.requestedBytes > MANAGED_MAX_BYTES || typeof r.tool !== 'string' || !tools.includes(r.tool)) throw new Error('invalid_request');
  if (r.relativeTarget !== null) {
    if (typeof r.relativeTarget !== 'string' || !r.relativeTarget || r.relativeTarget.startsWith('/') || r.relativeTarget.includes('\0') || path.posix.normalize(r.relativeTarget) !== r.relativeTarget || r.relativeTarget === '..' || r.relativeTarget.startsWith('../')) throw new Error('invalid_request');
  }
  if (r.requirementText !== null && (typeof r.requirementText !== 'string' || !r.requirementText || r.requirementText.includes('\0') || r.requirementText.length > 4096)) throw new Error('invalid_request');
  return r as unknown as ManagedReviewRequest;
}
function parseFacts(value: unknown): ManagedReviewFacts {
  const f = record(value, factsKeys);
  if (f.format !== 'amos-managed-review-facts' || f.version !== 1 || !['match', 'mismatch', 'unclear'].includes(f.requirementMatch as string) || typeof f.withinScope !== 'boolean' || !probability(f.risk) || !probability(f.confidence)) throw new Error('invalid_facts');
  text(f.model); hash(f.requestDigest);
  return f as unknown as ManagedReviewFacts;
}
function passes(p: ManagedReviewPolicy, r: ManagedReviewRequest, f: ManagedReviewFacts): boolean {
  return f.model === p.model && f.requestDigest === managedReviewRequestDigest(r) && f.requirementMatch === 'match' && f.withinScope && f.risk <= p.maxRisk && f.confidence >= p.minConfidence;
}
export interface ManagedCalibrationCase {
  readonly request: ManagedReviewRequest;
  readonly facts: ManagedReviewFacts | null;
  readonly expected: 'allow' | 'stop';
}
export function evaluateManagedCalibration(policy: ManagedReviewPolicy, cases: readonly ManagedCalibrationCase[], evaluatedAt: number, expiresAt: number): ManagedCalibrationEvidence {
  try {
    const p = parsePolicy(boundedCopy(policy));
    if (!integer(evaluatedAt) || !integer(expiresAt) || expiresAt <= evaluatedAt) throw new Error('invalid_time');
    const copied = list(boundedCopy(cases));
    let unsafeCases = 0; let falseAllows = 0;
    const visibleCases = new Set<string>();
    for (const value of copied) {
      const c = record(value, ['request', 'facts', 'expected']);
      if (c.expected !== 'allow' && c.expected !== 'stop') throw new Error('invalid_label');
      const request = parseRequest(c.request);
      if (request.policyDigest !== policyDigest(p)) throw new Error('policy_mismatch');
      if (request.tool === 'shell' || !p.tools.includes(request.tool)
        || p.requirementEgress !== 'allowed' || p.targetEgress !== 'workspace-relative'
        || request.requirementText === null || request.relativeTarget === null) throw new Error('ineligible_case');
      // Distinct nonces or opaque bindings do not create new model-visible cases.
      const visible = canonicalJson({ tool: request.tool, requestedBytes: request.requestedBytes, relativeTarget: request.relativeTarget, requirementText: request.requirementText });
      if (visibleCases.has(visible)) throw new Error('duplicate_case');
      visibleCases.add(visible);
      const facts = c.facts === null ? null : parseFacts(c.facts);
      if (facts && (facts.model !== p.model || facts.requestDigest !== managedReviewRequestDigest(request))) throw new Error('facts_mismatch');
      if (c.expected === 'stop') { unsafeCases++; if (facts && passes(p, request, facts)) falseAllows++; }
    }
    return deepFreeze({ format: 'amos-managed-calibration' as const, version: 1 as const, model: p.model, questionVersion: p.questionVersion, policyDigest: policyDigest(p), caseSetDigest: digest('amos-managed-calibration-cases-v1', copied), cases: copied.length, unsafeCases, falseAllows, evaluatedAt, expiresAt });
  } catch { throw new ManagedError(); }
}
function parseEvidence(value: unknown, policy: ManagedReviewPolicy): ManagedCalibrationEvidence {
  const e = record(value, evidenceKeys);
  if (e.format !== 'amos-managed-calibration' || e.version !== 1 || e.model !== policy.model || e.questionVersion !== policy.questionVersion || e.policyDigest !== policyDigest(policy)) throw new Error('invalid_evidence');
  hash(e.caseSetDigest); hash(e.policyDigest);
  for (const k of ['cases', 'unsafeCases', 'falseAllows', 'evaluatedAt', 'expiresAt']) if (!integer(e[k])) throw new Error('invalid_evidence');
  const result = e as unknown as ManagedCalibrationEvidence;
  // This empirical zero-error bound assumes suitable independent sampling; it
  // is not a global model safety probability or proof of case independence.
  if (result.cases < result.unsafeCases || result.unsafeCases < policy.minimumCases || result.falseAllows !== 0 || result.expiresAt <= result.evaluatedAt || 1 - Math.pow(0.05, 1 / result.unsafeCases) > policy.maximumFalseAllowRate) throw new Error('invalid_evidence');
  if (digest('amos-managed-calibration-v1', result) !== policy.evidenceDigest) throw new Error('invalid_evidence');
  return result;
}

export function createManagedReviewGate(options: { policy: ManagedReviewPolicy; calibration: ManagedCalibrationEvidence; requirement: unknown; workspace: string }) {
  try {
    const o = record(boundedCopy(options), ['policy', 'calibration', 'requirement', 'workspace']);
    const p = parsePolicy(o.policy); const e = parseEvidence(o.calibration, p); const root = workspace(o.workspace);
    if (p.resourceRoots.some(x => !inside(x, root))) throw new Error('invalid_root');
    const frame = record(o.requirement, frameKeys);
    if (!isRequirementFrame(frame)) throw new Error('invalid_frame');
    const requirementDigest = requirementFrameDigest(frame);
    const pd = policyDigest(p);
    // Only requests created by this gate instance can be accepted. This is a
    // process-local correlation fence, not a bearer permit or authorization.
    const issued = new Map<string, { deadline: number; issuedAt: number }>();
    const reviewedEnvelopes = new Set<string>();
    const validTime = (now: unknown) => integer(now) && now >= e.evaluatedAt && now < e.expiresAt && now < p.expiresAt;
    return Object.freeze({
      policyDigest: pd, model: p.model,
      request(envelope: ManagedEnvelope, decision: ManagedDecision, capability: ManagedCapability, attemptId: string, now: number): ManagedReviewRequest | null {
        try {
          const env = boundedCopy(envelope) as unknown as ManagedEnvelope;
          const d = record(boundedCopy(decision), decisionKeys);
          const c = record(boundedCopy(capability), capabilityKeys);
          const id = record(c.identity, identityKeys);
          const er = record(env, ['format', 'version', 'operationId', 'capabilityId', 'input', ...(Object.hasOwn(env, 'before') ? ['before'] : []), 'identity', 'requirementDigest', 'issuedAt']);
          record(er.identity, identityKeys); text(er.operationId); text(er.capabilityId); text(attemptId);
          for (const key of identityKeys) text(id[key]);
          text(c.id);
          for (const key of ['parentId', 'delegatorActorId', 'reviewPolicyId']) if (c[key] !== null) text(c[key]);
          for (const key of ['validFrom', 'expiresAt', 'delegationDepthRemaining', 'maxReadBytes', 'maxWriteBytes', 'maxOperations', 'maxShellFiles']) if (!integer(c[key])) return null;
          if (Object.hasOwn(er, 'before')) {
            if (!er.before || typeof er.before !== 'object' || Array.isArray(er.before)) return null;
            const before = er.before as Record<string, unknown>;
            if (before.kind === 'absent') record(before, ['kind']);
            else if (before.kind === 'directory' || before.kind === 'file') {
              record(before, before.kind === 'file' ? ['kind', 'dev', 'ino', 'contentDigest'] : ['kind', 'dev', 'ino']);
              if (!integer(before.dev) || !integer(before.ino)) return null;
              if (before.kind === 'file') hash(before.contentDigest);
            } else return null;
          }
          if (er.format !== 'amos-managed-envelope' || er.version !== 1 || !uintTime(er.issuedAt) || !validTime(now) || er.issuedAt > now || now - er.issuedAt > MANAGED_MAX_AGE_MS) return null;
          const input = er.input as Record<string, unknown>;
          if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tool !== 'string' || !tools.includes(input.tool) || input.tool === 'shell') return null;
          const fields: Record<string, string[]> = { read: ['tool', 'path'], write: ['tool', 'path', 'content'], edit: ['tool', 'path', 'oldText', 'newText'], list: ['tool', 'path'], search: ['tool', 'path', 'query'], mkdir: ['tool', 'path'], remove: ['tool', 'path'] };
          record(input, fields[input.tool]);
          for (const key of fields[input.tool].filter(x => x !== 'tool' && x !== 'path')) if (typeof input[key] !== 'string' || (input[key] as string).includes('\0') || Buffer.byteLength(input[key] as string) > MANAGED_MAX_BYTES) return null;
          const target = workspace(input.path);
          if (!inside(target, root) || !p.resourceRoots.some(x => inside(target, x))) return null;
          const capRoots = uniqueStrings(c.resourceRoots); capRoots.forEach(workspace);
          const capTools = uniqueStrings(c.tools);
          if (capTools.some(x => !tools.includes(x)) || !capRoots.length || !capTools.length) return null;
          const chain = uniqueStrings(d.capabilityChainIds); uniqueStrings(d.matchedRuleIds);
          const envelopeHash = managedEnvelopeDigest(env);
          if (reviewedEnvelopes.has(envelopeHash)) return null;
          if (frame.source !== 'user_message' || frame.egress !== 'allowed' || p.requirementEgress !== 'allowed' || p.targetEgress !== 'workspace-relative' || frame.session_id !== id.sessionId || er.requirementDigest !== requirementDigest || canonicalJson(er.identity) !== canonicalJson(id) || c.id !== er.capabilityId || chain[0] !== c.id || c.reviewPolicyId !== p.id || !capTools.includes(input.tool) || !p.tools.includes(input.tool as ManagedTool) || !capRoots.some(x => inside(target, x)) || d.state !== 'AUTO_REVIEW' || d.reason !== 'review_required' || d.envelopeDigest !== envelopeHash || !integer(d.notAfter) || now >= d.notAfter || !integer(c.validFrom) || !integer(c.expiresAt) || now < c.validFrom || now >= c.expiresAt) return null;
          hash(d.capabilityChainDigest); hash(id.snapshotDigest);
          const deadline = Math.min(now + p.timeoutMs, d.notAfter, c.expiresAt, p.expiresAt, e.expiresAt, er.issuedAt + MANAGED_MAX_AGE_MS);
          if (!Number.isSafeInteger(deadline) || deadline <= now) return null;
          const bytes = input.tool === 'write' ? Buffer.byteLength(input.content as string) : input.tool === 'edit' ? Buffer.byteLength(input.newText as string) : 0;
          const review = deepFreeze({ format: 'amos-managed-review-request' as const, version: 1 as const, attemptId, envelopeDigest: envelopeHash, capabilityChainDigest: d.capabilityChainDigest, snapshotDigest: id.snapshotDigest, requirementDigest, policyDigest: pd, deadline, tool: input.tool as ManagedTool, requestedBytes: bytes, relativeTarget: p.targetEgress === 'workspace-relative' ? path.posix.relative(root, target) || '.' : null, requirementText: p.requirementEgress === 'allowed' && frame.egress === 'allowed' ? frame.text : null });
          parseRequest(review);
          issued.set(managedReviewRequestDigest(review), { deadline, issuedAt: now });
          reviewedEnvelopes.add(envelopeHash);
          return review;
        } catch { return null; }
      },
      approve(request: ManagedReviewRequest, facts: ManagedReviewFacts, now: number): boolean {
        try {
          const r = parseRequest(boundedCopy(request)); const f = parseFacts(boundedCopy(facts));
          const bound = issued.get(managedReviewRequestDigest(r));
          return !!bound && validTime(now) && now >= bound.issuedAt && now < bound.deadline && r.deadline === bound.deadline && r.policyDigest === pd && r.requirementDigest === requirementDigest && p.tools.includes(r.tool) && r.tool !== 'shell' && passes(p, r, f);
        } catch { return false; }
      },
    });
  } catch { throw new ManagedError(); }
}
const uintTime = integer;
