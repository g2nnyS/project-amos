import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createProjectActivationCompiler } from '../../activation/compiler.ts';
import {
  entry,
  options as compilerOptions,
  project as projectInput,
} from '../../activation/test-support.ts';
import type { VersionedRule } from '../../activation/types.ts';
import { createOpenCodeV2Plugin } from './index.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly auditDir: string;
  readonly managedAudit: string;
  readonly snapshot: ReturnType<ReturnType<typeof createProjectActivationCompiler>['compile']>;
}

function rule(
  id: string,
  onHit: 'deny' | 'confirm' | 'log',
  target: string,
): VersionedRule {
  return entry(id, {
    level: 1,
    on_hit: onHit,
    predicate: [
      { op: 'op_in', args: { operations: ['file_write'] } },
      {
        op: 'target_glob',
        args: { patterns: [`\${SESSION_WORKSPACE}/${target}`] },
      },
    ],
  });
}

function createFixture(rules: readonly VersionedRule[]): Fixture {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = realpathSync(mkdtempSync(join('/tmp/opencode', 'amos-opencode-managed-')));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  const auditDir = join(root, 'audit');
  mkdirSync(auditDir, { recursive: true });

  const base = compilerOptions();
  const compiler = createProjectActivationCompiler({
    ...base,
    rules: [...base.rules, ...rules],
  });
  const snapshot = compiler.compile(
    projectInput({
      projectId: 'opencode-project',
      workspace,
      selectedRuleRefs: rules.map(({ id, version }) => ({ id, version })),
    }),
  );
  writeFileSync(join(workspace, '.pi', 'activation.json'), JSON.stringify(snapshot));
  return {
    root,
    workspace,
    auditDir,
    managedAudit: join(auditDir, 'managed.jsonl'),
    snapshot,
  };
}

function managedOptions(fixture: Fixture): Record<string, unknown> {
  return {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(fixture.auditDir, 'shadow.jsonl'),
    activation: { snapshotPath: '.pi/activation.json', projectId: 'opencode-project' },
    managed: {
      enabled: true,
      auditPath: fixture.managedAudit,
      requirementEgress: 'denied',
    },
  };
}

function projection(fixture: Fixture): Record<string, unknown> {
  return {
    format: 'amos-managed-host-projection',
    version: 1,
    projectId: 'opencode-project',
    workspace: fixture.workspace,
    policyVersion: fixture.snapshot.project.projectConfigVersion,
    activationDigest: fixture.snapshot.activationDigest,
    epoch: fixture.snapshot.epoch,
    publishedAt: new Date().toISOString(),
    kind: 'publish',
    activation: { snapshotPath: '.pi/activation.json', projectId: 'opencode-project' },
    managed: {
      enabled: true,
      auditPath: fixture.managedAudit,
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
  };
}

async function setup(
  t: any,
  options: Record<string, unknown>,
): Promise<{
  readonly call: (name: string, event: Record<string, unknown>) => Promise<unknown>;
  readonly cleanup: () => Promise<void>;
  readonly hooks: Map<string, (event: any) => unknown>;
}> {
  const hooks = new Map<string, (event: any) => unknown>();
  const cleanup = await createOpenCodeV2Plugin().setup({
    location: { directory: String((options as { workspace?: string }).workspace ?? '') },
    options,
    tool: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        hooks.set(name, callback);
        return { dispose: async () => undefined };
      },
    },
  } as never);
  t.after(async () => {
    await cleanup();
  });
  return {
    hooks,
    cleanup,
    async call(name, event) {
      const callback = hooks.get(name);
      assert.ok(callback, `tool.${name} must be registered`);
      return callback(event);
    },
  };
}

function journal(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeEvent(fixture: Fixture, name: string, id: string): Record<string, unknown> {
  return {
    tool: 'write',
    input: { path: join(fixture.workspace, 'src', name), content: 'secret' },
    sessionID: 'session-1',
    id,
  };
}

test('managed deny blocks before execution, writes a journal, and reports runtime', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const options = { ...managedOptions(fixture), workspace: fixture.workspace };
  const plugin = await setup(t, options);
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'deny.ts', 'call-1')),
    (error: unknown) => String(error).includes('amos_managed_denied'),
  );
  assert.equal(existsSync(join(fixture.workspace, 'src', 'deny.ts')), false);
  const entries = journal(fixture.managedAudit);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.event, 'authorization');
  assert.equal(entries[0]?.decision, 'deny');
  assert.deepEqual(entries[0]?.matchedRuleIds, ['deny-write']);
  assert.equal(entries[1]?.event, 'result');
  assert.equal(entries[1]?.status, 'stopped');
  const report = JSON.parse(
    readFileSync(join(fixture.workspace, '.pi', 'runtime.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(report.harness, 'opencode');
  assert.equal(report.mode, 'enforcing');
  assert.equal(report.activationDigest, fixture.snapshot.activationDigest);
});

test('managed allow records an executed result on execute.after', async (t) => {
  const fixture = createFixture([rule('other-write', 'deny', 'src/other.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const plugin = await setup(t, { ...managedOptions(fixture), workspace: fixture.workspace });
  await plugin.call('execute.before', writeEvent(fixture, 'allowed.ts', 'call-2'));
  await plugin.call('execute.after', {
    ...writeEvent(fixture, 'allowed.ts', 'call-2'),
    status: 'completed',
  });
  const entries = journal(fixture.managedAudit);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.decision, 'allow');
  assert.equal(entries[1]?.event, 'result');
  assert.equal(entries[1]?.status, 'executed');
});

test('managed confirm without a reviewer fails closed', async (t) => {
  const fixture = createFixture([rule('confirm-write', 'confirm', 'src/confirm.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const plugin = await setup(t, { ...managedOptions(fixture), workspace: fixture.workspace });
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'confirm.ts', 'call-3')),
    (error: unknown) => String(error).includes('amos_managed_review_unavailable'),
  );
  const entries = journal(fixture.managedAudit);
  assert.equal(entries[0]?.decision, 'confirm_required');
  assert.equal(entries[1]?.status, 'stopped');
});

test('managed coverage gaps and missing call ids are blocked', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const plugin = await setup(t, { ...managedOptions(fixture), workspace: fixture.workspace });
  await assert.rejects(
    plugin.call('execute.before', {
      tool: 'shell',
      input: { command: 'echo secret' },
      sessionID: 'session-1',
      id: 'call-4',
    }),
    (error: unknown) => String(error).includes('amos_managed_coverage_gap'),
  );
  await assert.rejects(
    plugin.call('execute.before', {
      ...writeEvent(fixture, 'deny.ts', 'call-5'),
      id: undefined,
    }),
    (error: unknown) => String(error).includes('amos_managed_missing_call_id'),
  );
});

test('a generated managed projection overrides hand-written options', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify(projection(fixture)),
  );
  const plugin = await setup(t, {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(fixture.auditDir, 'shadow.jsonl'),
    workspace: fixture.workspace,
  });
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'deny.ts', 'call-6')),
    (error: unknown) => String(error).includes('amos_managed_denied'),
  );
  assert.equal(existsSync(join(fixture.workspace, 'src', 'deny.ts')), false);
});

test('an invalid managed projection fails closed', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify({ format: 'amos-managed-host-projection', version: 1 }),
  );
  const plugin = await setup(t, {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(fixture.auditDir, 'shadow.jsonl'),
    workspace: fixture.workspace,
  });
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'deny.ts', 'call-7')),
    (error: unknown) => String(error).includes('amos_managed_config_error'),
  );
});
