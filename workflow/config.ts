/**
 * Shared opt-in configuration for the engineering workflow gate.
 *
 * This is intentionally separate from the security adapters' `log-only` mode.
 * Missing configuration means disabled; an explicitly enabled but malformed
 * configuration is an error and must be handled fail-closed by the caller.
 */

import { isAbsolute, resolve } from 'node:path';

export interface WorkflowGateConfig {
  readonly enabled: boolean;
  readonly guidance: boolean;
  readonly shellGate: boolean;
  readonly completionReview: boolean;
  readonly jevConfigPath: string | null;
  readonly actionAssessment: boolean;
  readonly requirementEgress: 'allowed' | 'denied';
}

export class WorkflowConfigError extends Error {
  readonly code = 'workflow_config_error';

  constructor() {
    super('workflow_config_error');
    this.name = 'WorkflowConfigError';
  }
}

const FIELDS = [
  'enabled',
  'guidance',
  'shellGate',
  'completionReview',
  'jevConfigPath',
  'actionAssessment',
  'requirementEgress',
] as const;

export function parseWorkflowGateConfig(
  value: unknown,
  baseDirectory: string,
): WorkflowGateConfig | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new WorkflowConfigError();
  }
  const raw = value as Record<string, unknown>;
  if (!isAbsolute(baseDirectory) || !hasExactKeys(raw, FIELDS)) {
    throw new WorkflowConfigError();
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new WorkflowConfigError();
  }
  if (raw.enabled === false) {
    return Object.freeze({
      enabled: false,
      guidance: false,
      shellGate: false,
      completionReview: false,
      jevConfigPath: null,
      actionAssessment: false,
      requirementEgress: 'denied',
    });
  }

  const guidance = optionalBoolean(raw.guidance, true);
  const shellGate = optionalBoolean(raw.shellGate, true);
  const completionReview = optionalBoolean(raw.completionReview, true);
  const jevConfigPath = optionalRelativePath(raw.jevConfigPath, baseDirectory);
  if (completionReview && jevConfigPath === null) {
    throw new WorkflowConfigError();
  }

  const actionAssessment = optionalBoolean(raw.actionAssessment, false);
  const requirementEgress = optionalRequirementEgress(raw.requirementEgress);
  if (
    actionAssessment &&
    (!shellGate || jevConfigPath === null)
  ) {
    throw new WorkflowConfigError();
  }
  if (requirementEgress === 'allowed' && !actionAssessment) {
    throw new WorkflowConfigError();
  }

  return Object.freeze({
    enabled: true,
    guidance,
    shellGate,
    completionReview,
    jevConfigPath,
    actionAssessment,
    requirementEgress,
  });
}

function optionalRequirementEgress(
  value: unknown,
): 'allowed' | 'denied' {
  if (value === undefined) {
    return 'denied';
  }
  if (value !== 'allowed' && value !== 'denied') {
    throw new WorkflowConfigError();
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new WorkflowConfigError();
  }
  return value;
}

function optionalRelativePath(
  value: unknown,
  baseDirectory: string,
): string | null {
  if (value === undefined) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0')
  ) {
    throw new WorkflowConfigError();
  }
  return resolve(baseDirectory, value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  try {
    return Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && allowed.includes(key),
    );
  } catch {
    return false;
  }
}
