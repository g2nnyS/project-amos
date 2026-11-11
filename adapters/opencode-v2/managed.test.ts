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
  failAuditRegistration = false,
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
        if (failAuditRegistration && name === 'execute.before') throw new Error('fixture registration failure');
        hooks.set(name, callback);
        return { dispose: async () => undefined };
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        hooks.set(`session.${name}`, callback);
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

test('projection v2 reports disabled without observer or managed side effects', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const projected = projection(fixture);
  projected.version = 2;
  projected.configDigest = `sha256:${'a'.repeat(64)}`;
  projected.harness = { enabled: false, mode: 'managed', advisoryInjection: true };
  projected.managed = {
    ...(projected.managed as Record<string, unknown>),
    enabled: false,
  };
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify(projected),
  );
  const plugin = await setup(t, {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(fixture.auditDir, 'shadow.jsonl'),
    workspace: fixture.workspace,
  });
  await plugin.call('execute.before', writeEvent(fixture, 'deny.ts', 'call-disabled'));
  assert.equal(existsSync(join(fixture.auditDir, 'shadow.jsonl')), false);
  assert.equal(existsSync(fixture.managedAudit), false);
  const report = JSON.parse(readFileSync(
    join(fixture.workspace, '.pi', 'runtime.opencode.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(report.mode, 'disabled');
  assert.equal(report.configDigest, projected.configDigest);
});

test('projection v2 log-only loads the observer without enforcing', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const projected = projection(fixture);
  projected.version = 2;
  projected.configDigest = `sha256:${'b'.repeat(64)}`;
  projected.harness = { enabled: true, mode: 'log-only', advisoryInjection: false };
  projected.managed = {
    ...(projected.managed as Record<string, unknown>),
    enabled: false,
  };
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify(projected),
  );
  const plugin = await setup(t, {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(fixture.auditDir, 'shadow.jsonl'),
    workspace: fixture.workspace,
  });
  await plugin.call('execute.before', writeEvent(fixture, 'deny.ts', 'call-log-only'));
  assert.equal(journal(join(fixture.auditDir, 'shadow.jsonl')).length, 1);
  assert.equal(existsSync(fixture.managedAudit), false);
  const report = JSON.parse(readFileSync(
    join(fixture.workspace, '.pi', 'runtime.opencode.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(report.mode, 'log-only');
  assert.equal(report.configDigest, projected.configDigest);
});

test('log-only receipts require successful observer hook registration', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const projected = projection(fixture);
  projected.version = 2;
  projected.configDigest = `sha256:${'f'.repeat(64)}`;
  projected.harness = { enabled: true, mode: 'log-only', advisoryInjection: false };
  projected.managed = {
    ...(projected.managed as Record<string, unknown>),
    enabled: false,
  };
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify(projected),
  );
  await setup(t, {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(fixture.auditDir, 'shadow.jsonl'),
    workspace: fixture.workspace,
  }, true);
  assert.equal(existsSync(join(fixture.workspace, '.pi', 'runtime.opencode.json')), false);
});

test('projection v2 rejects contradictory managed and harness modes', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const projected = projection(fixture);
  projected.version = 2;
  projected.configDigest = `sha256:${'c'.repeat(64)}`;
  projected.harness = { enabled: true, mode: 'log-only', advisoryInjection: false };
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify(projected),
  );
  const plugin = await setup(t, {
    ...managedOptions(fixture),
    workspace: fixture.workspace,
  });
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'deny.ts', 'call-contradictory')),
    (error: unknown) => String(error).includes('amos_managed_config_error'),
  );
});

test('projection v2 advisory suppression never disables managed denial', async (t) => {
  const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const projected = projection(fixture);
  projected.version = 2;
  projected.configDigest = `sha256:${'e'.repeat(64)}`;
  projected.harness = { enabled: true, mode: 'managed', advisoryInjection: false };
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify(projected),
  );
  const plugin = await setup(t, {
    ...managedOptions(fixture),
    workspace: fixture.workspace,
  });
  // Prompt capture remains available for Managed requirements; advisory context
  // emission is not registered when no independent completion review needs it.
  assert.equal(plugin.hooks.has('session.prompt'), true);
  assert.equal(plugin.hooks.has('session.context'), false);
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'deny.ts', 'call-no-advisory')),
    (error: unknown) => String(error).includes('amos_managed_denied'),
  );
  const entries = journal(fixture.managedAudit);
  assert.equal(entries[0]?.decision, 'deny');
  assert.equal(entries[1]?.status, 'stopped');
  const report = JSON.parse(readFileSync(
    join(fixture.workspace, '.pi', 'runtime.opencode.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(report.mode, 'enforcing');
  assert.equal(report.configDigest, projected.configDigest);
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

test('a legacy managed reviewer config stops with an explicit migration code', async (t) => {
  const fixture = createFixture([rule('confirm-write', 'confirm', 'src/confirm.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const plugin = await setup(t, {
    ...managedOptions(fixture),
    workspace: fixture.workspace,
    managed: {
      enabled: true,
      auditPath: fixture.managedAudit,
      requirementEgress: 'allowed',
      review: {
        endpoint: 'http://127.0.0.1:1/review',
        model: 'legacy-reviewer',
        apiKeyEnv: 'LEGACY_REVIEW_KEY',
        policy: { id: 'policy_1' },
        calibration: null,
        ceilingDigest: `sha256:${'e'.repeat(64)}`,
      },
    },
  });
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'confirm.ts', 'call-legacy')),
    (error: unknown) => String(error).includes('reviewer_migration_required'),
  );
  assert.equal(existsSync(fixture.managedAudit), false);
});

test('a legacy reviewer in a generated projection preserves the migration code', async (t) => {
  const fixture = createFixture([rule('confirm-write', 'confirm', 'src/confirm.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const legacy = projection(fixture);
  legacy.managed = {
    ...(legacy.managed as Record<string, unknown>),
    review: {
      endpoint: 'http://127.0.0.1:9/review',
      model: 'legacy-reviewer',
      apiKeyEnv: 'AMOS_REVIEW_KEY',
    },
  };
  writeFileSync(
    join(fixture.workspace, '.pi', 'amos.managed.json'),
    JSON.stringify(legacy),
  );
  const plugin = await setup(t, {
    ...managedOptions(fixture),
    workspace: fixture.workspace,
  });
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'confirm.ts', 'call-legacy-projection')),
    (error: unknown) => String(error).includes('amos_managed_reviewer_migration_required'),
  );
  assert.equal(existsSync(fixture.managedAudit), false);
});

test('a Jev reviewer config with an unreadable config file fails closed', async (t) => {
  const fixture = createFixture([rule('confirm-write', 'confirm', 'src/confirm.ts')]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const polish = {
    id: 'policy_1',
    model: 'jev-latest',
    questionVersion: 'jev-questions/v2',
    minConfidence: 0.7,
    maxRisk: 0.5,
    timeoutMs: 2_000,
    maxAttempts: 1 as const,
    requirementEgress: 'allowed' as const,
    targetEgress: 'workspace-relative' as const,
    minimumCases: 2,
    maximumFalseAllowRate: 0,
    expiresAt: Date.now() + 3_600_000,
    policyDigest: `sha256:${'d'.repeat(64)}`,
  };
  const plugin = await setup(t, {
    ...managedOptions(fixture),
    workspace: fixture.workspace,
    managed: {
      enabled: true,
      auditPath: fixture.managedAudit,
      requirementEgress: 'allowed',
      review: {
        reviewer: 'jev',
        jevConfigPath: join(fixture.root, 'missing-jev.local.json'),
        policy: polish,
        calibration: {
          format: 'amos-review-calibration',
          version: 1,
          model: 'jev-latest',
          questionVersion: 'jev-questions/v2',
          policyDigest: polish.policyDigest,
          caseSetDigest: `sha256:${'f'.repeat(64)}`,
          cases: 10,
          unsafeCases: 4,
          falseAllows: 0,
          evaluatedAt: Date.now() - 1_000,
          expiresAt: Date.now() + 3_600_000,
        },
        ceilingDigest: `sha256:${'e'.repeat(64)}`,
      },
    },
  });
  await assert.rejects(
    plugin.call('execute.before', writeEvent(fixture, 'confirm.ts', 'call-jev')),
    (error: unknown) => String(error).includes('amos_managed_reviewer_unavailable'),
  );
});
