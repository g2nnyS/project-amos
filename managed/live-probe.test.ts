/**
 * Live probe boundary checks: the probe reads the publication artifact the
 * governance process wrote into its own workspace and rejects anything that is
 * not a bounded project identity, version and digest.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { knownRuntimeState, readPublishedActivation } from './live-probe.ts';

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'amos-live-probe-test-'));
  roots.push(root);
  return root;
}

function activation(
  projectWorkspace: string,
  overrides: Record<string, unknown> = {},
  projectOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: 'amos-unified-rule-catalog',
    formatVersion: 2,
    project: {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      workspace: projectWorkspace,
      projectConfigVersion: 'policy-v1',
      baseVersion: 'base-v0',
      epoch: 1,
      selectedRuleRefs: [],
      excludedRuleIds: [],
      advisoryBaselineRuleIds: [],
      routes: [],
      ...projectOverrides,
    },
    activationDigest: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

function write(dir: string, value: unknown): void {
  mkdirSync(join(dir, '.pi'), { recursive: true });
  writeFileSync(
    join(dir, '.pi', 'activation.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

describe('readPublishedActivation', () => {
  test('returns the bounded identity from the published snapshot', () => {
    const dir = workspace();
    write(dir, activation(dir));
    assert.deepEqual(readPublishedActivation(dir), {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      version: 1,
      policyVersion: 'policy-v1',
      activationDigest: `sha256:${'a'.repeat(64)}`,
    });
  });

  test('fails closed when the artifact is missing or not JSON', () => {
    const missing = workspace();
    assert.throws(() => readPublishedActivation(missing), {
      message: 'activation_artifact_unreadable',
    });
    const invalid = workspace();
    write(invalid, '{not json');
    assert.throws(() => readPublishedActivation(invalid), {
      message: 'activation_artifact_unreadable',
    });
  });

  test('rejects hostile project identifiers', () => {
    for (const projectId of [
      '../../../etc/passwd',
      'a/b',
      'C:\\windows',
      ' id',
      'id\n',
      '',
      'x'.repeat(129),
      42,
      null,
    ]) {
      const dir = workspace();
      write(dir, activation(dir, {}, { projectId }));
      assert.throws(() => readPublishedActivation(dir), {
        message: 'activation_artifact_invalid',
      });
    }
  });

  test('rejects an artifact bound to another workspace', () => {
    const dir = workspace();
    write(dir, activation('/tmp/other-workspace'));
    assert.throws(() => readPublishedActivation(dir), {
      message: 'activation_artifact_invalid',
    });
  });

  test('rejects a workspace path that only shares a prefix', () => {
    const dir = workspace();
    write(dir, activation(`${dir}-sibling`));
    assert.throws(() => readPublishedActivation(dir), {
      message: 'activation_artifact_invalid',
    });
  });

  test('rejects versions that are not positive safe integers', () => {
    for (const epoch of [0, -1, 1.5, 2 ** 53, '1']) {
      const dir = workspace();
      write(dir, activation(dir, {}, { epoch }));
      assert.throws(() => readPublishedActivation(dir), {
        message: 'activation_artifact_invalid',
      });
    }
  });

  test('binds the policy version to the published version', () => {
    for (const projectConfigVersion of [
      'policy-v0',
      'policy-v2',
      'policy-v1\n',
      'policy-v1/../../x',
      'base-v1',
      '',
    ]) {
      const dir = workspace();
      write(dir, activation(dir, {}, { projectConfigVersion }));
      assert.throws(() => readPublishedActivation(dir), {
        message: 'activation_artifact_invalid',
      });
    }
  });

  test('rejects digests outside the fixed sha256 shape', () => {
    for (const activationDigest of [
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(64)}\n`,
      'sha256:zz',
      `../${'a'.repeat(64)}`,
      42,
      null,
    ]) {
      const dir = workspace();
      write(dir, activation(dir, { activationDigest }));
      assert.throws(() => readPublishedActivation(dir), {
        message: 'activation_artifact_invalid',
      });
    }
  });

  test('rejects an artifact with the wrong format identity', () => {
    for (const overrides of [
      { format: 'other' },
      { formatVersion: 1 },
      { project: null },
      { project: [] },
    ]) {
      const dir = workspace();
      write(dir, activation(dir, overrides));
      assert.throws(() => readPublishedActivation(dir), {
        message: 'activation_artifact_invalid',
      });
    }
    const array = workspace();
    write(array, '[]');
    assert.throws(() => readPublishedActivation(array), {
      message: 'activation_artifact_invalid',
    });
  });
});

describe('knownRuntimeState', () => {
  test('normalizes every closed runtime state to itself', () => {
    for (const value of [
      'unpublished',
      'never',
      'loaded',
      'loaded-unverified',
      'stale',
      'invalid',
    ]) {
      assert.equal(knownRuntimeState(value), value);
    }
  });

  test('rejects values outside the closed set', () => {
    for (const value of [
      'loaded\n',
      ' loaded',
      'LOADED',
      '../loaded',
      '',
      'ready',
      42,
      null,
      undefined,
      {},
    ]) {
      assert.equal(knownRuntimeState(value), null);
    }
  });
});
