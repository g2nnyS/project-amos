import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { MANDATORY_LEGACY_RULE_REFS } from '../catalog/migration-map.ts';
import { loadActivationRuntime } from '../adapters/shared/activation-guidance.ts';
import { writeHarnessRuntimeReport } from '../adapters/shared/runtime-report.ts';
import type { Candidate, ControlPlane, PublishedVersion, RuleRecord } from './contracts.ts';
import { writeActivationArtifact } from './cli.ts';
import { serializePolicyDocument, parsePolicyDocument } from './document.ts';
import { readRuntimeStatus } from './runtime-status.ts';
import { createControlPlane } from './store.ts';
import {
  createTestClock,
  futureIso,
  human,
  makeAdvisoryRule,
  makeRule,
  readSchema,
  type TestClock,
} from './test-helpers.ts';

const RULES = join(process.cwd(), 'constraints', 'rules.yaml');
const GUIDANCE = join(process.cwd(), 'guidance', 'packs.ts');

interface Fixture {
  readonly cp: ControlPlane;
  readonly clock: TestClock;
  readonly workspace: string;
  readonly root: string;
}

function fixture(t: TestContext, global = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'amos-publication-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = createTestClock();
  const cp = createControlPlane({
    databasePath: join(root, 'governance.sqlite'),
    rawSchema: readSchema(),
    ...(global
      ? {
          rulesYaml: readFileSync(RULES, 'utf8'),
          guidanceSource: readFileSync(GUIDANCE, 'utf8'),
        }
      : {}),
    publishArtifact: (input) => writeActivationArtifact(input),
    now: clock.now,
  });
  t.after(() => cp.close());
  return { cp, clock, workspace, root };
}

function projectRule(id = 'project-e2e', overrides: Partial<RuleRecord> = {}): RuleRecord {
  return makeRule(id, {
    dimension: 'project',
    narrative: 'Project-specific rule.',
    on_hit: 'log',
    source: {
      repo: 'local-project',
      rev: 'v1',
      path: '.pi/amos.json',
      section: 'project rule',
      lines: '1',
      quote: 'project-authored rule',
    },
    probe: 'project-authored rule',
    ...overrides,
  });
}

function publish(
  cp: ControlPlane,
  clock: TestClock,
  projectId: string,
  candidate: Candidate,
  baseVersion = 0,
): PublishedVersion {
  const proposal = cp.createProposal(
    projectId,
    {
      title: 'Publication fixture',
      rationale: 'Synthetic publication fixture.',
      baseVersion,
      expiresAt: futureIso(clock),
      candidate,
    },
    human(),
  );
  const approved = cp.decideProposal(
    proposal.id,
    {
      decision: 'approve',
      note: 'approved fixture',
      expectedDigest: proposal.digest,
    },
    human(),
  );
  assert.equal(approved.publishedVersion, baseVersion + 1);
  return cp.getVersion(projectId, baseVersion + 1);
}

test('publication compiles the P1 snapshot, writes a loadable artifact, and binds the mandatory baseline', (t) => {
  const { cp, clock, workspace } = fixture(t);
  const project = cp.createProject({ name: 'Publication', workspace }, human());
  const published = publish(cp, clock, project.id, {
    rules: [projectRule()],
    activation: { includedRuleIds: null, excludedRuleIds: [] },
  });

  const activation = published.snapshot.activationSnapshot;
  assert.equal(activation.format, 'amos-unified-rule-catalog');
  assert.equal(activation.project.projectId, project.id);
  assert.equal(activation.project.workspace, workspace);
  assert.equal(activation.project.projectConfigVersion, 'policy-v1');
  assert.equal(activation.epoch, 1);
  assert.equal(published.snapshot.digest, activation.digest);
  assert.equal(published.snapshot.activationDigest, activation.activationDigest);

  const runtimeIds = activation.enforcement.runtime.ruleRefs.map((ref) => ref.id);
  for (const ref of MANDATORY_LEGACY_RULE_REFS) {
    assert.ok(
      activation.activeRules.find((entry) => entry.id === ref.id)?.mandatory,
      `missing mandatory baseline ${ref.id}`,
    );
  }
  assert.ok(runtimeIds.includes('project-e2e'));

  const artifactPath = join(workspace, '.pi', 'activation.json');
  const artifact = readFileSync(artifactPath, 'utf8');
  assert.equal(artifact.endsWith('\n'), true);
  const parsed = JSON.parse(artifact) as unknown;
  assert.equal((parsed as { activationDigest: string }).activationDigest, activation.activationDigest);
  const loaded = loadActivationRuntime({
    snapshotPath: artifactPath,
    projectId: project.id,
    workspace,
  });
  assert.equal(loaded.status, 'ready');
  if (loaded.status === 'ready') {
    assert.equal(loaded.runtime.epoch, 1);
    assert.equal(loaded.runtime.execution('runtime').digest, activation.enforcement.runtime.digest);
  }
});

test('a project cannot redefine a global deny or exclude the mandatory baseline', (t) => {
  const { cp, clock, workspace } = fixture(t);
  const project = cp.createProject({ name: 'Conflicts', workspace }, human());

  const globalRules = parseYaml(readFileSync(RULES, 'utf8')) as RuleRecord[];
  const firstId = globalRules.find((rule) => rule.on_hit === 'deny')!.id;
  const modified = projectRule(firstId, { on_hit: 'log' });
  const validation = cp.validateCandidate(project.id, {
    rules: [modified],
    activation: { includedRuleIds: null, excludedRuleIds: [] },
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === 'global_rule_conflict'));

  const mandatoryId = MANDATORY_LEGACY_RULE_REFS[0]!.id;
  const exclusion = cp.validateCandidate(project.id, {
    rules: [projectRule()],
    activation: { includedRuleIds: null, excludedRuleIds: [mandatoryId] },
  });
  assert.equal(exclusion.valid, false);
  assert.ok(exclusion.issues.some((issue) => issue.code === 'mandatory_exclusion'));

  assert.throws(
    () =>
      cp.createProposal(
        project.id,
        {
          title: 'Conflict',
          rationale: 'Must not publish.',
          baseVersion: 0,
          expiresAt: futureIso(clock),
          candidate: {
            rules: [modified],
            activation: { includedRuleIds: null, excludedRuleIds: [] },
          },
        },
        human(),
      ),
    (error: unknown) => (error as { code?: string }).code === 'candidate_invalid',
  );
});

test('two projects publish isolated snapshots and rollback creates a new version', (t) => {
  const { cp, clock, workspace } = fixture(t);
  const first = cp.createProject({ name: 'Alpha', workspace }, human());
  const secondWorkspace = join(workspace, '..', 'workspace-two');
  mkdirSync(secondWorkspace, { recursive: true });
  const second = cp.createProject({ name: 'Beta', workspace: secondWorkspace }, human());

  const alpha = publish(cp, clock, first.id, {
    rules: [projectRule('alpha-rule')],
    activation: { includedRuleIds: null, excludedRuleIds: [] },
  });
  const beta = publish(cp, clock, second.id, {
    rules: [projectRule('beta-rule')],
    activation: { includedRuleIds: null, excludedRuleIds: [] },
  });
  assert.notEqual(alpha.snapshot.activationDigest, beta.snapshot.activationDigest);
  assert.notEqual(alpha.snapshot.activationSnapshot.project.projectId, beta.snapshot.activationSnapshot.project.projectId);
  assert.ok(alpha.snapshot.enforcement.ruleIds.includes('alpha-rule'));
  assert.equal(alpha.snapshot.enforcement.ruleIds.includes('beta-rule'), false);

  const rollback = cp.createRollbackProposal(
    first.id,
    alpha.version,
    {
      title: 'Rollback Alpha',
      rationale: 'Restore a new recorded version.',
      baseVersion: alpha.version,
      expiresAt: futureIso(clock),
    },
    human(),
  );
  const approved = cp.decideProposal(
    rollback.id,
    {
      decision: 'approve',
      note: 'rollback approved',
      expectedDigest: rollback.digest,
    },
    human(),
  );
  assert.equal(approved.publishedVersion, 2);
  const secondVersion = cp.getVersion(first.id, 2);
  assert.equal(secondVersion.snapshot.activationSnapshot.project.projectConfigVersion, 'policy-v2');
  assert.equal(cp.getVersion(first.id, 1).snapshot.activationDigest, alpha.snapshot.activationDigest);
});

test('YAML document round-trips rules, activation, and injection metadata', (t) => {
  const { cp, clock, workspace } = fixture(t);
  const project = cp.createProject({ name: 'Document', workspace }, human());
  const published = publish(cp, clock, project.id, {
    rules: [projectRule(), makeAdvisoryRule('advice-e2e')],
    activation: { includedRuleIds: null, excludedRuleIds: [] },
    injection: {
      baselineRuleIds: [],
      routes: [
        {
          match: { taskTag: 'docs' },
          add: ['advice-e2e'],
          suppress: [],
          specificity: 1,
        },
      ],
    },
  });
  const text = serializePolicyDocument(published);
  const parsed = parsePolicyDocument(text);
  assert.equal(parsed.projectId, project.id);
  assert.equal(parsed.workspace, workspace);
  assert.deepEqual(parsed.candidate.activation, published.candidate.activation);
  assert.deepEqual(parsed.candidate.rules, published.candidate.rules);
  assert.deepEqual(parsed.candidate.injection, published.candidate.injection);
  assert.match(text, /format: amos-project-policy/);
  assert.match(text, /mandatoryBaseline|activation:/);
});

test('empty runtime projections stay legal and allow by default', (t) => {
  const { cp, clock, workspace } = fixture(t, false);
  const project = cp.createProject({ name: 'Advisory only', workspace }, human());
  const published = publish(cp, clock, project.id, {
    rules: [makeAdvisoryRule('advice-only')],
    activation: { includedRuleIds: ['advice-only'], excludedRuleIds: [] },
  });
  assert.equal(published.snapshot.activationSnapshot.enforcement.runtime.status, 'empty');
  assert.deepEqual(published.snapshot.enforcement.rules, []);
  const decision = cp.simulate(project.id, {
    action: { tool: 'write', operation: 'file_write', target: join(workspace, 'src/a.ts') },
  });
  assert.equal(decision.verdict, 'allow');
});

test('runtime status distinguishes loaded, stale, and never-loaded reports', (t) => {
  const { cp, clock, workspace } = fixture(t);
  const project = cp.createProject({ name: 'Runtime', workspace }, human());
  const published = publish(cp, clock, project.id, {
    rules: [projectRule()],
    activation: { includedRuleIds: null, excludedRuleIds: [] },
  });
  assert.equal(readRuntimeStatus(workspace, published).status, 'never');

  const report = {
    directory: workspace,
    projectId: project.id,
    activationDigest: published.snapshot.activationDigest,
    epoch: published.version,
    policyVersion: published.snapshot.activationSnapshot.project.projectConfigVersion,
    loadedAt: new Date().toISOString(),
  };
  assert.equal(writeHarnessRuntimeReport(report), true);
  const loaded = readRuntimeStatus(workspace, published);
  // A v1 receipt cannot be compared against a configuration digest.
  assert.equal(loaded.status, 'loaded-unverified');
  assert.equal(loaded.harnesses.pi.status, 'loaded-unverified');
  assert.equal(loaded.runtime?.activationDigest, published.snapshot.activationDigest);

  assert.equal(
    writeHarnessRuntimeReport({
      ...report,
      activationDigest: `sha256:${'0'.repeat(64)}`,
    }),
    true,
  );
  assert.equal(readRuntimeStatus(workspace, published).status, 'stale');
  writeFileSync(join(workspace, '.pi', 'runtime.json'), '{not-json', { mode: 0o600 });
  assert.equal(readRuntimeStatus(workspace, published).status, 'invalid');
  assert.equal(readRuntimeStatus(workspace, null).status, 'invalid');
});

test('runtime status isolates harness reports and binds configuration-only changes', (t) => {
  const { workspace } = fixture(t);
  const configDigest = `sha256:${'a'.repeat(64)}`;
  const expected = {
    projectId: 'runtime-project',
    version: 1,
    activationDigest: `sha256:${'b'.repeat(64)}`,
    epoch: 1,
    policyVersion: 'policy-v1',
    configDigest,
  };
  for (const harness of ['pi', 'opencode'] as const) {
    assert.equal(writeHarnessRuntimeReport({
      directory: workspace,
      projectId: expected.projectId,
      activationDigest: expected.activationDigest,
      epoch: 1,
      policyVersion: expected.policyVersion,
      loadedAt: new Date().toISOString(),
      harness,
      mode: harness === 'pi' ? 'log-only' : 'disabled',
      configDigest,
      capabilities: {},
    }), true);
  }
  const loaded = readRuntimeStatus(workspace, expected);
  assert.equal(loaded.harnesses.pi.status, 'loaded');
  assert.equal(loaded.harnesses.opencode.status, 'loaded');
  assert.equal(loaded.harnesses.pi.runtime?.mode, 'log-only');
  assert.equal(loaded.harnesses.opencode.runtime?.mode, 'disabled');

  const changed = readRuntimeStatus(workspace, expected, {
    ...expected,
    configDigest: `sha256:${'c'.repeat(64)}`,
  });
  assert.equal(changed.harnesses.pi.status, 'stale');
  assert.equal(changed.harnesses.opencode.status, 'stale');

  writeFileSync(join(workspace, '.pi', 'runtime.pi.json'), '{bad', { mode: 0o600 });
  const invalid = readRuntimeStatus(workspace, expected);
  assert.equal(invalid.harnesses.pi.status, 'invalid');
  assert.equal(invalid.harnesses.opencode.status, 'loaded');
});

test('v1 receipts match identity but cannot verify configuration', (t) => {
  const { workspace } = fixture(t);
  const configDigest = `sha256:${'a'.repeat(64)}`;
  const expected = {
    projectId: 'legacy-project',
    version: 1,
    activationDigest: `sha256:${'b'.repeat(64)}`,
    epoch: 1,
    policyVersion: 'policy-v1',
  };
  const base = {
    directory: workspace,
    projectId: expected.projectId,
    activationDigest: expected.activationDigest,
    epoch: expected.epoch,
    policyVersion: expected.policyVersion,
    loadedAt: new Date().toISOString(),
    harness: 'pi' as const,
  };
  assert.equal(writeHarnessRuntimeReport(base), true);

  // No expected digest is available, so identity is all that can be checked.
  const withoutExpectedDigest = readRuntimeStatus(workspace, expected);
  assert.equal(withoutExpectedDigest.harnesses.pi.status, 'loaded-unverified');
  assert.equal(withoutExpectedDigest.status, 'loaded-unverified');

  // An expected digest exists, but the receipt does not carry one to compare.
  const withExpectedDigest = readRuntimeStatus(workspace, { ...expected, configDigest });
  assert.equal(withExpectedDigest.harnesses.pi.status, 'loaded-unverified');
  assert.equal(withExpectedDigest.status, 'loaded-unverified');

  assert.equal(writeHarnessRuntimeReport({
    ...base,
    activationDigest: `sha256:${'0'.repeat(64)}`,
  }), true);
  const stale = readRuntimeStatus(workspace, { ...expected, configDigest });
  assert.equal(stale.harnesses.pi.status, 'stale');
  assert.equal(stale.status, 'stale');

  assert.equal(writeHarnessRuntimeReport({ ...base, projectId: 'other-project' }), true);
  assert.equal(
    readRuntimeStatus(workspace, { ...expected, configDigest }).harnesses.pi.status,
    'stale',
  );
});

test('v2 receipts require a matching configuration digest for loaded', (t) => {
  const { workspace } = fixture(t);
  const configDigest = `sha256:${'a'.repeat(64)}`;
  const expected = {
    projectId: 'verified-project',
    version: 1,
    activationDigest: `sha256:${'b'.repeat(64)}`,
    epoch: 1,
    policyVersion: 'policy-v1',
    configDigest,
  };
  for (const harness of ['pi', 'opencode'] as const) {
    assert.equal(writeHarnessRuntimeReport({
      directory: workspace,
      projectId: expected.projectId,
      activationDigest: expected.activationDigest,
      epoch: expected.epoch,
      policyVersion: expected.policyVersion,
      loadedAt: new Date().toISOString(),
      harness,
      mode: 'enforcing',
      configDigest,
      capabilities: {},
    }), true);
  }

  const loaded = readRuntimeStatus(workspace, expected);
  assert.equal(loaded.harnesses.pi.status, 'loaded');
  assert.equal(loaded.harnesses.opencode.status, 'loaded');
  assert.equal(loaded.status, 'loaded');

  const mismatched = readRuntimeStatus(workspace, {
    ...expected,
    configDigest: `sha256:${'c'.repeat(64)}`,
  });
  assert.equal(mismatched.harnesses.pi.status, 'stale');
  assert.equal(mismatched.harnesses.opencode.status, 'stale');
  assert.equal(mismatched.status, 'stale');

  // Without an expected digest the receipts stay unverified rather than loaded.
  const { configDigest: _ignored, ...withoutDigest } = expected;
  const unverified = readRuntimeStatus(workspace, withoutDigest);
  assert.equal(unverified.harnesses.pi.status, 'loaded-unverified');
  assert.equal(unverified.harnesses.opencode.status, 'loaded-unverified');
  assert.equal(unverified.status, 'loaded-unverified');

  // Identity mismatch wins even when the configuration digest matches.
  const wrongIdentity = readRuntimeStatus(workspace, { ...expected, projectId: 'other-project' });
  assert.equal(wrongIdentity.harnesses.pi.status, 'stale');
  assert.equal(wrongIdentity.status, 'stale');
});

test('runtime status aggregates mixed harness verification without merging into loaded', (t) => {
  const { workspace } = fixture(t);
  const configDigest = `sha256:${'a'.repeat(64)}`;
  const expected = {
    projectId: 'mixed-project',
    version: 1,
    activationDigest: `sha256:${'b'.repeat(64)}`,
    epoch: 1,
    policyVersion: 'policy-v1',
    configDigest,
  };

  // pi leaves a legacy v1 receipt; opencode has a fully verified v2 receipt.
  assert.equal(writeHarnessRuntimeReport({
    directory: workspace,
    projectId: expected.projectId,
    activationDigest: expected.activationDigest,
    epoch: expected.epoch,
    policyVersion: expected.policyVersion,
    loadedAt: new Date().toISOString(),
    harness: 'pi',
  }), true);
  assert.equal(writeHarnessRuntimeReport({
    directory: workspace,
    projectId: expected.projectId,
    activationDigest: expected.activationDigest,
    epoch: expected.epoch,
    policyVersion: expected.policyVersion,
    loadedAt: new Date().toISOString(),
    harness: 'opencode',
    mode: 'enforcing',
    configDigest,
    capabilities: {},
  }), true);

  const mixed = readRuntimeStatus(workspace, expected);
  assert.equal(mixed.harnesses.pi.status, 'loaded-unverified');
  assert.equal(mixed.harnesses.opencode.status, 'loaded');
  assert.equal(mixed.status, 'loaded-unverified');

  // A stale harness outranks an unverified one.
  assert.equal(writeHarnessRuntimeReport({
    directory: workspace,
    projectId: expected.projectId,
    activationDigest: `sha256:${'0'.repeat(64)}`,
    epoch: expected.epoch,
    policyVersion: expected.policyVersion,
    loadedAt: new Date().toISOString(),
    harness: 'pi',
  }), true);
  const stale = readRuntimeStatus(workspace, expected);
  assert.equal(stale.harnesses.pi.status, 'stale');
  assert.equal(stale.harnesses.opencode.status, 'loaded');
  assert.equal(stale.status, 'stale');

  // An invalid harness outranks every other state.
  writeFileSync(join(workspace, '.pi', 'runtime.opencode.json'), '{bad', { mode: 0o600 });
  const invalid = readRuntimeStatus(workspace, expected);
  assert.equal(invalid.harnesses.pi.status, 'stale');
  assert.equal(invalid.harnesses.opencode.status, 'invalid');
  assert.equal(invalid.status, 'invalid');
});

test('legacy receipts are only read when the harness has no specific receipt', (t) => {
  const { workspace } = fixture(t);
  const configDigest = `sha256:${'a'.repeat(64)}`;
  const expected = {
    projectId: 'fallback-project',
    version: 1,
    activationDigest: `sha256:${'b'.repeat(64)}`,
    epoch: 1,
    policyVersion: 'policy-v1',
    configDigest,
  };

  // pi has a specific v2 receipt; opencode can only fall back to the legacy one.
  assert.equal(writeHarnessRuntimeReport({
    directory: workspace,
    projectId: expected.projectId,
    activationDigest: expected.activationDigest,
    epoch: expected.epoch,
    policyVersion: expected.policyVersion,
    loadedAt: new Date().toISOString(),
    harness: 'pi',
    mode: 'enforcing',
    configDigest,
    capabilities: {},
  }), true);
  assert.equal(writeHarnessRuntimeReport({
    directory: workspace,
    projectId: expected.projectId,
    activationDigest: expected.activationDigest,
    epoch: expected.epoch,
    policyVersion: expected.policyVersion,
    loadedAt: new Date().toISOString(),
    harness: 'opencode',
  }), true);

  const mixed = readRuntimeStatus(workspace, expected);
  assert.equal(mixed.harnesses.pi.status, 'loaded');
  assert.equal(mixed.harnesses.opencode.status, 'loaded-unverified');
  assert.equal(mixed.status, 'loaded-unverified');

  // A corrupt legacy file invalidates only the harness that falls back to it.
  writeFileSync(join(workspace, '.pi', 'runtime.json'), '{bad', { mode: 0o600 });
  const isolated = readRuntimeStatus(workspace, expected);
  assert.equal(isolated.harnesses.pi.status, 'loaded');
  assert.equal(isolated.harnesses.opencode.status, 'invalid');
  assert.equal(isolated.status, 'invalid');
});
