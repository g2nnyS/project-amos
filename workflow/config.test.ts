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
      actionAssessment: false,
      requirementEgress: 'denied',
    },
  );
});

test('disabled config reports an inert frozen gate', () => {
  const config = parseWorkflowGateConfig({ enabled: false }, BASE);
  assert.ok(config);
  assert.equal(config.enabled, false);
  assert.equal(config.guidance, false);
  assert.equal(config.completionReview, false);
  assert.equal(config.actionAssessment, false);
  assert.equal(config.requirementEgress, 'denied');
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

test('action assessment defaults off and requirement egress defaults denied', () => {
  const config = parseWorkflowGateConfig(
    { enabled: true, jevConfigPath: './jev.json' },
    BASE,
  );
  assert.equal(config?.actionAssessment, false);
  assert.equal(config?.requirementEgress, 'denied');
});

test('action assessment requires the shell gate and a Jev config path', () => {
  expectError({ enabled: true, actionAssessment: true });
  expectError({
    enabled: true,
    actionAssessment: true,
    shellGate: false,
    jevConfigPath: './jev.json',
  });
  expectError({
    enabled: true,
    actionAssessment: true,
    shellGate: true,
    jevConfigPath: null,
  });

  // Independent of completionReview.
  const config = parseWorkflowGateConfig(
    {
      enabled: true,
      completionReview: false,
      shellGate: true,
      jevConfigPath: './jev.json',
      actionAssessment: true,
    },
    BASE,
  );
  assert.equal(config?.actionAssessment, true);
  assert.equal(config?.completionReview, false);
  assert.equal(config?.jevConfigPath, '/work/repo/jev.json');
});

test('requirement egress allowed requires action assessment', () => {
  expectError({
    enabled: true,
    jevConfigPath: './jev.json',
    requirementEgress: 'allowed',
  });
  expectError({
    enabled: true,
    actionAssessment: false,
    jevConfigPath: './jev.json',
    requirementEgress: 'allowed',
  });
  expectError({
    enabled: true,
    jevConfigPath: './jev.json',
    requirementEgress: 'sometimes',
  });

  const config = parseWorkflowGateConfig(
    {
      enabled: true,
      actionAssessment: true,
      shellGate: true,
      jevConfigPath: './jev.json',
      requirementEgress: 'allowed',
    },
    BASE,
  );
  assert.equal(config?.requirementEgress, 'allowed');
});

test('new assessment fields still reject unknown fields', () => {
  expectError({
    enabled: true,
    jevConfigPath: './jev.json',
    actionAssessment: true,
    unknownAssessment: true,
  });
});
