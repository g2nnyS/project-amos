import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWorkflowGateConfig, WorkflowConfigError } from './config.ts';

const BASE = '/work/repo';

function expectError(value: unknown): void {
  assert.throws(
    () => parseWorkflowGateConfig(value, BASE),
    (error: unknown) => error instanceof WorkflowConfigError,
  );
}

test('missing workflow config means disabled', () => {
  assert.equal(parseWorkflowGateConfig(undefined, BASE), null);
  assert.equal(parseWorkflowGateConfig(null, BASE), null);
});

test('enabled config defaults each gate on and resolves local paths', () => {
  assert.deepEqual(
    parseWorkflowGateConfig(
      {
        enabled: true,
        jevConfigPath: './decision/jev.local.json',
      },
      BASE,
    ),
    {
      enabled: true,
      guidance: true,
      shellGate: true,
      completionReview: true,
      jevConfigPath: '/work/repo/decision/jev.local.json',
    },
  );
});

test('disabled config reports an inert frozen gate', () => {
  const config = parseWorkflowGateConfig({ enabled: false }, BASE);
  assert.ok(config);
  assert.equal(config.enabled, false);
  assert.equal(config.guidance, false);
  assert.equal(config.completionReview, false);
  assert.ok(Object.isFrozen(config));
});

test('enabled completion review requires a Jev config path', () => {
  expectError({ enabled: true });
  expectError({ enabled: true, completionReview: true });
});

test('invalid field types, unknown fields, and invalid base paths fail', () => {
  expectError({ enabled: 'yes' });
  expectError({ enabled: true, unknown: true });
  expectError({ enabled: true, guidance: 'yes' });
  expectError({ enabled: true, jevConfigPath: 3 });
  expectError({ enabled: true, jevConfigPath: ' ' });
  assert.throws(
    () => parseWorkflowGateConfig({ enabled: false }, 'relative'),
    WorkflowConfigError,
  );

  const valid = parseWorkflowGateConfig(
    {
      enabled: true,
      completionReview: false,
      guidance: false,
      shellGate: false,
    },
    BASE,
  );
  assert.equal(valid?.guidance, false);
  assert.equal(valid?.shellGate, false);
  assert.equal(valid?.completionReview, false);
  assert.equal(valid?.jevConfigPath, null);
});

test('completion review off does not require a Jev config', () => {
  const config = parseWorkflowGateConfig(
    { enabled: true, completionReview: false, shellGate: true },
    BASE,
  );
  assert.equal(config?.completionReview, false);
  assert.equal(config?.jevConfigPath, null);
});
