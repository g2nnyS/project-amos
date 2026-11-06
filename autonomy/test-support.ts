import { createProjectActivationCompiler } from '../activation/compiler.ts';
import type { ProjectActivationSnapshot } from '../activation/types.ts';
import { RAW_SCHEMA, entry } from '../activation/test-support.ts';
import type { CapabilityLease, FileCreateRequest, TrustedSessionContext } from './contracts.ts';

export const TEST_NOW = Date.parse('2026-11-02T12:00:00.000Z');

export function makeSnapshot(workspace = '/work/demo'): ProjectActivationSnapshot {
  const compiler = createProjectActivationCompiler({
    rawSchema: RAW_SCHEMA,
    catalogVersion: 'autonomy-probe-1',
    rules: [
      entry('protected-deny', {
        level: 0,
        predicate: [
          { op: 'op_in', args: { operations: ['file_write'] } },
          { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/protected-*'] } },
        ],
      }, 'security'),
      entry('stopped-review', {
        on_hit: 'confirm',
        predicate: [
          { op: 'op_in', args: { operations: ['file_write'] } },
          { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/review-*'] } },
        ],
      }, 'security'),
    ],
    mandatoryRuleRefs: [{ id: 'protected-deny', version: 1 }],
  });
  return compiler.compile({
    projectId: 'autonomy-probe',
    workspace,
    projectConfigVersion: 'probe-1',
    baseVersion: 'probe-base-1',
    epoch: 1,
    selectedRuleRefs: [{ id: 'stopped-review', version: 1 }],
    excludedRuleIds: [],
    advisoryBaselineRuleIds: [],
    routes: [],
  });
}

export function makeLease(snapshot: ProjectActivationSnapshot, overrides: Partial<CapabilityLease> = {}): CapabilityLease {
  return {
    format: 'amos-capability-lease', formatVersion: 1,
    id: 'lease-root', parentId: null, delegatorActorId: null,
    actorId: 'actor-main', projectId: snapshot.project.projectId, taskId: 'task-main', sessionId: null,
    snapshotDigest: snapshot.digest, tools: ['fs'], operations: ['file_write'],
    resourceRoots: [snapshot.project.workspace], effects: ['file_create'], maxWriteBytes: 4_096,
    validFrom: TEST_NOW - 1_000, expiresAt: TEST_NOW + 60_000,
    delegationDepthRemaining: 2, autoReviewEligible: true, requiredChecks: [], ...overrides,
  };
}

export function makeContext(snapshot: ProjectActivationSnapshot, overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext {
  return {
    actorId: 'actor-main', projectId: snapshot.project.projectId,
    sessionId: 'session-main', taskId: 'task-main', snapshotDigest: snapshot.digest, ...overrides,
  };
}

export function makeRequest(snapshot: ProjectActivationSnapshot, basename = 'allowed.txt', overrides: Partial<FileCreateRequest> = {}): FileCreateRequest {
  return {
    format: 'amos-file-create-request', formatVersion: 1,
    operationId: 'operation-1', capabilityId: 'lease-root',
    action: { tool: 'fs', operation: 'file_write', target: `${snapshot.project.workspace}/${basename}` },
    parameters: { effect: 'file_create', encoding: 'utf8', content: 'hello' }, ...overrides,
  };
}
