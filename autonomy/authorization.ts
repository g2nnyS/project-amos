import { boundedCopy, canonicalJson, deepFreeze, digest, list, record, text, uniqueStrings, workspace } from '../activation/json.ts';
import { assertValidTable, evaluatePolicy } from '../engine/engine.ts';
import { AutonomyError, ENVELOPE_DIGEST_DOMAIN, MAX_AUTHORIZATION_AGE_MS, MAX_FILE_CONTENT_BYTES } from './contracts.ts';
import type { ActionEnvelope, AuthorizationCore, AuthorizationDecision, AuthorizationReason, AuthorizationState, CapabilityLease, TrustedSessionContext } from './contracts.ts';

const leaseKeys = [
  'format', 'formatVersion', 'id', 'parentId', 'delegatorActorId', 'actorId',
  'projectId', 'taskId', 'sessionId', 'snapshotDigest', 'tools', 'operations',
  'resourceRoots', 'effects', 'maxWriteBytes', 'validFrom', 'expiresAt',
  'delegationDepthRemaining', 'autoReviewEligible', 'requiredChecks',
];
const ctxKeys = ['actorId','projectId','sessionId','taskId','snapshotDigest'];
const reqKeys = ['format','formatVersion','operationId','capabilityId','action','parameters'];
const envKeys = [...reqKeys, 'context', 'checkpoint', 'issuedAt'];
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const inside = (p: string, root: string) => root === '/' ? p.startsWith('/') : p === root
    || p.startsWith(root + '/');
function safePath(value: unknown): string {
  const path = workspace(value);
  if (/[*?\[\]{}!\\]/.test(path)) throw new Error('invalid_input');
  return path;
}
const nullable = (x: unknown) => x === null ? null : text(x);
const subset = (a: readonly string[], b: readonly string[]) => a.every(x => b.includes(x));
function validateActiveRules(input: unknown): Record<string, unknown>[] {
  const seen = new Set<string>();
  return list(input).map(value => {
    const item = record(value, ['id', 'version', 'mandatory', 'rule', 'injection']);
    const id = text(item.id);
    if (seen.has(id)
    || !integer(item.version)
    || item.version < 1
    || typeof item.mandatory !== 'boolean') {
      throw new Error('invalid_active_rule');
    }
    seen.add(id);
    if (item.rule === null
    || typeof item.rule !== 'object'
    || Array.isArray(item.rule)) {
      throw new Error('invalid_active_rule');
    }
    const rule = item.rule as Record<string, unknown>;
    if (rule.id !== id) throw new Error('invalid_active_rule');
    if (!['deterministic', 'advisory_only'].includes(rule.expressivity as string)
      || !['runtime', 'ci', 'server', 'advisory'].includes(rule.enforcement as string)) {
      throw new Error('invalid_active_rule');
    }
    if (item.injection !== null && (typeof item.injection !== 'object'
    || Array.isArray(item.injection))) {
      throw new Error('invalid_active_rule');
    }
    return item;
  });
}
function context(x: unknown): TrustedSessionContext {
  const r = record(x, ctxKeys);
  for (const k of ctxKeys) text(r[k]);
  return r as unknown as TrustedSessionContext;
}
function request(x: unknown, envelope = false): void {
  const r = record(x, envelope ? envKeys : reqKeys);
  if (r.format !== (envelope ? 'amos-action-envelope' : 'amos-file-create-request')
    || r.formatVersion !== 1) throw new Error('invalid_input');
  text(r.operationId); text(r.capabilityId);
  const a = record(r.action, ['tool','operation','target']);
  if (a.tool !== 'fs'
    || a.operation !== 'file_write') throw new Error('invalid_input');
  safePath(a.target);
  const p = record(r.parameters, ['effect','encoding','content']);
  if (p.effect !== 'file_create'
    || p.encoding !== 'utf8'
    || typeof p.content !== 'string'
    || Buffer.byteLength(p.content) > MAX_FILE_CONTENT_BYTES) throw new Error('invalid_input');
  if (envelope) {
    context(r.context);
    if (r.checkpoint !== 'runtime' || !integer(r.issuedAt)) throw new Error('invalid_input');
  }
}
function lease(x: unknown, root: string, project: string, pin: string): CapabilityLease {
  const r = record(x, leaseKeys);
  if (r.format !== 'amos-capability-lease'
    || r.formatVersion !== 1) throw new Error('invalid_input');
  for (const k of ['id','actorId','projectId','taskId','snapshotDigest']) text(r[k]);
  nullable(r.parentId); nullable(r.delegatorActorId); nullable(r.sessionId);
  if ((r.parentId === null) !== (r.delegatorActorId === null)
    || r.projectId !== project
    || r.snapshotDigest !== pin) throw new Error('invalid_input');
  for (const [k, v] of [['tools','fs'], ['operations','file_write'], ['effects','file_create']] as const) {
    const values = uniqueStrings(r[k]); if (!values.length
    || values.some(x => x !== v)) throw new Error('invalid_input');
  }
  const roots = uniqueStrings(r.resourceRoots); if (!roots.length
    || roots.some(x => !inside(safePath(x), root))) throw new Error('invalid_input');
  uniqueStrings(r.requiredChecks);
  if (!integer(r.maxWriteBytes)
    || r.maxWriteBytes < 1
    || !integer(r.validFrom)
    || !integer(r.expiresAt)
    || r.expiresAt <= r.validFrom
    || !integer(r.delegationDepthRemaining)
    || typeof r.autoReviewEligible !== 'boolean') throw new Error('invalid_input');
  return r as unknown as CapabilityLease;
}

function validateDelegation(child: CapabilityLease, parent: CapabilityLease): void {
  if (
    child.delegatorActorId !== parent.actorId
    || child.projectId !== parent.projectId
    || child.taskId !== parent.taskId
    || child.snapshotDigest !== parent.snapshotDigest
    || (parent.sessionId !== null && child.sessionId !== parent.sessionId)
    || child.validFrom < parent.validFrom
    || child.expiresAt > parent.expiresAt
    || child.delegationDepthRemaining >= parent.delegationDepthRemaining
    || child.maxWriteBytes > parent.maxWriteBytes
    || (child.autoReviewEligible && !parent.autoReviewEligible)
    || !subset(child.tools, parent.tools)
    || !subset(child.operations, parent.operations)
    || !subset(child.effects, parent.effects)
    || !subset(parent.requiredChecks, child.requiredChecks)
    || !child.resourceRoots.every(x => parent.resourceRoots.some(y => inside(x, y)))
  ) throw new Error('invalid_delegation');
}

export function createAuthorizationCore(options: unknown): AuthorizationCore {
  try {
    const o = record(boundedCopy(options), ['snapshot','expectedSnapshotDigest','capabilities']);
    const s = record(o.snapshot, [
      'format', 'formatVersion', 'compilerVersion', 'mode', 'libraryVersion',
      'schemaDigest', 'project', 'activeRules', 'activationDigest', 'enforcement',
      'advisory', 'digest',
    ]);
    const { digest: snapshotDigest, ...content } = s;
    if (s.format !== 'amos-project-activation'
    || s.formatVersion !== 1
    || s.compilerVersion !== 'amos-project-activation-v1'
    || s.mode !== 'offline-shadow'
    || typeof snapshotDigest !== 'string'
    || snapshotDigest !== o.expectedSnapshotDigest
    || digest('amos-project-activation-snapshot-v1', content) !== snapshotDigest) throw new Error('invalid_input');
    text(s.libraryVersion); text(s.schemaDigest);
    const project = record(s.project, [
      'projectId', 'workspace', 'policyVersion', 'selectedRuleRefs',
      'excludedRuleIds', 'advisoryBaselineRuleIds', 'routes',
    ]);
    const projectId = text(project.projectId), root = safePath(project.workspace);
    const active = validateActiveRules(s.activeRules);
    const activationDigest = digest('amos-project-activation-content-v1', {
      compilerVersion: s.compilerVersion, schemaDigest: s.schemaDigest,
      libraryVersion: s.libraryVersion, project, activeRules: active,
    });
    if (s.activationDigest !== activationDigest) throw new Error('invalid_input');
    const enforcement = record(s.enforcement, ['runtime','ci','server']);
    const runtime = record(enforcement.runtime, ['status','activationDigest','digest','rules']);
    const rules = list(runtime.rules);
    const projected = active.filter(x => {
      const r = x.rule as Record<string, unknown>; return r && r.expressivity === 'deterministic' && r.enforcement === 'runtime';
    }).map(x => x.rule);
    if (runtime.activationDigest !== activationDigest
    || runtime.digest !== digest('amos-activation-runtime-v1', { activationDigest, rules })
    || canonicalJson(projected) !== canonicalJson(rules)
    || runtime.status !== (rules.length ? 'ready' : 'empty')) throw new Error('invalid_input');
    if (rules.length) assertValidTable(rules);
    const leases = list(o.capabilities).map(x => lease(x, root, projectId, snapshotDigest));
    const map = new Map<string, CapabilityLease>();
    for (const l of leases) { if (map.has(l.id)) throw new Error('invalid_input'); map.set(l.id, l); }
    const chains = new Map<string, CapabilityLease[]>();
    for (const l of leases) {
      const chain: CapabilityLease[] = [], seen = new Set<string>(); let current: CapabilityLease | undefined = l;
      while (current) {
        if (seen.has(current.id)
    || chain.length >= 64) throw new Error('invalid_input');
        seen.add(current.id); chain.push(current);
        if (current.parentId === null) break;
        const parent: CapabilityLease | undefined = map.get(current.parentId);
        if (!parent) throw new Error('missing_parent');
        validateDelegation(current, parent);
        current = parent;
      }
      chains.set(l.id, chain);
    }
    const makeDecision = (
      state: AuthorizationState, reason: AuthorizationReason, operationId: string | null = null,
      matchedRuleIds: string[] = [], binding: AuthorizationDecision['binding'] = null,
      capabilityChainIds: string[] = [],
    ): AuthorizationDecision => deepFreeze({
      state, reason, operationId, matchedRuleIds, binding, capabilityChainIds,
    });
    return deepFreeze({
      projectId, workspace: root, snapshotDigest, capabilityIds: leases.map(x => x.id),
      createEnvelope(ctx: TrustedSessionContext, req: unknown, issuedAt: number): ActionEnvelope {
        try {
          const c = context(boundedCopy(ctx)); const r = boundedCopy(req); request(r);
          if (!integer(issuedAt)) throw new Error('invalid_input');
          return deepFreeze({
            ...(r as unknown as ActionEnvelope), format: 'amos-action-envelope' as const,
            context: c, checkpoint: 'runtime' as const, issuedAt,
          });
        } catch { throw new AutonomyError(); }
      },
      authorize(input: unknown, evaluation: unknown): AuthorizationDecision {
        try {
          const e = boundedCopy(input); request(e, true); const env = e as unknown as ActionEnvelope;
          const ev = record(boundedCopy(evaluation), ['now','revokedCapabilityIds']);
          if (!integer(ev.now)) throw new Error('invalid_input'); const now = ev.now; const revoked = uniqueStrings(ev.revokedCapabilityIds);
          const chain = chains.get(env.capabilityId);
          const chainIds = chain?.map(item => item.id) ?? [];
          const decision = (
            state: AuthorizationState, reason: AuthorizationReason, operationId: string | null = null,
            matchedRuleIds: string[] = [], binding: AuthorizationDecision['binding'] = null,
          ) => makeDecision(state, reason, operationId, matchedRuleIds, binding, chainIds);
          const id = env.operationId;
          if (env.context.projectId !== projectId
    || env.context.snapshotDigest !== snapshotDigest) return decision('DENY','snapshot_mismatch',id);
          if (env.issuedAt > now
    || now - env.issuedAt > MAX_AUTHORIZATION_AGE_MS) return decision('DEFER','stale_envelope',id);
          if (!chain) return decision('DENY','capability_missing',id);
          const cap = chain[0];
          if (cap.actorId !== env.context.actorId
    || cap.projectId !== env.context.projectId
    || cap.taskId !== env.context.taskId
    || (cap.sessionId !== null && cap.sessionId !== env.context.sessionId)) return decision('DENY','identity_mismatch',id);
          for (const c of chain) {
            if (revoked.includes(c.id)) return decision('DENY','capability_revoked',id);
            if (now < c.validFrom) return decision('DENY','capability_not_yet_valid',id);
            if (now >= c.expiresAt) return decision('DENY','capability_expired',id);
          }
          if (!cap.resourceRoots.some(x => inside(env.action.target,x))) return decision('DENY','scope_denied',id);
          const bytes = Buffer.byteLength(env.parameters.content, 'utf8');
          if (bytes > cap.maxWriteBytes) return decision('DENY','budget_exceeded',id);
          if (chain.some(x => x.requiredChecks.length)) return decision('DEFER','unsupported_precondition',id);
          if (!rules.length) return decision('DEFER','checkpoint_unavailable',id);
          const result = evaluatePolicy(env.action, rules, now);
          if (result.decision === 'error'
    || result.error) return decision('DENY','policy_error',id);
          if (result.verdict === 'deny') return decision('DENY','policy_denied',id,result.matched_rule_ids);
          if (result.verdict === 'confirm' && !cap.autoReviewEligible) return decision('DEFER','review_not_preauthorized',id,result.matched_rule_ids);
          const binding = {
            envelopeDigest: digest(ENVELOPE_DIGEST_DOMAIN, env),
            capabilityChainDigest: digest('amos-capability-chain-v1', chain),
            snapshotDigest,
            notAfter: Math.min(env.issuedAt + MAX_AUTHORIZATION_AGE_MS, ...chain.map(x => x.expiresAt)),
            authorizedBytes: bytes,
          };
          return result.verdict === 'confirm'
            ? decision('AUTO_REVIEW', 'review_required', id, result.matched_rule_ids, binding)
            : decision('ALLOW', 'allowed', id, result.matched_rule_ids, binding);
        } catch { return makeDecision('DENY','malformed_input'); }
      },
    });
  } catch { throw new AutonomyError(); }
}
