import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createProjectActivationCompiler } from '../../activation/compiler.ts';
import {
  entry,
  options as compilerOptions,
  project as projectInput,
} from '../../activation/test-support.ts';
import amosPiLogOnly from './index.ts';
import { readHostProjection } from '../shared/host-projection.ts';

const ROOT = process.cwd();

function journal(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a generated managed projection loads for Pi without .pi/amos.json', async (t) => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = realpathSync(mkdtempSync(join('/tmp/opencode', 'amos-pi-projection-')));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  const auditDir = join(root, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const managedAudit = join(auditDir, 'managed.jsonl');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const base = compilerOptions();
  const rule = entry('deny-write', {
    level: 1,
    on_hit: 'deny',
    predicate: [
      { op: 'op_in', args: { operations: ['file_write'] } },
      { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/src/deny.ts'] } },
    ],
  });
  const compiler = createProjectActivationCompiler({ ...base, rules: [...base.rules, rule] });
  const snapshot = compiler.compile(
    projectInput({
      projectId: 'pi-projection-project',
      workspace,
      selectedRuleRefs: [{ id: 'deny-write', version: 1 }],
    }),
  );
  writeFileSync(join(workspace, '.pi', 'activation.json'), JSON.stringify(snapshot));
  writeFileSync(
    join(workspace, '.pi', 'amos.managed.json'),
    JSON.stringify({
      format: 'amos-managed-host-projection',
      version: 1,
      projectId: 'pi-projection-project',
      workspace,
      policyVersion: snapshot.project.projectConfigVersion,
      activationDigest: snapshot.activationDigest,
      epoch: snapshot.epoch,
      publishedAt: new Date().toISOString(),
      kind: 'publish',
      activation: { snapshotPath: '.pi/activation.json', projectId: 'pi-projection-project' },
      managed: {
        enabled: true,
        auditPath: managedAudit,
        requirementEgress: 'denied',
        grantTtlMs: 20_000,
        review: null,
      },
      workflowGate: {
        enabled: false,
        guidance: false,
        shellGate: false,
        completionReview: false,
        jevConfigPath: null,
        actionAssessment: false,
        requirementEgress: 'denied',
      },
      tightening: { enabled: false },
      rollout: { thresholds: null, thresholdsByRule: {}, ruleStates: {} },
    }),
  );

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  amosPiLogOnly(pi);
  const ctx = { cwd: workspace };
  handlers.get('session_start')?.({ type: 'session_start', reason: 'new' }, ctx);
  assert.ok(existsSync(join(workspace, '.pi', 'runtime.json')));
  const report = JSON.parse(
    readFileSync(join(workspace, '.pi', 'runtime.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(report.harness, 'pi');
  assert.equal(report.mode, 'enforcing');

  const result = await handlers.get('tool_call')?.(
    {
      type: 'tool_call',
      toolCallId: 'pi-call-1',
      toolName: 'write',
      input: { path: join(workspace, 'src', 'deny.ts'), content: 'secret' },
    },
    ctx,
  ) as { block?: boolean; reason?: string } | undefined;
  assert.equal(result?.block, true);
  assert.equal(result?.reason, 'amos_managed_denied');
  assert.equal(existsSync(join(workspace, 'src', 'deny.ts')), false);
  const entries = journal(managedAudit);
  assert.equal(entries[0]?.event, 'authorization');
  assert.equal(entries[0]?.decision, 'deny');
  assert.equal(entries[1]?.status, 'stopped');
});

test('projection v2 disables Pi without loading activation or configuration', async (t) => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = realpathSync(mkdtempSync(join('/tmp/opencode', 'amos-pi-disabled-')));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  const auditDir = join(root, 'audit');
  mkdirSync(auditDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const base = compilerOptions();
  const snapshot = createProjectActivationCompiler(base).compile(
    projectInput({ projectId: 'pi-disabled-project', workspace }),
  );
  const configDigest = `sha256:${'d'.repeat(64)}`;
  writeFileSync(
    join(workspace, '.pi', 'amos.managed.json'),
    JSON.stringify({
      format: 'amos-managed-host-projection',
      version: 2,
      projectId: 'pi-disabled-project',
      workspace,
      policyVersion: snapshot.project.projectConfigVersion,
      activationDigest: snapshot.activationDigest,
      epoch: snapshot.epoch,
      publishedAt: new Date().toISOString(),
      kind: 'publish',
      configDigest,
      harness: { enabled: false, mode: 'managed', advisoryInjection: true },
      activation: { snapshotPath: '.pi/activation.json', projectId: 'pi-disabled-project' },
      managed: {
        enabled: false,
        auditPath: join(auditDir, 'managed.jsonl'),
        requirementEgress: 'denied',
        grantTtlMs: 20_000,
        review: null,
      },
      workflowGate: {
        enabled: false,
        guidance: false,
        shellGate: false,
        completionReview: false,
        jevConfigPath: null,
        actionAssessment: false,
        requirementEgress: 'denied',
      },
      tightening: { enabled: false },
      rollout: { thresholds: null, thresholdsByRule: {}, ruleStates: {} },
    }),
  );
  assert.equal(readHostProjection(workspace).status, 'ready');

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  amosPiLogOnly(pi);
  const ctx = { cwd: workspace };
  handlers.get('session_start')?.({ type: 'session_start', reason: 'new' }, ctx);
  const sections: Record<string, string> = {};
  handlers.get('before_agent_start')?.({
    messageType: 'user',
    prompt: 'write a file',
    systemPromptOptions: { sections },
  }, ctx);
  assert.deepEqual(sections, {});
  // A config rewrite is not a mid-session kill switch or mode mix. This load
  // remains pinned to the valid disabled projection accepted above.
  const reloaded = JSON.parse(readFileSync(
    join(workspace, '.pi', 'amos.managed.json'),
    'utf8',
  )) as Record<string, unknown>;
  reloaded.harness = { enabled: true, mode: 'managed', advisoryInjection: true };
  (reloaded.managed as Record<string, unknown>).enabled = true;
  writeFileSync(join(workspace, '.pi', 'amos.managed.json'), JSON.stringify(reloaded));
  const result = await handlers.get('tool_call')?.({
    type: 'tool_call',
    toolCallId: 'pi-disabled-call',
    toolName: 'write',
    input: { path: join(workspace, 'file.ts'), content: 'not logged' },
  }, ctx);
  assert.equal(result, undefined);
  const report = JSON.parse(readFileSync(
    join(workspace, '.pi', 'runtime.pi.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(report.mode, 'disabled');
  assert.equal(report.configDigest, configDigest);
  assert.equal(existsSync(join(auditDir, 'managed.jsonl')), false);

  const secondCtx = {
    cwd: workspace,
    sessionManager: { getSessionId: () => 'pi-second-session' },
  };
  handlers.get('session_start')?.({ type: 'session_start', reason: 'new' }, secondCtx);
  const second = await handlers.get('tool_call')?.({
    type: 'tool_call',
    toolCallId: 'pi-second-call',
    toolName: 'write',
    input: { path: join(workspace, 'second.ts'), content: 'blocked' },
  }, secondCtx) as { block?: boolean; reason?: string } | undefined;
  assert.equal(second?.block, true);
  assert.equal(second?.reason, 'amos_managed_config_error');
});
