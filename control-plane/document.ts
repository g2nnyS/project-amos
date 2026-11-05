/**
 * Versioned YAML/JSON policy document for the governance console.
 *
 * YAML is an exchange/edit format only. SQLite remains the single published
 * authority; import validates through the same candidate pipeline and never
 * becomes a runtime authority by itself.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Candidate, PublishedVersion } from './contracts.ts';

export const POLICY_DOCUMENT_FORMAT = 'amos-project-policy';
export const POLICY_DOCUMENT_VERSION = 1;
export const MAX_POLICY_DOCUMENT_BYTES = 60 * 1024;

export interface ParsedPolicyDocument {
  readonly candidate: Candidate;
  /** Optional identity fields; the service binds the real project. */
  readonly projectId: string | null;
  readonly workspace: string | null;
}

export function parsePolicyDocument(text: string): ParsedPolicyDocument {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    Buffer.byteLength(text, 'utf8') > MAX_POLICY_DOCUMENT_BYTES
  ) {
    throw new Error('document_invalid');
  }
  let value: unknown;
  try {
    value = parseYaml(text, { maxAliasCount: 50 });
  } catch {
    throw new Error('document_invalid');
  }
  if (Array.isArray(value)) {
    // Legacy rules-only document: activate every rule.
    return {
      candidate: {
        rules: value as Candidate['rules'],
        activation: { includedRuleIds: null, excludedRuleIds: [] },
      },
      projectId: null,
      workspace: null,
    };
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('document_invalid');
  }
  const document = value as Record<string, unknown>;
  const allowed = new Set([
    'format',
    'version',
    'project',
    'published',
    'activation',
    'injection',
    'rules',
  ]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) throw new Error('document_invalid');
  }
  if (
    document.format !== undefined &&
    document.format !== POLICY_DOCUMENT_FORMAT
  ) {
    throw new Error('document_invalid');
  }
  if (
    document.version !== undefined &&
    document.version !== POLICY_DOCUMENT_VERSION
  ) {
    throw new Error('document_invalid');
  }
  if (!Array.isArray(document.rules)) throw new Error('document_invalid');
  const activation = document.activation;
  if (typeof activation !== 'object' || activation === null || Array.isArray(activation)) {
    throw new Error('document_invalid');
  }
  const activationRecord = activation as Record<string, unknown>;
  for (const key of Object.keys(activationRecord)) {
    if (key !== 'includedRuleIds' && key !== 'excludedRuleIds') {
      throw new Error('document_invalid');
    }
  }
  const included = activationRecord.includedRuleIds;
  if (included !== null && !isStringArray(included)) {
    throw new Error('document_invalid');
  }
  if (!isStringArray(activationRecord.excludedRuleIds)) {
    throw new Error('document_invalid');
  }
  const candidate: Candidate = {
    rules: document.rules as Candidate['rules'],
    activation: {
      includedRuleIds: included === null ? null : [...included],
      excludedRuleIds: [...(activationRecord.excludedRuleIds as string[])],
    },
  };
  const injection = document.injection;
  if (injection !== undefined) {
    if (typeof injection !== 'object' || injection === null || Array.isArray(injection)) {
      throw new Error('document_invalid');
    }
    const injectionRecord = injection as Record<string, unknown>;
    for (const key of Object.keys(injectionRecord)) {
      if (key !== 'baselineRuleIds' && key !== 'routes') {
        throw new Error('document_invalid');
      }
    }
    if (!isStringArray(injectionRecord.baselineRuleIds)) {
      throw new Error('document_invalid');
    }
    if (!Array.isArray(injectionRecord.routes)) {
      throw new Error('document_invalid');
    }
    return {
      candidate: {
        ...candidate,
        injection: {
          baselineRuleIds: [...injectionRecord.baselineRuleIds],
          routes: injectionRecord.routes as NonNullable<Candidate['injection']>['routes'],
        },
      },
      ...readProject(document.project),
    };
  }
  return { candidate, ...readProject(document.project) };
}

export function serializePolicyDocument(published: PublishedVersion): string {
  const candidate = published.candidate;
  const document = {
    format: POLICY_DOCUMENT_FORMAT,
    version: POLICY_DOCUMENT_VERSION,
    project: {
      id: published.projectId,
      workspace: published.snapshot.workspace,
    },
    published: {
      version: published.version,
      snapshotDigest: published.snapshot.digest,
      activationDigest: published.snapshot.activationDigest,
    },
    activation: candidate.activation,
    injection: candidate.injection ?? { baselineRuleIds: [], routes: [] },
    rules: candidate.rules,
  };
  return stringifyYaml(document, { lineWidth: 0 });
}

function readProject(value: unknown): {
  projectId: string | null;
  workspace: string | null;
} {
  if (value === undefined) return { projectId: null, workspace: null };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('document_invalid');
  }
  const project = value as Record<string, unknown>;
  if (
    project.id !== undefined &&
    (typeof project.id !== 'string' || project.id.length === 0)
  ) {
    throw new Error('document_invalid');
  }
  if (
    project.workspace !== undefined &&
    (typeof project.workspace !== 'string' || !project.workspace.startsWith('/'))
  ) {
    throw new Error('document_invalid');
  }
  return {
    projectId: typeof project.id === 'string' ? project.id : null,
    workspace: typeof project.workspace === 'string' ? project.workspace : null,
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160)
  );
}
