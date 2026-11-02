import path from 'node:path';
import { boundedCopy, canonicalJson, deepFreeze, digest, list, record, text, uniqueStrings, workspace } from '../activation/json.ts';
import { assertValidTable, evaluatePolicy } from '../engine/engine.ts';
import { isRequirementFrame, requirementFrameDigest } from '../decision/requirement.ts';
import { ManagedError, MANAGED_MAX_AGE_MS, MANAGED_MAX_BYTES } from './contracts.ts';
import { managedEnvelopeDigest } from './digests.ts';
import type { ManagedAuthorizer, ManagedCapability, ManagedDecision, ManagedEnvelope, ManagedEvaluation, ManagedHostOptions, ManagedIdentity, ManagedInput, ManagedTool } from './contracts.ts';

const tools: ManagedTool[] = ['read', 'write', 'edit', 'list', 'search', 'mkdir', 'remove', 'shell'];
const identityKeys = ['actorId', 'projectId', 'sessionId', 'taskId', 'snapshotDigest'];
const capabilityKeys = ['id', 'parentId', 'delegatorActorId', 'identity', 'tools', 'resourceRoots', 'validFrom', 'expiresAt', 'delegationDepthRemaining', 'reviewPolicyId', 'maxReadBytes', 'maxWriteBytes', 'maxOperations', 'maxShellFiles'];
const requirementKeys = ['frame_id', 'session_id', 'root_frame_id', 'source', 'actor', 'delegator', 'user_turn_digest', 'egress', 'text', 'declared_scope', 'captured_by', 'captured_at'];
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const within = (value: string, root: string) => root === '/' ? value.startsWith('/') : value === root || value.startsWith(root + '/');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function absolute(value: unknown): string {
  const result = workspace(value);
  if (/[*?\[\]{}!\\]/.test(result)) throw new Error('invalid_path');
  return result;
}
function identity(value: unknown): ManagedIdentity {
  const r = record(value, identityKeys);
  for (const key of identityKeys) text(r[key]);
  return r as unknown as ManagedIdentity;
}
function precondition(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_precondition');
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'absent') { record(value, ['kind']); return; }
  if (kind !== 'file' && kind !== 'directory') throw new Error('invalid_precondition');
  const r = record(value, kind === 'file' ? ['kind', 'dev', 'ino', 'contentDigest'] : ['kind', 'dev', 'ino']);
  if (!uint(r.dev) || !uint(r.ino)) throw new Error('invalid_precondition');
  if (kind === 'file' && (typeof r.contentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.contentDigest))) throw new Error('invalid_precondition');
}
function normalizeInput(value: unknown, root: string, normalized: boolean): ManagedInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input');
  const tool = (value as Record<string, unknown>).tool;
  if (typeof tool !== 'string' || !tools.includes(tool as ManagedTool)) throw new Error('invalid_tool');
  const keys: Record<ManagedTool, string[]> = {
    read: ['tool', 'path'], write: ['tool', 'path', 'content'], edit: ['tool', 'path', 'oldText', 'newText'],
    list: ['tool', 'path'], search: ['tool', 'path', 'query'], mkdir: ['tool', 'path'],
    remove: ['tool', 'path'], shell: ['tool', 'command'],
  };
  const input = record(value, keys[tool as ManagedTool]);
  for (const key of keys[tool as ManagedTool].filter(x => x !== 'tool' && x !== 'path')) {
    if (typeof input[key] !== 'string' || (input[key] as string).includes('\0') || Buffer.byteLength(input[key] as string) > MANAGED_MAX_BYTES) throw new Error('invalid_parameter');
  }
  if (tool !== 'shell') {
    if (typeof input.path !== 'string' || !input.path || input.path.includes('\0') || input.path.includes('\\')) throw new Error('invalid_path');
    const resolved = path.posix.resolve(root, input.path);
    absolute(resolved);
    if (!within(resolved, root) || (normalized && resolved !== input.path)) throw new Error('invalid_path');
    input.path = resolved;
  }
  return input as unknown as ManagedInput;
}
function parseRequest(value: unknown, root: string, envelope: boolean): ManagedEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  const hasBefore = Object.hasOwn(value, 'before');
  const keys = ['format', 'version', 'operationId', 'capabilityId', 'input', ...(hasBefore ? ['before'] : []), ...(envelope ? ['identity', 'requirementDigest', 'issuedAt'] : [])];
  const r = record(value, keys);
  if (r.format !== (envelope ? 'amos-managed-envelope' : 'amos-managed-request') || r.version !== 1) throw new Error('invalid_request');
  text(r.operationId); text(r.capabilityId);
  r.input = normalizeInput(r.input, root, envelope);
  if (hasBefore) precondition(r.before);
  if (envelope) {
    identity(r.identity); text(r.requirementDigest);
    if (!uint(r.issuedAt)) throw new Error('invalid_time');
  }
  return r as unknown as ManagedEnvelope;
}
function capability(value: unknown, root: string, host: ManagedIdentity): ManagedCapability {
  const r = record(value, capabilityKeys);
  text(r.id);
  if (r.parentId !== null) text(r.parentId);
  if (r.delegatorActorId !== null) text(r.delegatorActorId);
  if ((r.parentId === null) !== (r.delegatorActorId === null)) throw new Error('invalid_parent');
  const id = identity(r.identity);
  if (id.projectId !== host.projectId || id.snapshotDigest !== host.snapshotDigest) throw new Error('invalid_identity');
  const granted = uniqueStrings(r.tools);
  if (!granted.length || granted.some(x => !tools.includes(x as ManagedTool))) throw new Error('invalid_tools');
  const roots = uniqueStrings(r.resourceRoots);
  if (!roots.length || roots.some(x => !within(absolute(x), root))) throw new Error('invalid_roots');
  for (const k of ['validFrom', 'expiresAt', 'delegationDepthRemaining', 'maxReadBytes', 'maxWriteBytes', 'maxOperations', 'maxShellFiles']) {
    if (!uint(r[k])) throw new Error('invalid_budget');
  }
  if ((r.expiresAt as number) <= (r.validFrom as number)) throw new Error('invalid_time');
  if (r.reviewPolicyId !== null) text(r.reviewPolicyId);
  return r as unknown as ManagedCapability;
}
function checkDelegation(c: ManagedCapability, p: ManagedCapability): void {
  if (c.delegatorActorId !== p.identity.actorId || c.identity.projectId !== p.identity.projectId || c.identity.taskId !== p.identity.taskId || c.identity.sessionId !== p.identity.sessionId || c.identity.snapshotDigest !== p.identity.snapshotDigest || c.validFrom < p.validFrom || c.expiresAt > p.expiresAt || c.delegationDepthRemaining >= p.delegationDepthRemaining || c.tools.some(x => !p.tools.includes(x)) || c.resourceRoots.some(x => !p.resourceRoots.some(y => within(x, y))) || c.maxReadBytes > p.maxReadBytes || c.maxWriteBytes > p.maxWriteBytes || c.maxOperations > p.maxOperations || c.maxShellFiles > p.maxShellFiles || (c.reviewPolicyId !== null && c.reviewPolicyId !== p.reviewPolicyId)) throw new Error('invalid_delegation');
}

export function createManagedAuthorizer(options: Pick<ManagedHostOptions, 'compiler' | 'snapshot' | 'expectedSnapshotDigest' | 'identity' | 'requirement' | 'capabilities' | 'protectedPaths'>): ManagedAuthorizer {
  try {
    // The compiler is trusted executable bootstrap input, not JSON data. Never
    // access an options accessor; all remaining inputs are inert bounded copies.
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const allowed = ['compiler', 'snapshot', 'expectedSnapshotDigest', 'identity', 'requirement', 'capabilities', 'protectedPaths'];
    if (Reflect.ownKeys(options).some(k => typeof k !== 'string' || !allowed.includes(k)) || allowed.slice(0, 6).some(k => !descriptors[k] || !('value' in descriptors[k])) || (descriptors.protectedPaths && !('value' in descriptors.protectedPaths))) throw new Error('invalid_options');
    const compiler = descriptors.compiler.value as ManagedHostOptions['compiler'];
    const data = boundedCopy({ snapshot: descriptors.snapshot.value, expectedSnapshotDigest: descriptors.expectedSnapshotDigest.value, identity: descriptors.identity.value, requirement: descriptors.requirement.value, capabilities: descriptors.capabilities.value, protectedPaths: descriptors.protectedPaths?.value ?? [] }) as unknown as Record<string, unknown>;
    const host = identity(data.identity);
    const snapshotInput = data.snapshot as ManagedHostOptions['snapshot'];
    const root = absolute(snapshotInput.project.workspace);
    const verified = boundedCopy(compiler.verify(snapshotInput, { projectId: host.projectId, workspace: root })) as unknown as ManagedHostOptions['snapshot'];
    if (verified.digest !== data.expectedSnapshotDigest || verified.digest !== host.snapshotDigest || snapshotInput.digest !== verified.digest) throw new Error('snapshot_mismatch');
    const req = record(data.requirement, requirementKeys);
    if (!isRequirementFrame(req) || req.session_id !== host.sessionId) throw new Error('invalid_requirement');
    const requirementDigest = requirementFrameDigest(req);
    // Protected paths are literal absolute paths, not glob expressions.
    const protectedPaths = uniqueStrings(data.protectedPaths).map(workspace);
    const runtime = verified.enforcement.runtime;
    if (runtime.status === 'ready') assertValidTable(runtime.rules);
    else if (runtime.status !== 'empty' || runtime.rules.length) throw new Error('invalid_runtime');
    const capabilities = list(data.capabilities).map(x => capability(x, root, host));
    const byId = new Map<string, ManagedCapability>();
    for (const cap of capabilities) { if (byId.has(cap.id)) throw new Error('duplicate_capability'); byId.set(cap.id, cap); }
    const chains = new Map<string, ManagedCapability[]>();
    for (const cap of capabilities) {
      const chain: ManagedCapability[] = []; const seen = new Set<string>(); let current = cap;
      while (true) {
        if (seen.has(current.id) || chain.length >= 64) throw new Error('invalid_chain');
        seen.add(current.id); chain.push(current);
        if (current.parentId === null) break;
        const parent = byId.get(current.parentId);
        if (!parent) throw new Error('invalid_chain');
        checkDelegation(current, parent); current = parent;
      }
      chains.set(cap.id, chain);
    }
    deepFreeze(host); deepFreeze(capabilities);
    const makeDecision = (state: ManagedDecision['state'], reason: string, envelopeDigest = '', chain: ManagedCapability[] = [], matchedRuleIds: string[] = [], notAfter: number | null = null): ManagedDecision => deepFreeze({ state, reason, envelopeDigest, capabilityChainDigest: chain.length ? digest('amos-managed-capability-chain-v1', chain) : null, capabilityChainIds: chain.map(x => x.id), matchedRuleIds, notAfter });
    const authorize = (input: unknown, evaluation: ManagedEvaluation): ManagedDecision => {
      try {
        const env = parseRequest(boundedCopy(input), root, true);
        const ed = managedEnvelopeDigest(env);
        const ev = record(boundedCopy(evaluation), ['now', 'revokedCapabilityIds', 'operationCounts']);
        if (!uint(ev.now)) throw new Error('invalid_time');
        const now = ev.now; const revoked = uniqueStrings(ev.revokedCapabilityIds);
        if (!ev.operationCounts || typeof ev.operationCounts !== 'object' || Array.isArray(ev.operationCounts)) throw new Error('invalid_counts');
        const counts = ev.operationCounts as Record<string, unknown>;
        if (Object.entries(counts).some(([key, value]) => !byId.has(key) || !uint(value))) throw new Error('invalid_counts');
        const chain = chains.get(env.capabilityId) ?? [];
        const result = (state: ManagedDecision['state'], reason: string, matched: string[] = [], notAfter: number | null = null) => makeDecision(state, reason, ed, chain, matched, notAfter);
        if (!same(env.identity, host) || env.requirementDigest !== requirementDigest) return result('DENY', 'identity_mismatch');
        if (env.issuedAt > now || now - env.issuedAt > MANAGED_MAX_AGE_MS) return result('DEFER', 'stale_envelope');
        if (!chain.length) return result('DENY', 'capability_missing');
        const cap = chain[0];
        if (!same(cap.identity, host)) return result('DENY', 'identity_mismatch');
        for (const item of chain) {
          if (revoked.includes(item.id)) return result('DENY', 'capability_revoked');
          if (now < item.validFrom || now >= item.expiresAt) return result('DENY', 'capability_expired');
          if (!Object.hasOwn(counts, item.id) || !uint(counts[item.id]) || (counts[item.id] as number) >= item.maxOperations) return result('DENY', 'budget_exceeded');
        }
        if (!cap.tools.includes(env.input.tool)) return result('DENY', 'scope_denied');
        if (env.input.tool !== 'shell') {
          const target = env.input.path;
          const destructive = env.input.tool === 'write' || env.input.tool === 'edit' || env.input.tool === 'remove';
          const touchesProtected = protectedPaths.some(protectedPath =>
            within(target, protectedPath) || (destructive && within(protectedPath, target)));
          if (!cap.resourceRoots.some(x => within(target, x)) || touchesProtected) return result('DENY', 'scope_denied');
        }
        const bytes = env.input.tool === 'write' ? Buffer.byteLength(env.input.content) : env.input.tool === 'edit' ? Buffer.byteLength(env.input.newText) : 0;
        if (bytes > cap.maxWriteBytes || bytes > MANAGED_MAX_BYTES) return result('DENY', 'budget_exceeded');
        if (runtime.status !== 'ready' || !runtime.rules.length) return result('DEFER', 'checkpoint_unavailable');
        const operations: Record<ManagedTool, string[]> = { read: ['file_read'], write: ['file_write'], edit: ['file_read', 'file_write'], list: ['file_list'], search: ['file_search'], mkdir: ['file_mkdir'], remove: ['file_delete'], shell: ['shell_input'] };
        const target = env.input.tool === 'shell' ? root : env.input.path;
        const decisions = operations[env.input.tool].map(operation => evaluatePolicy({ tool: env.input.tool, operation, target }, runtime.rules, now));
        const matched = [...new Set(decisions.flatMap(x => x.matched_rule_ids))];
        if (decisions.some(x => x.decision === 'error' || x.error)) return result('DENY', 'policy_error', matched);
        if (decisions.some(x => x.verdict === 'deny')) return result('DENY', 'policy_denied', matched);
        const notAfter = Math.min(env.issuedAt + MANAGED_MAX_AGE_MS, ...chain.map(x => x.expiresAt));
        if (decisions.some(x => x.verdict === 'confirm')) return cap.reviewPolicyId === null ? result('DEFER', 'review_not_preauthorized', matched) : result('AUTO_REVIEW', 'review_required', matched, notAfter);
        return result('ALLOW', 'allowed', matched, notAfter);
      } catch { return makeDecision('DENY', 'malformed_input'); }
    };
    return deepFreeze({
      identity: host, workspace: root, capabilities,
      createEnvelope(request: unknown, now: number): ManagedEnvelope {
        try {
          if (!uint(now)) throw new Error('invalid_time');
          const r = parseRequest(boundedCopy(request), root, false);
          return deepFreeze({ ...r, format: 'amos-managed-envelope' as const, identity: host, requirementDigest, issuedAt: now });
        } catch { throw new ManagedError(); }
      },
      authorize,
      guards(envelope: ManagedEnvelope, evaluation: ManagedEvaluation) {
        try {
          const env = parseRequest(boundedCopy(envelope), root, true);
          const ev = boundedCopy(evaluation) as unknown as ManagedEvaluation;
          const base = authorize(env, ev);
          const chain = chains.get(env.capabilityId);
          if (!chain || (base.state !== 'ALLOW' && base.state !== 'AUTO_REVIEW')) throw new Error('invalid_guard');
          const cap = chain[0];
          const guard = (tool: 'read' | 'list', target: string): boolean => {
            try {
              const absoluteTarget = absolute(target);
              const probe = { ...env, input: { tool, path: absoluteTarget } };
              return authorize(probe, ev).state === 'ALLOW';
            } catch { return false; }
          };
          return Object.freeze({ maxReadBytes: cap.maxReadBytes, maxWriteBytes: cap.maxWriteBytes, maxShellFiles: cap.maxShellFiles, mayRead: (target: string) => guard('read', target), mayList: (target: string) => guard('list', target) });
        } catch { return Object.freeze({ maxReadBytes: 0, maxWriteBytes: 0, maxShellFiles: 0, mayRead: () => false, mayList: () => false }); }
      },
    });
  } catch { throw new ManagedError(); }
}
