import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { RAW_SCHEMA, rule } from '../activation/test-support.ts';
import { createRequirementFrame } from '../decision/requirement.ts';
import type { ManagedCapability, ManagedHostOptions, ManagedInput, ManagedRequest } from './contracts.ts';

/**
 * A skip is unsupported-host evidence, never a successful cgroup probe.
 *
 * The scope tests exercise a real systemd user manager and cgroup filesystem.
 * GitHub runners and containers do not provide either, so they must skip
 * explicitly rather than fail or fall back to a weaker executor.
 */
export function scopedProcessUnsupportedReason(): string | false {
  if (process.platform !== 'linux') return 'cgroup scope probe requires Linux';
  if (!existsSync('/usr/bin/systemctl') || !existsSync('/usr/bin/systemd-run')) {
    return 'systemd user scope tools unavailable';
  }
  if (!existsSync('/proc/self/cgroup') || !existsSync('/sys/fs/cgroup')) {
    return 'cgroup filesystem unavailable';
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const probe = spawnSync('/usr/bin/systemctl', ['--user', '--no-pager', '--no-ask-password', 'show-environment'], {
    encoding: 'utf8',
    timeout: 3_000,
    env,
  });
  return probe.status === 0 ? false : 'systemd user manager unavailable; cgroup scope probe unsupported';
}

export const NOW = Date.parse('2026-11-02T12:00:00.000Z');
export function fixture(): Pick<ManagedHostOptions, 'compiler' | 'snapshot' | 'expectedSnapshotDigest' | 'identity' | 'requirement' | 'capabilities' | 'protectedPaths'> {
  const compiler = createProjectActivationCompiler({
    rawSchema: RAW_SCHEMA, libraryVersion: 'managed-test',
    rules: [
      { version: 1, injection: null, rule: rule('deny-read', { predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }, { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/secret*'] } }] }) },
      { version: 1, injection: null, rule: rule('review-write', { on_hit: 'confirm', predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }, { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/review*'] } }] }) },
      { version: 1, injection: null, rule: rule('deny-mkdir', { predicate: [{ op: 'op_in', args: { operations: ['file_mkdir'] } }, { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/mkdir-denied'] } }] }) },
      { version: 1, injection: null, rule: rule('review-mkdir', { on_hit: 'confirm', predicate: [{ op: 'op_in', args: { operations: ['file_mkdir'] } }, { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/mkdir-review'] } }] }) },
    ], mandatoryRuleRefs: [{ id: 'deny-read', version: 1 }],
  });
  const snapshot = compiler.compile({ projectId: 'project', workspace: '/work/demo', policyVersion: 'v1', selectedRuleRefs: [{ id: 'review-write', version: 1 }, { id: 'deny-mkdir', version: 1 }, { id: 'review-mkdir', version: 1 }], excludedRuleIds: [], advisoryBaselineRuleIds: [], routes: [] });
  const identity = { actorId: 'agent-1', projectId: 'project', sessionId: 'session-1', taskId: 'task-1', snapshotDigest: snapshot.digest };
  const requirement = createRequirementFrame({ frame_id: 'frame', session_id: identity.sessionId, source: 'user_message', user_turn_digest: 'sha256:' + 'a'.repeat(64), egress: 'denied', text: 'fixture requirement', captured_at: '2026-11-02T12:00:00.000Z' });
  const cap: ManagedCapability = { id: 'root', parentId: null, delegatorActorId: null, identity, tools: ['read', 'write', 'edit', 'list', 'search', 'mkdir', 'remove', 'shell'], resourceRoots: ['/work/demo'], validFrom: NOW - 1000, expiresAt: NOW + 60_000, delegationDepthRemaining: 2, reviewPolicyId: 'review-1', maxReadBytes: 4096, maxWriteBytes: 4096, maxOperations: 5, maxShellFiles: 8 };
  return { compiler, snapshot, expectedSnapshotDigest: snapshot.digest, identity, requirement, capabilities: [cap], protectedPaths: ['/work/demo/private'] };
}
export function request(input: ManagedInput, capabilityId = 'root'): ManagedRequest {
  return { format: 'amos-managed-request', version: 1, operationId: 'operation', capabilityId, input };
}
